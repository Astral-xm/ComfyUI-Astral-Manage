from __future__ import annotations

import json
import hashlib
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import unquote, urlparse

from PIL import Image, ImageOps, UnidentifiedImageError


IMAGE_EXTENSIONS = {
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".avif",
  ".tif",
  ".tiff",
}
VIDEO_EXTENSIONS = {
  ".mp4",
  ".webm",
  ".mov",
  ".mkv",
  ".avi",
  ".m4v",
  ".mpeg",
  ".mpg",
}
AUDIO_EXTENSIONS = {
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".wma",
}
MEDIA_EXTENSIONS = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS | AUDIO_EXTENSIONS
SKIPPED_DIRECTORIES = {".git", "node_modules", "__pycache__"}
WORKFLOW_LIMIT = 16 * 1024 * 1024
MAX_ASSET_BATCH_ITEMS = 500
WINDOWS_RESERVED_NAMES = {
  "CON",
  "PRN",
  "AUX",
  "NUL",
  *(f"COM{index}" for index in range(1, 10)),
  *(f"LPT{index}" for index in range(1, 10)),
}
_WINDOWS_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class AssetPathError(ValueError):
  pass


def _path_inside(directory: str, target: str) -> bool:
  try:
    directory = os.path.normcase(os.path.realpath(directory))
    target = os.path.normcase(os.path.realpath(target))
    return os.path.commonpath((directory, target)) == directory
  except ValueError:
    return False


def normalize_relative_path(value: str) -> str:
  value = str(value or "").replace("\\", "/").strip()
  if not value or value.startswith("/") or "\x00" in value:
    raise AssetPathError("素材路径为空或不是相对路径")
  if re.match(r"^[A-Za-z]:", value):
    raise AssetPathError("素材路径必须是 input/output 内的相对路径")
  parts = [part for part in value.split("/") if part not in ("", ".")]
  if not parts or any(part == ".." for part in parts):
    raise AssetPathError("素材路径不能越过 input/output 目录")
  return "/".join(parts)


def resolve_asset_path(
  root: str,
  relative_path: str,
  input_root: str,
  output_root: str,
) -> str:
  roots = {"input": input_root, "output": output_root}
  if root not in roots:
    raise AssetPathError("素材根目录必须是 input 或 output")
  base = os.path.realpath(roots[root])
  relative_path = normalize_relative_path(relative_path)
  target = os.path.realpath(os.path.join(base, *relative_path.split("/")))
  if not _path_inside(base, target):
    raise AssetPathError("素材路径不在允许的目录内")
  if not os.path.isfile(target):
    raise FileNotFoundError("素材文件不存在")
  if media_kind(target) is None:
    raise AssetPathError("只允许访问图片或视频素材")
  return target


def resolve_asset_directory(
  root: str,
  relative_path: str,
  input_root: str,
  output_root: str,
) -> str:
  roots = {"input": input_root, "output": output_root}
  if root not in roots:
    raise AssetPathError("素材根目录必须是 input 或 output")
  base = os.path.realpath(roots[root])
  normalized = str(relative_path or "").replace("\\", "/").strip()
  if normalized:
    normalized = normalize_relative_path(normalized)
    target = os.path.realpath(os.path.join(base, *normalized.split("/")))
  else:
    target = os.path.realpath(base)
  if not _path_inside(base, target):
    raise AssetPathError("素材目录不在允许的目录内")
  if not os.path.isdir(target):
    raise FileNotFoundError("素材目录不存在")
  return target


def resolve_workspace_directory(
  root: str,
  relative_path: str,
  roots: dict[str, str],
) -> str:
  if root not in roots:
    raise AssetPathError("工作区目录不在允许范围内")
  base = os.path.abspath(roots[root])
  normalized = str(relative_path or "").replace("\\", "/").strip()
  if normalized:
    normalized = normalize_relative_path(normalized)
    target = os.path.abspath(os.path.join(base, *normalized.split("/")))
  else:
    target = base
  try:
    inside = os.path.commonpath((base, target)) == base
  except ValueError:
    inside = False
  if not inside:
    raise AssetPathError("工作区目录路径越界")
  if not os.path.isdir(target):
    raise FileNotFoundError("工作区目录不存在")
  return target


def list_workspace_entries(
  root: str,
  relative_path: str,
  roots: dict[str, str],
) -> dict[str, Any]:
  directory = resolve_workspace_directory(root, relative_path, roots)
  normalized = str(relative_path or "").replace("\\", "/").strip().strip("/")
  items: list[dict[str, Any]] = []
  with os.scandir(directory) as entries:
    for entry in entries:
      try:
        is_directory = entry.is_dir()
        if not is_directory and not entry.is_file():
          continue
        stat = entry.stat()
      except (OSError, PermissionError):
        continue
      child_path = f"{normalized}/{entry.name}" if normalized else entry.name
      items.append(
        {
          "name": entry.name,
          "path": child_path,
          "kind": "directory" if is_directory else "file",
          "size": 0 if is_directory else int(stat.st_size),
          "modified": float(stat.st_mtime),
        }
      )
  items.sort(
    key=lambda item: (
      item["kind"] != "directory",
      item["name"].casefold(),
    )
  )
  return {
    "root": root,
    "path": normalized,
    "absolutePath": directory,
    "directoryCount": sum(item["kind"] == "directory" for item in items),
    "fileCount": sum(item["kind"] == "file" for item in items),
    "items": items,
  }


def media_kind(path: str) -> str | None:
  extension = os.path.splitext(path)[1].lower()
  if extension in IMAGE_EXTENSIONS:
    return "image"
  if extension in VIDEO_EXTENSIONS:
    return "video"
  if extension in AUDIO_EXTENSIONS:
    return "audio"
  return None


def media_mime(path: str) -> str:
  mime_type, _ = mimetypes.guess_type(path, strict=False)
  if mime_type and (
    mime_type.startswith("image/") or mime_type.startswith("video/")
    or mime_type.startswith("audio/")
  ):
    return mime_type
  return "application/octet-stream"


def _find_ffmpeg() -> str | None:
  candidates = [
    shutil.which("ffmpeg"),
    os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg.exe"),
  ]
  return next((path for path in candidates if path and os.path.isfile(path)), None)


