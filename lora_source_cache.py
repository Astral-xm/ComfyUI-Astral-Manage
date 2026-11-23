from __future__ import annotations

import copy
import json
import os
import re
import tempfile
import time
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import urlencode

from .model_card_info import normalize_trigger_words
from .thumbnail_proxy import download_thumbnail_image


PREVIEW_EXTENSIONS = (
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".avif",
  ".bmp",
)
SIDECAR_KEYS = {
  "triggerWords",
  "recommendedWeight",
  "civitaiUrl",
  "civitaiStatus",
  "previewImage",
  "assetsAstral",
}
_NUMBER = re.compile(r"[+-]?(?:\d+(?:\.\d+)?|\.\d+)")


def _stem(path: str) -> str:
  return os.path.splitext(os.path.abspath(path))[0]


def sidecar_candidates(path: str) -> list[str]:
  stem = _stem(path)
  return [f"{stem}.json", f"{stem}.astral.json"]


def find_lora_preview(path: str) -> str | None:
  stem = _stem(path)
  directory = os.path.dirname(stem)
  prefix = f"{os.path.basename(stem)}.preview."
  try:
    with os.scandir(directory) as entries:
      candidates = [
        entry.path
        for entry in entries
        if entry.is_file()
        and not entry.is_symlink()
        and entry.name.casefold().startswith(prefix.casefold())
        and os.path.splitext(entry.name)[1].casefold() in PREVIEW_EXTENSIONS
      ]
  except OSError:
    return None
  if not candidates:
    return None
  extension_order = {
    extension: index for index, extension in enumerate(PREVIEW_EXTENSIONS)
  }
  candidates.sort(
    key=lambda candidate: (
      extension_order.get(
        os.path.splitext(candidate)[1].casefold(),
        len(extension_order),
      ),
      candidate.casefold(),
    )
  )
  return candidates[0]


def _read_json(path: str) -> dict[str, Any] | None:
  try:
    with open(path, "r", encoding="utf-8") as handle:
      data = json.load(handle)
  except (OSError, UnicodeDecodeError, json.JSONDecodeError):
    return None
  return data if isinstance(data, dict) else None


def _is_lora_sidecar(data: dict[str, Any] | None) -> bool:
  return bool(data) and any(key in data for key in SIDECAR_KEYS)


def _read_sidecar(path: str) -> tuple[str | None, dict[str, Any] | None]:
  for candidate in sidecar_candidates(path):
    data = _read_json(candidate)
    if _is_lora_sidecar(data):
      return candidate, data
  return None, None


def _iso_timestamp(timestamp: float) -> str:
  return (
    datetime.fromtimestamp(timestamp, timezone.utc)
    .isoformat(timespec="milliseconds")
    .replace("+00:00", "Z")
  )


def _timestamp(value: Any) -> float:
  if isinstance(value, (int, float)):
    return float(value)
  text = str(value or "").strip()
  if not text:
    return 0.0
  try:
    return float(text)
  except ValueError:
    pass
  try:
    return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
  except ValueError:
    return 0.0


def _strength_from_text(value: Any) -> dict[str, Any] | None:
  if isinstance(value, dict):
    text = str(value.get("text") or "").strip()
    if not text:
      return None
    return {
      "text": text,
      "value": value.get("value"),
      "min": value.get("min"),
      "max": value.get("max"),
      "source": str(value.get("source") or "Local cache"),
    }
  text = str(value or "").strip()
  if not text:
    return None
  numbers = [float(number) for number in _NUMBER.findall(text)]
  if not numbers:
    return None
  low = min(numbers)
  high = max(numbers)
  return {
    "text": text,
    "value": round((low + high) / 2, 2),
    "min": low,
    "max": high,
    "source": "Local cache",
  }


