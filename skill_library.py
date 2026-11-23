from __future__ import annotations

import os
import re
from typing import Any


SKILL_FILE_NAMES = ("SKILL.cn.md", "SKILL.md")
REFERENCE_EXTENSIONS = {".md", ".txt", ".json", ".yaml", ".yml"}
MAX_SKILL_FILE_BYTES = 512 * 1024
MAX_REFERENCE_FILE_BYTES = 512 * 1024
MAX_SKILL_CONTEXT_BYTES = 2 * 1024 * 1024
MAX_SKILLS = 500
SKIPPED_SCAN_DIRECTORIES = {
  ".asset-library-tests",
  ".git",
  ".hg",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".svn",
  ".venv",
  "__pycache__",
  "env",
  "node_modules",
  "references",
  "site-packages",
  "venv",
}


class SkillLibraryError(ValueError):
  pass


def default_skills_directory() -> str:
  package_root = os.path.dirname(os.path.abspath(__file__))
  custom_nodes_root = os.path.dirname(package_root)
  if os.path.basename(custom_nodes_root).casefold() == "custom_nodes":
    return custom_nodes_root
  return os.path.join(package_root, "skills")


def default_input_directory() -> str:
  return os.path.join(os.path.dirname(default_skills_directory()), "input")


def default_skill_directories() -> list[str]:
  roots: list[str] = []
  seen: set[str] = set()
  for root in (default_skills_directory(), default_input_directory()):
    normalized = os.path.realpath(root)
    key = os.path.normcase(normalized)
    if key in seen:
      continue
    seen.add(key)
    roots.append(normalized)
  return roots


def _read_limited(path: str, maximum: int) -> str:
  try:
    size = os.path.getsize(path)
  except OSError as error:
    raise SkillLibraryError(f"Unable to read skill file: {error}") from error
  if size > maximum:
    raise SkillLibraryError(
      f"Skill file too large ({size} bytes); limit is {maximum} bytes"
    )
  try:
    with open(path, "r", encoding="utf-8-sig") as source:
      return source.read()
  except (OSError, UnicodeDecodeError) as error:
    raise SkillLibraryError(f"Unable to read skill file: {error}") from error


def _parse_frontmatter(text: str) -> dict[str, str]:
  if not text.startswith("---"):
    return {}
  match = re.search(r"\r?\n---\s*(?:\r?\n|$)", text[3:])
  if not match:
    return {}
  body = text[3 : 3 + match.start()]
  values: dict[str, str] = {}
  current_key = ""
  for line in body.splitlines():
    key_match = re.match(r"^([A-Za-z0-9_-]+):\s*(.*?)\s*$", line)
    if key_match:
      current_key = key_match.group(1)
      value = key_match.group(2).strip()
      if value in {"|", ">"}:
        value = ""
      values[current_key] = value.strip("\"'")
      continue
    if current_key and line.startswith((" ", "\t")):
      continuation = line.strip()
      if continuation:
        values[current_key] = f"{values[current_key]} {continuation}".strip()
  return values


def _first_heading(text: str) -> str:
  for line in text.splitlines():
    match = re.match(r"^#\s+(.+?)\s*$", line)
    if match:
      return match.group(1).strip()
  return ""


def _safe_relative(path: str, root: str) -> str:
  relative = os.path.relpath(path, root).replace("\\", "/")
  if relative == ".." or relative.startswith("../") or os.path.isabs(relative):
    raise SkillLibraryError("Skill path escapes the skill root directory")
  return relative


def _reference_files(skill_directory: str) -> list[str]:
  reference_root = os.path.join(skill_directory, "references")
  if not os.path.isdir(reference_root):
    return []
  files: list[str] = []
  for directory, subdirectories, filenames in os.walk(
    reference_root,
    followlinks=False,
  ):
    subdirectories[:] = [
      name
      for name in subdirectories
      if not name.startswith(".") and not os.path.islink(os.path.join(directory, name))
    ]
    for filename in filenames:
      path = os.path.join(directory, filename)
      if os.path.islink(path):
        continue
      if os.path.splitext(filename)[1].lower() not in REFERENCE_EXTENSIONS:
        continue
      try:
        if os.path.getsize(path) > MAX_REFERENCE_FILE_BYTES:
          continue
      except OSError:
        continue
      files.append(
        os.path.relpath(path, skill_directory).replace("\\", "/")
      )
  return sorted(files)