def create_thumbnail(path: str, cache_directory: str, cache_token: str) -> str:
  os.makedirs(cache_directory, exist_ok=True)
  safe_token = hashlib.sha256(cache_token.encode("utf-8")).hexdigest()
  thumbnail_path = os.path.join(cache_directory, f"{safe_token}.webp")
  if os.path.isfile(thumbnail_path) and os.path.getmtime(thumbnail_path) >= os.path.getmtime(path):
    return thumbnail_path

  kind = media_kind(path)
  if kind == "image":
    with Image.open(path) as image:
      image.seek(0)
      image = ImageOps.exif_transpose(image)
      image.thumbnail((420, 280), Image.Resampling.LANCZOS)
      if image.mode not in {"RGB", "RGBA"}:
        image = image.convert("RGBA")
      image.save(thumbnail_path, "WEBP", quality=82, method=4)
  elif kind == "video":
    ffmpeg = _find_ffmpeg()
    if not ffmpeg:
      raise OSError("未找到 ffmpeg，无法生成视频缩略图")
    process = subprocess.run(
      [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        "0.2",
        "-i",
        path,
        "-frames:v",
        "1",
        "-vf",
        "scale=420:280:force_original_aspect_ratio=decrease,pad=420:280:(ow-iw)/2:(oh-ih)/2",
        "-y",
        thumbnail_path,
      ],
      capture_output=True,
      timeout=25,
      creationflags=_WINDOWS_NO_WINDOW,
    )
    if process.returncode != 0 or not os.path.isfile(thumbnail_path):
      raise OSError("ffmpeg 无法生成视频缩略图")
  else:
    raise AssetPathError("只允许生成图片或视频缩略图")
  return thumbnail_path


def _root_entries(root_name: str, root_path: str) -> Iterable[tuple[str, str, os.stat_result]]:
  if not os.path.isdir(root_path):
    return
  for directory, subdirectories, filenames in os.walk(root_path, followlinks=False):
    subdirectories[:] = [
      name
      for name in subdirectories
      if name not in SKIPPED_DIRECTORIES
      and not os.path.islink(os.path.join(directory, name))
    ]
    if os.path.islink(directory):
      continue
    for filename in filenames:
      full_path = os.path.join(directory, filename)
      if os.path.islink(full_path) or media_kind(full_path) is None:
        continue
      if not _path_inside(root_path, full_path):
        continue
      try:
        stat = os.stat(full_path)
      except OSError:
        continue
      relative_path = os.path.relpath(full_path, root_path).replace("\\", "/")
      yield root_name, relative_path, stat


def asset_entry(root: str, relative_path: str, absolute_path: str, stat: os.stat_result) -> dict[str, Any]:
  return {
    "root": root,
    "path": relative_path,
    "name": os.path.basename(relative_path),
    "absolutePath": os.path.abspath(absolute_path),
    "kind": media_kind(absolute_path),
    "mime": media_mime(absolute_path),
    "size": stat.st_size,
    "modified": stat.st_mtime,
  }


def list_assets(
  input_root: str,
  output_root: str,
  *,
  root_filter: str = "all",
  kind_filter: str = "all",
  relative_path: str = "",
  exact_path: bool = False,
  query: str = "",
  offset: int = 0,
  limit: int = 80,
) -> dict[str, Any]:
  if root_filter not in {"all", "input", "output"}:
    raise AssetPathError("root 必须是 all、input 或 output")
  if kind_filter not in {"all", "image", "video", "audio"}:
    raise AssetPathError("kind 必须是 all、image、video 或 audio")
  offset = max(0, int(offset))
  limit = min(500, max(1, int(limit)))
  query = " ".join(str(query or "").split()).casefold()
  path_prefix = normalize_relative_path(relative_path) if relative_path else ""
  path_prefix_key = path_prefix.casefold()

  roots = {
    "input": input_root,
    "output": output_root,
  }
  selected_roots = roots if root_filter == "all" else {root_filter: roots[root_filter]}
  entries: list[dict[str, Any]] = []
  for root_name, root_path in selected_roots.items():
    for entry_root, relative_path, stat in _root_entries(root_name, root_path):
      if kind_filter != "all" and media_kind(relative_path) != kind_filter:
        continue
      if exact_path:
        parent_path = relative_path.casefold().rpartition("/")[0]
        if parent_path != path_prefix_key:
          continue
      elif path_prefix and not (
        relative_path.casefold() == path_prefix_key
        or relative_path.casefold().startswith(f"{path_prefix_key}/")
      ):
        continue
      if query and query not in relative_path.casefold():
        continue
      absolute_path = os.path.join(root_path, *relative_path.split("/"))
      entries.append(asset_entry(entry_root, relative_path, absolute_path, stat))

  entries.sort(key=lambda item: (-item["modified"], item["root"], item["path"].casefold()))
  total = len(entries)
  page = entries[offset : offset + limit]
  return {
    "items": page,
    "total": total,
    "offset": offset,
    "limit": limit,
    "hasMore": offset + len(page) < total,
  }


def _relative_child(root: str, full_path: str) -> str:
  return os.path.relpath(full_path, root).replace("\\", "/")


def list_asset_tree(
  input_root: str,
  output_root: str,
  *,
  root: str,
  relative_path: str = "",
) -> dict[str, Any]:
  if root not in {"input", "output"}:
    raise AssetPathError("素材根目录必须是 input 或 output")
  roots = {"input": input_root, "output": output_root}
  root_path = os.path.realpath(roots[root])
  target = resolve_asset_directory(
    root,
    relative_path,
    input_root,
    output_root,
  )
  normalized_path = normalize_relative_path(relative_path) if relative_path else ""
  directories: list[dict[str, Any]] = []
  files: list[dict[str, Any]] = []
  try:
    with os.scandir(target) as entries:
      for entry in entries:
        try:
          if entry.is_symlink():
            continue
          relative_child = (
            f"{normalized_path}/{entry.name}" if normalized_path else entry.name
          )
          if entry.is_dir(follow_symlinks=False):
            if entry.name in SKIPPED_DIRECTORIES:
              continue
            child = os.path.join(target, entry.name)
            if not _path_inside(root_path, child):
              continue
            directories.append(
              {
                "name": entry.name,
                "path": relative_child,
                "type": "directory",
              }
            )
          elif entry.is_file(follow_symlinks=False):
            if media_kind(entry.name) is None:
              continue
            child = os.path.join(target, entry.name)
            if not _path_inside(root_path, child):
              continue
            stat = entry.stat(follow_symlinks=False)
            files.append(
              asset_entry(root, relative_child, child, stat)
            )
        except OSError:
          continue
  except OSError as error:
    raise AssetPathError(f"无法读取素材目录：{error}") from error
  directories.sort(key=lambda item: item["name"].casefold())
  files.sort(key=lambda item: item["name"].casefold())
  return {
    "root": root,
    "path": normalized_path,
    "directories": directories,
    "files": files,
  }


