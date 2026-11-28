from __future__ import annotations

import asyncio
import json
import mimetypes
import os
from typing import Any

import folder_paths
from aiohttp import web
from server import PromptServer

from .asset_library import (
  AssetPathError,
  create_thumbnail,
  list_assets,
  list_asset_tree,
  list_prompt_entries,
  list_workspace_entries,
  media_mime,
  open_asset_target,
  read_asset_detail,
  recycle_asset_files,
  rename_asset_files,
  resolve_asset_path,
  resolve_asset_open_target,
  resolve_workspace_directory,
)
from .chat_service import (
  ChatAPIError,
  ChatCancelled,
  ChatServiceError,
  cancel_chat_request,
  finish_chat_request,
  generate_inspiration_prompt,
  invert_prompt,
  list_api_models,
  optimize_prompt,
  register_chat_request,
  run_chat_turn_async,
  run_local_chat_turn_async,
  run_prompt_task_async,
  run_translation_turn_async,
  translate_text,
)
from .duplicate_scan import DuplicateScanManager
from .local_llm_service import (
  LocalLLMError,
  list_local_llm_models,
  list_local_llm_vision_models,
  load_local_llm_config,
  local_llm_models_root,
  save_local_llm_config,
)
from .lora_source_cache import (
  find_lora_preview,
  load_lora_source_cache,
  persist_lora_source_result,
)
from .model_library import (
  ModelPathError,
  RecycleBinError,
  configured_model_categories,
  list_model_directories,
  list_model_files,
  list_model_tree,
  move_model_files,
  native_model_identifier,
  normalized_model_name_lookup,
  normalize_relative_path,
  recycle_bin_paths,
  recycle_model_file,
  recycle_model_files,
  resolve_missing_model_files,
  resolve_model_path,
  scan_duplicate_models,
)
from .prompt_library import (
  PromptDataError,
  _api_base_url,
  create_conversation,
  create_prompt_category,
  default_data_directory,
  delete_conversation,
  delete_conversation_message,
  delete_prompt_category,
  delete_template,
  get_conversation,
  list_conversations,
  list_templates,
  load_api_config,
  load_api_configuration,
  resolve_api_provider,
  save_api_config,
  save_template,
  update_conversation,
)
from .skill_library import (
  SkillLibraryError,
  default_skill_directories,
  default_skills_directory,
  discover_skills,
  load_skill_text,
  resolve_skill_file,
)
from .skill_tags import (
  SkillTagDataError,
  assign_skill_tags,
  create_skill_tag,
  create_skill_tags,
  create_tag_category,
  create_tag_subcategory,
  delete_skill_tag,
  delete_skill_tags,
  delete_tag_category,
  delete_tag_subcategory,
  get_skill_tag_state,
  move_skill_tags,
  rename_tag_category,
  rename_tag_subcategory,
  reorder_skill_tags,
  update_skill_tag,
)
from .source_resolver import resolve_lora_sources
from .thumbnail_proxy import ThumbnailError, cache_thumbnail


ROUTES = PromptServer.instance.routes
NO_STORE_HEADERS = {"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"}
MAX_BATCH_SOURCE_FILES = 30
MAX_CACHED_SOURCE_FILES = 500
DUPLICATE_SCAN_MANAGER = DuplicateScanManager(scan_duplicate_models)


def _error(message: str, status: int) -> web.Response:
  return web.json_response(
    {"error": message},
    status=status,
    headers=NO_STORE_HEADERS,
  )


async def _resolve_lora_sources_cached(
  file: str,
  full_path: str,
  *,
  refresh: bool,
) -> dict[str, Any]:
  if not refresh:
    cached = await asyncio.to_thread(
      load_lora_source_cache,
      file,
      full_path,
    )
    if cached:
      return cached
  result = await resolve_lora_sources(
    file,
    full_path,
    refresh=refresh,
  )
  try:
    return await asyncio.to_thread(
      persist_lora_source_result,
      file,
      full_path,
      result,
    )
  except Exception as error:
    print(
      "[ComfyUI-Astral-Manage] Unable to persist LoRA source cache for "
      f"{file}: {error}"
    )
    result["cacheWarning"] = (
      "Query succeeded, but the local cache file could not be written"
    )
    return result


@ROUTES.get("/assets-astral/loras/info")
async def get_lora_info(request: web.Request) -> web.Response:
  file = str(request.query.get("file", "")).strip()
  if not file:
    return _error("Missing LoRA file parameter", 400)

  try:
    available_files = await asyncio.to_thread(
      folder_paths.get_filename_list,
      "loras",
    )
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to list LoRAs: {error}")
    return _error("Unable to read the local LoRA list", 500)
  try:
    normalized_file = normalize_relative_path(file)
  except ModelPathError as error:
    return _error(str(error), 400)
  registered_file = normalized_model_name_lookup(available_files).get(
    normalized_file
  )
  if not registered_file:
    return _error("This LoRA file was not found locally", 404)

  file_path = await asyncio.to_thread(
    folder_paths.get_full_path,
    "loras",
    registered_file,
  )
  if not file_path or not os.path.isfile(file_path):
    return _error("The local LoRA file does not exist or cannot be accessed", 404)

  refresh_value = str(request.query.get("refresh", "")).strip().lower()
  refresh = bool(refresh_value) and refresh_value not in {"0", "false", "no"}

  try:
    result = await _resolve_lora_sources_cached(
      normalized_file,
      file_path,
      refresh=refresh,
    )
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unexpected LoRA detail error: {error}")
    return _error("Internal error while fetching LoRA model details", 500)

  sources = result.get("sources", {})
  civitai = sources.get("civitai", {}) if isinstance(sources, dict) else {}
  info = {
    "file": file,
    "name": civitai.get("name") or file,
    "url": civitai.get("url"),
    "sha256": result.get("sha256"),
    "baseModel": civitai.get("baseModel"),
    "recommendedStrength": result.get("recommendedStrength"),
    "recommendedStrengthSource": result.get("recommendedStrengthSource"),
    "triggers": result.get("triggers", []),
    "triggersSource": result.get("triggersSource"),
    "thumbnailUrl": result.get("thumbnailUrl"),
    "thumbnailLocalUrl": result.get("thumbnailLocalUrl"),
    "thumbnailSource": result.get("thumbnailSource"),
    "modelId": civitai.get("modelId"),
    "modelVersionId": civitai.get("modelVersionId"),
    "sources": sources,
    "metadata": result.get("metadata", {}),
    "searchQueries": result.get("searchQueries", []),
    "refreshedAt": result.get("refreshedAt"),
    "cachedAt": result.get("cachedAt"),
    "cache": result.get("cache"),
    "cacheWarning": result.get("cacheWarning"),
  }
  return web.json_response(info, headers=NO_STORE_HEADERS)