def _skill_label(name: str, skill_id: str) -> str:
  return (
    f"{name} [{skill_id}]"
    if skill_id and name != skill_id
    else name
  )


def _skill_record(
  root: str,
  skill_directory: str,
  *,
  source: str,
  id_prefix: str = "",
) -> dict[str, Any] | None:
  file_name = next(
    (
      name
      for name in SKILL_FILE_NAMES
      if os.path.isfile(os.path.join(skill_directory, name))
    ),
    "",
  )
  if not file_name:
    return None
  file_path = os.path.join(skill_directory, file_name)
  text = _read_limited(file_path, MAX_SKILL_FILE_BYTES)
  metadata = _parse_frontmatter(text)
  relative_directory = _safe_relative(skill_directory, root)
  relative_id = relative_directory.replace(os.sep, "/")
  if relative_id == ".":
    relative_id = ""
  skill_id = "/".join(
    part for part in (id_prefix.strip("/"), relative_id) if part
  )
  display_name = (
    str(metadata.get("name") or "").strip()
    or _first_heading(text)
    or os.path.basename(skill_directory)
  )
  description = re.sub(r"\s+", " ", str(metadata.get("description") or "")).strip()
  return {
    "id": skill_id,
    "name": display_name,
    "label": _skill_label(display_name, skill_id),
    "description": description,
    "fileName": file_name,
    "relativeDirectory": relative_directory,
    "source": source,
    "root": os.path.abspath(root),
    "absolutePath": os.path.abspath(file_path),
    "references": _reference_files(skill_directory),
    "size": os.path.getsize(file_path),
  }


def _discover_in_root(
  root: str,
  *,
  source: str,
  id_prefix: str = "",
  limit: int = MAX_SKILLS,
) -> list[dict[str, Any]]:
  root = os.path.realpath(root)
  if not os.path.isdir(root):
    return []
  skills: list[dict[str, Any]] = []
  for directory, subdirectories, filenames in os.walk(root, followlinks=False):
    subdirectories[:] = [
      name
      for name in subdirectories
      if not name.startswith(".")
      and name.casefold() not in SKIPPED_SCAN_DIRECTORIES
      and not os.path.islink(os.path.join(directory, name))
    ]
    if not any(name in filenames for name in SKILL_FILE_NAMES):
      continue
    try:
      record = _skill_record(
        root,
        directory,
        source=source,
        id_prefix=id_prefix,
      )
    except SkillLibraryError:
      continue
    if record is not None:
      skills.append(record)
    if len(skills) >= limit:
      break
  return skills


def discover_skills(
  skills_root: str | None = None,
  *,
  input_root: str | None = None,
) -> list[dict[str, Any]]:
  uses_default_roots = skills_root is None
  root_specs: list[tuple[str, str, str]] = []
  if uses_default_roots:
    root_specs.append(
      (default_skills_directory(), "custom_nodes", "")
    )
  else:
    root_specs.append(
      (str(skills_root), os.path.basename(str(skills_root)), "")
    )
  input_directory = input_root
  if input_directory is None and uses_default_roots:
    input_directory = default_input_directory()
  if input_directory:
    root_specs.append((str(input_directory), "input", "input"))

  skills: list[dict[str, Any]] = []
  seen_files: set[str] = set()
  used_ids: set[str] = set()
  for root, source, id_prefix in root_specs:
    for skill in _discover_in_root(
      root,
      source=source,
      id_prefix=id_prefix,
      limit=MAX_SKILLS - len(skills),
    ):
      file_key = os.path.normcase(os.path.realpath(skill["absolutePath"]))
      if file_key in seen_files:
        continue
      seen_files.add(file_key)
      candidate = skill["id"]
      if candidate in used_ids:
        base = "/".join(
          part for part in (source, candidate.lstrip("/")) if part
        )
        candidate = base
        suffix = 2
        while candidate in used_ids:
          candidate = f"{base}-{suffix}"
          suffix += 1
        skill["id"] = candidate
        skill["label"] = _skill_label(skill["name"], candidate)
      used_ids.add(skill["id"])
      skills.append(skill)
      if len(skills) >= MAX_SKILLS:
        break
    if len(skills) >= MAX_SKILLS:
      break
  skills.sort(key=lambda item: (item["name"].casefold(), item["id"].casefold()))
  return skills