def _asset_root_paths(
  input_root: str,
  output_root: str,
) -> dict[str, str]:
  return {
    "input": os.path.realpath(input_root),
    "output": os.path.realpath(output_root),
  }


def _asset_selection(
  items: Any,
  input_root: str,
  output_root: str,
) -> list[dict[str, Any]]:
  if not isinstance(items, list) or not items:
    raise AssetPathError("请至少选择一个素材")
  if len(items) > MAX_ASSET_BATCH_ITEMS:
    raise AssetPathError(f"一次最多操作 {MAX_ASSET_BATCH_ITEMS} 个素材")

  roots = _asset_root_paths(input_root, output_root)
  selected: list[dict[str, Any]] = []
  seen: set[tuple[str, str]] = set()
  for raw_item in items:
    if not isinstance(raw_item, dict):
      raise AssetPathError("素材选择项格式错误")
    root = str(raw_item.get("root", "")).strip()
    raw_path = str(raw_item.get("path", ""))
    relative_path = normalize_relative_path(raw_path)
    absolute_path = resolve_asset_path(
      root,
      relative_path,
      input_root,
      output_root,
    )
    key = (root, os.path.normcase(absolute_path))
    if key in seen:
      continue
    seen.add(key)
    parent_path = relative_path.rpartition("/")[0]
    selected.append(
      {
        "root": root,
        "path": relative_path,
        "name": os.path.basename(relative_path),
        "parentPath": parent_path,
        "absolutePath": absolute_path,
        "rootPath": roots[root],
      }
    )
  if not selected:
    raise AssetPathError("请至少选择一个素材")
  return selected


def _validate_file_name(value: Any, *, label: str = "文件名") -> str:
  name = str(value or "").strip()
  if not name or name in {".", ".."}:
    raise AssetPathError(f"{label}不能为空")
  if "/" in name or "\\" in name:
    raise AssetPathError(f"{label}不能包含路径分隔符")
  if any(ord(character) < 32 for character in name):
    raise AssetPathError(f"{label}不能包含控制字符")
  if any(character in '<>:"|?*' for character in name):
    raise AssetPathError(f'{label}不能包含 < > : " | ? *')
  if name.endswith((" ", ".")):
    raise AssetPathError(f"{label}不能以空格或句点结尾")
  stem = os.path.splitext(name)[0]
  if stem.upper() in WINDOWS_RESERVED_NAMES:
    raise AssetPathError(f"{label}不能使用 Windows 保留名称")
  return name


def _renamed_file_name(original_name: str, requested_name: Any) -> str:
  new_name = _validate_file_name(requested_name, label="新文件名")
  original_extension = os.path.splitext(original_name)[1]
  requested_extension = os.path.splitext(new_name)[1]
  if requested_extension:
    if requested_extension.casefold() != original_extension.casefold():
      raise AssetPathError("重命名不能修改文件扩展名")
  else:
    new_name = f"{new_name}{original_extension}"
  return _validate_file_name(new_name, label="新文件名")


def _temporary_sibling_path(path: str) -> str:
  directory = os.path.dirname(path)
  extension = os.path.splitext(path)[1]
  while True:
    candidate = os.path.join(
      directory,
      f".assets-astral-{uuid.uuid4().hex}{extension}",
    )
    if not os.path.lexists(candidate):
      return candidate


def _execute_two_phase_file_moves(
  operations: list[tuple[dict[str, Any], str, str]],
  move_function: Any,
) -> None:
  prepared: list[tuple[dict[str, Any], str, str, str]] = []
  completed: list[tuple[dict[str, Any], str, str, str]] = []
  try:
    for item, source, destination in operations:
      if source == destination:
        continue
      temporary = _temporary_sibling_path(source)
      os.replace(source, temporary)
      prepared.append((item, source, temporary, destination))
    for item, source, temporary, destination in prepared:
      move_function(temporary, destination)
      completed.append((item, source, temporary, destination))
  except Exception:
    for _item, _source, temporary, destination in reversed(completed):
      try:
        if os.path.lexists(destination):
          move_function(destination, temporary)
      except OSError:
        pass
    for _item, source, temporary, _destination in reversed(prepared):
      try:
        if os.path.lexists(temporary):
          os.replace(temporary, source)
      except OSError:
        pass
    raise


def rename_asset_files(
  input_root: str,
  output_root: str,
  items: Any,
  *,
  mode: str,
  new_name: str = "",
  prefix: str = "",
  start: int = 1,
) -> dict[str, Any]:
  selected = _asset_selection(items, input_root, output_root)
  if mode == "single" and len(selected) != 1:
    raise AssetPathError("单个重命名只能选择一个素材")
  if mode == "prefix" and not selected:
    raise AssetPathError("请至少选择一个图片")
  if mode not in {"single", "prefix"}:
    raise AssetPathError("不支持的批量重命名模式")

  try:
    sequence = int(start)
  except (TypeError, ValueError) as error:
    raise AssetPathError("批量重命名起始序号无效") from error
  if sequence < 1:
    raise AssetPathError("批量重命名起始序号必须大于 0")

  normalized_prefix = (
    _validate_file_name(prefix, label="文件名前缀")
    if mode == "prefix"
    else ""
  )
  operations: list[tuple[dict[str, Any], str, str]] = []
  destination_keys: set[str] = set()
  source_keys = {
    os.path.normcase(item["absolutePath"])
    for item in selected
  }
  results: list[dict[str, Any]] = []
  for index, item in enumerate(selected):
    if mode == "prefix":
      extension = os.path.splitext(item["name"])[1]
      requested_name = f"{normalized_prefix}{sequence + index}{extension}"
      requested_name = _validate_file_name(requested_name, label="新文件名")
    else:
      requested_name = _renamed_file_name(item["name"], new_name)
    relative_path = (
      f"{item['parentPath']}/{requested_name}"
      if item["parentPath"]
      else requested_name
    )
    destination = os.path.realpath(
      os.path.join(item["rootPath"], *relative_path.split("/"))
    )
    if not _path_inside(item["rootPath"], destination):
      raise AssetPathError("重命名目标不在允许的目录内")
    destination_key = os.path.normcase(destination)
    if destination_key in destination_keys:
      raise AssetPathError("批量重命名产生了重复文件名")
    destination_keys.add(destination_key)
    if (
      os.path.lexists(destination)
      and destination_key not in source_keys
    ):
      raise FileExistsError(f"目标文件已存在：{requested_name}")
    operations.append((item, item["absolutePath"], destination))
    results.append(
      {
        "root": item["root"],
        "oldPath": item["path"],
        "path": relative_path,
        "name": requested_name,
        "absolutePath": destination,
      }
    )

  _execute_two_phase_file_moves(operations, os.replace)
  return {
    "ok": True,
    "operation": "rename",
    "count": len(results),
    "items": results,
  }


