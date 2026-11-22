from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import time
from pathlib import Path
from typing import Any


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
COMFYUI_ROOT = PLUGIN_ROOT.parent.parent
if str(PLUGIN_ROOT) not in sys.path:
  sys.path.insert(0, str(PLUGIN_ROOT))

import prompt_library


SYSTEM_SECTIONS = (
  ("expand_prompts", "text"),
  ("translate_prompts", "text"),
  ("vision_prompts", "image"),
  ("video_prompts", "video"),
)


def _load_json(path: Path) -> dict[str, Any]:
  try:
    with path.open("r", encoding="utf-8-sig") as source:
      payload = json.load(source)
  except FileNotFoundError as error:
    raise RuntimeError(f"找不到源文件：{path}") from error
  except (OSError, json.JSONDecodeError, UnicodeDecodeError) as error:
    raise RuntimeError(f"无法读取源文件：{path}") from error
  if not isinstance(payload, dict):
    raise RuntimeError(f"源文件格式错误：{path}")
  return payload


def _stable_template_id(section: str, source_key: str) -> str:
  digest = hashlib.sha256(
    f"prompt-assistant\0{section}\0{source_key}".encode("utf-8")
  ).hexdigest()
  return f"pa-{digest[:24]}"


def _display_title(source_key: str, entry: dict[str, Any]) -> str:
  title = str(entry.get("name") or "").strip()
  if title:
    return title
  fallback = source_key.split("_", 1)[-1].strip()
  return fallback or source_key


def _system_category(
  section: str,
  source_key: str,
  entry: dict[str, Any],
  default_category: str,
) -> str:
  descriptor = " ".join(
    [
      source_key,
      str(entry.get("name") or ""),
      str(entry.get("category") or ""),
    ]
  ).casefold()
  if section == "video_prompts":
    return "video"
  if any(token in descriptor for token in ("wan视频", "minimaxh3", "i2v", "图像到视频")):
    return "video"
  if any(
    token in descriptor
    for token in (
      "图像编辑",
      "qwen-image-edit",
      "qwenimage",
      "kontext",
      "zimage",
      "krea2",
    )
  ):
    return "image"
  return default_category


def _system_templates(system_payload: dict[str, Any]) -> list[dict[str, Any]]:
  templates: list[dict[str, Any]] = []
  for section, default_category in SYSTEM_SECTIONS:
    section_payload = system_payload.get(section)
    if not isinstance(section_payload, dict):
      continue
    for source_key, raw_entry in section_payload.items():
      if not isinstance(raw_entry, dict):
        continue
      content = str(raw_entry.get("content") or "").strip()
      if not content:
        continue
      templates.append(
        {
          "id": _stable_template_id(section, str(source_key)),
          "title": _display_title(str(source_key), raw_entry),
          "category": _system_category(
            section,
            str(source_key),
            raw_entry,
            default_category,
          ),
          "prompt": content,
          "source": f"{section}/{source_key}",
        }
      )
  return templates


def _kontext_templates(kontext_payload: dict[str, Any]) -> list[dict[str, Any]]:
  presets = kontext_payload.get("kontext_presets")
  if not isinstance(presets, dict):
    return []
  prefix = str(kontext_payload.get("kontext_prefix") or "").strip()
  suffix = str(kontext_payload.get("kontext_suffix") or "").strip()
  templates: list[dict[str, Any]] = []
  for source_key, raw_entry in presets.items():
    if not isinstance(raw_entry, dict):
      continue
    content = str(raw_entry.get("content") or "").strip()
    if not content:
      continue
    prompt = "\n\n".join(part for part in (prefix, content, suffix) if part)
    templates.append(
      {
        "id": _stable_template_id("kontext_presets", str(source_key)),
        "title": _display_title(str(source_key), raw_entry),
        "category": "image",
        "prompt": prompt,
        "source": f"kontext_presets/{source_key}",
      }
    )
  return templates


def _read_existing_templates(templates_path: Path) -> list[dict[str, Any]]:
  if not templates_path.is_file():
    return []
  payload = _load_json(templates_path)
  templates = payload.get("templates")
  if not isinstance(templates, list):
    return []
  return [item for item in templates if isinstance(item, dict) and item.get("id")]