def _fallback_result_from_nb_data(
  file: str,
  data: dict[str, Any],
) -> dict[str, Any]:
  civitai_url = str(data.get("civitaiUrl") or "").strip()
  matched = (
    bool(civitai_url)
    and str(data.get("civitaiStatus") or "").strip().casefold()
    in {"matched", "ok", "success"}
  )
  triggers = normalize_trigger_words(data.get("triggerWords"))
  recommendation = _strength_from_text(data.get("recommendedWeight"))
  civitai = {
    "ok": matched,
    "match": "sha256" if matched else None,
    "url": civitai_url or None,
    "name": str(data.get("name") or file),
    "baseModel": data.get("baseModel"),
    "recommendedStrength": recommendation,
    "triggers": triggers,
    "modelId": data.get("civitaiModelId"),
    "modelVersionId": data.get("civitaiVersionId"),
    "versionName": data.get("civitaiVersionName"),
    "description": data.get("description"),
  }
  if not matched:
    civitai["error"] = str(
      data.get("civitaiError")
      or "No usable Civitai match is available in the local cache. Click Refresh Sources to retrieve it again."
    )
  unavailable = {
    "ok": False,
    "error": "The local cache does not contain this source. Click Refresh Sources to retrieve it again.",
  }
  return {
    "file": file,
    "sha256": data.get("sha256"),
    "metadata": {},
    "searchQueries": [],
    "refreshedAt": int(_timestamp(data.get("updatedAt"))),
    "recommendedStrength": recommendation,
    "recommendedStrengthSource": (
      recommendation.get("source") if recommendation else None
    ),
    "triggers": triggers,
    "triggersSource": "NB local cache" if triggers else None,
    "thumbnailUrl": None,
    "thumbnailSource": None,
    "sources": {
      "civitai": civitai,
      "huggingface": dict(unavailable),
      "modelscope": dict(unavailable),
    },
    "cachedOnly": True,
  }


def _preview_url(file: str, preview: str) -> str:
  try:
    version = str(os.stat(preview).st_mtime_ns)
  except OSError:
    version = str(int(time.time()))
  return (
    "/assets-astral/loras/thumbnail?"
    + urlencode({"file": file, "v": version})
  )


def _attach_cache_metadata(
  result: dict[str, Any],
  *,
  file: str,
  sidecar_path: str,
  preview: str | None,
  updated_at: str,
) -> dict[str, Any]:
  result["file"] = file
  result["cachedAt"] = updated_at
  result["cache"] = {
    "persisted": True,
    "sidecar": os.path.basename(sidecar_path),
    "updatedAt": updated_at,
    **(
      {"preview": os.path.basename(preview)}
      if preview
      else {}
    ),
  }
  if preview:
    result["thumbnailLocalUrl"] = _preview_url(file, preview)
    result["thumbnailLocalFile"] = os.path.basename(preview)
    if not result.get("thumbnailSource"):
      result["thumbnailSource"] = "Local thumbnail"
  return result


def load_lora_source_cache(file: str, path: str) -> dict[str, Any] | None:
  sidecar_path, data = _read_sidecar(path)
  if not sidecar_path or data is None:
    return None
  full_result = data.get("assetsAstral")
  if isinstance(full_result, dict):
    result = copy.deepcopy(full_result)
    result["file"] = file
  else:
    result = _fallback_result_from_nb_data(file, data)
  updated_at = str(
    data.get("updatedAt")
    or data.get("civitaiCheckedAt")
    or result.get("cachedAt")
    or ""
  )
  return _attach_cache_metadata(
    result,
    file=file,
    sidecar_path=sidecar_path,
    preview=find_lora_preview(path),
    updated_at=updated_at,
  )


def _write_json_atomic(path: str, payload: dict[str, Any]) -> None:
  directory = os.path.dirname(path)
  os.makedirs(directory, exist_ok=True)
  descriptor, temporary = tempfile.mkstemp(
    prefix=f".{os.path.basename(path)}.",
    suffix=".tmp",
    dir=directory,
  )
  try:
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
      json.dump(
        payload,
        handle,
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
      )
      handle.write("\n")
      handle.flush()
      os.fsync(handle.fileno())
    os.replace(temporary, path)
  finally:
    if os.path.exists(temporary):
      os.remove(temporary)


def _sidecar_for_write(path: str) -> tuple[str, dict[str, Any]]:
  existing_path, existing_data = _read_sidecar(path)
  if existing_path and existing_data is not None:
    return existing_path, existing_data
  standard_path = sidecar_candidates(path)[0]
  if not os.path.exists(standard_path):
    return standard_path, {}
  return sidecar_candidates(path)[1], {}


def _download_preview(
  path: str,
  url: str,
  downloader: Callable[[str], tuple[bytes, str]] | None,
) -> str | None:
  existing = find_lora_preview(path)
  if existing:
    return existing
  value = str(url or "").strip()
  if not value:
    return None
  download = downloader or download_thumbnail_image
  data, extension = download(value)
  extension = extension.casefold()
  if extension not in PREVIEW_EXTENSIONS:
    raise ValueError("Downloaded thumbnail format is not supported")
  target = f"{_stem(path)}.preview{extension}"
  descriptor, temporary = tempfile.mkstemp(
    prefix=f".{os.path.basename(target)}.",
    suffix=".tmp",
    dir=os.path.dirname(target),
  )
  try:
    with os.fdopen(descriptor, "wb") as handle:
      handle.write(data)
      handle.flush()
      os.fsync(handle.fileno())
    os.replace(temporary, target)
  finally:
    if os.path.exists(temporary):
      os.remove(temporary)
  return target