def recycle_asset_files(
  input_root: str,
  output_root: str,
  items: Any,
  *,
  confirm: bool,
  recycle_function: Any = None,
) -> dict[str, Any]:
  if confirm is not True:
    raise PermissionError("删除素材前必须明确确认")
  selected = _asset_selection(items, input_root, output_root)
  recycle = recycle_function
  if recycle is None:
    raise RuntimeError("未配置系统回收站操作")
  recycle([item["absolutePath"] for item in selected])
  return {
    "ok": True,
    "operation": "recycle",
    "count": len(selected),
    "items": [
      {
        "root": item["root"],
        "path": item["path"],
        "absolutePath": item["absolutePath"],
      }
      for item in selected
    ],
    "recycled": True,
  }


def resolve_asset_open_target(
  root: str,
  relative_path: str,
  input_root: str,
  output_root: str,
  *,
  select: bool,
) -> tuple[str, str]:
  if relative_path:
    if select:
      return (
        resolve_asset_path(
          root,
          relative_path,
          input_root,
          output_root,
        ),
        "file",
      )
    return (
      resolve_asset_directory(
        root,
        relative_path,
        input_root,
        output_root,
      ),
      "directory",
    )
  return (
    resolve_asset_directory(root, "", input_root, output_root),
    "directory",
  )


def _windows_path_aliases(path: str) -> set[str]:
  aliases = {
    os.path.normcase(os.path.normpath(os.path.abspath(path))),
    os.path.normcase(os.path.normpath(os.path.realpath(path))),
  }
  return {alias.rstrip("\\/") or alias for alias in aliases}


def _explorer_location_matches(location_url: str, directory: str) -> bool:
  if not location_url:
    return False
  parsed = urlparse(location_url)
  if parsed.scheme.lower() != "file":
    return False
  location = unquote(parsed.path)
  if re.match(r"^/[A-Za-z]:", location):
    location = location[1:]
  location = location.replace("/", "\\")
  if parsed.netloc:
    location = f"//{parsed.netloc}{location}"
  return bool(_windows_path_aliases(location) & _windows_path_aliases(directory))


def _activate_windows_window(hwnd: int) -> bool:
  try:
    import ctypes
    from ctypes import wintypes
  except ImportError:
    return False

  user32 = ctypes.WinDLL("user32", use_last_error=True)
  kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
  user32.GetForegroundWindow.restype = wintypes.HWND
  user32.GetWindowThreadProcessId.argtypes = (
    wintypes.HWND,
    ctypes.POINTER(wintypes.DWORD),
  )
  user32.GetWindowThreadProcessId.restype = wintypes.DWORD
  user32.AttachThreadInput.argtypes = (
    wintypes.DWORD,
    wintypes.DWORD,
    wintypes.BOOL,
  )
  user32.AttachThreadInput.restype = wintypes.BOOL
  user32.ShowWindowAsync.argtypes = (wintypes.HWND, ctypes.c_int)
  user32.ShowWindowAsync.restype = wintypes.BOOL
  user32.BringWindowToTop.argtypes = (wintypes.HWND,)
  user32.BringWindowToTop.restype = wintypes.BOOL
  user32.SetForegroundWindow.argtypes = (wintypes.HWND,)
  user32.SetForegroundWindow.restype = wintypes.BOOL
  user32.SetFocus.argtypes = (wintypes.HWND,)
  user32.SetFocus.restype = wintypes.HWND
  kernel32.GetCurrentThreadId.restype = wintypes.DWORD

  target = wintypes.HWND(hwnd)
  user32.ShowWindowAsync(target, 9 if user32.IsIconic(target) else 5)
  if user32.SetForegroundWindow(target):
    return True

  foreground = user32.GetForegroundWindow()
  current_thread = kernel32.GetCurrentThreadId()
  target_thread = user32.GetWindowThreadProcessId(target, None)
  foreground_thread = (
    user32.GetWindowThreadProcessId(foreground, None)
    if foreground
    else 0
  )
  attached: list[tuple[int, int]] = []
  for other_thread in (foreground_thread, current_thread):
    if (
      target_thread
      and other_thread
      and other_thread != target_thread
      and all(
        (other_thread, attached_thread) not in attached
        for attached_thread in (target_thread,)
      )
    ):
      if user32.AttachThreadInput(other_thread, target_thread, True):
        attached.append((other_thread, target_thread))
  try:
    user32.BringWindowToTop(target)
    user32.SetForegroundWindow(target)
    user32.SetFocus(target)
  finally:
    for source_thread, attached_thread in attached:
      user32.AttachThreadInput(source_thread, attached_thread, False)

  if user32.GetForegroundWindow() == target:
    return True
  try:
    user32.SwitchToThisWindow.argtypes = (wintypes.HWND, wintypes.BOOL)
    user32.SwitchToThisWindow(target, True)
  except (AttributeError, OSError):
    pass
  return user32.GetForegroundWindow() == target