@ROUTES.get("/assets-astral/loras/thumbnail")
async def get_lora_thumbnail(request: web.Request) -> web.StreamResponse:
  file = str(request.query.get("file", "")).strip()
  if not file:
    return _error("Missing LoRA file parameter", 400)
  try:
    available_files = await asyncio.to_thread(
      folder_paths.get_filename_list,
      "loras",
    )
    normalized_file = normalize_relative_path(file)
    registered_file = normalized_model_name_lookup(available_files).get(
      normalized_file
    )
    if not registered_file:
      return _error("This LoRA file was not found locally", 404)
    full_path = await asyncio.to_thread(
      folder_paths.get_full_path,
      "loras",
      registered_file,
    )
    if not full_path or not os.path.isfile(full_path):
      return _error("The local LoRA file does not exist or cannot be accessed", 404)
    preview = await asyncio.to_thread(find_lora_preview, full_path)
  except ModelPathError as error:
    return _error(str(error), 400)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to read LoRA thumbnail: {error}")
    return _error("Unable to read the LoRA thumbnail", 500)
  if not preview:
    return _error("This LoRA has no local thumbnail", 404)
  content_type = mimetypes.guess_type(preview)[0] or "application/octet-stream"
  return web.FileResponse(
    preview,
    headers={
      "Content-Type": content_type,
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  )


def _query_int(request: web.Request, name: str, default: int) -> int:
  try:
    return int(request.query.get(name, default))
  except (TypeError, ValueError):
    return default


def _query_bool(request: web.Request, name: str, default: bool = False) -> bool:
  value = str(request.query.get(name, "1" if default else "0")).strip().lower()
  return value in {"1", "true", "yes", "on"}


def _lora_categories() -> list[dict[str, Any]]:
  categories = configured_model_categories(
    folder_paths.folder_names_and_paths,
  )
  return [
    category
    for category in categories
    if str(category.get("name", "")).casefold() == "loras"
  ]


def _lora_category(categories: list[dict[str, Any]]) -> dict[str, Any]:
  if not categories:
    raise ModelPathError("ComfyUI has no LoRA directory configured")
  return categories[0]


def _lora_root_index(
  category: dict[str, Any],
  requested: int | None = None,
) -> int:
  roots = category.get("roots", [])
  if requested is not None:
    try:
      root_index = int(requested)
    except (TypeError, ValueError) as error:
      raise ModelPathError("Invalid LoRA root directory index") from error
    if root_index < 0 or root_index >= len(roots):
      raise ModelPathError("LoRA root directory index is out of range")
    return root_index
  for root in roots:
    if root.get("exists"):
      return int(root["index"])
  return 0


def _lora_roots(category: dict[str, Any]) -> list[dict[str, Any]]:
  return [
    {
      "index": int(root["index"]),
      "path": root["path"],
      "exists": bool(root.get("exists")),
      "linkType": root.get("linkType", "directory"),
      "resolvedPath": root.get("resolvedPath"),
    }
    for root in category.get("roots", [])
  ]


@ROUTES.get("/assets-astral/loras")
async def list_loras(request: web.Request) -> web.Response:
  offset = max(0, _query_int(request, "offset", 0))
  limit = min(500, max(1, _query_int(request, "limit", 60)))
  try:
    categories = _lora_categories()
    category = _lora_category(categories)
    requested_root = (
      _query_int(request, "root_index", 0)
      if "root_index" in request.query
      else None
    )
    root_index = _lora_root_index(category, requested_root)
    result = await asyncio.to_thread(
      list_model_files,
      categories,
      category_filter=category["name"],
      root_index=root_index,
      relative_path=str(request.query.get("path", "")),
      exact=_query_bool(request, "exact"),
      query=str(request.query.get("q", "")),
      offset=offset,
      limit=limit,
    )
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to list LoRAs: {error}")
    return _model_error(error)
  for item in result["items"]:
    item["file"] = item["relativePath"]
    item["nativeFile"] = native_model_identifier(item["relativePath"])
  result["category"] = category["name"]
  result["rootIndex"] = root_index
  result["roots"] = _lora_roots(category)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.get("/assets-astral/loras/tree")
async def get_lora_tree(request: web.Request) -> web.Response:
  try:
    categories = _lora_categories()
    category = _lora_category(categories)
    requested_root = (
      _query_int(request, "root_index", 0)
      if "root_index" in request.query
      else None
    )
    root_index = _lora_root_index(category, requested_root)
    result = await asyncio.to_thread(
      list_model_tree,
      categories,
      category["name"],
      root_index,
      str(request.query.get("path", "")),
    )
    result["roots"] = _lora_roots(category)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to read LoRA tree: {error}")
    return _model_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.get("/assets-astral/loras/directories")
async def get_lora_directories(_request: web.Request) -> web.Response:
  try:
    categories = _lora_categories()
    category = _lora_category(categories)
    result = await asyncio.to_thread(
      list_model_directories,
      categories,
      category_filter=category["name"],
    )
    result["roots"] = _lora_roots(category)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to list LoRA directories: {error}")
    return _model_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/loras/open")
async def post_lora_open(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    categories = _lora_categories()
    category = _lora_category(categories)
    root_index = _lora_root_index(category, payload.get("rootIndex"))
    relative_path = str(payload.get("path", ""))
    expect = "file" if payload.get("kind") == "file" else "directory"
    _category_data, _root, target = await asyncio.to_thread(
      resolve_model_path,
      categories,
      category["name"],
      root_index,
      relative_path,
      expect=expect,
    )
    reveal_mode = await asyncio.to_thread(open_asset_target, target, expect)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to open LoRA location: {error}")
    return _model_error(error)
  return web.json_response(
    {
      "ok": True,
      "rootIndex": root_index,
      "path": relative_path,
      "absolutePath": target,
      "kind": expect,
      "revealMode": reveal_mode,
    },
    headers=NO_STORE_HEADERS,
  )


@ROUTES.post("/assets-astral/loras/move")
async def post_lora_move(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    categories = _lora_categories()
    category = _lora_category(categories)
    target = payload.get("target")
    if not isinstance(target, dict):
      raise ValueError("Missing LoRA move destination directory")
    result = await asyncio.to_thread(
      move_model_files,
      categories,
      category["name"],
      payload.get("items"),
      target.get("rootIndex"),
      str(target.get("path", "")),
    )
    _clear_filename_caches()
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] LoRA move failed: {error}")
    return _model_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/loras/recycle")
async def post_lora_recycle(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    categories = _lora_categories()
    category = _lora_category(categories)
    result = await asyncio.to_thread(
      recycle_model_files,
      categories,
      category["name"],
      payload.get("items"),
      confirm=payload.get("confirm") is True,
    )
    _clear_filename_caches()
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] LoRA recycle failed: {error}")
    return _model_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/loras/sources")
async def get_lora_sources(request: web.Request) -> web.Response:
  try:
    payload = await request.json()
  except (json.JSONDecodeError, UnicodeDecodeError):
    return _error("Request body must be JSON", 400)
  if not isinstance(payload, dict):
    return _error("Invalid request body format", 400)
  requested_files = payload.get("files")
  if not isinstance(requested_files, list) or not requested_files:
    return _error("Please select at least one LoRA", 400)
  files = list(
    dict.fromkeys(
      str(file).strip() for file in requested_files if str(file).strip()
    )
  )
  if len(files) > MAX_BATCH_SOURCE_FILES:
    return _error(
      f"At most {MAX_BATCH_SOURCE_FILES} LoRAs can be queried at once",
      400,
    )
  refresh = bool(payload.get("refresh", False))

  try:
    available_files = normalized_model_name_lookup(
      await asyncio.to_thread(folder_paths.get_filename_list, "loras")
    )
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to list LoRAs: {error}")
    return _error("Unable to read the local LoRA list", 500)

  semaphore = asyncio.Semaphore(3)

  async def resolve_file(file: str) -> dict[str, Any]:
    try:
      normalized_file = normalize_relative_path(file)
    except ModelPathError as error:
      return {
        "file": file,
        "error": str(error),
      }
    registered_file = available_files.get(normalized_file)
    if not registered_file:
      return {"file": file, "error": "This LoRA file was not found locally"}
    full_path = await asyncio.to_thread(
      folder_paths.get_full_path,
      "loras",
      registered_file,
    )
    if not full_path or not os.path.isfile(full_path):
      return {"file": file, "error": "The local LoRA file does not exist or cannot be accessed"}
    async with semaphore:
      try:
        return await _resolve_lora_sources_cached(
          normalized_file,
          full_path,
          refresh=refresh,
        )
      except Exception as error:
        print(f"[ComfyUI-Astral-Manage] Source lookup failed for {file}: {error}")
        return {"file": file, "error": "Internal error while querying LoRA sources"}

  items = await asyncio.gather(*(resolve_file(file) for file in files))
  return web.json_response(
    {
      "items": items,
      "refreshed": refresh,
      "count": len(items),
    },
    headers=NO_STORE_HEADERS,
  )


@ROUTES.post("/assets-astral/loras/sources/cached")
async def get_cached_lora_sources(request: web.Request) -> web.Response:
  try:
    payload = await request.json()
  except (json.JSONDecodeError, UnicodeDecodeError):
    return _error("Request body must be JSON", 400)
  if not isinstance(payload, dict):
    return _error("Invalid request body format", 400)
  requested_files = payload.get("files")
  if not isinstance(requested_files, list) or not requested_files:
    return _error("Please select at least one LoRA", 400)
  files = list(
    dict.fromkeys(
      str(file).strip() for file in requested_files if str(file).strip()
    )
  )
  if len(files) > MAX_CACHED_SOURCE_FILES:
    return _error(
      f"At most {MAX_CACHED_SOURCE_FILES} LoRA local caches can be read at once",
      400,
    )

  try:
    available_files = normalized_model_name_lookup(
      await asyncio.to_thread(folder_paths.get_filename_list, "loras")
    )
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to list LoRAs: {error}")
    return _error("Unable to read the local LoRA list", 500)

  async def load_cached(file: str) -> dict[str, Any] | None:
    try:
      normalized_file = normalize_relative_path(file)
    except ModelPathError:
      return None
    registered_file = available_files.get(normalized_file)
    if not registered_file:
      return None
    full_path = await asyncio.to_thread(
      folder_paths.get_full_path,
      "loras",
      registered_file,
    )
    if not full_path or not os.path.isfile(full_path):
      return None
    return await asyncio.to_thread(
      load_lora_source_cache,
      normalized_file,
      full_path,
    )

  resolved = await asyncio.gather(*(load_cached(file) for file in files))
  items = [item for item in resolved if item]
  return web.json_response(
    {
      "items": items,
      "count": len(items),
      "missingCount": len(files) - len(items),
    },
    headers=NO_STORE_HEADERS,
  )


def _asset_roots() -> tuple[str, str]:
  return (
    folder_paths.get_input_directory(),
    folder_paths.get_output_directory(),
  )


def _workspace_roots() -> dict[str, str]:
  base_path = getattr(
    folder_paths,
    "base_path",
    os.path.dirname(os.path.abspath(folder_paths.__file__)),
  )
  models_directory = getattr(folder_paths, "models_dir", None)
  if not models_directory:
    models_directory = os.path.join(base_path, "models")

  custom_nodes_directories = []
  try:
    custom_nodes_directories = folder_paths.get_folder_paths("custom_nodes")
  except Exception:
    configured = getattr(folder_paths, "folder_names_and_paths", {}).get(
      "custom_nodes",
      (),
    )
    if configured:
      custom_nodes_directories = configured[0]
  custom_nodes_directory = (
    custom_nodes_directories[0]
    if custom_nodes_directories
    else os.path.join(base_path, "custom_nodes")
  )

  user_directory = folder_paths.get_user_directory()
  workflows_directory = os.path.join(user_directory, "default", "workflows")
  if not os.path.isdir(workflows_directory):
    fallback = os.path.join(user_directory, "workflows")
    if os.path.isdir(fallback):
      workflows_directory = fallback

  return {
    "models": os.path.abspath(models_directory),
    "custom_nodes": os.path.abspath(custom_nodes_directory),
    "input": os.path.abspath(folder_paths.get_input_directory()),
    "output": os.path.abspath(folder_paths.get_output_directory()),
    "workflows": os.path.abspath(workflows_directory),
  }


def _asset_error(error: Exception) -> web.Response:
  if isinstance(error, FileNotFoundError):
    return _error(str(error), 404)
  if isinstance(error, FileExistsError):
    return _error(str(error), 409)
  if isinstance(error, AssetPathError):
    return _error(str(error), 400)
  if isinstance(error, PermissionError):
    return _error("No permission to access this asset", 403)
  if isinstance(error, RecycleBinError):
    return _error(str(error), 500)
  return _error("Internal error while reading assets", 500)


@ROUTES.get("/assets-astral/assets")
async def get_assets(request: web.Request) -> web.Response:
  input_root, output_root = _asset_roots()
  try:
    result = await asyncio.to_thread(
      list_assets,
      input_root,
      output_root,
      root_filter=str(request.query.get("root", "all")),
      kind_filter=str(request.query.get("kind", "all")),
      relative_path=str(request.query.get("path", "")),
      exact_path=_query_bool(request, "exact"),
      query=str(request.query.get("q", "")),
      offset=_query_int(request, "offset", 0),
      limit=_query_int(request, "limit", 80),
    )
  except (AssetPathError, ValueError) as error:
    return _asset_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to list assets: {error}")
    return _asset_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.get("/assets-astral/assets/detail")
async def get_asset_detail(request: web.Request) -> web.Response:
  input_root, output_root = _asset_roots()
  try:
    result = await asyncio.to_thread(
      read_asset_detail,
      str(request.query.get("root", "")),
      str(request.query.get("path", "")),
      input_root,
      output_root,
    )
  except (AssetPathError, FileNotFoundError, PermissionError) as error:
    return _asset_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to read asset detail: {error}")
    return _asset_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


def _asset_response_headers(path: str) -> dict[str, str]:
  return {
    "Content-Type": media_mime(path),
    "Content-Disposition": "inline",
    "Cache-Control": "private, max-age=300",
    "X-Content-Type-Options": "nosniff",
  }


@ROUTES.get("/assets-astral/assets/file")
async def get_asset_file(request: web.Request) -> web.StreamResponse:
  input_root, output_root = _asset_roots()
  try:
    path = resolve_asset_path(
      str(request.query.get("root", "")),
      str(request.query.get("path", "")),
      input_root,
      output_root,
    )
  except (AssetPathError, FileNotFoundError, PermissionError) as error:
    return _asset_error(error)
  return web.FileResponse(path, headers=_asset_response_headers(path))


@ROUTES.get("/assets-astral/assets/thumbnail")
async def get_asset_thumbnail(request: web.Request) -> web.StreamResponse:
  input_root, output_root = _asset_roots()
  root = str(request.query.get("root", ""))
  relative_path = str(request.query.get("path", ""))
  try:
    path = resolve_asset_path(root, relative_path, input_root, output_root)
    stat = os.stat(path)
    cache_directory = os.path.join(
      folder_paths.get_temp_directory(),
      "assets_astral_thumbnails",
    )
    thumbnail = await asyncio.to_thread(
      create_thumbnail,
      path,
      cache_directory,
      f"{root}\0{relative_path}\0{stat.st_mtime_ns}\0{stat.st_size}",
    )
  except (AssetPathError, FileNotFoundError, PermissionError) as error:
    return _asset_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to create thumbnail: {error}")
    return _error("Unable to generate asset thumbnail", 404)
  return web.FileResponse(
    thumbnail,
    headers={
      "Content-Type": "image/webp",
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  )


@ROUTES.get("/assets-astral/assets/tree")
async def get_asset_tree(request: web.Request) -> web.Response:
  input_root, output_root = _asset_roots()
  try:
    result = await asyncio.to_thread(
      list_asset_tree,
      input_root,
      output_root,
      root=str(request.query.get("root", "input")),
      relative_path=str(request.query.get("path", "")),
    )
  except (AssetPathError, FileNotFoundError, PermissionError) as error:
    return _asset_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to read asset tree: {error}")
    return _error("Unable to read the asset directory structure", 500)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/assets/open")
async def post_asset_open(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    input_root, output_root = _asset_roots()
    root = str(payload.get("root", ""))
    relative_path = str(payload.get("path", ""))
    selected = payload.get("select") is True
    target, kind = await asyncio.to_thread(
      resolve_asset_open_target,
      root,
      relative_path,
      input_root,
      output_root,
      select=selected,
    )
    reveal_mode = await asyncio.to_thread(open_asset_target, target, kind)
  except (AssetPathError, FileNotFoundError, PermissionError) as error:
    return _asset_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to open asset in file manager: {error}")
    return _error("Unable to open the asset in the system file manager", 500)
  return web.json_response(
    {
      "ok": True,
      "root": root,
      "path": relative_path,
      "absolutePath": target,
      "kind": kind,
      "revealMode": reveal_mode,
    },
    headers=NO_STORE_HEADERS,
  )


@ROUTES.get("/assets-astral/workspace/entries")
async def get_workspace_entries(request: web.Request) -> web.Response:
  root = str(request.query.get("root", "")).strip()
  relative_path = str(request.query.get("path", "")).strip()
  try:
    result = await asyncio.to_thread(
      list_workspace_entries,
      root,
      relative_path,
      _workspace_roots(),
    )
  except (AssetPathError, FileNotFoundError, PermissionError) as error:
    return _asset_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to browse workspace: {error}")
    return _error("Failed to read the workspace directory", 500)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/workspace/open")
async def post_workspace_open(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    root = str(payload.get("root", "")).strip()
    relative_path = str(payload.get("path", "")).strip()
    target = await asyncio.to_thread(
      resolve_workspace_directory,
      root,
      relative_path,
      _workspace_roots(),
    )
    reveal_mode = await asyncio.to_thread(
      open_asset_target,
      target,
      "directory",
    )
  except (AssetPathError, FileNotFoundError, PermissionError) as error:
    return _asset_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to open workspace directory: {error}")
    return _error(
      "Unable to open the workspace directory in the system file manager",
      500,
    )
  return web.json_response(
    {
      "ok": True,
      "root": root,
      "path": relative_path,
      "absolutePath": target,
      "revealMode": reveal_mode,
    },
    headers=NO_STORE_HEADERS,
  )


@ROUTES.post("/assets-astral/assets/rename")
async def post_asset_rename(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    input_root, output_root = _asset_roots()
    result = await asyncio.to_thread(
      rename_asset_files,
      input_root,
      output_root,
      payload.get("items"),
      mode=str(payload.get("mode", "")),
      new_name=str(payload.get("newName", "")),
      prefix=str(payload.get("prefix", "")),
      start=payload.get("start", 1),
    )
  except (
    AssetPathError,
    FileExistsError,
    FileNotFoundError,
    PermissionError,
    ValueError,
  ) as error:
    return _asset_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Asset rename failed: {error}")
    return _error("Failed to batch rename assets", 500)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/assets/recycle")
async def post_asset_recycle(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    input_root, output_root = _asset_roots()
    result = await asyncio.to_thread(
      recycle_asset_files,
      input_root,
      output_root,
      payload.get("items"),
      confirm=payload.get("confirm") is True,
      recycle_function=recycle_bin_paths,
    )
  except (
    AssetPathError,
    FileExistsError,
    FileNotFoundError,
    PermissionError,
    RecycleBinError,
    ValueError,
  ) as error:
    return _asset_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Asset recycle failed: {error}")
    return _error("Failed to move assets to the recycle bin", 500)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.get("/assets-astral/prompts")
async def get_prompts(request: web.Request) -> web.Response:
  input_root, output_root = _asset_roots()
  try:
    result = await asyncio.to_thread(
      list_prompt_entries,
      input_root,
      output_root,
      query=str(request.query.get("q", "")),
      root_filter=str(request.query.get("root", "all")),
      offset=_query_int(request, "offset", 0),
      limit=_query_int(request, "limit", 80),
    )
  except (AssetPathError, ValueError) as error:
    return _asset_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to list prompts: {error}")
    return _error("Internal error while reading prompts", 500)
  return web.json_response(result, headers=NO_STORE_HEADERS)


def _prompt_error(error: Exception) -> web.Response:
  if isinstance(error, FileNotFoundError):
    return _error(str(error), 404)
  if isinstance(error, (PromptDataError, SkillLibraryError, ValueError)):
    return _error(str(error), 400)
  if isinstance(error, PermissionError):
    return _error(str(error), 403)
  return _error("Internal error in prompt management operation", 500)


def _chat_error(error: Exception) -> web.Response:
  if isinstance(error, FileNotFoundError):
    return _error(str(error), 404)
  if isinstance(error, ChatCancelled):
    return _error(str(error), 409)
  if isinstance(error, ChatAPIError):
    status = 502 if not error.status or error.status >= 500 else 400
    return _error(str(error), status)
  if isinstance(
    error,
    (
      ChatServiceError,
      LocalLLMError,
      PromptDataError,
      SkillLibraryError,
    ),
  ):
    return _error(str(error), 400)
  return _error("AI chat request failed", 500)


@ROUTES.get("/assets-astral/prompt-templates")
async def get_prompt_templates(request: web.Request) -> web.Response:
  try:
    result = await asyncio.to_thread(
      list_templates,
      default_data_directory(),
      query=str(request.query.get("q", "")),
      category=str(request.query.get("category", "")),
    )
  except (PromptDataError, ValueError) as error:
    return _prompt_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to list prompt templates: {error}")
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/prompt-templates")
@ROUTES.post("/assets-astral/prompt-templates/save")
async def post_prompt_template(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    result = await asyncio.to_thread(
      save_template,
      default_data_directory(),
      payload,
    )
  except (PromptDataError, ValueError) as error:
    return _prompt_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to save prompt template: {error}")
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/prompt-templates/categories/create")
async def post_prompt_category_create(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    result = await asyncio.to_thread(
      create_prompt_category,
      default_data_directory(),
      payload.get("name"),
    )
  except (PromptDataError, ValueError) as error:
    return _prompt_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to create prompt category: {error}")
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/prompt-templates/categories/delete")
async def post_prompt_category_delete(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    result = await asyncio.to_thread(
      delete_prompt_category,
      default_data_directory(),
      payload.get("name"),
    )
  except (PromptDataError, ValueError) as error:
    return _prompt_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to delete prompt category: {error}")
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/prompt-templates/delete")
async def post_prompt_template_delete(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    result = await asyncio.to_thread(
      delete_template,
      default_data_directory(),
      str(payload.get("id", "")),
    )
  except (PromptDataError, ValueError, FileNotFoundError) as error:
    return _prompt_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to delete prompt template: {error}")
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.get("/assets-astral/chat/config")
async def get_chat_config(_request: web.Request) -> web.Response:
  try:
    result = await asyncio.to_thread(
      load_api_configuration,
      default_data_directory(),
    )
  except (PromptDataError, ValueError) as error:
    return _prompt_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to load chat config: {error}")
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/chat/config")
async def post_chat_config(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    result = await asyncio.to_thread(
      save_api_config,
      default_data_directory(),
      payload,
    )
  except (PromptDataError, ValueError) as error:
    return _prompt_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to save chat config: {error}")
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/prompt-expert/models")
async def post_prompt_expert_models(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    base_url = _api_base_url(payload.get("baseUrl"))
    if not base_url:
      raise ChatServiceError("Please enter the API address first")
    models = await asyncio.to_thread(
      list_api_models,
      {
        "baseUrl": base_url,
        "apiKey": str(payload.get("apiKey") or "").strip(),
      },
    )
  except (
    ChatServiceError,
    PromptDataError,
    ValueError,
  ) as error:
    return _chat_error(error)
  except Exception as error:
    print(
      "[ComfyUI-Astral-Manage] Unable to fetch Prompt Processor API models: "
      f"{error}"
    )
    return _chat_error(error)
  return web.json_response(
    {"items": models, "total": len(models)},
    headers=NO_STORE_HEADERS,
  )


@ROUTES.post("/assets-astral/chat/models")
async def post_chat_models(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    provider = await asyncio.to_thread(
      resolve_api_provider,
      default_data_directory(),
      payload,
    )
    models = await asyncio.to_thread(list_api_models, provider)
  except (
    ChatServiceError,
    PromptDataError,
    ValueError,
  ) as error:
    return _chat_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to fetch API models: {error}")
    return _chat_error(error)
  return web.json_response(
    {
      "items": models,
      "total": len(models),
      "providerId": provider.get("id"),
    },
    headers=NO_STORE_HEADERS,
  )


@ROUTES.get("/assets-astral/chat/conversations")
async def get_chat_conversations(_request: web.Request) -> web.Response:
  try:
    result = await asyncio.to_thread(
      list_conversations,
      default_data_directory(),
    )
  except (PromptDataError, ValueError) as error:
    return _prompt_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to list conversations: {error}")
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/chat/conversations")
async def post_chat_conversation(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    result = await asyncio.to_thread(
      create_conversation,
      default_data_directory(),
      payload,
    )
  except (PromptDataError, ValueError) as error:
    return _prompt_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to create conversation: {error}")
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.get("/assets-astral/chat/conversations/get")
async def get_chat_conversation(request: web.Request) -> web.Response:
  try:
    result = await asyncio.to_thread(
      get_conversation,
      default_data_directory(),
      str(request.query.get("id", "")),
    )
  except (PromptDataError, ValueError, FileNotFoundError) as error:
    return _prompt_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to read conversation: {error}")
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/chat/conversations/update")
async def post_chat_conversation_update(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    conversation_id = str(payload.pop("id", "")).strip()
    result = await asyncio.to_thread(
      update_conversation,
      default_data_directory(),
      conversation_id,
      payload,
    )
  except (PromptDataError, ValueError, FileNotFoundError) as error:
    return _prompt_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to update conversation: {error}")
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/chat/conversations/delete")
async def post_chat_conversation_delete(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    result = await asyncio.to_thread(
      delete_conversation,
      default_data_directory(),
      str(payload.get("id", "")),
    )
  except (PromptDataError, ValueError, FileNotFoundError) as error:
    return _prompt_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to delete conversation: {error}")
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/chat/cancel")
async def post_chat_cancel(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    request_id = str(payload.get("requestId") or "").strip()
    cancelled = cancel_chat_request(request_id)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to cancel chat request: {error}")
    return _chat_error(error)
  return web.json_response(
    {
      "ok": True,
      "cancelled": cancelled,
      "requestId": request_id,
    },
    headers=NO_STORE_HEADERS,
  )


@ROUTES.post("/assets-astral/prompt-task")
async def post_prompt_task(request: web.Request) -> web.Response:
  registered_request_id = ""
  try:
    payload = await _json_body(request)
    attachments = payload.get("attachments")
    skill_ids = payload.get("skillIds")
    registered_request_id = register_chat_request(payload.get("requestId"))
    result = await run_prompt_task_async(
      default_data_directory(),
      str(payload.get("text") or ""),
      task=str(payload.get("task") or "expand"),
      mode=str(payload.get("mode") or "api"),
      rule_id=str(payload.get("ruleId") or ""),
      skill_ids=skill_ids if isinstance(skill_ids, list) else None,
      attachments=attachments if isinstance(attachments, list) else None,
      clear_vram=payload.get("clearVram") is True,
      request_id=registered_request_id,
      target_language=str(payload.get("targetLanguage") or "en"),
      source_language=str(payload.get("sourceLanguage") or "auto"),
    )
  except (
    ChatServiceError,
    LocalLLMError,
    PromptDataError,
    SkillLibraryError,
    FileNotFoundError,
    ValueError,
  ) as error:
    return _chat_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Prompt task failed: {error}")
    return _chat_error(error)
  finally:
    if registered_request_id:
      finish_chat_request(registered_request_id)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/chat/messages/delete")
async def post_chat_message_delete(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    result = await asyncio.to_thread(
      delete_conversation_message,
      default_data_directory(),
      str(payload.get("conversationId") or ""),
      str(payload.get("messageId") or ""),
    )
  except (
    PromptDataError,
    FileNotFoundError,
    PermissionError,
    ValueError,
  ) as error:
    return _prompt_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to delete chat message: {error}")
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


def _local_llm_payload() -> dict[str, Any]:
  config = load_local_llm_config(default_data_directory())
  models = list_local_llm_models()
  vision_models = list_local_llm_vision_models()
  return {
    "config": config,
    "models": models,
    "visionModels": vision_models,
    "total": len(models),
    "visionTotal": len(vision_models),
    "modelsRoot": local_llm_models_root(),
  }


@ROUTES.get("/assets-astral/local-llm/config")
async def get_local_llm_config(_request: web.Request) -> web.Response:
  try:
    result = await asyncio.to_thread(_local_llm_payload)
  except LocalLLMError as error:
    return _chat_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to load local LLM config: {error}")
    return _chat_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/local-llm/config")
async def post_local_llm_config(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    config = await asyncio.to_thread(
      save_local_llm_config,
      default_data_directory(),
      payload,
    )
    models = await asyncio.to_thread(list_local_llm_models)
    vision_models = await asyncio.to_thread(list_local_llm_vision_models)
    result = {
      "config": config,
      "models": models,
      "visionModels": vision_models,
      "total": len(models),
      "visionTotal": len(vision_models),
      "modelsRoot": local_llm_models_root(),
    }
  except LocalLLMError as error:
    return _chat_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to save local LLM config: {error}")
    return _chat_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.get("/assets-astral/local-llm/models")
async def get_local_llm_models(_request: web.Request) -> web.Response:
  try:
    models = await asyncio.to_thread(list_local_llm_models)
    vision_models = await asyncio.to_thread(list_local_llm_vision_models)
  except LocalLLMError as error:
    return _chat_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to list local LLM models: {error}")
    return _chat_error(error)
  return web.json_response(
    {
      "items": models,
      "visionModels": vision_models,
      "total": len(models),
      "visionTotal": len(vision_models),
      "modelsRoot": local_llm_models_root(),
    },
    headers=NO_STORE_HEADERS,
  )


@ROUTES.post("/assets-astral/local-llm/chat")
async def post_local_llm_chat(request: web.Request) -> web.Response:
  registered_request_id = ""
  try:
    payload = await _json_body(request)
    conversation_id = str(payload.get("conversationId") or "canvas").strip()
    attachments = payload.get("attachments")
    skill_ids = payload.get("skillIds")
    registered_request_id = register_chat_request(payload.get("requestId"))
    result = await run_local_chat_turn_async(
      default_data_directory(),
      conversation_id,
      str(payload.get("message") or ""),
      attachments=attachments if isinstance(attachments, list) else None,
      skill_ids=skill_ids if isinstance(skill_ids, list) else None,
      request_id=registered_request_id,
    )
  except (
    ChatServiceError,
    LocalLLMError,
    PromptDataError,
    SkillLibraryError,
    FileNotFoundError,
    ValueError,
  ) as error:
    return _chat_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Local LLM chat failed: {error}")
    return _chat_error(error)
  finally:
    if registered_request_id:
      finish_chat_request(registered_request_id)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/chat")
async def post_chat(request: web.Request) -> web.Response:
  registered_request_id = ""
  try:
    payload = await _json_body(request)
    conversation_id = str(payload.get("conversationId") or "canvas").strip()
    user_message = str(payload.get("message") or "")
    attachments = payload.get("attachments")
    skill_ids = payload.get("skillIds")
    task = str(payload.get("task") or "").strip() or None
    registered_request_id = register_chat_request(payload.get("requestId"))
    result = await run_chat_turn_async(
      default_data_directory(),
      conversation_id,
      user_message,
      attachments=attachments if isinstance(attachments, list) else None,
      skill_ids=skill_ids if isinstance(skill_ids, list) else None,
      task=task,
      request_id=registered_request_id,
    )
  except (
    ChatServiceError,
    PromptDataError,
    SkillLibraryError,
    FileNotFoundError,
    ValueError,
  ) as error:
    return _chat_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Chat request failed: {error}")
    return _chat_error(error)
  finally:
    if registered_request_id:
      finish_chat_request(registered_request_id)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/chat/translate")
async def post_chat_translate(request: web.Request) -> web.Response:
  registered_request_id = ""
  try:
    payload = await _json_body(request)
    conversation_id = str(payload.get("conversationId") or "").strip()
    local_mode = bool(
      payload.get("useLocal")
      or str(payload.get("mode") or "").strip().lower() == "local"
    )
    registered_request_id = register_chat_request(payload.get("requestId"))
    if conversation_id:
      result = await run_translation_turn_async(
        default_data_directory(),
        conversation_id,
        str(payload.get("text") or ""),
        str(payload.get("targetLanguage") or ""),
        source_language=str(payload.get("sourceLanguage") or "auto"),
        local_mode=local_mode,
        request_id=registered_request_id,
      )
      return web.json_response(result, headers=NO_STORE_HEADERS)
    translated = await asyncio.to_thread(
      translate_text,
      default_data_directory(),
      str(payload.get("text") or ""),
      str(payload.get("targetLanguage") or ""),
      source_language=str(payload.get("sourceLanguage") or "auto"),
      request_id=registered_request_id,
    )
    result = {
      "text": translated,
      "targetLanguage": payload.get("targetLanguage"),
    }
  except (
    ChatServiceError,
    LocalLLMError,
    PromptDataError,
    FileNotFoundError,
    ValueError,
  ) as error:
    return _chat_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Translation failed: {error}")
    return _chat_error(error)
  finally:
    if registered_request_id:
      finish_chat_request(registered_request_id)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/chat/optimize")
async def post_chat_optimize(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    attachments = payload.get("attachments")
    skill_ids = payload.get("skillIds")
    result = await asyncio.to_thread(
      optimize_prompt,
      default_data_directory(),
      str(payload.get("text") or ""),
      attachments=attachments if isinstance(attachments, list) else None,
      skill_ids=skill_ids if isinstance(skill_ids, list) else None,
    )
  except (
    ChatServiceError,
    PromptDataError,
    SkillLibraryError,
    FileNotFoundError,
    ValueError,
  ) as error:
    return _chat_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Prompt optimization failed: {error}")
    return _chat_error(error)
  return web.json_response({"text": result}, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/prompt-inspiration/generate")
async def post_prompt_inspiration_generate(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    result = await asyncio.to_thread(
      generate_inspiration_prompt,
      default_data_directory(),
      str(payload.get("basePrompt") or ""),
      tags=payload.get("tags"),
      target=str(payload.get("target") or "image"),
      language=str(payload.get("language") or "en"),
      mode=str(payload.get("mode") or "api"),
    )
  except (
    ChatServiceError,
    PromptDataError,
    FileNotFoundError,
    ValueError,
  ) as error:
    return _chat_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Prompt inspiration failed: {error}")
    return _chat_error(error)
  return web.json_response({"text": result}, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/chat/invert")
async def post_chat_invert(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    attachments = payload.get("attachments")
    skill_ids = payload.get("skillIds")
    result = await asyncio.to_thread(
      invert_prompt,
      default_data_directory(),
      hint=str(payload.get("hint") or ""),
      attachments=attachments if isinstance(attachments, list) else None,
      skill_ids=skill_ids if isinstance(skill_ids, list) else None,
    )
  except (
    ChatServiceError,
    PromptDataError,
    SkillLibraryError,
    FileNotFoundError,
    ValueError,
  ) as error:
    return _chat_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Prompt inversion failed: {error}")
    return _chat_error(error)
  return web.json_response({"text": result}, headers=NO_STORE_HEADERS)


@ROUTES.get("/assets-astral/skills")
async def get_skills(_request: web.Request) -> web.Response:
  try:
    result = await asyncio.to_thread(discover_skills)
  except SkillLibraryError as error:
    return _prompt_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to discover skills: {error}")
    return _prompt_error(error)
  return web.json_response(
    {
      "items": result,
      "total": len(result),
      "root": default_skills_directory(),
      "roots": default_skill_directories(),
    },
    headers=NO_STORE_HEADERS,
  )


@ROUTES.get("/assets-astral/skills/content")
async def get_skill_content(request: web.Request) -> web.Response:
  try:
    result = await asyncio.to_thread(
      load_skill_text,
      str(request.query.get("id", "")),
    )
  except (SkillLibraryError, FileNotFoundError, ValueError) as error:
    return _prompt_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to load skill: {error}")
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/skills/open")
async def post_skill_open(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    target = await asyncio.to_thread(
      resolve_skill_file,
      str(payload.get("id", "")),
    )
    reveal_mode = await asyncio.to_thread(open_asset_target, target, "file")
  except (SkillLibraryError, FileNotFoundError, PermissionError, ValueError) as error:
    return _prompt_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to open skill location: {error}")
    return _prompt_error(error)
  return web.json_response(
    {
      "ok": True,
      "id": str(payload.get("id", "")),
      "absolutePath": target,
      "revealMode": reveal_mode,
    },
    headers=NO_STORE_HEADERS,
  )


@ROUTES.get("/assets-astral/skill-tags")
async def get_skill_tags(_request: web.Request) -> web.Response:
  try:
    result = await asyncio.to_thread(
      get_skill_tag_state,
      default_data_directory(),
    )
  except (SkillTagDataError, ValueError) as error:
    return _prompt_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to load skill tags: {error}")
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/skill-tags/categories/create")
async def post_skill_tag_category_create(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    result = await asyncio.to_thread(
      create_tag_category,
      default_data_directory(),
      payload.get("name"),
    )
  except (
    SkillTagDataError,
    FileNotFoundError,
    PermissionError,
    ValueError,
  ) as error:
    return _prompt_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to create skill tag category: {error}")
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/skill-tags/categories/rename")
async def post_skill_tag_category_rename(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    result = await asyncio.to_thread(
      rename_tag_category,
      default_data_directory(),
      payload.get("id"),
      payload.get("name"),
    )
  except (
    SkillTagDataError,
    FileNotFoundError,
    PermissionError,
    ValueError,
  ) as error:
    return _prompt_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to rename skill tag category: {error}")
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/skill-tags/categories/delete")
async def post_skill_tag_category_delete(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    result = await asyncio.to_thread(
      delete_tag_category,
      default_data_directory(),
      payload.get("id"),
    )
  except (
    SkillTagDataError,
    FileNotFoundError,
    PermissionError,
    ValueError,
  ) as error:
    return _prompt_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to delete skill tag category: {error}")
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/skill-tags/subcategories/create")
async def post_skill_tag_subcategory_create(
  request: web.Request,
) -> web.Response:
  try:
    payload = await _json_body(request)
    result = await asyncio.to_thread(
      create_tag_subcategory,
      default_data_directory(),
      category_id=payload.get("categoryId"),
      name=payload.get("name"),
    )
  except (
    SkillTagDataError,
    FileNotFoundError,
    PermissionError,
    ValueError,
  ) as error:
    return _prompt_error(error)
  except Exception as error:
    print(
      "[ComfyUI-Astral-Manage] Unable to create skill tag "
      f"subcategory: {error}"
    )
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/skill-tags/subcategories/rename")
async def post_skill_tag_subcategory_rename(
  request: web.Request,
) -> web.Response:
  try:
    payload = await _json_body(request)
    result = await asyncio.to_thread(
      rename_tag_subcategory,
      default_data_directory(),
      payload.get("id"),
      payload.get("name"),
    )
  except (
    SkillTagDataError,
    FileNotFoundError,
    PermissionError,
    ValueError,
  ) as error:
    return _prompt_error(error)
  except Exception as error:
    print(
      "[ComfyUI-Astral-Manage] Unable to rename skill tag "
      f"subcategory: {error}"
    )
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/skill-tags/subcategories/delete")
async def post_skill_tag_subcategory_delete(
  request: web.Request,
) -> web.Response:
  try:
    payload = await _json_body(request)
    result = await asyncio.to_thread(
      delete_tag_subcategory,
      default_data_directory(),
      payload.get("id"),
    )
  except (
    SkillTagDataError,
    FileNotFoundError,
    PermissionError,
    ValueError,
  ) as error:
    return _prompt_error(error)
  except Exception as error:
    print(
      "[ComfyUI-Astral-Manage] Unable to delete skill tag "
      f"subcategory: {error}"
    )
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/skill-tags/create")
async def post_skill_tag_create(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    result = await asyncio.to_thread(
      create_skill_tag,
      default_data_directory(),
      name=payload.get("name"),
      category_id=payload.get("categoryId"),
      subcategory_id=payload.get("subcategoryId"),
      color=payload.get("color"),
      favorite=payload.get("favorite", False),
    )
  except (
    SkillTagDataError,
    FileNotFoundError,
    PermissionError,
    ValueError,
  ) as error:
    return _prompt_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to create skill tag: {error}")
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/skill-tags/batch-create")
async def post_skill_tag_batch_create(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    result = await asyncio.to_thread(
      create_skill_tags,
      default_data_directory(),
      names=payload.get("names"),
      category_id=payload.get("categoryId"),
      subcategory_id=payload.get("subcategoryId"),
      color=payload.get("color"),
    )
  except (
    SkillTagDataError,
    FileNotFoundError,
    PermissionError,
    ValueError,
  ) as error:
    return _prompt_error(error)
  except Exception as error:
    print(
      f"[ComfyUI-Astral-Manage] Unable to create skill tags: {error}"
    )
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/skill-tags/batch-delete")
async def post_skill_tag_batch_delete(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    result = await asyncio.to_thread(
      delete_skill_tags,
      default_data_directory(),
      payload.get("tagIds"),
    )
  except (
    SkillTagDataError,
    FileNotFoundError,
    PermissionError,
    ValueError,
  ) as error:
    return _prompt_error(error)
  except Exception as error:
    print(
      f"[ComfyUI-Astral-Manage] Unable to batch delete skill tags: {error}"
    )
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/skill-tags/batch-move")
async def post_skill_tag_batch_move(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    result = await asyncio.to_thread(
      move_skill_tags,
      default_data_directory(),
      payload.get("tagIds"),
      category_id=payload.get("categoryId"),
      subcategory_id=payload.get("subcategoryId"),
    )
  except (
    SkillTagDataError,
    FileNotFoundError,
    PermissionError,
    ValueError,
  ) as error:
    return _prompt_error(error)
  except Exception as error:
    print(
      f"[ComfyUI-Astral-Manage] Unable to batch move skill tags: {error}"
    )
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/skill-tags/update")
async def post_skill_tag_update(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    changes = {
      key: payload[key]
      for key in (
        "name",
        "categoryId",
        "subcategoryId",
        "color",
        "favorite",
      )
      if key in payload
    }
    result = await asyncio.to_thread(
      update_skill_tag,
      default_data_directory(),
      payload.get("id"),
      changes,
    )
  except (
    SkillTagDataError,
    FileNotFoundError,
    PermissionError,
    ValueError,
  ) as error:
    return _prompt_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to update skill tag: {error}")
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/skill-tags/delete")
async def post_skill_tag_delete(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    result = await asyncio.to_thread(
      delete_skill_tag,
      default_data_directory(),
      payload.get("id"),
    )
  except (
    SkillTagDataError,
    FileNotFoundError,
    PermissionError,
    ValueError,
  ) as error:
    return _prompt_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to delete skill tag: {error}")
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/skill-tags/assign")
async def post_skill_tag_assign(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    result = await asyncio.to_thread(
      assign_skill_tags,
      default_data_directory(),
      payload.get("skillId"),
      payload.get("tagIds"),
    )
  except (
    SkillTagDataError,
    FileNotFoundError,
    PermissionError,
    ValueError,
  ) as error:
    return _prompt_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to assign skill tags: {error}")
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/skill-tags/reorder")
async def post_skill_tag_reorder(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    result = await asyncio.to_thread(
      reorder_skill_tags,
      default_data_directory(),
      payload.get("kind"),
      payload.get("orderedIds"),
    )
  except (
    SkillTagDataError,
    FileNotFoundError,
    PermissionError,
    ValueError,
  ) as error:
    return _prompt_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to reorder skill tags: {error}")
    return _prompt_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


def _model_categories() -> list[dict[str, Any]]:
  models_directory = getattr(folder_paths, "models_dir", None)
  if not models_directory:
    base_path = getattr(
      folder_paths,
      "base_path",
      os.path.dirname(os.path.abspath(folder_paths.__file__)),
    )
    models_directory = os.path.join(base_path, "models")
  return configured_model_categories(
    folder_paths.folder_names_and_paths,
    model_roots=[models_directory],
  )


def _model_error(error: Exception) -> web.Response:
  if isinstance(error, FileNotFoundError):
    return _error(str(error), 404)
  if isinstance(error, FileExistsError):
    return _error(str(error), 409)
  if isinstance(error, (ModelPathError, ValueError)):
    return _error(str(error), 400)
  if isinstance(error, PermissionError):
    return _error(str(error), 403)
  if isinstance(error, RecycleBinError):
    return _error(str(error), 500)
  return _error("Internal error in model operation", 500)


async def _json_body(request: web.Request) -> dict[str, Any]:
  try:
    payload = await request.json()
  except (json.JSONDecodeError, UnicodeDecodeError) as error:
    raise ValueError("Request body must be JSON") from error
  if not isinstance(payload, dict):
    raise ValueError("Invalid request body format")
  return payload


@ROUTES.get("/assets-astral/models")
async def get_models(request: web.Request) -> web.Response:
  try:
    categories = _model_categories()
    result = await asyncio.to_thread(
      list_model_files,
      categories,
      category_filter=str(request.query.get("category", "")),
      root_index=(
        _query_int(request, "root_index", -1)
        if "root_index" in request.query
        else None
      ),
      relative_path=str(request.query.get("path", "")),
      query=str(request.query.get("q", "")),
      offset=_query_int(request, "offset", 0),
      limit=_query_int(request, "limit", 120),
    )
  except (ModelPathError, ValueError) as error:
    return _model_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to list models: {error}")
    return _model_error(error)
  return web.json_response(
    {
      "categories": categories,
      **result,
    },
    headers=NO_STORE_HEADERS,
  )


@ROUTES.get("/assets-astral/models/categories")
async def get_model_categories(_request: web.Request) -> web.Response:
  try:
    categories = await asyncio.to_thread(_model_categories)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to list model categories: {error}")
    return _error("Internal error while reading model categories", 500)
  return web.json_response(
    {"categories": categories},
    headers=NO_STORE_HEADERS,
  )


@ROUTES.post("/assets-astral/models/missing/resolve")
async def post_model_missing_resolve(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    items = payload.get("items")
    result = await asyncio.to_thread(
      resolve_missing_model_files,
      _model_categories(),
      items,
    )
  except (
    ModelPathError,
    FileNotFoundError,
    PermissionError,
    ValueError,
  ) as error:
    return _model_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to resolve missing models: {error}")
    return _model_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/models/open")
async def post_model_open(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    category = str(payload.get("category", "")).strip()
    relative_path = str(payload.get("relativePath", "")).strip()
    _model_category, _model_root, target = await asyncio.to_thread(
      resolve_model_path,
      _model_categories(),
      category,
      payload.get("rootIndex"),
      relative_path,
      expect="file",
    )
    reveal_mode = await asyncio.to_thread(open_asset_target, target, "file")
  except (
    ModelPathError,
    FileNotFoundError,
    PermissionError,
    ValueError,
  ) as error:
    return _model_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to open model file: {error}")
    return _model_error(error)
  return web.json_response(
    {
      "ok": True,
      "category": category,
      "relativePath": relative_path,
      "absolutePath": target,
      "revealMode": reveal_mode,
    },
    headers=NO_STORE_HEADERS,
  )


@ROUTES.get("/assets-astral/models/tree")
async def get_model_tree(request: web.Request) -> web.Response:
  try:
    categories = _model_categories()
    result = await asyncio.to_thread(
      list_model_tree,
      categories,
      str(request.query.get("category", "")),
      _query_int(request, "root_index", -1),
      str(request.query.get("path", "")),
    )
    result["categories"] = categories
  except (ModelPathError, FileNotFoundError, ValueError) as error:
    return _model_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to read model tree: {error}")
    return _model_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/models/duplicates")
async def post_model_duplicates(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    category = str(payload.get("category", "")).strip()
    categories = await asyncio.to_thread(_model_categories)
    task, started = DUPLICATE_SCAN_MANAGER.start(
      categories,
      category_filter=category,
    )
  except (ValueError, ModelPathError) as error:
    return _model_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to start duplicate model scan: {error}")
    return _model_error(error)
  return web.json_response(
    {
      "task": task,
      "started": started,
    },
    status=202,
    headers=NO_STORE_HEADERS,
  )


@ROUTES.get("/assets-astral/models/duplicates/status")
async def get_model_duplicates_status(request: web.Request) -> web.Response:
  task_id = str(request.query.get("task_id", "")).strip() or None
  try:
    task = DUPLICATE_SCAN_MANAGER.snapshot(task_id)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to read duplicate scan status: {error}")
    return _error("Failed to read duplicate model scan progress", 500)
  if task_id and task is None:
    return _error("Scan task not found; ComfyUI may have restarted", 404)
  return web.json_response({"task": task}, headers=NO_STORE_HEADERS)


@ROUTES.post("/assets-astral/models/duplicates/cancel")
async def post_model_duplicates_cancel(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    task_id = str(payload.get("taskId", "")).strip() or None
    task = DUPLICATE_SCAN_MANAGER.cancel(task_id)
  except ValueError as error:
    return _model_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Unable to cancel duplicate model scan: {error}")
    return _error("Failed to cancel duplicate model scan", 500)
  if task is None:
    return _error("No duplicate model scan to cancel", 404)
  return web.json_response({"task": task}, headers=NO_STORE_HEADERS)


def _clear_filename_caches() -> None:
  cache = getattr(folder_paths, "filename_list_cache", None)
  if isinstance(cache, dict):
    cache.clear()
  helper = getattr(folder_paths, "cache_helper", None)
  clear = getattr(helper, "clear", None)
  if callable(clear):
    clear()


@ROUTES.post("/assets-astral/models/recycle")
async def post_model_recycle(request: web.Request) -> web.Response:
  try:
    payload = await _json_body(request)
    result = await asyncio.to_thread(
      recycle_model_file,
      _model_categories(),
      str(payload.get("category", "")),
      payload.get("rootIndex"),
      str(payload.get("relativePath", "")),
      confirm=payload.get("confirm") is True,
    )
    _clear_filename_caches()
  except (
    ModelPathError,
    RecycleBinError,
    FileNotFoundError,
    PermissionError,
    ValueError,
  ) as error:
    return _model_error(error)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Model recycle failed: {error}")
    return _model_error(error)
  return web.json_response(result, headers=NO_STORE_HEADERS)


@ROUTES.get("/assets-astral/thumbnails/proxy")
async def get_source_thumbnail(request: web.Request) -> web.StreamResponse:
  url = str(request.query.get("url", "")).strip()
  if not url:
    return _error("Missing thumbnail URL", 400)
  cache_directory = os.path.join(
    folder_paths.get_temp_directory(),
    "assets_astral_source_thumbnails",
  )
  try:
    thumbnail = await asyncio.to_thread(
      cache_thumbnail,
      url,
      cache_directory,
    )
  except ThumbnailError as error:
    return _error(str(error), 400)
  except Exception as error:
    print(f"[ComfyUI-Astral-Manage] Thumbnail proxy failed: {error}")
    return _error("Unable to fetch model thumbnail", 502)
  content_type = mimetypes.guess_type(thumbnail)[0] or "application/octet-stream"
  return web.FileResponse(
    thumbnail,
    headers={
      "Content-Type": content_type,
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  )
