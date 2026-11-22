from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import struct
import time
from functools import lru_cache
from typing import Any
from urllib.parse import quote, urlencode, urljoin, urlsplit

import requests

from .civitai_info import (
  error_message_for_status,
  extract_recommended_strength_from_text,
  normalize_civitai_model_version,
)
from .model_card_info import (
  extract_trigger_words_from_model_card,
  has_no_trigger_statement,
  normalize_trigger_words,
)


CIVITAI_API = "https://civitai.com/api/v1/model-versions/by-hash/{sha256}"
HUGGINGFACE_API = "https://huggingface.co/api/models"
HUGGINGFACE_README_API = "https://huggingface.co/{model_id}/raw/main/README.md"
MODELSCOPE_API = "https://www.modelscope.cn/api/v1/dolphin/models"
MODELSCOPE_FILES_API = "https://www.modelscope.cn/api/v1/models/{model_id}/repo/files"
MODELSCOPE_MODEL_API = "https://www.modelscope.cn/api/v1/models/{model_id}"
USER_AGENT = "ComfyUI-Astral-Manage/0.7.0"
CACHE_SECONDS = 15 * 60
MAX_SEARCH_QUERIES = 8
MAX_VERIFY_CANDIDATES = 6
MAX_HF_TREE_PAGES = 20
HF_PATHS_PER_REQUEST = 100
MAX_SAFETENSORS_HEADER_BYTES = 16 * 1024 * 1024
MAX_MODEL_CARD_CHARS = 512 * 1024
_source_cache: dict[tuple[str, int, int], tuple[float, dict[str, Any]]] = {}

SEARCH_LEADING_STOPWORDS = {
  "flux",
  "krea",
  "krea2",
  "lora",
  "pony",
  "qwen",
  "sd15",
  "sd3",
  "sdxl",
  "wan",
  "zimage",
}
SAFETENSORS_NAME_KEYS = (
  "modelspec.title",
  "ss_output_name",
  "ss_model_name",
  "model_name",
  "name",
  "title",
)
SAFETENSORS_DETAIL_KEYS = (
  *SAFETENSORS_NAME_KEYS,
  "modelspec.architecture",
  "modelspec.description",
  "ss_base_model_version",
  "ss_sd_model_name",
  "ss_network_module",
  "ss_network_dim",
  "ss_network_alpha",
)


class SourceRequestError(Exception):
  def __init__(self, message: str, http_status: int = 502):
    super().__init__(message)
    self.http_status = http_status


def _is_https_image_url(value: Any) -> bool:
  if not isinstance(value, str) or not value.strip():
    return False
  try:
    parsed = urlsplit(value.strip())
  except ValueError:
    return False
  return parsed.scheme.lower() == "https" and bool(parsed.hostname)


def _markdown_image_url(value: str, base_url: str) -> str | None:
  if not value:
    return None
  patterns = (
    r"!\[[^\]]*\]\((https?://[^)\s]+)",
    r"<img[^>]+src=[\"'](https?://[^\"']+)",
    r"(?im)^\s*(?:thumbnail|cover|preview)\s*:\s*(https?://\S+)",
  )
  for pattern in patterns:
    match = re.search(pattern, value, flags=re.IGNORECASE)
    if not match:
      continue
    candidate = urljoin(base_url, match.group(1))
    if _is_https_image_url(candidate):
      return candidate
  return None


def _first_mapping_image(
  value: Any,
  keys: set[str],
  *,
  base_url: str,
  depth: int = 0,
) -> str | None:
  if depth > 6:
    return None
  if isinstance(value, str):
    candidate = urljoin(base_url, value.strip())
    return candidate if _is_https_image_url(candidate) else None
  if isinstance(value, list):
    for item in value:
      candidate = _first_mapping_image(
        item,
        keys,
        base_url=base_url,
        depth=depth + 1,
      )
      if candidate:
        return candidate
    return None
  if not isinstance(value, dict):
    return None
  for key, item in value.items():
    if str(key).casefold() in keys:
      candidate = _first_mapping_image(
        item,
        keys,
        base_url=base_url,
        depth=depth + 1,
      )
      if candidate:
        return candidate
  return None


def _normalize_proxy_url(value: str) -> str:
  value = value.strip()
  return value if "://" in value else f"http://{value}"


def _parse_windows_proxy_server(value: str) -> dict[str, str]:
  entries = [entry.strip() for entry in str(value or "").split(";") if entry.strip()]
  if not entries:
    return {}
  if not any("=" in entry for entry in entries):
    proxy = _normalize_proxy_url(entries[0])
    return {"http": proxy, "https": proxy}

  proxies: dict[str, str] = {}
  for entry in entries:
    if "=" not in entry:
      continue
    scheme, address = entry.split("=", 1)
    scheme = scheme.strip().lower()
    if scheme in {"http", "https"} and address.strip():
      proxies[scheme] = _normalize_proxy_url(address)
  if "https" not in proxies and "http" in proxies:
    proxies["https"] = proxies["http"]
  return proxies