def _focus_windows_explorer(directory: str, timeout: float = 1.5) -> bool:
  try:
    import pythoncom
    import win32com.client
  except ImportError:
    return False

  initialized = False
  try:
    pythoncom.CoInitialize()
    initialized = True
    shell = win32com.client.Dispatch("Shell.Application")
    deadline = time.monotonic() + max(0.0, timeout)
    while True:
      try:
        windows = shell.Windows()
        for index in range(windows.Count):
          try:
            window = windows.Item(index)
            if not _explorer_location_matches(
              str(window.LocationURL or ""),
              directory,
            ):
              continue
            hwnd = int(window.HWND)
            if hwnd and _activate_windows_window(hwnd):
              return True
          except Exception:
            continue
      except Exception:
        pass
      if time.monotonic() >= deadline:
        return False
      time.sleep(0.05)
  except Exception:
    return False
  finally:
    if initialized:
      try:
        pythoncom.CoUninitialize()
      except Exception:
        pass


def _activate_macos_finder(timeout: float = 2.0) -> bool:
  osascript = shutil.which("osascript")
  if not osascript:
    return False
  try:
    process = subprocess.run(
      [osascript, "-e", 'tell application "Finder" to activate'],
      stdout=subprocess.DEVNULL,
      stderr=subprocess.DEVNULL,
      timeout=max(0.1, timeout),
      check=False,
    )
  except (OSError, subprocess.SubprocessError):
    return False
  return process.returncode == 0


_LINUX_FILE_MANAGER_CLASS_HINTS = (
  "nautilus",
  "org.gnome.files",
  "dolphin",
  "nemo",
  "thunar",
  "pcmanfm",
  "caja",
  "filemanager",
)


def _linux_window_title_score(title: str, target: str) -> int:
  title_folded = unquote(title).casefold()
  if not title_folded:
    return 0
  absolute_target = Path(os.path.abspath(target))
  score = 0
  if absolute_target.is_dir():
    names = (absolute_target.name,)
  else:
    names = (absolute_target.parent.name, absolute_target.name)
  for index, name in enumerate(names):
    if name and name.casefold() in title_folded:
      score += 20 if index == 0 else 10
  return score


def _is_linux_file_manager_class(wm_class: str) -> bool:
  normalized = wm_class.casefold()
  return any(hint in normalized for hint in _LINUX_FILE_MANAGER_CLASS_HINTS)


def _activate_linux_file_manager_window(
  target: str,
  timeout: float = 1.5,
) -> bool:
  wmctrl = shutil.which("wmctrl")
  xdotool = shutil.which("xdotool")
  if not wmctrl and not xdotool:
    return False

  deadline = time.monotonic() + max(0.0, timeout)
  while True:
    if wmctrl:
      try:
        listing = subprocess.run(
          [wmctrl, "-l", "-x"],
          capture_output=True,
          text=True,
          errors="replace",
          timeout=2,
          check=False,
        )
      except (OSError, subprocess.SubprocessError):
        listing = None
      if listing and listing.returncode == 0:
        candidates: list[tuple[int, str]] = []
        for line in listing.stdout.splitlines():
          match = re.match(
            r"^\s*(\S+)\s+\S+\s+(\S+)\s+\S+\s+(.*)$",
            line,
          )
          if not match:
            continue
          window_id, wm_class, title = match.groups()
          if not _is_linux_file_manager_class(wm_class):
            continue
          score = _linux_window_title_score(title, target)
          if score:
            candidates.append((score, window_id))
        for _, window_id in sorted(candidates, reverse=True):
          try:
            activated = subprocess.run(
              [wmctrl, "-i", "-a", window_id],
              stdout=subprocess.DEVNULL,
              stderr=subprocess.DEVNULL,
              timeout=2,
              check=False,
            )
          except (OSError, subprocess.SubprocessError):
            continue
          if activated.returncode == 0:
            return True

    if xdotool:
      absolute_target = Path(os.path.abspath(target))
      title_hints = (
        (absolute_target.name,)
        if absolute_target.is_dir()
        else (
          absolute_target.parent.name,
          absolute_target.name,
        )
      )
      for title_hint in title_hints:
        if not title_hint:
          continue
        try:
          found = subprocess.run(
            [
              xdotool,
              "search",
              "--onlyvisible",
              "--name",
              re.escape(title_hint),
            ],
            capture_output=True,
            text=True,
            errors="replace",
            timeout=2,
            check=False,
          )
        except (OSError, subprocess.SubprocessError):
          continue
        if found.returncode != 0:
          continue
        for window_id in found.stdout.splitlines():
          window_id = window_id.strip()
          if not window_id:
            continue
          try:
            window_class = subprocess.run(
              [xdotool, "getwindowclassname", window_id],
              capture_output=True,
              text=True,
              errors="replace",
              timeout=2,
              check=False,
            )
          except (OSError, subprocess.SubprocessError):
            continue
          if (
            window_class.returncode != 0
            or not _is_linux_file_manager_class(
              window_class.stdout.strip()
            )
          ):
            continue
          try:
            activated = subprocess.run(
              [xdotool, "windowactivate", "--sync", window_id],
              stdout=subprocess.DEVNULL,
              stderr=subprocess.DEVNULL,
              timeout=2,
              check=False,
            )
          except (OSError, subprocess.SubprocessError):
            continue
          if activated.returncode == 0:
            return True

    if time.monotonic() >= deadline:
      return False
    time.sleep(0.1)


def _try_linux_file_selection(target: str) -> bool:
  file_uri = Path(os.path.abspath(target)).as_uri()
  commands: list[list[str]] = []
  gdbus = shutil.which("gdbus")
  if gdbus:
    commands.append(
      [
        gdbus,
        "call",
        "--session",
        "--dest",
        "org.freedesktop.FileManager1",
        "--object-path",
        "/org/freedesktop/FileManager1",
        "--method",
        "org.freedesktop.FileManager1.ShowItems",
        f"['{file_uri}']",
        "''",
      ]
    )
  dbus_send = shutil.which("dbus-send")
  if dbus_send:
    commands.append(
      [
        dbus_send,
        "--session",
        "--dest=org.freedesktop.FileManager1",
        "--type=method_call",
        "/org/freedesktop/FileManager1",
        "org.freedesktop.FileManager1.ShowItems",
        f"array:string:{file_uri}",
        "string:",
      ]
    )
  for command in commands:
    try:
      process = subprocess.run(
        command,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=2,
        check=False,
      )
    except (OSError, subprocess.SubprocessError):
      continue
    if process.returncode == 0:
      return True
  return False


