"""Prompt Skill Loader: choose a Skill from the pack or load any local .md/.txt file."""

from __future__ import annotations

import hashlib
import os
from typing import Any

AUTO_LABEL = "Auto (none)"
MAX_SKILL_BYTES = 4 * 1024 * 1024
SKILL_SUFFIXES = {".md", ".txt"}
PACKAGE_SKILLS_DIR = os.path.join(
  os.path.dirname(os.path.realpath(__file__)),
  "skills",
)


def _records() -> list[dict[str, Any]]:
  from .skill_library import discover_skills

  records: list[dict[str, Any]] = []
  # Only this pack's own skills are offered in the dropdown; other folders are
  # loaded explicitly through the file button or the asset manager.
  for skill in discover_skills(PACKAGE_SKILLS_DIR):
    relative_directory = str(skill.get("relativeDirectory") or "").strip("/")
    file_name = str(skill.get("fileName") or "").strip()
    records.append(
      {
        "id": str(skill.get("id") or ""),
        "name": str(skill.get("name") or ""),
        "label": str(
          skill.get("label") or skill.get("name") or skill.get("id") or ""
        ),
        "description": str(skill.get("description") or ""),
        "skill_file": file_name,
        "skill_path": "/".join(
          part for part in (relative_directory, file_name) if part
        ),
        "skill_dir": relative_directory,
        "absolute_path": str(skill.get("absolutePath") or ""),
        "references": list(skill.get("references") or []),
      }
    )
  return records


def _options() -> list[str]:
  return [AUTO_LABEL] + [
    record["label"] for record in _records() if record["label"]
  ]


def _read_skill(path: str) -> str:
  resolved = os.path.realpath(os.path.expanduser(str(path or "").strip()))
  if not resolved:
    raise ValueError("Skill loader needs a file path")
  if not os.path.isfile(resolved):
    raise ValueError(f"Skill file was not found: {resolved}")
  if os.path.splitext(resolved)[1].lower() not in SKILL_SUFFIXES:
    raise ValueError("Skill loader supports only .md or .txt files")
  if os.path.getsize(resolved) > MAX_SKILL_BYTES:
    raise ValueError("Skill loader file must be 4 MB or smaller")
  with open(resolved, "r", encoding="utf-8-sig") as file:
    return file.read()


def _inline_payload(name: str, content: str) -> dict[str, Any] | None:
  text = str(content or "")
  if not text.strip():
    return None
  filename = os.path.basename(str(name or "").strip()) or "skill.txt"
  digest = hashlib.sha1(
    (filename + "\0" + text).encode("utf-8")
  ).hexdigest()[:16]
  return {
    "name": filename,
    "content": text,
    "source": "skill_loader",
    "id": digest,
  }


class AstralPromptSkillLoader:
  NAME = "Prompt Skill Loader"
  CATEGORY = "Astral/Prompt"
  DESCRIPTION = (
    "Loads this pack's Skill or any local .md/.txt file and outputs it for "
    "Prompt Processor or Qwen llama TE nodes."
  )

  @classmethod
  def INPUT_TYPES(cls):
    return {
      "required": {
        "skill": (
          _options(),
          {
            "default": AUTO_LABEL,
            "tooltip": "Pick an installed Skill, or load a file with the buttons below.",
          },
        ),
      },
      "optional": {
        "skill_path": (
          "STRING",
          {
            "default": "",
            "tooltip": "Absolute Skill file pinned by the asset manager.",
          },
        ),
        "inline_name": (
          "STRING",
          {
            "default": "",
            "multiline": False,
            "tooltip": "File name of a Skill loaded from disk.",
          },
        ),
        "inline_content": (
          "STRING",
          {
            "default": "",
            "multiline": True,
            "tooltip": "Contents of a Skill loaded from disk.",
          },
        ),
      },
    }

  RETURN_TYPES = ("QWEN_TE_SKILL",)
  RETURN_NAMES = ("skill",)
  FUNCTION = "run"
  OUTPUT_NODE = False

  def run(
    self,
    skill=AUTO_LABEL,
    skill_path="",
    inline_name="",
    inline_content="",
  ):
    records = _records()
    selected = ""
    inline = _inline_payload(inline_name, inline_content)
    if inline is None:
      pinned = str(skill_path or "").strip()
      if pinned:
        inline = _inline_payload(os.path.basename(pinned), _read_skill(pinned))
    if inline is None and skill and skill != AUTO_LABEL:
      record = next(
        (
          item
          for item in records
          if skill in {item["label"], item["id"]}
        ),
        None,
      )
      if record is None:
        raise ValueError(f"Skill was not found: {skill}")
      selected = record["id"]
      absolute = record.get("absolute_path") or ""
      if absolute and os.path.isfile(absolute):
        try:
          inline = _inline_payload(
            record.get("skill_file") or os.path.basename(absolute),
            _read_skill(absolute),
          )
        except (OSError, ValueError):
          inline = None
    return (
      {
        "selected": selected,
        "skills": records,
        "inline_file": inline,
      },
    )


NODE_CLASS_MAPPINGS = {
  "Prompt Skill Loader": AstralPromptSkillLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
  "Prompt Skill Loader": AstralPromptSkillLoader.NAME,
}