def build_templates(source_directory: Path) -> list[dict[str, Any]]:
  system_payload = _load_json(source_directory / "system_prompts.json")
  kontext_payload = _load_json(source_directory / "kontext_presets.json")
  return [
    *_system_templates(system_payload),
    *_kontext_templates(kontext_payload),
  ]


def merge_templates(
  existing: list[dict[str, Any]],
  imported: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], int, int]:
  by_id = {str(item.get("id")): item for item in existing}
  now = time.time()
  created = 0
  updated = 0
  for index, raw in enumerate(imported):
    template = {
      "id": prompt_library._safe_conversation_id(raw["id"]),
      "title": prompt_library._clean_text(
        raw["title"],
        maximum=prompt_library.MAX_TITLE_LENGTH,
        field="标题",
        required=True,
      ),
      "category": prompt_library._clean_category(raw["category"]),
      "prompt": prompt_library._clean_text(
        raw["prompt"],
        maximum=prompt_library.MAX_PROMPT_LENGTH,
        field="提示词",
        required=True,
      ),
    }
    previous = by_id.get(template["id"])
    if previous is None:
      template["createdAt"] = now - index
      created += 1
    else:
      template["createdAt"] = float(previous.get("createdAt") or now - index)
      updated += 1
    template["updatedAt"] = now - index
    by_id[template["id"]] = template
  merged = list(by_id.values())
  if len(merged) > prompt_library.MAX_TEMPLATES:
    raise RuntimeError(
      f"合并后共有 {len(merged)} 条模板，超过上限 "
      f"{prompt_library.MAX_TEMPLATES}"
    )
  return merged, created, updated


def _default_source_directory() -> Path:
  return (
    COMFYUI_ROOT
    / "user"
    / "default"
    / "prompt-assistant"
    / "rules"
  )


def _default_data_directory() -> Path:
  return COMFYUI_ROOT / "user" / "assets-astral"


def _preserve_existing_backup(templates_path: Path) -> None:
  backup_path = Path(f"{templates_path}.bak")
  preserved_path = Path(f"{templates_path}.pre-import.bak")
  if backup_path.is_file() and not preserved_path.exists():
    shutil.copy2(backup_path, preserved_path)


def _parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(
    description="将提示词小助手的规则复制到 Assets-Astral 提示词模板。"
  )
  parser.add_argument(
    "--source-dir",
    type=Path,
    default=_default_source_directory(),
    help="提示词小助手的 rules 目录",
  )
  parser.add_argument(
    "--data-dir",
    type=Path,
    default=_default_data_directory(),
    help="Assets-Astral 用户数据目录",
  )
  parser.add_argument(
    "--dry-run",
    action="store_true",
    help="只统计和校验，不写入文件",
  )
  return parser.parse_args()


def main() -> int:
  args = _parse_args()
  source_directory = args.source_dir.resolve()
  data_directory = args.data_dir.resolve()
  imported = build_templates(source_directory)
  templates_path = data_directory / "prompt-templates.json"
  existing = _read_existing_templates(templates_path)
  merged, created, updated = merge_templates(existing, imported)

  import_counts: dict[str, int] = {}
  for item in imported:
    import_counts[item["category"]] = import_counts.get(item["category"], 0) + 1
  summary = ", ".join(
    f"{category}={import_counts.get(category, 0)}"
    for category in prompt_library.TEMPLATE_CATEGORIES
  )
  print(f"源规则：{len(imported)} 条（{summary}）")
  print(f"目标文件：{templates_path}")
  print(f"将新增 {created} 条，更新 {updated} 条，保留其他模板后共 {len(merged)} 条")

  if args.dry_run:
    print("dry-run：未写入文件")
    return 0

  data_directory.mkdir(parents=True, exist_ok=True)
  _preserve_existing_backup(templates_path)
  prompt_library._atomic_write_json(
    os.fspath(templates_path),
    {"version": 1, "templates": merged},
  )
  listing = prompt_library.list_templates(os.fspath(data_directory))
  print(f"写入完成：{listing['total']} 条模板")
  if templates_path.with_suffix(".json.bak").is_file():
    print(f"原文件备份：{templates_path}.bak")
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