def _open_linux_directory(target: str) -> None:
  opener = shutil.which("xdg-open")
  if not opener:
    raise FileNotFoundError(
      "系统缺少 xdg-open，无法打开文件管理器；请安装 xdg-utils"
    )
  subprocess.Popen(
    [opener, os.path.abspath(target)],
    close_fds=True,
  )


def open_asset_target(target: str, kind: str) -> str:
  absolute_target = os.path.abspath(target)
  if sys.platform == "win32":
    if kind == "file":
      subprocess.Popen(
        ["explorer.exe", f"/select,{absolute_target}"],
        close_fds=True,
      )
      directory = os.path.dirname(absolute_target)
      _focus_windows_explorer(directory)
    else:
      os.startfile(absolute_target)
      directory = absolute_target
      _focus_windows_explorer(directory)
    return "selected" if kind == "file" else "opened"
  if sys.platform == "darwin":
    opener = shutil.which("open")
    if not opener:
      raise FileNotFoundError(
        "系统缺少 open 命令，无法打开 Finder"
      )
    arguments = ["-R", absolute_target] if kind == "file" else [absolute_target]
    subprocess.Popen(
      [opener, *arguments],
      close_fds=True,
    )
    _activate_macos_finder()
    return "selected" if kind == "file" else "opened"
  if kind == "file" and _try_linux_file_selection(absolute_target):
    _activate_linux_file_manager_window(absolute_target)
    return "selected"
  fallback = os.path.dirname(absolute_target) if kind == "file" else absolute_target
  _open_linux_directory(fallback)
  _activate_linux_file_manager_window(fallback)
  return "parent-opened" if kind == "file" else "opened"


def _decode_bytes(value: bytes) -> str:
  for encoding in ("utf-8", "utf-16-le", "latin-1"):
    try:
      return value.decode(encoding).strip("\x00 \r\n\t")
    except UnicodeDecodeError:
      continue
  return ""


def _decode_metadata_value(value: Any) -> Any:
  if isinstance(value, bytes):
    value = _decode_bytes(value)
  if not isinstance(value, str):
    return value
  value = value.strip()
  if not value:
    return ""
  if value.startswith("\ufeff"):
    value = value.lstrip("\ufeff")
  if value[:1] in {"{", "["}:
    try:
      return json.loads(value)
    except json.JSONDecodeError:
      return value
  return value


def _merge_tag_payload(target: dict[str, Any], payload: Any) -> None:
  payload = _decode_metadata_value(payload)
  if not isinstance(payload, dict):
    return
  for key in ("prompt", "workflow", "parameters"):
    if key in payload and payload[key] not in (None, ""):
      target.setdefault(key, payload[key])
  if "nodes" in payload and "workflow" not in target:
    target["workflow"] = payload


def _read_image_metadata(path: str) -> tuple[dict[str, Any], dict[str, Any]]:
  metadata: dict[str, Any] = {}
  properties: dict[str, Any] = {}
  with Image.open(path) as image:
    properties["width"], properties["height"] = image.size
    properties["format"] = image.format
    for key in ("prompt", "workflow", "parameters", "Comment", "comment"):
      if key in image.info:
        metadata[key] = _decode_metadata_value(image.info[key])
    exif = image.getexif()
    if exif:
      for tag in (0x9286, 0x9C9C):
        value = exif.get(tag)
        if value not in (None, ""):
          decoded = _decode_metadata_value(value)
          if isinstance(decoded, str) and decoded.startswith("ASCII"):
            decoded = decoded[8:]
          if isinstance(decoded, str) and decoded.startswith("UNICODE"):
            decoded = decoded[8:]
          _merge_tag_payload(metadata, decoded)
          if "parameters" not in metadata and isinstance(decoded, str):
            metadata["parameters"] = decoded
  return metadata, properties


def _find_ffprobe() -> str | None:
  candidates = [
    shutil.which("ffprobe"),
    os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Links\ffprobe.exe"),
  ]
  return next((path for path in candidates if path and os.path.isfile(path)), None)


def _read_video_metadata(path: str) -> tuple[dict[str, Any], dict[str, Any]]:
  ffprobe = _find_ffprobe()
  if not ffprobe:
    return {}, {}
  try:
    process = subprocess.run(
      [
        ffprobe,
        "-v",
        "error",
        "-show_entries",
        "format_tags:stream_tags:stream=width,height,codec_type",
        "-of",
        "json",
        path,
      ],
      capture_output=True,
      text=True,
      encoding="utf-8",
      errors="replace",
      timeout=15,
      creationflags=_WINDOWS_NO_WINDOW,
    )
  except (OSError, subprocess.SubprocessError):
    return {}, {}
  if process.returncode != 0:
    return {}, {}
  try:
    data = json.loads(process.stdout or "{}")
  except json.JSONDecodeError:
    return {}, {}

  metadata: dict[str, Any] = {}
  properties: dict[str, Any] = {}
  format_tags = data.get("format", {}).get("tags", {})
  for key, value in format_tags.items():
    normalized_key = str(key).lower()
    decoded = _decode_metadata_value(value)
    if normalized_key in {"prompt", "workflow", "parameters"}:
      metadata[normalized_key] = decoded
    else:
      _merge_tag_payload(metadata, decoded)
    if normalized_key == "comment" and isinstance(decoded, str):
      metadata.setdefault("parameters", decoded)

  for stream in data.get("streams", []):
    for key, value in stream.get("tags", {}).items():
      _merge_tag_payload(metadata, value)
    if stream.get("codec_type") == "video" and "width" not in properties:
      properties["width"] = stream.get("width")
      properties["height"] = stream.get("height")
  return metadata, properties


def _read_sidecar(path: str) -> tuple[dict[str, Any], list[str]]:
  stem, _ = os.path.splitext(path)
  candidates = [
    f"{path}.json",
    f"{path}.workflow.json",
    f"{stem}.workflow.json",
    f"{stem}.json",
  ]
  found: dict[str, Any] = {}
  names: list[str] = []
  for candidate in dict.fromkeys(candidates):
    if not os.path.isfile(candidate):
      continue
    try:
      if os.path.getsize(candidate) > WORKFLOW_LIMIT:
        continue
      with open(candidate, "r", encoding="utf-8-sig") as handle:
        payload = json.load(handle)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
      continue
    names.append(os.path.basename(candidate))
    if isinstance(payload, dict) and "workflow" in payload:
      _merge_tag_payload(found, payload["workflow"])
      if isinstance(payload.get("prompt"), (dict, str)):
        found.setdefault("prompt", payload["prompt"])
    elif isinstance(payload, dict) and isinstance(payload.get("nodes"), list):
      found.setdefault("workflow", payload)
    elif isinstance(payload, dict):
      found.setdefault("prompt", payload)
  return found, names


