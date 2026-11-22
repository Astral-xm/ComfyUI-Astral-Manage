from __future__ import annotations

import ctypes
import hashlib
import os
import re
import shutil
from collections.abc import Callable, Iterable, Mapping
from typing import Any


NON_MODEL_CATEGORIES = {"custom_nodes", "datasets"}
SKIPPED_DIRECTORIES = {".git", "node_modules", "__pycache__"}
MODEL_EXTENSIONS = {
  ".bin",
  ".ckpt",
  ".gguf",
  ".onnx",
  ".pkl",
  ".pt",
  ".pt2",
  ".pth",
  ".safetensors",
  ".sft",
}
FOF_ALLOWUNDO = 0x0040
FOF_NOCONFIRMATION = 0x0010
FOF_NOERRORUI = 0x0400
FOF_SILENT = 0x0004


class ModelPathError(ValueError):
  pass


class RecycleBinError(OSError):
  pass


class DuplicateScanCancelled(Exception):
  pass


def _raise_if_cancelled(cancel_callback: Callable[[], bool] | None) -> None:
  if cancel_callback is not None and cancel_callback():
    raise DuplicateScanCancelled("重复模型扫描已取消")


def _report_progress(
  progress_callback: Callable[[dict[str, Any]], None] | None,
  **updates: Any,
) -> None:
  if progress_callback is not None:
    progress_callback(updates)


def _path_inside(root: str, target: str) -> bool:
  try:
    root = os.path.normcase(os.path.realpath(root))
    target = os.path.normcase(os.path.realpath(target))
    return os.path.commonpath((root, target)) == root
  except (OSError, ValueError):
    return False


def normalize_relative_path(value: str, *, allow_empty: bool = False) -> str:
  value = str(value or "").replace("\\", "/").strip()
  if not value:
    if allow_empty:
      return ""
    raise ModelPathError("模型路径不能为空")
  if value.startswith("/") or "\x00" in value:
    raise ModelPathError("模型路径必须是相对路径")
  if re.match(r"^[A-Za-z]:", value):
    raise ModelPathError("模型路径不能使用绝对路径")
  parts = [part for part in value.split("/") if part not in ("", ".")]
  if any(part == ".." for part in parts):
    raise ModelPathError("模型路径不能越过配置的模型目录")
  return "/".join(parts)


def native_model_identifier(value: str) -> str:
  """Return a normalized relative model name using the server OS separator."""
  return normalize_relative_path(value).replace("/", os.sep)


def normalized_model_name_lookup(names: Iterable[str]) -> dict[str, str]:
  lookup: dict[str, str] = {}
  for name in names:
    registered_name = str(name or "")
    try:
      normalized_name = normalize_relative_path(registered_name)
    except ModelPathError:
      continue
    lookup.setdefault(normalized_name, registered_name)
  return lookup


MODEL_CATEGORY_ALIASES = {
  "checkpoint": ("checkpoints",),
  "checkpoints": ("checkpoints",),
  "clip": ("text_encoders", "clip"),
  "clip_vision": ("clip_vision",),
  "controlnet": ("controlnet",),
  "diffusion_models": ("diffusion_models", "unet"),
  "loras": ("loras",),
  "model_patches": ("model_patches",),
  "style_models": ("style_models",),
  "text_encoders": ("text_encoders", "clip"),
  "unet": ("diffusion_models", "unet"),
  "upscale_models": ("upscale_models",),
  "vae": ("vae",),
  "vae_approx": ("vae_approx",),
}


def _related_model_categories(values: Any) -> set[str]:
  related: set[str] = set()
  if not isinstance(values, (list, tuple, set)):
    return related
  for value in values:
    name = str(value or "").strip()
    if not name:
      continue
    key = name.casefold()
    related.add(key)
    related.update(
      alias.casefold()
      for alias in MODEL_CATEGORY_ALIASES.get(key, ())
    )
  return related


def _sha256_hint(value: Any) -> str:
  candidate = str(value or "").strip().lower()
  return candidate if re.fullmatch(r"[0-9a-f]{64}", candidate) else ""


def _public_missing_candidate(item: dict[str, Any]) -> dict[str, Any]:
  return {
    "category": item["category"],
    "rootIndex": item["rootIndex"],
    "rootPath": item["rootPath"],
    "relativePath": item["relativePath"],
    "nativePath": native_model_identifier(item["relativePath"]),
    "absolutePath": item["absolutePath"],
    "name": item["name"],
    "size": item["size"],
    "modified": item["modified"],
  }