@lru_cache(maxsize=1)
def windows_system_proxies() -> dict[str, str]:
  """Read the current user's Windows proxy so requests does not use a stale env proxy."""
  if os.name != "nt":
    return {}
  try:
    import winreg

    settings_path = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings"
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, settings_path) as key:
      enabled, _ = winreg.QueryValueEx(key, "ProxyEnable")
      if not enabled:
        return {}
      server, _ = winreg.QueryValueEx(key, "ProxyServer")
  except (ImportError, OSError):
    return {}
  return _parse_windows_proxy_server(str(server or ""))


def request_with_system_proxy(method: str, url: str, **kwargs: Any):
  proxies = windows_system_proxies()
  if proxies:
    kwargs["proxies"] = proxies
  return requests.request(method, url, **kwargs)


def _request_error(source: str, error: requests.exceptions.RequestException) -> SourceRequestError:
  if isinstance(error, requests.exceptions.Timeout):
    return SourceRequestError(f"{source}请求超时，请检查网络后重试", 504)
  if isinstance(error, requests.exceptions.SSLError):
    return SourceRequestError(f"与{source}建立 TLS 连接失败，请检查代理设置", 502)
  if isinstance(error, requests.exceptions.ConnectionError):
    return SourceRequestError(f"无法连接{source}，请检查网络或代理设置", 502)
  return SourceRequestError(f"访问{source}失败，请检查网络或代理设置", 502)


def _status_error(source: str, status_code: int) -> SourceRequestError:
  if status_code == 429:
    message = f"{source}请求过于频繁，请稍后重试"
  elif status_code in (401, 403):
    message = f"{source}要求登录或 API 密钥"
  elif status_code == 404:
    message = f"{source}未找到匹配内容"
  elif status_code >= 500:
    message = f"{source}服务暂时不可用（HTTP {status_code}）"
  else:
    message = f"{source}返回 HTTP {status_code}"
  return SourceRequestError(message, status_code)