def _is_link(value: Any) -> bool:
  return (
    isinstance(value, list)
    and len(value) == 2
    and isinstance(value[0], (str, int))
  )


def _clean_prompt(value: Any) -> str:
  if not isinstance(value, str):
    return ""
  return "\n".join(line.strip() for line in value.replace("\r\n", "\n").split("\n")).strip()


def _dedupe_prompts(values: Iterable[str]) -> list[str]:
  result: list[str] = []
  seen: set[str] = set()
  for value in values:
    value = _clean_prompt(value)
    if not value:
      continue
    key = " ".join(value.split())
    if key in seen:
      continue
    seen.add(key)
    result.append(value)
    if len(result) >= 12:
      break
  return result


def _api_follow(graph: dict[str, Any], value: Any, seen: set[str], depth: int = 0) -> list[str]:
  if depth > 24:
    return []
  if isinstance(value, str):
    return [value] if value.strip() else []
  if not _is_link(value):
    return []
  node_id = str(value[0])
  if node_id in seen:
    return []
  node = graph.get(node_id)
  if not isinstance(node, dict):
    return []
  return _api_node_texts(graph, node, seen | {node_id}, depth + 1)


def _api_node_texts(
  graph: dict[str, Any],
  node: dict[str, Any],
  seen: set[str],
  depth: int = 0,
) -> list[str]:
  if depth > 24:
    return []
  inputs = node.get("inputs")
  if not isinstance(inputs, dict):
    return []

  text_keys = (
    "text_0",
    "text",
    "positive_prompt",
    "user_prompt",
    "text_positive",
    "string",
    "value",
    "prompt",
    "text_g",
    "text_l",
  )
  direct_texts = [
    inputs[key]
    for key in text_keys
    if isinstance(inputs.get(key), str) and inputs[key].strip()
  ]
  # Some helper nodes keep the final executed text in text_0 while ``text``
  # points to the generator prompt. Prefer the recorded literal.
  if direct_texts:
    return direct_texts

  texts: list[str] = []
  for key in text_keys:
    raw = inputs.get(key)
    if _is_link(raw):
      texts.extend(_api_follow(graph, raw, seen, depth + 1))

  link_keys = [
    "conditioning",
    "conditioning_to",
    "conditioning_1",
    "conditioning_2",
    "positive",
    "input",
    "source",
  ]
  class_type = str(node.get("class_type", "")).lower()
  if "switch" in class_type:
    branch_key = "on_true" if inputs.get("switch") else "on_false"
    link_keys.insert(0, branch_key)
  for key in link_keys:
    raw = inputs.get(key)
    if _is_link(raw):
      texts.extend(_api_follow(graph, raw, seen, depth + 1))
  return texts


def _api_graph_prompts(graph: Any) -> list[str]:
  if not isinstance(graph, dict):
    return []
  nodes = {
    str(node_id): node
    for node_id, node in graph.items()
    if isinstance(node, dict)
  }
  prompts: list[str] = []
  for node in nodes.values():
    inputs = node.get("inputs")
    if not isinstance(inputs, dict):
      continue
    positive = inputs.get("positive")
    if _is_link(positive):
      prompts.extend(_api_follow(nodes, positive, set()))
  if not prompts:
    for node in nodes.values():
      class_type = str(node.get("class_type", "")).lower()
      if "textencode" in class_type or class_type in {"string", "primitive string"}:
        inputs = node.get("inputs")
        if isinstance(inputs, dict):
          prompts.extend(_api_node_texts(nodes, node, set()))
  return _dedupe_prompts(prompts)


def _ui_link_source(link_id: Any, links: dict[str, dict[str, Any]]) -> int | None:
  link = links.get(str(link_id))
  if not link:
    return None
  return link.get("origin_id")


def _ui_widget_strings(node: dict[str, Any]) -> list[str]:
  values = node.get("widgets_values")
  result: list[str] = []
  if isinstance(values, str):
    result.append(values)
  elif isinstance(values, dict):
    result.extend(value for value in values.values() if isinstance(value, str))
  elif isinstance(values, list):
    result.extend(value for value in values if isinstance(value, str))
  return _dedupe_prompts(result)


def _ui_node_prompts(
  node: dict[str, Any] | None,
  nodes: dict[str, dict[str, Any]],
  links: dict[str, dict[str, Any]],
  seen: set[str],
  depth: int = 0,
) -> list[str]:
  if not node or depth > 24:
    return []
  node_id = str(node.get("id", ""))
  if node_id in seen:
    return []
  seen = seen | {node_id}
  class_type = str(node.get("type", "")).lower()
  if "textencode" in class_type or "prompt" in class_type or class_type in {
    "string",
    "primitive string",
    "string literal",
  }:
    return _ui_widget_strings(node)

  prompts: list[str] = []
  inputs = node.get("inputs")
  if isinstance(inputs, dict):
    prioritized = [
      item
      for key, item in inputs.items()
      if str(key).lower() in {"conditioning", "positive", "text", "string"}
    ]
  elif isinstance(inputs, list):
    prioritized = [
      item
      for item in inputs
      if isinstance(item, dict)
      and str(item.get("name", "")).lower()
      in {"conditioning", "positive", "text", "string"}
    ]
  else:
    prioritized = []
  for item in prioritized:
    if not isinstance(item, dict):
      continue
    source_id = _ui_link_source(item.get("link"), links)
    if source_id is not None:
      prompts.extend(
        _ui_node_prompts(
          nodes.get(str(source_id)),
          nodes,
          links,
          seen,
          depth + 1,
        )
      )
  return prompts