def _dedupe_model_candidates(
  items: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
  candidates: list[dict[str, Any]] = []
  seen: set[tuple[str, str]] = set()
  for item in items:
    key = (
      str(item["category"]).casefold(),
      str(item["relativePath"]).casefold(),
    )
    if key in seen:
      continue
    seen.add(key)
    candidates.append(_public_missing_candidate(item))
  candidates.sort(
    key=lambda item: (
      item["category"].casefold(),
      item["relativePath"].casefold(),
    )
  )
  return candidates


def resolve_missing_model_files(
  categories: list[dict[str, Any]],
  requests: list[dict[str, Any]],
) -> dict[str, Any]:
  """Resolve missing ComfyUI combo values against files in the local model roots.

  This function is read-only. A request may carry a SHA256 and size copied from
  workflow metadata; when present, the hash is authoritative. Without a hash,
  an exact relative path wins, otherwise same-name files are returned as
  confirmable candidates.
  """

  if not isinstance(requests, list) or not requests:
    raise ModelPathError("请至少提供一个缺失模型")
  if len(requests) > 500:
    raise ModelPathError("单次最多检查 500 个缺失模型")

  local_files = list(_iter_configured_files(categories))
  category_names = {
    str(category["name"]).casefold(): str(category["name"])
    for category in categories
  }
  digest_cache: dict[str, str] = {}
  failed_paths: set[str] = set()
  hashed_paths: set[str] = set()

  def hash_file(item: dict[str, Any]) -> str:
    path = str(item["absolutePath"])
    if path in digest_cache:
      return digest_cache[path]
    if path in failed_paths:
      return ""
    try:
      digest = _sha256(path)
    except OSError:
      failed_paths.add(path)
      return ""
    digest_cache[path] = digest
    hashed_paths.add(path)
    return digest

  results: list[dict[str, Any]] = []
  for index, raw_request in enumerate(requests):
    if not isinstance(raw_request, dict):
      raise ModelPathError("缺失模型检查项格式错误")
    key = str(raw_request.get("key", index))
    value = str(raw_request.get("value", "")).strip()
    if not value:
      raise ModelPathError("缺失模型名称不能为空")
    try:
      normalized_value = normalize_relative_path(value)
    except ModelPathError:
      normalized_value = ""

    related_categories = _related_model_categories(
      raw_request.get("categories")
    )
    selected_categories = {
      category_names[name]
      for name in related_categories
      if name in category_names
    }
    scope_fallback = bool(related_categories and not selected_categories)
    if selected_categories:
      pool = [
        item
        for item in local_files
        if item["category"] in selected_categories
      ]
    else:
      pool = list(local_files)

    basename = (
      normalized_value.rpartition("/")[2].casefold()
      if normalized_value
      else value.replace("\\", "/").rpartition("/")[2].casefold()
    )
    same_name = [
      item
      for item in pool
      if str(item["name"]).casefold() == basename
    ]
    expected_hash = _sha256_hint(
      raw_request.get("sha256") or raw_request.get("hash")
    )
    expected_size = max(0, int(raw_request.get("size") or 0))

    result: dict[str, Any] = {
      "key": key,
      "value": value,
      "requestedCategories": sorted(related_categories),
      "scopeFallback": scope_fallback,
      "hashHint": expected_hash,
      "sizeHint": expected_size,
      "via": "",
      "state": "missing",
      "candidates": [],
      "rejectedCandidates": [],
    }

    if expected_hash:
      hash_pool = (
        [
          item
          for item in pool
          if int(item["size"]) == expected_size
        ]
        if expected_size > 0
        else pool
      )
      same_name_paths = {
        str(item["absolutePath"]).casefold()
        for item in same_name
      }
      hash_pool.sort(
        key=lambda item: (
          str(item["absolutePath"]).casefold() not in same_name_paths,
          item["category"].casefold(),
          item["relativePath"].casefold(),
        )
      )
      hash_matches: list[dict[str, Any]] = []
      for item in hash_pool:
        if hash_file(item) == expected_hash:
          hash_matches.append(item)
      if hash_matches:
        result["candidates"] = _dedupe_model_candidates(hash_matches)
        result["state"] = "match"
        result["via"] = "sha256"
      else:
        result["state"] = "conflict" if same_name else "missing"
        result["via"] = "sha256"
        result["rejectedCandidates"] = _dedupe_model_candidates(same_name)
      results.append(result)
      continue

    exact_path = []
    if normalized_value:
      wanted_path = normalized_value.casefold()
      exact_path = [
        item
        for item in same_name
        if str(item["relativePath"]).casefold() == wanted_path
      ]
    if exact_path:
      result["candidates"] = _dedupe_model_candidates(exact_path)
      result["state"] = "match"
      result["via"] = "path"
    elif len(same_name) == 1:
      result["candidates"] = _dedupe_model_candidates(same_name)
      result["state"] = "candidate"
      result["via"] = "name"
    elif len(same_name) > 1:
      result["candidates"] = _dedupe_model_candidates(same_name)
      result["state"] = "ambiguous"
      result["via"] = "name"
    results.append(result)

  return {
    "results": results,
    "scannedFiles": len(local_files),
    "hashedFiles": len(hashed_paths),
    "failedHashFiles": len(failed_paths),
  }


def _normalized_extensions(values: Iterable[str] | None) -> set[str]:
  result: set[str] = set()
  for value in values or ():
    extension = str(value or "").strip().lower()
    if extension in {"", "folder"}:
      continue
    if not extension.startswith("."):
      extension = f".{extension}"
    result.add(extension)
  return result or set(MODEL_EXTENSIONS)


def _absolute_path(value: str) -> str:
  return os.path.abspath(os.path.expanduser(str(value)))


def _canonical_path(value: str) -> str:
  return os.path.normcase(os.path.realpath(_absolute_path(value)))


def _path_is_within(root: str, target: str) -> bool:
  try:
    root = os.path.normcase(os.path.abspath(root))
    target = os.path.normcase(os.path.abspath(target))
    return os.path.commonpath((root, target)) == root
  except (OSError, ValueError):
    return False


def _root_link_type(path: str) -> str:
  if os.path.islink(path):
    return "symlink"
  is_junction = getattr(os.path, "isjunction", None)
  if callable(is_junction) and is_junction(path):
    return "junction"
  return "directory"


def _make_root(index: int, path: str) -> dict[str, Any]:
  path = _absolute_path(path)
  exists = os.path.isdir(path)
  root = {
    "index": index,
    "path": path,
    "exists": exists,
    "linkType": _root_link_type(path),
  }
  if exists:
    root["resolvedPath"] = os.path.realpath(path)
  return root


def _registered_categories(
  mapping: Mapping[str, tuple[list[str], Iterable[str]]],
) -> list[dict[str, Any]]:
  categories: list[dict[str, Any]] = []
  for raw_name, raw_value in mapping.items():
    name = str(raw_name)
    if name in NON_MODEL_CATEGORIES:
      continue
    try:
      raw_roots, raw_extensions = raw_value
    except (TypeError, ValueError):
      continue
    roots = [
      _make_root(index, raw_root)
      for index, raw_root in enumerate(raw_roots or [])
    ]
    if not roots:
      continue
    categories.append(
      {
        "name": name,
        "roots": roots,
        "extensions": sorted(_normalized_extensions(raw_extensions)),
        "source": "configured",
      }
    )
  return categories


def _discover_models_directory_categories(
  mapping: Mapping[str, tuple[list[str], Iterable[str]]],
  model_roots: Iterable[str],
) -> list[dict[str, Any]]:
  registered = _registered_categories(mapping)
  registered_roots: dict[str, set[str]] = {}
  for category in registered:
    for root in category["roots"]:
      key = _canonical_path(root["path"])
      registered_roots.setdefault(key, set()).update(category["extensions"])

  discovered: dict[str, dict[str, Any]] = {}
  for raw_model_root in model_roots:
    model_root = _absolute_path(raw_model_root)
    if not os.path.isdir(model_root):
      continue
    try:
      with os.scandir(model_root) as entries:
        for entry in entries:
          try:
            if not entry.is_dir(follow_symlinks=True):
              continue
          except OSError:
            continue
          key = entry.name.casefold()
          category = discovered.get(key)
          if category is None:
            category = {
              "name": entry.name,
              "roots": [],
              "extensions": [],
              "source": "models",
            }
            discovered[key] = category
          path = _absolute_path(entry.path)
          canonical = _canonical_path(path)
          if any(
            _canonical_path(root["path"]) == canonical
            for root in category["roots"]
          ):
            continue
          category["roots"].append(_make_root(len(category["roots"]), path))
          category["extensions"] = sorted(
            set(category["extensions"])
            | registered_roots.get(
              canonical,
              _normalized_extensions(None),
            )
          )
    except OSError:
      continue

  # Model management mirrors the physical top-level folders inside
  # ``ComfyUI/models``. External roots that are merely registered in
  # folder_names_and_paths (LUTs, fonts, etc.) are intentionally excluded.
  return list(discovered.values())


def configured_model_categories(
  mapping: Mapping[str, tuple[list[str], Iterable[str]]],
  *,
  model_roots: Iterable[str] | None = None,
) -> list[dict[str, Any]]:
  model_roots = [
    _absolute_path(root)
    for root in (model_roots or [])
    if str(root or "").strip()
  ]
  if model_roots:
    categories = _discover_models_directory_categories(mapping, model_roots)
  else:
    categories = _registered_categories(mapping)
  categories.sort(key=lambda item: item["name"].casefold())
  return categories


def _category(
  categories: list[dict[str, Any]],
  category_name: str,
) -> dict[str, Any]:
  for category in categories:
    if category["name"] == category_name:
      return category
  raise ModelPathError("未知的模型分类")


def _root(
  category: dict[str, Any],
  root_index: int,
) -> dict[str, Any]:
  try:
    root_index = int(root_index)
  except (TypeError, ValueError) as error:
    raise ModelPathError("模型根目录索引无效") from error
  roots = category["roots"]
  if root_index < 0 or root_index >= len(roots):
    raise ModelPathError("模型根目录索引超出范围")
  return roots[root_index]


def resolve_model_path(
  categories: list[dict[str, Any]],
  category_name: str,
  root_index: int,
  relative_path: str,
  *,
  expect: str = "file",
) -> tuple[dict[str, Any], dict[str, Any], str]:
  category = _category(categories, category_name)
  root = _root(category, root_index)
  if not root.get("exists"):
    raise FileNotFoundError("模型根目录不存在")
  relative_path = normalize_relative_path(
    relative_path,
    allow_empty=expect == "directory",
  )
  base = os.path.realpath(root["path"])
  target = os.path.realpath(
    os.path.join(base, *relative_path.split("/")) if relative_path else base
  )
  if not _path_inside(base, target):
    raise ModelPathError("模型路径不在配置的根目录内")
  if expect == "file":
    if not os.path.isfile(target):
      raise FileNotFoundError("模型文件不存在")
  elif expect == "directory":
    if not os.path.isdir(target):
      raise FileNotFoundError("模型目录不存在")
  else:
    raise ValueError(f"Unknown path expectation: {expect}")
  return category, root, target


def _safe_directory_entries(path: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
  directories: list[dict[str, Any]] = []
  files: list[dict[str, Any]] = []
  try:
    with os.scandir(path) as entries:
      for entry in entries:
        try:
          if entry.is_symlink():
            continue
          if entry.is_dir(follow_symlinks=False):
            directories.append(
              {
                "name": entry.name,
                "path": entry.name,
                "type": "directory",
              }
            )
          elif entry.is_file(follow_symlinks=False):
            stat = entry.stat(follow_symlinks=False)
            files.append(
              {
                "name": entry.name,
                "path": entry.name,
                "type": "file",
                "size": stat.st_size,
                "modified": stat.st_mtime,
              }
            )
        except OSError:
          continue
  except OSError as error:
    raise ModelPathError(f"无法读取模型目录：{error}") from error
  directories.sort(key=lambda item: item["name"].casefold())
  files.sort(key=lambda item: item["name"].casefold())
  return directories, files


def _directory_contains_model_files(
  path: str,
  allowed_extensions: set[str],
) -> bool:
  try:
    with os.scandir(path) as entries:
      for entry in entries:
        try:
          if entry.is_symlink():
            continue
          if entry.is_file(follow_symlinks=False):
            if os.path.splitext(entry.name)[1].lower() in allowed_extensions:
              return True
            continue
          if (
            entry.is_dir(follow_symlinks=False)
            and entry.name not in SKIPPED_DIRECTORIES
            and _directory_contains_model_files(entry.path, allowed_extensions)
          ):
            return True
        except OSError:
          continue
  except OSError:
    return False
  return False


def list_model_tree(
  categories: list[dict[str, Any]],
  category_name: str,
  root_index: int,
  relative_path: str = "",
) -> dict[str, Any]:
  category, root, target = resolve_model_path(
    categories,
    category_name,
    root_index,
    relative_path,
    expect="directory",
  )
  normalized_path = normalize_relative_path(relative_path, allow_empty=True)
  directories, files = _safe_directory_entries(target)
  allowed_extensions = set(category["extensions"])
  visible_directories: list[dict[str, Any]] = []
  for directory in directories:
    child_path = os.path.join(target, directory["name"])
    if not _directory_contains_model_files(child_path, allowed_extensions):
      continue
    directory["path"] = (
      f"{normalized_path}/{directory['name']}" if normalized_path else directory["name"]
    )
    visible_directories.append(directory)
  allowed_files: list[dict[str, Any]] = []
  for file in files:
    if os.path.splitext(file["name"])[1].lower() not in allowed_extensions:
      continue
    file["path"] = f"{normalized_path}/{file['name']}" if normalized_path else file["name"]
    allowed_files.append(file)
  return {
    "category": category_name,
    "rootIndex": root["index"],
    "rootPath": root["path"],
    "path": normalized_path,
    "directories": visible_directories,
    "files": allowed_files,
  }


def _iter_configured_files(
  categories: list[dict[str, Any]],
  *,
  category_filter: str = "",
) -> Iterable[dict[str, Any]]:
  selected = (
    [_category(categories, category_filter)]
    if category_filter
    else categories
  )
  seen_paths: set[str] = set()
  for category in selected:
    allowed_extensions = set(category["extensions"])
    for root in category["roots"]:
      if not root.get("exists"):
        continue
      base = os.path.realpath(root["path"])
      for directory, subdirectories, filenames in os.walk(base, followlinks=False):
        retained: list[str] = []
        for name in subdirectories:
          full_path = os.path.join(directory, name)
          if name in SKIPPED_DIRECTORIES or os.path.islink(full_path):
            continue
          if not _path_inside(base, full_path):
            continue
          retained.append(name)
        subdirectories[:] = retained
        for filename in filenames:
          extension = os.path.splitext(filename)[1].lower()
          if extension not in allowed_extensions:
            continue
          full_path = os.path.join(directory, filename)
          if os.path.islink(full_path) or not _path_inside(base, full_path):
            continue
          canonical = os.path.normcase(os.path.realpath(full_path))
          if canonical in seen_paths:
            continue
          seen_paths.add(canonical)
          try:
            stat = os.stat(full_path)
          except OSError:
            continue
          relative_path = os.path.relpath(full_path, base).replace("\\", "/")
          yield {
            "category": category["name"],
            "rootIndex": root["index"],
            "rootPath": root["path"],
            "relativePath": relative_path,
            "absolutePath": os.path.abspath(full_path),
            "name": filename,
            "size": stat.st_size,
            "modified": stat.st_mtime,
          }


def list_model_files(
  categories: list[dict[str, Any]],
  *,
  category_filter: str = "",
  root_index: int | None = None,
  relative_path: str = "",
  exact: bool = False,
  query: str = "",
  offset: int = 0,
  limit: int = 120,
) -> dict[str, Any]:
  query = " ".join(str(query or "").split()).casefold()
  prefix = normalize_relative_path(relative_path, allow_empty=True)
  files: list[dict[str, Any]] = []
  for item in _iter_configured_files(categories, category_filter=category_filter):
    if root_index is not None and item["rootIndex"] != int(root_index):
      continue
    if prefix or exact:
      item_path = item["relativePath"].casefold()
      if exact:
        if item_path.rpartition("/")[0] != prefix.casefold():
          continue
      elif prefix and not (
        item_path == prefix.casefold()
        or item_path.startswith(f"{prefix.casefold()}/")
      ):
        continue
    if query and query not in item["relativePath"].casefold():
      continue
    files.append(item)
  files.sort(
    key=lambda item: (
      item["category"].casefold(),
      item["relativePath"].casefold(),
    )
  )
  offset = max(0, int(offset))
  limit = min(500, max(1, int(limit)))
  page = files[offset : offset + limit]
  return {
    "items": page,
    "total": len(files),
    "offset": offset,
    "limit": limit,
    "hasMore": offset + len(page) < len(files),
  }


def list_model_directories(
  categories: list[dict[str, Any]],
  *,
  category_filter: str = "",
) -> dict[str, Any]:
  selected = (
    [_category(categories, category_filter)]
    if category_filter
    else list(categories)
  )
  directories: list[dict[str, Any]] = []
  seen: set[str] = set()
  for category in selected:
    for root in category["roots"]:
      if not root.get("exists"):
        continue
      base = os.path.realpath(root["path"])
      if base in seen:
        continue
      seen.add(base)
      directories.append(
        {
          "category": category["name"],
          "rootIndex": root["index"],
          "rootPath": root["path"],
          "relativePath": "",
          "absolutePath": os.path.abspath(root["path"]),
          "name": os.path.basename(os.path.normpath(root["path"])),
        }
      )
      for directory, subdirectories, _filenames in os.walk(
        base,
        followlinks=False,
      ):
        retained: list[str] = []
        for name in subdirectories:
          full_path = os.path.join(directory, name)
          if name in SKIPPED_DIRECTORIES or os.path.islink(full_path):
            continue
          if not _path_inside(base, full_path):
            continue
          retained.append(name)
        subdirectories[:] = retained
        for name in retained:
          full_path = os.path.join(directory, name)
          canonical = os.path.normcase(os.path.realpath(full_path))
          if canonical in seen:
            continue
          seen.add(canonical)
          relative_path = os.path.relpath(full_path, base).replace("\\", "/")
          directories.append(
            {
              "category": category["name"],
              "rootIndex": root["index"],
              "rootPath": root["path"],
              "relativePath": relative_path,
              "absolutePath": os.path.abspath(full_path),
              "name": name,
            }
          )
  directories.sort(
    key=lambda item: (
      item["category"].casefold(),
      int(item["rootIndex"]),
      item["relativePath"].casefold(),
    )
  )
  return {
    "directories": directories,
    "total": len(directories),
  }


def _sha256(
  path: str,
  *,
  progress_callback: Callable[[int], None] | None = None,
  cancel_callback: Callable[[], bool] | None = None,
) -> str:
  digest = hashlib.sha256()
  with open(path, "rb") as source:
    while True:
      _raise_if_cancelled(cancel_callback)
      chunk = source.read(4 * 1024 * 1024)
      if not chunk:
        break
      digest.update(chunk)
      if progress_callback is not None:
        progress_callback(len(chunk))
  return digest.hexdigest()


def scan_duplicate_models(
  categories: list[dict[str, Any]],
  *,
  category_filter: str = "",
  progress_callback: Callable[[dict[str, Any]], None] | None = None,
  cancel_callback: Callable[[], bool] | None = None,
) -> dict[str, Any]:
  by_size: dict[int, list[dict[str, Any]]] = {}
  scanned = 0
  for item in _iter_configured_files(categories, category_filter=category_filter):
    _raise_if_cancelled(cancel_callback)
    scanned += 1
    if item["size"] <= 0:
      continue
    by_size.setdefault(int(item["size"]), []).append(item)
    _report_progress(
      progress_callback,
      phase="discovering",
      scannedFiles=scanned,
      hashedFiles=0,
      hashedBytes=0,
      currentFile={
        "category": item["category"],
        "relativePath": item["relativePath"],
        "name": item["name"],
        "size": item["size"],
        "bytesRead": 0,
      },
    )

  candidates = [
    candidate
    for same_size in by_size.values()
    if len(same_size) >= 2
    for candidate in same_size
  ]
  total_files_to_hash = len(candidates)
  total_bytes_to_hash = sum(int(item["size"]) for item in candidates)
  _report_progress(
    progress_callback,
    phase="hashing",
    scannedFiles=scanned,
    totalFilesToHash=total_files_to_hash,
    totalBytesToHash=total_bytes_to_hash,
    hashedFiles=0,
    hashedBytes=0,
    failedFiles=0,
    currentFile=None,
  )

  groups: list[dict[str, Any]] = []
  hashed_files = 0
  hashed_bytes = 0
  failed_files = 0
  for size, candidates in by_size.items():
    if len(candidates) < 2:
      continue
    by_hash: dict[str, list[dict[str, Any]]] = {}
    for candidate in candidates:
      _raise_if_cancelled(cancel_callback)
      hashed_files += 1
      current_file = {
        "category": candidate["category"],
        "relativePath": candidate["relativePath"],
        "name": candidate["name"],
        "size": candidate["size"],
        "bytesRead": 0,
      }
      _report_progress(
        progress_callback,
        phase="hashing",
        hashedFiles=hashed_files - 1,
        hashedBytes=hashed_bytes,
        failedFiles=failed_files,
        currentFile=current_file,
      )

      def file_progress(byte_count: int) -> None:
        nonlocal hashed_bytes
        hashed_bytes += byte_count
        current_file["bytesRead"] = int(current_file["bytesRead"]) + byte_count
        _report_progress(
          progress_callback,
          phase="hashing",
          hashedFiles=hashed_files - 1,
          hashedBytes=hashed_bytes,
          failedFiles=failed_files,
          currentFile=current_file,
        )

      try:
        digest = _sha256(
          candidate["absolutePath"],
          progress_callback=file_progress,
          cancel_callback=cancel_callback,
        )
      except OSError:
        failed_files += 1
        _report_progress(
          progress_callback,
          phase="hashing",
          hashedFiles=hashed_files,
          hashedBytes=hashed_bytes,
          failedFiles=failed_files,
          currentFile=current_file,
        )
        continue
      by_hash.setdefault(digest, []).append(candidate)
      _report_progress(
        progress_callback,
        phase="hashing",
        hashedFiles=hashed_files,
        hashedBytes=hashed_bytes,
        failedFiles=failed_files,
        currentFile=current_file,
      )
    for digest, matches in by_hash.items():
      if len(matches) < 2:
        continue
      matches.sort(
        key=lambda item: (
          item["category"].casefold(),
          item["relativePath"].casefold(),
        )
      )
      groups.append(
        {
          "sha256": digest,
          "size": size,
          "items": matches,
        }
      )
  groups.sort(
    key=lambda group: (
      -int(group["size"]) * (len(group["items"]) - 1),
      group["sha256"],
    )
  )
  reclaimable = sum(
    int(group["size"]) * (len(group["items"]) - 1)
    for group in groups
  )
  _report_progress(
    progress_callback,
    phase="finalizing",
    hashedFiles=hashed_files,
    hashedBytes=hashed_bytes,
    failedFiles=failed_files,
    currentFile=None,
  )
  return {
    "groups": groups,
    "groupCount": len(groups),
    "fileCount": sum(len(group["items"]) for group in groups),
    "reclaimableBytes": reclaimable,
    "scannedFiles": scanned,
    "hashedFiles": hashed_files,
    "hashedBytes": hashed_bytes,
    "failedFiles": failed_files,
  }


class _SHFILEOPSTRUCTW(ctypes.Structure):
  _fields_ = [
    ("hwnd", ctypes.c_void_p),
    ("wFunc", ctypes.c_uint),
    ("pFrom", ctypes.c_wchar_p),
    ("pTo", ctypes.c_wchar_p),
    ("fFlags", ctypes.c_ushort),
    ("fAnyOperationsAborted", ctypes.c_int),
    ("hNameMappings", ctypes.c_void_p),
    ("lpszProgressTitle", ctypes.c_wchar_p),
  ]


def recycle_bin_paths(paths: list[str]) -> None:
  if os.name != "nt":
    raise RecycleBinError("当前系统不支持 Windows 回收站操作")
  if not paths:
    return
  operation = _SHFILEOPSTRUCTW()
  operation.wFunc = 3  # FO_DELETE
  operation.pFrom = "\0".join(os.path.abspath(path) for path in paths) + "\0\0"
  operation.pTo = None
  operation.fFlags = (
    FOF_ALLOWUNDO
    | FOF_NOCONFIRMATION
    | FOF_NOERRORUI
    | FOF_SILENT
  )
  shell32 = ctypes.windll.shell32
  shell32.SHFileOperationW.argtypes = [
    ctypes.POINTER(_SHFILEOPSTRUCTW)
  ]
  shell32.SHFileOperationW.restype = ctypes.c_int
  result = shell32.SHFileOperationW(ctypes.byref(operation))
  if result != 0:
    raise RecycleBinError(f"Windows 回收站操作失败，错误码 {result}")
  if operation.fAnyOperationsAborted:
    raise RecycleBinError("用户或系统取消了回收站操作")


def _selected_model_files(
  categories: list[dict[str, Any]],
  category_name: str,
  items: Any,
) -> list[dict[str, Any]]:
  if not isinstance(items, list) or not items:
    raise ModelPathError("请至少选择一个模型")
  selected: list[dict[str, Any]] = []
  seen: set[tuple[int, str]] = set()
  for raw_item in items:
    if not isinstance(raw_item, dict):
      raise ModelPathError("模型选择项格式错误")
    relative_path = normalize_relative_path(
      str(raw_item.get("relativePath", "")),
    )
    try:
      root_index = int(raw_item.get("rootIndex"))
    except (TypeError, ValueError) as error:
      raise ModelPathError("模型根目录索引无效") from error
    key = (root_index, relative_path.casefold())
    if key in seen:
      continue
    seen.add(key)
    category, root, target = resolve_model_path(
      categories,
      category_name,
      root_index,
      relative_path,
      expect="file",
    )
    allowed_extensions = {
      str(extension).casefold()
      for extension in category.get("extensions", [])
      if str(extension).strip()
    }
    extension = os.path.splitext(target)[1].casefold()
    if allowed_extensions and extension not in allowed_extensions:
      raise ModelPathError(
        f"所选文件不是“{category_name}”分类支持的模型文件"
      )
    if os.path.islink(target):
      raise ModelPathError("出于安全考虑，不操作符号链接模型")
    selected.append(
      {
        "rootIndex": root_index,
        "rootPath": root["path"],
        "relativePath": relative_path,
        "absolutePath": target,
        "name": os.path.basename(target),
      }
    )
  if not selected:
    raise ModelPathError("请至少选择一个模型")
  return selected


def move_model_files(
  categories: list[dict[str, Any]],
  category_name: str,
  items: Any,
  target_root_index: int,
  target_relative_path: str,
  *,
  move_function: Any = None,
) -> dict[str, Any]:
  selected = _selected_model_files(categories, category_name, items)
  _category_data, target_root, target_directory = resolve_model_path(
    categories,
    category_name,
    target_root_index,
    target_relative_path,
    expect="directory",
  )
  if os.path.islink(target_directory):
    raise ModelPathError("出于安全考虑，不移动到符号链接目录")

  destinations: set[str] = set()
  operations: list[tuple[dict[str, Any], str]] = []
  for item in selected:
    if os.path.normcase(
      os.path.realpath(os.path.dirname(item["absolutePath"]))
    ) == os.path.normcase(os.path.realpath(target_directory)):
      raise ModelPathError("模型已经位于目标目录中")
    destination = os.path.join(target_directory, item["name"])
    destination_key = os.path.normcase(os.path.abspath(destination))
    if destination_key in destinations:
      raise FileExistsError("多个模型移动后会重名，请分批移动")
    if os.path.lexists(destination):
      raise FileExistsError(f"目标目录中已存在同名文件：{item['name']}")
    if not _path_inside(target_root["path"], destination):
      raise ModelPathError("模型目标路径不在配置的根目录内")
    destinations.add(destination_key)
    operations.append((item, destination))

  move = move_function or shutil.move
  moved: list[tuple[str, str]] = []
  try:
    for item, destination in operations:
      move(item["absolutePath"], destination)
      moved.append((item["absolutePath"], destination))
  except Exception:
    for source, destination in reversed(moved):
      try:
        move(destination, source)
      except Exception:
        pass
    raise

  return {
    "ok": True,
    "category": category_name,
    "targetRootIndex": int(target_root_index),
    "targetPath": normalize_relative_path(
      target_relative_path,
      allow_empty=True,
    ),
    "items": [
      {
        **item,
        "destination": destination,
      }
      for item, destination in operations
    ],
    "count": len(operations),
  }


def recycle_model_files(
  categories: list[dict[str, Any]],
  category_name: str,
  items: Any,
  *,
  confirm: bool,
  recycle_function: Any = None,
) -> dict[str, Any]:
  if confirm is not True:
    raise PermissionError("删除模型前必须明确确认")
  selected = _selected_model_files(categories, category_name, items)
  recycle = recycle_function or recycle_bin_paths
  recycle([item["absolutePath"] for item in selected])
  return {
    "ok": True,
    "category": category_name,
    "items": selected,
    "count": len(selected),
    "recycled": True,
  }


def recycle_model_file(
  categories: list[dict[str, Any]],
  category_name: str,
  root_index: int,
  relative_path: str,
  *,
  confirm: bool,
  recycle_function: Any = None,
) -> dict[str, Any]:
  result = recycle_model_files(
    categories,
    category_name,
    [{"rootIndex": root_index, "relativePath": relative_path}],
    confirm=confirm,
    recycle_function=recycle_function,
  )
  item = result["items"][0]
  return {
    "ok": True,
    "category": category_name,
    "rootIndex": int(root_index),
    "relativePath": normalize_relative_path(relative_path),
    "absolutePath": item["absolutePath"],
    "recycled": True,
  }