def persist_lora_source_result(
  file: str,
  path: str,
  result: dict[str, Any],
  *,
  downloader: Callable[[str], tuple[bytes, str]] | None = None,
) -> dict[str, Any]:
  sidecar_path, existing = _sidecar_for_write(path)
  preview = find_lora_preview(path)
  if not preview:
    try:
      preview = _download_preview(
        path,
        str(result.get("thumbnailUrl") or ""),
        downloader,
      )
    except Exception as error:
      print(
        "[ComfyUI-Astral-Manage] Unable to save LoRA preview locally: "
        f"{error}"
      )

  refreshed_at = float(result.get("refreshedAt") or time.time())
  updated_at = _iso_timestamp(refreshed_at)
  current_sources = (
    result.get("sources")
    if isinstance(result.get("sources"), dict)
    else {}
  )
  storage_result = copy.deepcopy(result)
  previous_result = (
    existing.get("assetsAstral")
    if isinstance(existing.get("assetsAstral"), dict)
    else {}
  )
  previous_sources = (
    previous_result.get("sources")
    if isinstance(previous_result.get("sources"), dict)
    else {}
  )
  merged_sources = dict(current_sources)
  preserved_sources: list[str] = []
  for source_name in ("civitai", "huggingface", "modelscope"):
    current_source = (
      current_sources.get(source_name)
      if isinstance(current_sources.get(source_name), dict)
      else {}
    )
    previous_source = (
      previous_sources.get(source_name)
      if isinstance(previous_sources.get(source_name), dict)
      else {}
    )
    if not current_source.get("ok") and previous_source.get("ok"):
      merged_sources[source_name] = copy.deepcopy(previous_source)
      preserved_sources.append(source_name)
  storage_result["sources"] = merged_sources
  storage_result["lastRefreshAttempt"] = {
    "refreshedAt": int(refreshed_at),
    "sources": {
      source_name: {
        "ok": bool(source.get("ok")),
        "error": source.get("error"),
      }
      for source_name, source in current_sources.items()
      if isinstance(source, dict)
    },
  }
  if preserved_sources:
    result["preservedCachedSources"] = preserved_sources
  if not any(
    isinstance(source, dict) and source.get("ok")
    for source in current_sources.values()
  ) and previous_result:
    for key in (
      "recommendedStrength",
      "recommendedStrengthSource",
      "triggers",
      "triggersSource",
      "thumbnailUrl",
      "thumbnailSource",
    ):
      if previous_result.get(key):
        storage_result[key] = copy.deepcopy(previous_result[key])
  sources = merged_sources
  civitai = (
    sources.get("civitai")
    if isinstance(sources.get("civitai"), dict)
    else {}
  )
  triggers = normalize_trigger_words(storage_result.get("triggers"))
  recommendation = (
    storage_result.get("recommendedStrength")
    if isinstance(storage_result.get("recommendedStrength"), dict)
    else None
  )
  source_urls = {
    name: source.get("url")
    for name, source in sources.items()
    if isinstance(source, dict) and source.get("url")
  }

  full_result = copy.deepcopy(storage_result)
  for ephemeral_key in (
    "cache",
    "cachedAt",
    "thumbnailLocalUrl",
    "thumbnailLocalFile",
  ):
    full_result.pop(ephemeral_key, None)
  payload = dict(existing)
  payload.update(
    {
      "name": os.path.basename(path),
      "triggerWords": ", ".join(triggers),
      "recommendedWeight": (
        str(recommendation.get("text") or "")
        if recommendation
        else ""
      ),
      "baseModel": civitai.get("baseModel"),
      "description": civitai.get("description") or "",
      "previewImage": preview or "",
      "previewType": "image" if preview else "",
      "previewVideo": "",
      "civitaiUrl": civitai.get("url") or "",
      "civitaiModelId": civitai.get("modelId"),
      "civitaiVersionId": civitai.get("modelVersionId"),
      "civitaiVersionName": civitai.get("versionName") or "",
      "civitaiStatus": "matched" if civitai.get("ok") else "failed",
      "civitaiCheckedAt": updated_at,
      "civitaiError": (
        ""
        if civitai.get("ok")
        else str(civitai.get("error") or "")
      ),
      "sourceUrls": source_urls,
      "updatedAt": updated_at,
      "assetsAstral": full_result,
    }
  )
  _write_json_atomic(sidecar_path, payload)
  return _attach_cache_metadata(
    result,
    file=file,
    sidecar_path=sidecar_path,
    preview=preview,
    updated_at=updated_at,
  )