def _ui_graph_prompts(workflow: Any) -> list[str]:
  if not isinstance(workflow, dict) or not isinstance(workflow.get("nodes"), list):
    return []
  nodes = {
    str(node.get("id")): node
    for node in workflow["nodes"]
    if isinstance(node, dict) and node.get("id") is not None
  }
  links = {
    str(link[0]): {
      "origin_id": link[1],
      "origin_slot": link[2],
      "target_id": link[3],
      "target_slot": link[4],
      "type": link[5] if len(link) > 5 else "",
    }
    for link in workflow.get("links", [])
    if isinstance(link, list) and len(link) >= 5
  }
  prompts: list[str] = []
  for node in nodes.values():
    inputs = node.get("inputs")
    if not isinstance(inputs, list):
      continue
    positive = next(
      (
        item
        for item in inputs
        if isinstance(item, dict) and str(item.get("name", "")).lower() == "positive"
      ),
      None,
    )
    if positive:
      source_id = _ui_link_source(positive.get("link"), links)
      if source_id is not None:
        prompts.extend(
          _ui_node_prompts(nodes.get(str(source_id)), nodes, links, set())
        )
  if not prompts:
    for node in nodes.values():
      class_type = str(node.get("type", "")).lower()
      if "textencode" in class_type or class_type in {"string", "string literal"}:
        prompts.extend(_ui_widget_strings(node))
  return _dedupe_prompts(prompts)


def _parameters_prompt(value: Any) -> str:
  if not isinstance(value, str):
    return ""
  text = value.strip()
  if not text:
    return ""
  return re.split(r"(?im)^\s*negative prompt\s*:", text, maxsplit=1)[0].strip()


def _is_ui_workflow(value: Any) -> bool:
  return isinstance(value, dict) and isinstance(value.get("nodes"), list)


def read_asset_detail(
  root: str,
  relative_path: str,
  input_root: str,
  output_root: str,
) -> dict[str, Any]:
  absolute_path = resolve_asset_path(root, relative_path, input_root, output_root)
  stat = os.stat(absolute_path)
  kind = media_kind(absolute_path)
  if kind is None:
    raise AssetPathError("只允许读取图片、视频或音频素材")
  if kind == "audio":
    return {
      "asset": asset_entry(root, relative_path, absolute_path, stat),
      "properties": {},
      "metadata": {
        "hasPrompt": False,
        "hasWorkflow": False,
        "hasApiPrompt": False,
        "fields": [],
        "sidecars": [],
      },
      "prompt": "",
      "promptCandidates": [],
      "workflow": {
        "available": False,
        "data": None,
      },
    }
  try:
    if kind == "image":
      metadata, properties = _read_image_metadata(absolute_path)
    else:
      metadata, properties = _read_video_metadata(absolute_path)
  except (OSError, UnidentifiedImageError):
    metadata, properties = {}, {}

  sidecar_metadata, sidecars = _read_sidecar(absolute_path)
  for key, value in sidecar_metadata.items():
    metadata.setdefault(key, value)

  prompt_data = metadata.get("prompt")
  workflow_data = metadata.get("workflow")
  candidates = _dedupe_prompts(
    [
      *_api_graph_prompts(prompt_data),
      *_ui_graph_prompts(workflow_data),
      _parameters_prompt(metadata.get("parameters")),
    ]
  )
  loadable_workflow = workflow_data if _is_ui_workflow(workflow_data) else None
  if loadable_workflow is None and _is_ui_workflow(prompt_data):
    loadable_workflow = prompt_data

  return {
    "asset": asset_entry(
      root,
      relative_path,
      absolute_path,
      stat,
    ),
    "properties": properties,
    "metadata": {
      "hasPrompt": bool(candidates),
      "hasWorkflow": loadable_workflow is not None,
      "hasApiPrompt": isinstance(prompt_data, dict) and not _is_ui_workflow(prompt_data),
      "fields": sorted(str(key) for key in metadata),
      "sidecars": sidecars,
    },
    "prompt": "\n\n".join(candidates),
    "promptCandidates": candidates,
    "workflow": {
      "available": loadable_workflow is not None,
      "data": loadable_workflow,
    },
  }


def list_prompt_entries(
  input_root: str,
  output_root: str,
  *,
  query: str = "",
  root_filter: str = "all",
  offset: int = 0,
  limit: int = 80,
) -> dict[str, Any]:
  if root_filter not in {"all", "input", "output"}:
    raise AssetPathError("root 必须是 all、input 或 output")
  query = " ".join(str(query or "").split()).casefold()
  offset = max(0, int(offset))
  limit = min(300, max(1, int(limit)))
  roots = {"input": input_root, "output": output_root}
  selected_roots = (
    roots
    if root_filter == "all"
    else {root_filter: roots[root_filter]}
  )
  assets: list[tuple[str, str, str, os.stat_result]] = []
  for root_name, root_path in selected_roots.items():
    for entry_root, relative_path, stat in _root_entries(root_name, root_path):
      if query and query not in relative_path.casefold():
        continue
      absolute_path = os.path.join(root_path, *relative_path.split("/"))
      assets.append((entry_root, relative_path, absolute_path, stat))
  assets.sort(key=lambda item: (-item[3].st_mtime, item[0], item[1].casefold()))

  entries: list[dict[str, Any]] = []
  scanned_assets = 0
  for root_name, relative_path, absolute_path, stat in assets:
    scanned_assets += 1
    try:
      detail = read_asset_detail(
        root_name,
        relative_path,
        input_root,
        output_root,
      )
    except (AssetPathError, FileNotFoundError, OSError):
      continue
    for index, prompt in enumerate(detail.get("promptCandidates") or []):
      prompt = _clean_prompt(prompt)
      if not prompt:
        continue
      if query and query not in prompt.casefold():
        continue
      entries.append(
        {
          "id": hashlib.sha256(
            f"{root_name}\0{relative_path}\0{index}\0{prompt}".encode("utf-8")
          ).hexdigest()[:20],
          "prompt": prompt,
          "asset": asset_entry(
            root_name,
            relative_path,
            absolute_path,
            stat,
          ),
        }
      )
  entries.sort(
    key=lambda item: (
      -float(item["asset"]["modified"]),
      item["asset"]["root"],
      item["asset"]["path"].casefold(),
      item["id"],
    )
  )
  page = entries[offset : offset + limit]
  return {
    "items": page,
    "total": len(entries),
    "offset": offset,
    "limit": limit,
    "hasMore": offset + len(page) < len(entries),
    "scannedAssets": scanned_assets,
  }