def get_skill(
  skill_id: str,
  skills_root: str | None = None,
  *,
  input_root: str | None = None,
) -> dict[str, Any]:
  requested = str(skill_id or "").replace("\\", "/").strip("/")
  for skill in discover_skills(skills_root, input_root=input_root):
    if skill["id"] == requested:
      return skill
  raise FileNotFoundError("Skill not found")


def resolve_skill_file(
  skill_id: str,
  skills_root: str | None = None,
  *,
  input_root: str | None = None,
) -> str:
  skill = get_skill(skill_id, skills_root, input_root=input_root)
  path = os.path.realpath(str(skill.get("absolutePath") or ""))
  if not os.path.isfile(path):
    raise FileNotFoundError("Skill file not found")
  return path


def load_skill_text(
  skill_id: str,
  skills_root: str | None = None,
  *,
  input_root: str | None = None,
) -> dict[str, Any]:
  skill = get_skill(skill_id, skills_root, input_root=input_root)
  return _load_skill_record(skill)


def _load_skill_record(skill: dict[str, Any]) -> dict[str, Any]:
  text = _read_limited(skill["absolutePath"], MAX_SKILL_FILE_BYTES)
  return {**skill, "content": text}


def _selected_reference_text(
  skill: dict[str, Any],
  reference: str,
) -> str:
  reference = str(reference or "").replace("\\", "/").strip("/")
  if reference not in skill["references"]:
    raise SkillLibraryError(f"Skill reference file not found: {reference}")
  skill_directory = os.path.realpath(
    os.path.dirname(skill["absolutePath"])
  )
  path = os.path.realpath(
    os.path.join(skill_directory, *reference.split("/"))
  )
  try:
    if os.path.commonpath((skill_directory, path)) != skill_directory:
      raise SkillLibraryError("Skill reference file path escapes the skill directory")
  except ValueError as error:
    raise SkillLibraryError("Invalid skill reference file path") from error
  return _read_limited(path, MAX_REFERENCE_FILE_BYTES)


def build_skill_context(
  skill_ids: list[str] | tuple[str, ...] | None,
  *,
  skills_root: str | None = None,
  input_root: str | None = None,
  include_references: bool = True,
) -> tuple[list[dict[str, Any]], str]:
  selected_ids = []
  for value in skill_ids or ():
    if not isinstance(value, str):
      continue
    normalized = value.replace("\\", "/").strip("/")
    if normalized and normalized not in selected_ids:
      selected_ids.append(normalized)
  if not selected_ids:
    return [], ""

  available_skills = {
    skill["id"]: skill
    for skill in discover_skills(skills_root, input_root=input_root)
  }
  sections: list[str] = []
  loaded: list[dict[str, Any]] = []
  total_bytes = 0
  for skill_id in selected_ids:
    available = available_skills.get(skill_id)
    if available is None:
      raise FileNotFoundError("Skill not found")
    skill = _load_skill_record(available)
    text = (
      f"<skill id=\"{skill['id']}\" name=\"{skill['name']}\">\n"
      f"{skill['content'].strip()}\n"
    )
    total_bytes += len(text.encode("utf-8"))
    if include_references:
      for reference in skill["references"]:
        reference_text = _selected_reference_text(skill, reference)
        block = (
          f"\n<skill-reference file=\"{reference}\">\n"
          f"{reference_text.strip()}\n"
          "</skill-reference>"
        )
        total_bytes += len(block.encode("utf-8"))
        text += block
    text += "\n</skill>"
    if total_bytes > MAX_SKILL_CONTEXT_BYTES:
      raise SkillLibraryError("Selected skill content is too large; reduce the number of skills")
    sections.append(text)
    loaded.append(
      {
        "id": skill["id"],
        "name": skill["name"],
        "references": skill["references"] if include_references else [],
      }
    )
  context = (
    "The following Skills are work instructions the user explicitly loaded. Follow them without violating system safety requirements or the user's request:\n\n"
    + "\n\n".join(sections)
  )
  return loaded, context