def _json_request_with_headers(
  source: str,
  method: str,
  url: str,
  *,
  params: dict[str, Any] | None = None,
  body: dict[str, Any] | None = None,
) -> tuple[Any, dict[str, str]]:
  try:
    response = request_with_system_proxy(
      method,
      url,
      params=params,
      json=body,
      headers={
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      timeout=(10, 25),
      allow_redirects=True,
    )
  except requests.exceptions.RequestException as error:
    raise _request_error(source, error) from error
  if response.status_code != 200:
    raise _status_error(source, response.status_code)
  try:
    payload = response.json()
  except (ValueError, UnicodeDecodeError) as error:
    raise SourceRequestError(f"{source}返回的数据不是有效 JSON", 502) from error
  headers = {
    str(key): str(value)
    for key, value in response.headers.items()
  }
  return payload, headers


def _json_request(
  source: str,
  method: str,
  url: str,
  *,
  params: dict[str, Any] | None = None,
  body: dict[str, Any] | None = None,
) -> Any:
  payload, _headers = _json_request_with_headers(
    source,
    method,
    url,
    params=params,
    body=body,
  )
  return payload


def _text_request(
  source: str,
  method: str,
  url: str,
  *,
  params: dict[str, Any] | None = None,
  max_chars: int = MAX_MODEL_CARD_CHARS,
) -> str:
  try:
    response = request_with_system_proxy(
      method,
      url,
      params=params,
      headers={
        "Accept": "text/plain, text/markdown, */*",
        "User-Agent": USER_AGENT,
      },
      timeout=(10, 25),
      allow_redirects=True,
    )
  except requests.exceptions.RequestException as error:
    raise _request_error(source, error) from error
  if response.status_code != 200:
    raise _status_error(source, response.status_code)
  content = getattr(response, "content", b"")
  if isinstance(content, bytes):
    text = content.decode("utf-8-sig", errors="replace")
  else:
    text = str(getattr(response, "text", "") or "")
  return text[:max_chars]


def _read_safetensors_metadata(path: str) -> dict[str, str]:
  """Read only the JSON header; the tensor payload is never loaded."""
  if not str(path).lower().endswith(".safetensors"):
    return {}
  try:
    with open(path, "rb") as model_file:
      raw_length = model_file.read(8)
      if len(raw_length) != 8:
        return {}
      header_length = struct.unpack("<Q", raw_length)[0]
      if header_length <= 0 or header_length > MAX_SAFETENSORS_HEADER_BYTES:
        return {}
      header = json.loads(model_file.read(header_length).decode("utf-8"))
  except (OSError, UnicodeDecodeError, ValueError, struct.error):
    return {}
  raw_metadata = header.get("__metadata__") if isinstance(header, dict) else None
  if not isinstance(raw_metadata, dict):
    return {}
  metadata: dict[str, str] = {}
  for raw_key, raw_value in raw_metadata.items():
    key = str(raw_key).strip()
    if not key or raw_value is None:
      continue
    value = raw_value if isinstance(raw_value, str) else json.dumps(
      raw_value,
      ensure_ascii=False,
    )
    if len(value) > 4000:
      value = value[:4000]
    metadata[key] = value
  return metadata


def _clean_name(value: Any) -> str:
  text = str(value or "").replace("\r", " ").replace("\n", " ")
  text = os.path.splitext(text.rsplit("/", 1)[-1].rsplit("\\", 1)[-1])[0]
  return " ".join(text.split()).strip(" \t-_,.")


def _name_variants(value: Any) -> list[str]:
  raw = _clean_name(value)
  if not raw:
    return []
  display = " ".join(re.sub(r"[_\-.]+", " ", raw).split())
  compact = " ".join(re.sub(r"[^\w]+", " ", raw, flags=re.UNICODE).split())
  ascii_tokens = re.findall(r"[A-Za-z0-9]+", raw)
  ascii_compact = " ".join(ascii_tokens)
  leading = re.split(r"[\s_.-]+", raw, maxsplit=1)[0].strip()
  versionless = re.sub(
    r"(?i)(?:\s+(?:v|ver|version)\s*\d+(?:\.\d+)*|\s+\d{4,8})$",
    "",
    compact,
  ).strip()
  variants = [raw, display, compact, ascii_compact]
  if re.search(r"\s[-–—|]\s", raw):
    variants.extend(part.strip() for part in re.split(r"\s+[-–—|]\s+", raw))
  if (
    len(leading) >= 5
    and leading.casefold() not in SEARCH_LEADING_STOPWORDS
    and leading.casefold() != raw.casefold()
  ):
    variants.append(leading)
  variants.append(versionless)
  meaningful: list[str] = []
  for query in dict.fromkeys(variants):
    normalized = query.casefold().strip()
    if len(query) < 2 or normalized in {"none", "unknown", "lora"}:
      continue
    if not re.search(r"[a-z\u3400-\u9fff]", normalized, flags=re.IGNORECASE):
      continue
    if re.match(r"^(?:v|ver|version)\s*\d+(?:\.\d+)*\b", normalized):
      continue
    meaningful.append(query)
  return meaningful


def _search_query_entries(
  file: str,
  *,
  aliases: list[str] | None = None,
  canonical_name: str | None = None,
) -> list[tuple[str, str]]:
  entries: list[tuple[str, str]] = []

  def add_names(names: list[str], basis: str) -> None:
    for name in names:
      for query in _name_variants(name):
        key = (query.casefold(), basis)
        if key not in {(item[0].casefold(), item[1]) for item in entries}:
          entries.append((query, basis))

  if canonical_name:
    add_names([canonical_name], "canonical")
  add_names(list(aliases or []), "metadata")
  add_names([file], "filename")
  return entries[:MAX_SEARCH_QUERIES]


def search_queries(
  file: str,
  *,
  aliases: list[str] | None = None,
  canonical_name: str | None = None,
) -> list[str]:
  return [
    query
    for query, _basis in _search_query_entries(
      file,
      aliases=aliases,
      canonical_name=canonical_name,
    )
  ]


def summarize_safetensors_metadata(metadata: dict[str, str] | None) -> dict[str, Any]:
  metadata = metadata or {}
  aliases: list[str] = []
  for key in SAFETENSORS_NAME_KEYS:
    for alias in _name_variants(metadata.get(key)):
      if alias.casefold() not in {item.casefold() for item in aliases}:
        aliases.append(alias)
  details = {
    key: metadata[key]
    for key in SAFETENSORS_DETAIL_KEYS
    if key in metadata and metadata[key]
  }
  return {
    "aliases": aliases[:8],
    "details": details,
  }


def _basis_match(basis: str) -> tuple[str, str]:
  if basis == "canonical":
    return "civitai-name", "C站哈希对应的名称引导候选"
  if basis == "metadata":
    return "metadata", "Safetensors 元数据候选"
  return "name-candidate", "名称候选，未经文件哈希确认"


def _mark_match(candidate: dict[str, Any], basis: str) -> None:
  match_type, match_label = _basis_match(basis)
  candidate.setdefault("matchType", match_type)
  candidate.setdefault("matchLabel", match_label)
  candidate.setdefault("searchBasis", basis)


def _mark_exact_hash(candidate: dict[str, Any], file_name: str) -> None:
  candidate["matchType"] = "sha256"
  candidate["matchLabel"] = "SHA256 精确匹配"
  candidate["matchedFile"] = file_name


def _candidate_rank(candidate: dict[str, Any]) -> tuple[int, int, str]:
  match_rank = {
    "sha256": 0,
    "metadata": 1,
    "civitai-name": 2,
    "name-candidate": 3,
  }.get(str(candidate.get("matchType")), 4)
  downloads = candidate.get("downloads")
  try:
    popularity = -int(downloads)
  except (TypeError, ValueError):
    popularity = 0
  return match_rank, popularity, str(candidate.get("id") or "").casefold()


def _iter_huggingface_files(payload: Any):
  entries = payload
  if isinstance(payload, dict):
    for key in ("siblings", "files"):
      if isinstance(payload.get(key), list):
        entries = payload[key]
        break
  if not isinstance(entries, list):
    return
  for entry in entries:
    if isinstance(entry, dict):
      yield entry


def _huggingface_file_hash(entry: dict[str, Any]) -> str:
  lfs = entry.get("lfs")
  if isinstance(lfs, dict):
    for key in ("oid", "sha256", "sha256sum"):
      value = str(lfs.get(key) or "").strip().lower()
      if len(value) == 64:
        return value
  for key in ("sha256", "sha256sum"):
    value = str(entry.get(key) or "").strip().lower()
    if len(value) == 64:
      return value
  return ""


def _huggingface_safetensors_paths(model: dict[str, Any]) -> list[str]:
  siblings = model.get("siblings")
  if not isinstance(siblings, list):
    return []
  paths: list[str] = []
  for entry in siblings:
    if not isinstance(entry, dict):
      continue
    path = str(entry.get("rfilename") or entry.get("path") or "").strip()
    if path.lower().endswith(".safetensors"):
      paths.append(path)
  return list(dict.fromkeys(paths))


def _verify_huggingface_paths(
  candidate: dict[str, Any],
  sha256: str,
  paths: list[str],
) -> bool | None:
  model_id = str(candidate.get("id") or "")
  wanted = str(sha256).strip().lower()
  errors: list[str] = []
  for offset in range(0, len(paths), HF_PATHS_PER_REQUEST):
    chunk = paths[offset : offset + HF_PATHS_PER_REQUEST]
    try:
      payload = _json_request(
        "Hugging Face",
        "POST",
        f"{HUGGINGFACE_API}/{quote(model_id, safe='/')}/paths-info/main",
        body={"paths": chunk},
      )
    except SourceRequestError as error:
      errors.append(str(error))
      continue
    for entry in _iter_huggingface_files(payload):
      if _huggingface_file_hash(entry) != wanted:
        continue
      file_name = str(entry.get("path") or entry.get("rfilename") or model_id)
      _mark_exact_hash(candidate, file_name)
      return True
  if errors:
    candidate["hashVerificationError"] = "；".join(dict.fromkeys(errors))
    return None
  return False


def _next_link(headers: dict[str, str]) -> str | None:
  match = re.search(
    r'<([^>]+)>;\s*rel="next"',
    str(headers.get("Link") or ""),
    flags=re.IGNORECASE,
  )
  return match.group(1) if match else None


def _verify_huggingface_tree(
  candidate: dict[str, Any],
  sha256: str,
) -> bool:
  model_id = str(candidate.get("id") or "")
  if not model_id:
    return False
  url = f"{HUGGINGFACE_API}/{quote(model_id, safe='/')}/tree/main"
  params: dict[str, Any] | None = {
    "recursive": "true",
    "expand": "true",
    "limit": 100,
  }
  wanted = str(sha256).strip().lower()
  try:
    for _page in range(MAX_HF_TREE_PAGES):
      payload, headers = _json_request_with_headers(
        "Hugging Face",
        "GET",
        url,
        params=params,
      )
      for entry in _iter_huggingface_files(payload):
        if _huggingface_file_hash(entry) != wanted:
          continue
        file_name = str(entry.get("path") or entry.get("rfilename") or model_id)
        _mark_exact_hash(candidate, file_name)
        return True
      next_url = _next_link(headers)
      if not next_url:
        break
      url = next_url
      params = None
  except SourceRequestError as error:
    candidate["hashVerificationError"] = str(error)
  return False


def _verify_huggingface_hash(
  candidate: dict[str, Any],
  sha256: str,
  paths: list[str] | None = None,
) -> bool:
  if paths:
    result = _verify_huggingface_paths(candidate, sha256, paths)
    if result is not None:
      return result
  return _verify_huggingface_tree(candidate, sha256)


def _model_url(base_url: str, *parts: str) -> str:
  return base_url.rstrip("/") + "/" + "/".join(quote(str(part), safe="") for part in parts)


def find_huggingface_sources(
  file: str,
  limit: int = 5,
  *,
  sha256: str | None = None,
  aliases: list[str] | None = None,
  canonical_name: str | None = None,
) -> dict[str, Any]:
  query_entries = _search_query_entries(
    file,
    aliases=aliases,
    canonical_name=canonical_name,
  )
  if not query_entries:
    query_entries = [(os.path.basename(file), "filename")]
  results: dict[str, dict[str, Any]] = {}
  warnings: list[str] = []
  successful_queries = 0
  hash_verified: set[str] = set()
  candidate_files: dict[str, list[str]] = {}

  for query, basis in query_entries:
    try:
      payload = _json_request(
        "Hugging Face",
        "GET",
        HUGGINGFACE_API,
        params={
          "search": query,
          "limit": max(1, min(10, int(limit))),
          "full": "false",
        },
      )
    except SourceRequestError as error:
      warnings.append(f"{query}：{error}")
      continue
    if not isinstance(payload, list):
      warnings.append(f"{query}：Hugging Face 返回了意外的数据格式")
      continue
    successful_queries += 1
    new_candidates: list[dict[str, Any]] = []
    for model in payload:
      if not isinstance(model, dict):
        continue
      model_id = str(model.get("id") or model.get("modelId") or "").strip()
      if not model_id or model_id in results:
        continue
      candidate = {
        "id": model_id,
        "name": model_id.rsplit("/", 1)[-1],
        "url": _model_url("https://huggingface.co", *model_id.split("/")),
        "downloads": model.get("downloads"),
        "likes": model.get("likes"),
        "pipelineTag": model.get("pipeline_tag"),
        "searchQuery": query,
      }
      candidate_files[model_id] = _huggingface_safetensors_paths(model)
      _mark_match(candidate, basis)
      results[model_id] = candidate
      new_candidates.append(candidate)
    if sha256:
      for candidate in new_candidates:
        _verify_huggingface_hash(
          candidate,
          sha256,
          candidate_files.get(str(candidate.get("id") or "")),
        )
        hash_verified.add(str(candidate.get("id") or ""))
      if any(candidate.get("matchType") == "sha256" for candidate in results.values()):
        break
    elif results:
      break

  if not successful_queries and warnings:
    raise SourceRequestError("；".join(warnings))

  candidates = sorted(results.values(), key=_candidate_rank)
  if sha256:
    for candidate in candidates[:MAX_VERIFY_CANDIDATES]:
      candidate_id = str(candidate.get("id") or "")
      if candidate_id not in hash_verified:
        _verify_huggingface_hash(
          candidate,
          sha256,
          candidate_files.get(candidate_id),
        )
    candidates.sort(key=_candidate_rank)

  primary_match = candidates[0]["matchType"] if candidates else "name-candidate"
  result: dict[str, Any] = {
    "ok": True,
    "match": primary_match,
    "query": query_entries[0][0],
    "queries": [query for query, _basis in query_entries],
    "candidates": candidates,
    "url": candidates[0]["url"] if candidates else None,
  }
  if warnings:
    result["warnings"] = warnings
  return result


def _iter_modelscope_files(value: Any):
  stack = [value]
  seen: set[int] = set()
  while stack:
    current = stack.pop()
    if isinstance(current, dict):
      identity = id(current)
      if identity in seen:
        continue
      seen.add(identity)
      if any(key in current for key in ("Sha256", "SHA256", "sha256", "OID", "Oid")):
        yield current
      stack.extend(current.values())
    elif isinstance(current, list):
      stack.extend(current)


def _modelscope_file_hash(entry: dict[str, Any]) -> str:
  for key in ("Sha256", "SHA256", "sha256", "sha256sum", "LfsSha256", "Oid", "OID"):
    value = str(entry.get(key) or "").strip().lower()
    if len(value) == 64:
      return value
  return ""


def _verify_modelscope_hash(candidate: dict[str, Any], sha256: str) -> None:
  model_id = str(candidate.get("id") or "")
  if not model_id:
    return
  try:
    payload = _json_request(
      "魔搭社区",
      "GET",
      MODELSCOPE_FILES_API.format(model_id=quote(model_id, safe="/")),
      params={"Revision": "master", "Recursive": "true", "Root": ""},
    )
  except SourceRequestError as error:
    candidate["hashVerificationError"] = str(error)
    return
  wanted = str(sha256).strip().lower()
  for entry in _iter_modelscope_files(payload):
    if _modelscope_file_hash(entry) != wanted:
      continue
    file_name = str(entry.get("Path") or entry.get("Name") or model_id)
    _mark_exact_hash(candidate, file_name)
    return


def find_modelscope_sources(
  file: str,
  limit: int = 5,
  *,
  sha256: str | None = None,
  aliases: list[str] | None = None,
  canonical_name: str | None = None,
) -> dict[str, Any]:
  query_entries = _search_query_entries(
    file,
    aliases=aliases,
    canonical_name=canonical_name,
  )
  if not query_entries:
    query_entries = [(os.path.basename(file), "filename")]
  results: dict[str, dict[str, Any]] = {}
  warnings: list[str] = []
  successful_queries = 0
  hash_verified: set[str] = set()

  for query, basis in query_entries:
    try:
      payload = _json_request(
        "魔搭社区",
        "PUT",
        MODELSCOPE_API,
        body={
          "PageSize": max(1, min(10, int(limit))),
          "PageNumber": 1,
          "SortBy": "Default",
          "Target": "",
          "SingleCriterion": [],
          "Name": query,
          "Criterion": [],
        },
      )
    except SourceRequestError as error:
      warnings.append(f"{query}：{error}")
      continue
    if not isinstance(payload, dict):
      warnings.append(f"{query}：魔搭社区返回了意外的数据格式")
      continue
    code = payload.get("Code")
    if code not in (None, 0, 200, "0", "200"):
      message = payload.get("Message") or payload.get("ErrorMessage") or f"接口错误码 {code}"
      warnings.append(f"{query}：魔搭社区搜索失败：{message}")
      continue
    successful_queries += 1
    model_data = payload.get("Data", {}).get("Model", {})
    models = model_data.get("Models", []) if isinstance(model_data, dict) else []
    if not isinstance(models, list):
      models = []
    new_candidates: list[dict[str, Any]] = []
    for model in models:
      if not isinstance(model, dict):
        continue
      owner = str(model.get("Path") or "").strip()
      name = str(model.get("Name") or "").strip()
      if not name:
        continue
      model_id = f"{owner}/{name}" if owner else name
      if model_id in results:
        continue
      candidate = {
        "id": model_id,
        "name": str(model.get("ChineseName") or name),
        "url": _model_url("https://www.modelscope.cn/models", owner, name)
        if owner
        else _model_url("https://www.modelscope.cn/models", name),
        "downloads": model.get("Downloads"),
        "stars": model.get("Stars"),
        "searchQuery": query,
      }
      _mark_match(candidate, basis)
      results[model_id] = candidate
      new_candidates.append(candidate)
    if sha256:
      for candidate in new_candidates:
        _verify_modelscope_hash(candidate, sha256)
        hash_verified.add(str(candidate.get("id") or ""))
      if any(candidate.get("matchType") == "sha256" for candidate in results.values()):
        break
    elif results:
      break

  if not successful_queries and warnings:
    raise SourceRequestError("；".join(warnings))

  candidates = sorted(results.values(), key=_candidate_rank)
  if sha256:
    for candidate in candidates[:MAX_VERIFY_CANDIDATES]:
      candidate_id = str(candidate.get("id") or "")
      if candidate_id not in hash_verified:
        _verify_modelscope_hash(candidate, sha256)
    candidates.sort(key=_candidate_rank)

  primary_match = candidates[0]["matchType"] if candidates else "name-candidate"
  result: dict[str, Any] = {
    "ok": True,
    "match": primary_match,
    "query": query_entries[0][0],
    "queries": [query for query, _basis in query_entries],
    "candidates": candidates,
    "url": candidates[0]["url"] if candidates else None,
  }
  if warnings:
    result["warnings"] = warnings
  return result


def _verified_candidate(source: dict[str, Any]) -> dict[str, Any] | None:
  candidates = source.get("candidates")
  if not isinstance(candidates, list):
    return None
  for candidate in candidates:
    if (
      isinstance(candidate, dict)
      and candidate.get("matchType") == "sha256"
      and candidate.get("id")
    ):
      return candidate
  return None


def _source_warning(source: dict[str, Any], message: str) -> None:
  if not message:
    return
  warnings = source.setdefault("warnings", [])
  if isinstance(warnings, list) and message not in warnings:
    warnings.append(message)


def _enrich_huggingface_source(source: dict[str, Any]) -> None:
  if not source.get("ok"):
    return
  candidate = _verified_candidate(source)
  if not candidate:
    return

  model_id = str(candidate.get("id") or "")
  api_payload: dict[str, Any] = {}
  readme = ""
  warnings: list[str] = []
  try:
    payload = _json_request(
      "Hugging Face",
      "GET",
      f"{HUGGINGFACE_API}/{quote(model_id, safe='/')}",
    )
    if isinstance(payload, dict):
      api_payload = payload
    else:
      warnings.append("Hugging Face 模型接口返回了意外的数据格式")
  except SourceRequestError as error:
    warnings.append(f"Hugging Face 模型接口：{error}")
  try:
    readme = _text_request(
      "Hugging Face",
      "GET",
      HUGGINGFACE_README_API.format(model_id=quote(model_id, safe="/")),
    )
  except SourceRequestError as error:
    if error.http_status != 404:
      warnings.append(f"Hugging Face README：{error}")

  card_data = api_payload.get("cardData")
  if not isinstance(card_data, dict):
    card_data = {}
  structured_triggers: list[str] = []
  for key in (
    "instance_prompt",
    "trigger_words",
    "triggerWords",
    "trained_words",
    "trainedWords",
  ):
    if key in card_data:
      structured_triggers.extend(normalize_trigger_words(card_data[key]))
  readme_triggers = extract_trigger_words_from_model_card(readme)
  triggers = normalize_trigger_words([structured_triggers, readme_triggers])
  recommendation = extract_recommended_strength_from_text(
    readme,
    "Hugging Face 模型卡",
  )
  thumbnail_url = _first_mapping_image(
    card_data,
    {
      "thumbnail",
      "thumbnailurl",
      "cover",
      "coverimage",
      "cover_image",
      "previewimage",
      "image",
    },
    base_url=f"https://huggingface.co/{model_id}/",
  )
  if not thumbnail_url:
    thumbnail_url = _markdown_image_url(
      readme,
      f"https://huggingface.co/{model_id}/raw/main/",
    )

  if recommendation:
    source["recommendedStrength"] = recommendation
  if triggers:
    source["triggers"] = triggers
    source["triggersSource"] = "Hugging Face 模型卡"
  if thumbnail_url:
    source["thumbnailUrl"] = thumbnail_url
    source["thumbnailSource"] = "Hugging Face 模型卡"
  source["modelDetails"] = {
    "id": model_id,
    "readmeLoaded": bool(readme),
    "noTriggersDeclared": has_no_trigger_statement(readme),
  }
  for warning in warnings:
    _source_warning(source, warning)


def _modelscope_rich_text(value: Any) -> str:
  if isinstance(value, str):
    stripped = value.strip()
    if stripped[:1] in "[{":
      try:
        value = json.loads(stripped)
      except (TypeError, ValueError):
        return value
    else:
      return value
  if isinstance(value, list):
    return " ".join(
      text
      for item in value
      if (text := _modelscope_rich_text(item)).strip()
    )
  if isinstance(value, dict):
    return " ".join(
      text
      for item in value.values()
      if (text := _modelscope_rich_text(item)).strip()
    )
  return ""


def _enrich_modelscope_source(source: dict[str, Any]) -> None:
  if not source.get("ok"):
    return
  candidate = _verified_candidate(source)
  if not candidate:
    return

  model_id = str(candidate.get("id") or "")
  try:
    payload = _json_request(
      "魔搭社区",
      "GET",
      MODELSCOPE_MODEL_API.format(model_id=quote(model_id, safe="/")),
    )
  except SourceRequestError as error:
    _source_warning(source, f"魔搭模型详情：{error}")
    return
  if not isinstance(payload, dict):
    _source_warning(source, "魔搭模型详情返回了意外的数据格式")
    return
  code = payload.get("Code")
  if code not in (None, 0, 200, "0", "200"):
    message = payload.get("Message") or f"接口错误码 {code}"
    _source_warning(source, f"魔搭模型详情：{message}")
    return
  data = payload.get("Data")
  if not isinstance(data, dict):
    _source_warning(source, "魔搭模型详情缺少 Data 数据")
    return

  thumbnail_url = _first_mapping_image(
    data,
    {
      "thumbnail",
      "thumbnailurl",
      "cover",
      "coverimage",
      "coverimages",
      "coverimageurl",
      "previewimage",
      "image",
      "images",
    },
    base_url=f"https://www.modelscope.cn/models/{model_id}/",
  )
  raw_triggers: list[Any] = [data.get("TriggerWords")]
  muse_info = data.get("MuseInfo")
  if isinstance(muse_info, dict):
    versions = muse_info.get("versions")
    if isinstance(versions, list):
      for version in versions:
        if not isinstance(version, dict):
          continue
        model_version = version.get("modelVersion")
        if isinstance(model_version, dict):
          raw_triggers.append(model_version.get("triggerWords"))
  triggers = normalize_trigger_words(raw_triggers)

  text_parts = [
    data.get("Description"),
    data.get("ReadMeContent"),
  ]
  if isinstance(muse_info, dict):
    muse_model = muse_info.get("model")
    if isinstance(muse_model, dict):
      text_parts.append(_modelscope_rich_text(muse_model.get("description")))
    versions = muse_info.get("versions")
    if isinstance(versions, list):
      for version in versions:
        if not isinstance(version, dict):
          continue
        model_version = version.get("modelVersion")
        if isinstance(model_version, dict):
          text_parts.append(
            _modelscope_rich_text(model_version.get("description")),
          )
  model_card_text = "\n".join(
    str(part or "") for part in text_parts if str(part or "").strip()
  )
  if not triggers:
    triggers = extract_trigger_words_from_model_card(model_card_text)
  recommendation = None
  for text in text_parts:
    recommendation = extract_recommended_strength_from_text(
      _modelscope_rich_text(text),
      "魔搭模型卡",
    )
    if recommendation:
      break

  if recommendation:
    source["recommendedStrength"] = recommendation
  if triggers:
    source["triggers"] = triggers
    source["triggersSource"] = "魔搭模型卡"
  if thumbnail_url:
    source["thumbnailUrl"] = thumbnail_url
    source["thumbnailSource"] = "魔搭模型卡"
  source["modelDetails"] = {
    "id": model_id,
    "readmeLoaded": bool(data.get("ReadMeContent")),
    "noTriggersDeclared": has_no_trigger_statement(model_card_text),
  }


def _aggregate_model_info(sources: dict[str, Any]) -> dict[str, Any]:
  recommendation = None
  recommendation_source = None
  for source_name, label in (
    ("civitai", "C站"),
    ("huggingface", "Hugging Face"),
    ("modelscope", "魔搭"),
  ):
    source = sources.get(source_name)
    if not isinstance(source, dict) or not source.get("ok"):
      continue
    candidate = source.get("recommendedStrength")
    if isinstance(candidate, dict) and candidate.get("text"):
      recommendation = candidate
      recommendation_source = label
      break

  triggers: list[str] = []
  triggers_source = None
  for source_name, label in (
    ("civitai", "C站模型"),
    ("huggingface", "Hugging Face 模型卡"),
    ("modelscope", "魔搭模型卡"),
  ):
    source = sources.get(source_name)
    if not isinstance(source, dict) or not source.get("ok"):
      continue
    candidate_triggers = normalize_trigger_words(source.get("triggers"))
    if candidate_triggers:
      triggers = candidate_triggers
      triggers_source = str(source.get("triggersSource") or label)
      break

  thumbnail_url = None
  thumbnail_source = None
  for source_name, label in (
    ("civitai", "C站示例图"),
    ("huggingface", "Hugging Face 模型卡"),
    ("modelscope", "魔搭模型卡"),
  ):
    source = sources.get(source_name)
    if not isinstance(source, dict) or not source.get("ok"):
      continue
    candidate = source.get("thumbnailUrl")
    if _is_https_image_url(candidate):
      thumbnail_url = candidate
      thumbnail_source = str(source.get("thumbnailSource") or label)
      break

  return {
    "recommendedStrength": recommendation,
    "recommendedStrengthSource": recommendation_source,
    "triggers": triggers,
    "triggersSource": triggers_source,
    "thumbnailUrl": thumbnail_url,
    "thumbnailSource": thumbnail_source,
  }


def _sha256(path: str) -> str:
  digest = hashlib.sha256()
  with open(path, "rb") as model_file:
    for chunk in iter(lambda: model_file.read(4 * 1024 * 1024), b""):
      digest.update(chunk)
  return digest.hexdigest()


def _fetch_civitai(file: str, sha256: str) -> dict[str, Any]:
  try:
    data = _json_request(
      "C站",
      "GET",
      CIVITAI_API.format(sha256=sha256),
    )
  except SourceRequestError as error:
    if error.http_status == 404:
      raise SourceRequestError(
        error_message_for_status(404),
        error.http_status,
      ) from error
    raise
  if not isinstance(data, dict):
    raise SourceRequestError("C站返回了意外的数据格式")
  info = normalize_civitai_model_version(data, file, sha256)
  thumbnail_url = _first_mapping_image(
    data.get("images"),
    {"url", "imageurl", "image", "src", "thumbnail"},
    base_url="https://civitai.com",
  )
  return {
    "ok": True,
    "match": "sha256",
    "url": info.get("url"),
    "name": info.get("name"),
    "versionName": data.get("name"),
    "baseModel": info.get("baseModel"),
    "recommendedStrength": info.get("recommendedStrength"),
    "triggers": info.get("triggers", []),
    "modelId": info.get("modelId"),
    "modelVersionId": info.get("modelVersionId"),
    "description": (
      (data.get("model") or {}).get("description")
      if isinstance(data.get("model"), dict)
      else None
    )
    or data.get("description")
    or "",
    "thumbnailUrl": thumbnail_url,
    "thumbnailSource": "C站示例图" if thumbnail_url else None,
  }


def _failure(error: Exception) -> dict[str, Any]:
  return {
    "ok": False,
    "error": str(error) or error.__class__.__name__,
  }


async def resolve_lora_sources(
  file: str,
  path: str,
  *,
  refresh: bool = False,
) -> dict[str, Any]:
  stat = os.stat(path)
  cache_key = (file, stat.st_size, stat.st_mtime_ns)
  cached = _source_cache.get(cache_key)
  if not refresh and cached and time.time() - cached[0] < CACHE_SECONDS:
    return cached[1]

  sha_result, metadata_result = await asyncio.gather(
    asyncio.to_thread(_sha256, path),
    asyncio.to_thread(_read_safetensors_metadata, path),
    return_exceptions=True,
  )

  if isinstance(sha_result, Exception):
    sha_value = None
    civitai_result: dict[str, Any] = _failure(
      SourceRequestError("读取本地 LoRA 文件失败，无法按 SHA256 查询 C站")
    )
  else:
    sha_value = sha_result
    try:
      civitai_result = await asyncio.to_thread(_fetch_civitai, file, sha_result)
    except Exception as error:
      civitai_result = _failure(error)

  metadata = summarize_safetensors_metadata(
    None if isinstance(metadata_result, Exception) else metadata_result
  )
  canonical_name = (
    str(civitai_result.get("name") or "").strip()
    if civitai_result.get("ok")
    else None
  )
  hf_task = asyncio.create_task(
    asyncio.to_thread(
      find_huggingface_sources,
      file,
      sha256=sha_value,
      aliases=metadata["aliases"],
      canonical_name=canonical_name,
    )
  )
  modelscope_task = asyncio.create_task(
    asyncio.to_thread(
      find_modelscope_sources,
      file,
      sha256=sha_value,
      aliases=metadata["aliases"],
      canonical_name=canonical_name,
    )
  )
  hf_result, modelscope_result = await asyncio.gather(
    hf_task,
    modelscope_task,
    return_exceptions=True,
  )

  sources = {
    "civitai": civitai_result,
    "huggingface": _failure(hf_result)
    if isinstance(hf_result, Exception)
    else hf_result,
    "modelscope": _failure(modelscope_result)
    if isinstance(modelscope_result, Exception)
    else modelscope_result,
  }
  await asyncio.gather(
    asyncio.to_thread(_enrich_huggingface_source, sources["huggingface"]),
    asyncio.to_thread(_enrich_modelscope_source, sources["modelscope"]),
  )
  model_info = _aggregate_model_info(sources)
  result = {
    "file": file,
    "sha256": sha_value,
    "metadata": metadata,
    "searchQueries": search_queries(
      file,
      aliases=metadata["aliases"],
      canonical_name=canonical_name,
    ),
    "refreshedAt": int(time.time()),
    **model_info,
    "sources": sources,
  }
  _source_cache[cache_key] = (time.time(), result)
  return result
