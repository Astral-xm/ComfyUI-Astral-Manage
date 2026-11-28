from __future__ import annotations

import copy
import ipaddress
import json
import os
import re
import shutil
import time
import urllib.parse
import uuid
from typing import Any


TEMPLATE_CATEGORIES = ("text", "image", "audio", "video", "expand", "invert")
MAX_TEMPLATES = 1000
MAX_TITLE_LENGTH = 160
MAX_PROMPT_LENGTH = 200_000
MAX_MESSAGES_PER_CONVERSATION = 200
MAX_CONVERSATIONS = 100
MAX_CONVERSATION_ATTACHMENTS = 30
CONVERSATION_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
MESSAGE_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
ATTACHMENT_ROOTS = {"input", "output"}

DEFAULT_API_CONFIG = {
  "baseUrl": "https://api.openai.com/v1",
  "model": "",
  "apiKey": "",
  "temperature": 0.7,
  "topP": 0.95,
  "maxTokens": 2048,
  "maxRounds": 12,
  "frequencyPenalty": 0.0,
  "presencePenalty": 0.0,
  "seed": None,
  "stop": [],
  "responseFormat": "default",
  "reasoningEffort": "default",
  "systemPrompt": (
    "You are a rigorous and helpful AI assistant. "
    "Always answer in the language the user writes in."
  ),
  "targetLanguage": "zh",
  "sourceLanguage": "auto",
}

API_CONFIG_VERSION = 2
API_TASKS = ("text", "image", "multimodal")
API_TASK_MIGRATION_SOURCES = {
  "text": ("optimize", "translate"),
  "image": ("invert",),
  "multimodal": ("chat",),
}
MAX_API_PROVIDERS = 20
API_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
# Operator allow-list for API base URLs: a comma-separated list of host,
# host:port or *.domain entries. When it is empty every public host is allowed,
# except reserved and link-local addresses.
API_ALLOWED_HOSTS_ENV = "ASTRAL_MANAGE_API_ALLOWED_HOSTS"


class PromptDataError(ValueError):
  pass


def _normalized_api_base_url(value: Any) -> str:
  return str(value or "").strip().rstrip("/")


def _api_host_allowlist() -> tuple[str, ...]:
  raw = str(os.environ.get(API_ALLOWED_HOSTS_ENV) or "")
  return tuple(
    item.strip().casefold() for item in raw.split(",") if item.strip()
  )


def _api_host_matches(
  host: str,
  port: int | None,
  pattern: str,
) -> bool:
  if pattern.startswith("*."):
    return host.endswith(pattern[1:])
  if ":" in pattern:
    pattern_host, _, pattern_port = pattern.rpartition(":")
    return (
      pattern_host == host
      and pattern_port.isdigit()
      and int(pattern_port) == port
    )
  return pattern == host


def _blocked_api_host(host: str) -> bool:
  try:
    address = ipaddress.ip_address(host)
  except ValueError:
    return False
  return bool(
    address.is_link_local
    or address.is_multicast
    or address.is_unspecified
    or address.is_reserved
  )


def _api_base_url(value: Any) -> str:
  base_url = _clean_text(value, maximum=2000, field="API address")
  if not base_url:
    return ""
  if not re.match(r"^https?://", base_url, re.IGNORECASE):
    raise PromptDataError("API address must use http:// or https://")
  parsed = urllib.parse.urlsplit(base_url)
  if not parsed.hostname:
    raise PromptDataError("API address is missing a host name")
  if parsed.username is not None or parsed.password is not None:
    raise PromptDataError("API address must not contain a username or password")
  host = parsed.hostname.casefold().rstrip(".")
  if _blocked_api_host(host):
    raise PromptDataError(
      "API address must not point to a reserved or link-local address"
    )
  try:
    port = parsed.port
  except ValueError:
    raise PromptDataError("API address has an invalid port") from None
  allowed = _api_host_allowlist()
  if allowed and not any(
    _api_host_matches(host, port, pattern) for pattern in allowed
  ):
    raise PromptDataError("API address is not in the allowed host list")
  return base_url


def _provider_api_key(provider: dict[str, Any]) -> str:
  key = str(provider.get("apiKey") or "").strip()
  if not key:
    return ""
  saved_base_url = str(provider.get("apiKeyBaseUrl") or "")
  if saved_base_url and _normalized_api_base_url(
    saved_base_url
  ) != _normalized_api_base_url(provider.get("baseUrl")):
    return ""
  return key


def default_data_directory() -> str:
  try:
    import folder_paths

    user_directory = getattr(folder_paths, "get_user_directory", None)
    if callable(user_directory):
      base = user_directory()
    else:
      base = os.path.join(
        getattr(
          folder_paths,
          "base_path",
          os.path.dirname(os.path.abspath(folder_paths.__file__)),
        ),
        "user",
        "default",
      )
  except Exception:
    base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "user-data")
  return os.path.join(os.path.abspath(base), "assets-astral")


def _ensure_data_directory(data_directory: str) -> str:
  directory = os.path.abspath(str(data_directory))
  os.makedirs(directory, exist_ok=True)
  return directory


def _read_json(path: str, default: dict[str, Any]) -> dict[str, Any]:
  if not os.path.isfile(path):
    return copy.deepcopy(default)
  try:
    with open(path, "r", encoding="utf-8-sig") as source:
      payload = json.load(source)
  except (OSError, json.JSONDecodeError, UnicodeDecodeError) as error:
    backup = f"{path}.bak"
    if os.path.isfile(backup):
      try:
        with open(backup, "r", encoding="utf-8-sig") as source:
          payload = json.load(source)
      except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        raise PromptDataError(
          f"Unable to read data file: {os.path.basename(path)}"
        ) from error
    else:
      raise PromptDataError(
        f"Unable to read data file: {os.path.basename(path)}"
      ) from error
  if not isinstance(payload, dict):
    raise PromptDataError(f"Invalid data file format: {os.path.basename(path)}")
  return payload


def _atomic_write_json(path: str, payload: dict[str, Any]) -> None:
  directory = os.path.dirname(path)
  os.makedirs(directory, exist_ok=True)
  temporary = os.path.join(
    directory,
    f".{os.path.basename(path)}.{uuid.uuid4().hex}.tmp",
  )
  try:
    with open(temporary, "w", encoding="utf-8", newline="\n") as target:
      json.dump(
        payload,
        target,
        ensure_ascii=False,
        indent=2,
        sort_keys=False,
      )
      target.write("\n")
      target.flush()
      os.fsync(target.fileno())
    if os.path.isfile(path):
      try:
        shutil.copy2(path, f"{path}.bak")
      except OSError:
        pass
    os.replace(temporary, path)
  finally:
    if os.path.exists(temporary):
      try:
        os.remove(temporary)
      except OSError:
        pass


def _clean_text(value: Any, *, maximum: int, field: str, required: bool = False) -> str:
  text = str(value or "").strip()
  if required and not text:
    raise PromptDataError(f"{field} cannot be empty")
  if len(text) > maximum:
    raise PromptDataError(f"{field} cannot exceed {maximum} characters")
  return text


def _clean_category(value: Any) -> str:
  category = " ".join(str(value or "").split())
  if not category:
    return "text"
  if len(category) > 40:
    raise PromptDataError("Prompt category cannot exceed 40 characters")
  if category.casefold() in TEMPLATE_CATEGORIES:
    return category.casefold()
  return category


def _safe_conversation_id(value: Any, *, create: bool = False) -> str:
  conversation_id = str(value or "").strip()
  if not conversation_id and create:
    return uuid.uuid4().hex
  if not CONVERSATION_ID_RE.fullmatch(conversation_id):
    raise PromptDataError(
      "Conversation ID may only contain letters, digits, dots, "
      "underscores or hyphens"
    )
  return conversation_id


def _normalize_attachment(raw: Any) -> dict[str, Any]:
  if not isinstance(raw, dict):
    raise PromptDataError("Invalid asset attachment format")
  root = str(raw.get("root", "")).strip().lower()
  if root not in ATTACHMENT_ROOTS:
    raise PromptDataError("Asset attachment root must be input or output")
  path = str(raw.get("path", "")).replace("\\", "/").strip("/")
  if not path or "\x00" in path:
    raise PromptDataError("Asset attachment path must not be empty")
  if re.match(r"^[A-Za-z]:", path) or any(part == ".." for part in path.split("/")):
    raise PromptDataError(
      "Asset attachments must use a relative path inside input/output"
    )
  kind = str(raw.get("kind", "")).strip().lower()
  if kind not in {"", "image", "audio", "video"}:
    kind = ""
  mention = str(raw.get("mention", "")).strip().lower()
  if not re.fullmatch(r"(?:image|video|audio)[1-9]\d{0,2}", mention):
    mention = ""
  if mention and kind and not mention.startswith(kind):
    mention = ""
  return {
    "root": root,
    "path": path,
    "name": os.path.basename(path),
    **({"kind": kind} if kind else {}),
    **({"mention": mention} if mention else {}),
  }


def _normalize_attachments(value: Any) -> list[dict[str, Any]]:
  if value is None:
    return []
  if not isinstance(value, list):
    raise PromptDataError("Asset attachments must be an array")
  if len(value) > MAX_CONVERSATION_ATTACHMENTS:
    raise PromptDataError(
      f"At most {MAX_CONVERSATION_ATTACHMENTS} assets can be attached at once"
    )
  result = []
  seen = set()
  for raw in value:
    item = _normalize_attachment(raw)
    key = (item["root"], item["path"].casefold())
    if key in seen:
      continue
    seen.add(key)
    result.append(item)
  return result


def _templates_path(data_directory: str) -> str:
  return os.path.join(_ensure_data_directory(data_directory), "prompt-templates.json")


def _api_config_path(data_directory: str) -> str:
  return os.path.join(_ensure_data_directory(data_directory), "api-config.json")


def _conversations_path(data_directory: str) -> str:
  return os.path.join(_ensure_data_directory(data_directory), "conversations.json")


def _categories_path(data_directory: str) -> str:
  return os.path.join(
    _ensure_data_directory(data_directory),
    "prompt-categories.json",
  )


def _load_categories(data_directory: str) -> list[str]:
  payload = _read_json(
    _categories_path(data_directory),
    {"version": 1, "categories": list(TEMPLATE_CATEGORIES)},
  )
  raw = payload.get("categories") if isinstance(payload, dict) else payload
  if not isinstance(raw, list):
    raw = list(TEMPLATE_CATEGORIES)
  categories: list[str] = []
  seen: set[str] = set()
  for item in raw:
    value = " ".join(str(item or "").split())
    if not value:
      continue
    key = value.casefold()
    if key in seen:
      continue
    seen.add(key)
    categories.append(value)
  return categories


def _save_categories(data_directory: str, categories: list[str]) -> None:
  _atomic_write_json(
    _categories_path(data_directory),
    {"version": 1, "categories": categories},
  )


def _category_list(
  data_directory: str,
  categories: list[str] | None = None,
) -> list[str]:
  base = list(
    categories if categories is not None else _load_categories(data_directory)
  )
  seen = {item.casefold() for item in base}
  extras: list[str] = []
  for item in _load_templates(data_directory):
    value = str(item.get("category") or "text").strip() or "text"
    if value.casefold() in seen:
      continue
    seen.add(value.casefold())
    extras.append(value)
  return [*base, *sorted(extras, key=str.casefold)]


def create_prompt_category(data_directory: str, name: Any) -> dict[str, Any]:
  category = _clean_category(name)
  categories = _load_categories(data_directory)
  seen = {item.casefold() for item in categories}
  created = category.casefold() not in seen
  if created:
    categories.append(category)
    _save_categories(data_directory, categories)
  return {
    "created": created,
    "category": category,
    "categories": _category_list(data_directory, categories),
  }


def delete_prompt_category(data_directory: str, name: Any) -> dict[str, Any]:
  category = " ".join(str(name or "").split())
  if not category:
    raise PromptDataError("Category name cannot be empty")
  key = category.casefold()
  if key in {"expand", "invert"}:
    raise PromptDataError("Built-in rule categories cannot be removed")
  used = [
    item
    for item in _load_templates(data_directory)
    if str(item.get("category") or "text").casefold() == key
  ]
  if used:
    raise PromptDataError(
      f"Category still contains {len(used)} prompt templates "
      "and cannot be removed"
    )
  categories = _load_categories(data_directory)
  remaining = [item for item in categories if item.casefold() != key]
  if len(remaining) != len(categories):
    _save_categories(data_directory, remaining)
  return {"categories": _category_list(data_directory, remaining)}


def _load_templates(data_directory: str) -> list[dict[str, Any]]:
  payload = _read_json(
    _templates_path(data_directory),
    {"version": 1, "templates": []},
  )
  templates = payload.get("templates")
  if not isinstance(templates, list):
    return []
  return [item for item in templates if isinstance(item, dict) and item.get("id")]


def get_template(
  data_directory: str,
  template_id: str,
) -> dict[str, Any]:
  template_id = _safe_conversation_id(template_id)
  template = next(
    (
      item
      for item in _load_templates(data_directory)
      if item.get("id") == template_id
    ),
    None,
  )
  if template is None:
    raise FileNotFoundError("Prompt template not found")
  return copy.deepcopy(template)


def list_templates(
  data_directory: str,
  *,
  query: str = "",
  category: str = "",
) -> dict[str, Any]:
  normalized_query = " ".join(str(query or "").split()).casefold()
  normalized_category = str(category or "").strip().casefold()
  all_templates = _load_templates(data_directory)
  templates = all_templates
  if normalized_category:
    templates = [
      item
      for item in templates
      if str(item.get("category") or "text").casefold() == normalized_category
    ]
  if normalized_query:
    templates = [
      item
      for item in templates
      if normalized_query
      in "\n".join(
        [
          str(item.get("title", "")),
          str(item.get("prompt", "")),
          str(item.get("category", "")),
        ]
      ).casefold()
    ]
  templates.sort(
    key=lambda item: (
      str(item.get("category", "text")),
      -float(item.get("updatedAt") or 0),
      str(item.get("title", "")).casefold(),
    )
  )
  return {
    "items": templates,
    "total": len(templates),
    "categories": _category_list(data_directory),
  }


def save_template(
  data_directory: str,
  payload: dict[str, Any],
) -> dict[str, Any]:
  if not isinstance(payload, dict):
    raise PromptDataError("Invalid prompt template format")
  now = time.time()
  requested_id = str(payload.get("id", "")).strip()
  template_id = (
    _safe_conversation_id(requested_id)
    if requested_id
    else uuid.uuid4().hex
  )
  template = {
    "id": template_id,
    "title": _clean_text(
      payload.get("title"),
      maximum=MAX_TITLE_LENGTH,
      field="Title",
      required=True,
    ),
    "category": _clean_category(payload.get("category")),
    "prompt": _clean_text(
      payload.get("prompt"),
      maximum=MAX_PROMPT_LENGTH,
      field="Prompt",
      required=True,
    ),
    "createdAt": now,
    "updatedAt": now,
  }
  templates = _load_templates(data_directory)
  existing_index = next(
    (index for index, item in enumerate(templates) if item.get("id") == template_id),
    None,
  )
  if existing_index is None:
    if len(templates) >= MAX_TEMPLATES:
      raise PromptDataError(
        f"At most {MAX_TEMPLATES} prompt templates can be saved"
      )
    templates.append(template)
  else:
    template["createdAt"] = float(templates[existing_index].get("createdAt") or now)
    templates[existing_index] = template
  _atomic_write_json(
    _templates_path(data_directory),
    {"version": 1, "templates": templates},
  )
  return template


def delete_template(data_directory: str, template_id: str) -> dict[str, Any]:
  template_id = _safe_conversation_id(template_id)
  templates = _load_templates(data_directory)
  remaining = [item for item in templates if item.get("id") != template_id]
  if len(remaining) == len(templates):
    raise FileNotFoundError("Prompt template not found")
  _atomic_write_json(
    _templates_path(data_directory),
    {"version": 1, "templates": remaining},
  )
  return {"ok": True, "id": template_id, "deleted": 1}


def _api_common_settings(
  raw: dict[str, Any],
  previous: dict[str, Any] | None = None,
) -> dict[str, Any]:
  previous = previous or {}
  config = {
    key: copy.deepcopy(value)
    for key, value in DEFAULT_API_CONFIG.items()
    if key not in {"baseUrl", "model", "apiKey"}
  }
  config.update(
    {
      key: value
      for key, value in previous.items()
      if key in config
    }
  )
  for key in config:
    if key in raw:
      config[key] = raw[key]
  config["systemPrompt"] = _clean_text(
    config.get("systemPrompt"),
    maximum=100_000,
    field="System prompt",
  )
  config["targetLanguage"] = _clean_text(
    config.get("targetLanguage"),
    maximum=60,
    field="Target language",
  )
  config["sourceLanguage"] = _clean_text(
    config.get("sourceLanguage"),
    maximum=60,
    field="Source language",
  ) or "auto"

  def bounded_float(
    key: str,
    default: float,
    minimum: float,
    maximum: float,
    field: str,
  ) -> float:
    try:
      value = float(config.get(key, default))
    except (TypeError, ValueError) as error:
      raise PromptDataError(f"{field} must be a number") from error
    return min(maximum, max(minimum, value))

  def bounded_int(
    key: str,
    default: int,
    minimum: int,
    maximum: int,
    field: str,
  ) -> int:
    try:
      value = int(config.get(key, default))
    except (TypeError, ValueError) as error:
      raise PromptDataError(f"{field} must be an integer") from error
    return min(maximum, max(minimum, value))

  config["temperature"] = bounded_float(
    "temperature",
    0.7,
    0.0,
    2.0,
    "Temperature",
  )
  config["topP"] = bounded_float("topP", 0.95, 0.0, 1.0, "Top P")
  config["maxTokens"] = bounded_int(
    "maxTokens",
    2048,
    1,
    128_000,
    "Max output tokens",
  )
  config["maxRounds"] = bounded_int(
    "maxRounds",
    12,
    1,
    50,
    "Max conversation rounds",
  )
  config["frequencyPenalty"] = bounded_float(
    "frequencyPenalty",
    0.0,
    -2.0,
    2.0,
    "Frequency penalty",
  )
  config["presencePenalty"] = bounded_float(
    "presencePenalty",
    0.0,
    -2.0,
    2.0,
    "Presence penalty",
  )

  seed_value = config.get("seed")
  if seed_value is None or str(seed_value).strip() == "":
    config["seed"] = None
  else:
    config["seed"] = bounded_int(
      "seed",
      42,
      0,
      4_294_967_295,
      "API Seed",
    )

  raw_stop = config.get("stop")
  if isinstance(raw_stop, str):
    stop_values = raw_stop.splitlines() if "\n" in raw_stop else [raw_stop]
  elif isinstance(raw_stop, (list, tuple)):
    stop_values = raw_stop
  elif raw_stop is None:
    stop_values = []
  else:
    raise PromptDataError("Stop sequences must be a string or an array of strings")
  stop_sequences: list[str] = []
  for value in stop_values:
    sequence = _clean_text(
      value,
      maximum=200,
      field="Stop sequence",
    )
    if sequence and sequence not in stop_sequences:
      stop_sequences.append(sequence)
  config["stop"] = stop_sequences[:8]

  response_format = str(config.get("responseFormat") or "default").strip()
  if response_format not in {"default", "text", "json_object"}:
    raise PromptDataError("Unknown API response format")
  config["responseFormat"] = response_format

  reasoning_effort = str(config.get("reasoningEffort") or "default").strip()
  if reasoning_effort not in {"default", "low", "medium", "high"}:
    raise PromptDataError("Unknown API reasoning effort")
  config["reasoningEffort"] = reasoning_effort
  return config


def _safe_api_id(value: Any, *, create: bool = False) -> str:
  api_id = str(value or "").strip()
  if not api_id and create:
    return uuid.uuid4().hex
  if not API_ID_RE.fullmatch(api_id):
    raise PromptDataError(
      "API config ID may only contain letters, digits, dots, "
      "underscores or hyphens"
    )
  return api_id


def _api_key_value(
  raw: dict[str, Any],
  previous: dict[str, Any] | None = None,
  *,
  base_url_changed: bool = False,
) -> str:
  previous = previous or {}
  current_key = "" if base_url_changed else str(previous.get("apiKey") or "")
  if raw.get("clearApiKey") is True:
    return ""
  if "apiKey" not in raw:
    return current_key
  requested_key = str(raw.get("apiKey") or "").strip()
  if (
    requested_key
    and "•" not in requested_key
    and requested_key not in {"[已保存]", "[Saved]"}
  ):
    if base_url_changed and requested_key == str(previous.get("apiKey") or ""):
      # The key came from the merged previous provider, not from the user.
      return ""
    return requested_key[:8000]
  return current_key


def _normalized_api_provider(
  raw: Any,
  previous: dict[str, Any] | None = None,
  *,
  index: int = 0,
) -> dict[str, Any]:
  if not isinstance(raw, dict):
    raise PromptDataError("Invalid API config entry format")
  previous = previous or {}
  requested_id = str(raw.get("id") or "").strip()
  provider_id = (
    _safe_api_id(requested_id)
    if requested_id
    else str(previous.get("id") or uuid.uuid4().hex)
  )
  name = _clean_text(
    raw.get("name", previous.get("name") or f"API {index + 1}"),
    maximum=80,
    field="API name",
  ) or f"API {index + 1}"
  base_url = _api_base_url(raw.get("baseUrl", previous.get("baseUrl") or ""))
  previous_base_url = str(previous.get("baseUrl") or "")
  base_url_changed = bool(previous_base_url) and (
    _normalized_api_base_url(base_url)
    != _normalized_api_base_url(previous_base_url)
  )
  api_key = _api_key_value(
    raw,
    previous,
    base_url_changed=base_url_changed,
  )
  return {
    "id": provider_id,
    "name": name,
    "baseUrl": base_url,
    "model": _clean_text(
      raw.get("model", previous.get("model") or ""),
      maximum=300,
      field="Model name",
    ),
    "apiKey": api_key,
    # The key is only ever sent back to the base URL it was entered for.
    "apiKeyBaseUrl": base_url if api_key else "",
  }


def _initial_api_settings(
  raw: dict[str, Any] | None = None,
  *,
  previous: dict[str, Any] | None = None,
) -> dict[str, Any]:
  raw = raw if isinstance(raw, dict) else {}
  previous = previous if isinstance(previous, dict) else {}
  previous_providers = previous.get("providers")
  providers: list[dict[str, Any]] = []
  if isinstance(previous_providers, list):
    providers = [
      copy.deepcopy(item)
      for item in previous_providers
      if isinstance(item, dict) and item.get("id")
    ]
  raw_providers = raw.get("providers")
  previous_by_id = {
    str(item.get("id")): item
    for item in previous_providers or []
    if isinstance(item, dict)
    if item.get("id")
  }
  is_multi_payload = isinstance(raw_providers, list)
  if is_multi_payload:
    if len(raw_providers) > MAX_API_PROVIDERS:
      raise PromptDataError(
        f"At most {MAX_API_PROVIDERS} API configs can be saved"
      )
    providers = []
    seen_ids: set[str] = set()
    for index, item in enumerate(raw_providers):
      requested_id = (
        str(item.get("id") or "").strip()
        if isinstance(item, dict)
        else ""
      )
      normalized = _normalized_api_provider(
        item,
        previous_by_id.get(requested_id),
        index=index,
      )
      if normalized["id"] in seen_ids:
        normalized["id"] = uuid.uuid4().hex
      seen_ids.add(normalized["id"])
      providers.append(normalized)
  else:
    legacy_fields = {
      key: raw[key]
      for key in ("name", "baseUrl", "model", "apiKey", "clearApiKey")
      if key in raw
    }
    if providers:
      active_index = next(
        (
          index
          for index, provider in enumerate(providers)
          if provider.get("id")
          in {
            previous.get("activeApiId"),
            previous.get("activeProviderId"),
          }
        ),
        0,
      )
      if legacy_fields:
        current = providers[active_index]
        providers[active_index] = _normalized_api_provider(
          {**current, **legacy_fields},
          current,
          index=active_index,
        )
    else:
      legacy_provider = {
        "id": "default",
        "name": raw.get("name") or "Default API",
        **{
          key: DEFAULT_API_CONFIG[key]
          for key in ("baseUrl", "model", "apiKey")
        },
        **legacy_fields,
      }
      providers = [
        _normalized_api_provider(
          legacy_provider,
          previous,
          index=0,
        )
      ]
  if not providers:
    providers = [
      _normalized_api_provider(
        {
          "id": "default",
          "name": "Default API",
          **{
            key: DEFAULT_API_CONFIG[key]
            for key in ("baseUrl", "model", "apiKey")
          },
        }
      )
    ]
  provider_ids = {item["id"] for item in providers}
  active_api_id = str(
    raw.get("activeApiId")
    or raw.get("activeProviderId")
    or previous.get("activeApiId")
    or previous.get("activeProviderId")
    or providers[0]["id"]
  )
  if active_api_id not in provider_ids:
    active_api_id = providers[0]["id"]
  previous_tasks = (
    previous.get("tasks")
    if isinstance(previous.get("tasks"), dict)
    else {}
  )
  raw_tasks = raw.get("tasks") if isinstance(raw.get("tasks"), dict) else {}
  tasks: dict[str, dict[str, str]] = {}
  for task in API_TASKS:
    task_source: dict[str, Any] = {}
    for source in (raw_tasks, previous_tasks):
      for task_id in (task, *API_TASK_MIGRATION_SOURCES.get(task, ())):
        candidate = source.get(task_id)
        if isinstance(candidate, dict) and (
          candidate.get("apiId")
          or candidate.get("providerId")
          or "model" in candidate
        ):
          task_source = candidate
          break
      if task_source:
        break
    source_api_id = str(
      task_source.get("apiId")
      or task_source.get("providerId")
      or ""
    )
    task_api_id = str(
      source_api_id
      or active_api_id
    )
    if task_api_id not in provider_ids:
      task_api_id = active_api_id
    if (
      (not source_api_id or source_api_id == task_api_id)
      and "model" in task_source
    ):
      default_model = task_source.get("model")
    elif not previous_tasks and not is_multi_payload:
      default_model = raw.get("model")
    else:
      default_model = ""
    tasks[task] = {
      "apiId": task_api_id,
      "model": _clean_text(
        default_model,
        maximum=300,
        field="Task model name",
      ),
    }
  return {
    "version": API_CONFIG_VERSION,
    "providers": providers,
    "activeApiId": active_api_id,
    "tasks": tasks,
    **_api_common_settings(raw, previous),
  }


def _public_api_provider(provider: dict[str, Any]) -> dict[str, Any]:
  public = {
    key: value
    for key, value in provider.items()
    if key != "apiKey"
  }
  key = str(provider.get("apiKey") or "")
  public["hasApiKey"] = bool(key)
  public["apiKey"] = "••••••••" if key else ""
  if key:
    public["apiKeyHint"] = "Saved"
  else:
    public["apiKeyHint"] = ""
  return public


def _load_api_settings(
  data_directory: str,
  *,
  include_secret: bool = False,
) -> dict[str, Any]:
  payload = _read_json(
    _api_config_path(data_directory),
    {"version": API_CONFIG_VERSION, "config": DEFAULT_API_CONFIG},
  )
  raw = payload.get("config")
  if not isinstance(raw, dict):
    raw = {}
  settings = _initial_api_settings(raw)
  if include_secret:
    return settings
  public = copy.deepcopy(settings)
  public["providers"] = [
    _public_api_provider(provider)
    for provider in settings["providers"]
  ]
  return public


def _active_provider(settings: dict[str, Any]) -> dict[str, Any]:
  active_api_id = str(settings.get("activeApiId") or "")
  providers = settings.get("providers")
  providers = providers if isinstance(providers, list) else []
  return next(
    (
      provider
      for provider in providers
      if isinstance(provider, dict) and provider.get("id") == active_api_id
    ),
    providers[0] if providers else {},
  )


def _flatten_api_config(settings: dict[str, Any]) -> dict[str, Any]:
  provider = _active_provider(settings)
  config = {
    key: copy.deepcopy(value)
    for key, value in settings.items()
    if key not in {"version", "providers", "activeApiId", "tasks"}
  }
  text_task = (
    settings.get("tasks", {}).get("text", {})
    if isinstance(settings.get("tasks"), dict)
    else {}
  )
  config.update(
    {
      "baseUrl": provider.get("baseUrl", ""),
      "model": text_task.get("model") or provider.get("model", ""),
      "apiKey": _provider_api_key(provider),
      "providerId": provider.get("id", ""),
      "providerName": provider.get("name", ""),
    }
  )
  return config


def load_api_config(
  data_directory: str,
  *,
  include_secret: bool = False,
) -> dict[str, Any]:
  settings = _load_api_settings(data_directory, include_secret=True)
  config = _flatten_api_config(settings)
  if include_secret:
    return config
  public = {key: value for key, value in config.items() if key != "apiKey"}
  key = str(config.get("apiKey") or "")
  public["hasApiKey"] = bool(key)
  public["apiKey"] = "••••••••" if key else ""
  if key:
    public["apiKeyHint"] = "Saved"
  else:
    public["apiKeyHint"] = ""
  return public


def load_api_configuration(data_directory: str) -> dict[str, Any]:
  settings = _load_api_settings(data_directory, include_secret=True)
  public = _load_api_settings(data_directory, include_secret=False)
  active = _active_provider(settings)
  active_public = _public_api_provider(active)
  text_task = settings["tasks"]["text"]
  public.update(active_public)
  public["model"] = text_task.get("model") or active_public.get("model", "")
  return public


def resolve_api_config(
  data_directory: str,
  task: str = "text",
  *,
  provider_id: str | None = None,
  model: str | None = None,
) -> dict[str, Any]:
  normalized_task = str(task or "text").strip().lower()
  if normalized_task not in API_TASKS:
    raise PromptDataError("Unknown API task type")
  settings = _load_api_settings(data_directory, include_secret=True)
  provider_map = {
    str(provider.get("id")): provider
    for provider in settings["providers"]
  }
  binding = settings["tasks"][normalized_task]
  selected_id = str(provider_id or binding.get("apiId") or settings["activeApiId"])
  provider = provider_map.get(selected_id) or _active_provider(settings)
  config = {
    key: copy.deepcopy(value)
    for key, value in settings.items()
    if key not in {"version", "providers", "activeApiId", "tasks"}
  }
  config.update(
    {
      "baseUrl": provider.get("baseUrl", ""),
      "model": str(model or binding.get("model") or provider.get("model") or ""),
      "apiKey": _provider_api_key(provider),
      "providerId": provider.get("id", ""),
      "providerName": provider.get("name", ""),
      "task": normalized_task,
    }
  )
  return config


def resolve_api_provider(
  data_directory: str,
  payload: dict[str, Any],
) -> dict[str, Any]:
  """Return a saved API provider selected by id.

  The request body may only choose among providers saved on disk: the base URL
  and the key always come from the stored settings, never from the request.
  """
  if not isinstance(payload, dict):
    raise PromptDataError("Invalid API config format")
  settings = _load_api_settings(data_directory, include_secret=True)
  provider_id = str(payload.get("id") or "").strip()
  provider = next(
    (
      item
      for item in settings["providers"]
      if item.get("id") == provider_id
    ),
    None,
  ) or _active_provider(settings)
  return {
    "id": str(provider.get("id") or ""),
    "name": str(provider.get("name") or ""),
    "baseUrl": str(provider.get("baseUrl") or ""),
    "model": str(provider.get("model") or ""),
    "apiKey": _provider_api_key(provider),
  }


def _save_api_settings(
  data_directory: str,
  settings: dict[str, Any],
  *,
  previous: dict[str, Any] | None = None,
) -> dict[str, Any]:
  previous_settings = (
    previous
    if isinstance(previous, dict)
    else _load_api_settings(data_directory, include_secret=True)
  )
  clean_settings = _initial_api_settings(
    settings,
    previous=previous_settings,
  )
  _atomic_write_json(
    _api_config_path(data_directory),
    {"version": API_CONFIG_VERSION, "config": clean_settings},
  )
  return load_api_configuration(data_directory)


def save_api_config(
  data_directory: str,
  payload: dict[str, Any],
) -> dict[str, Any]:
  if not isinstance(payload, dict):
    raise PromptDataError("Invalid API config format")
  previous = _load_api_settings(data_directory, include_secret=True)
  is_multi_config = (
    isinstance(payload.get("providers"), list)
    or isinstance(payload.get("tasks"), dict)
    or "activeApiId" in payload
    or "activeProviderId" in payload
  )
  if is_multi_config:
    return _save_api_settings(
      data_directory,
      payload,
      previous=previous,
    )

  merged = copy.deepcopy(previous)
  active_index = next(
    (
      index
      for index, provider in enumerate(merged["providers"])
      if provider.get("id") == merged["activeApiId"]
    ),
    0,
  )
  active = merged["providers"][active_index]
  previous_active_model = str(active.get("model") or "")
  active.update(
    _normalized_api_provider(
      {
        **active,
        **{
          key: payload[key]
          for key in ("baseUrl", "model", "apiKey", "clearApiKey")
          if key in payload
        },
      },
      active,
      index=active_index,
    )
  )
  if payload.get("clearApiKey") is True:
    active["clearApiKey"] = True
  if "model" in payload:
    for task in API_TASKS:
      if (
        not merged["tasks"][task].get("model")
        or merged["tasks"][task].get("model") == previous_active_model
      ):
        merged["tasks"][task]["model"] = active["model"]
  merged.update(_api_common_settings(payload, merged))
  _save_api_settings(
    data_directory,
    merged,
    previous=previous,
  )
  return load_api_config(data_directory)


def normalize_conversation_skill_ids(value: Any) -> list[str]:
  if not isinstance(value, (list, tuple)):
    return []
  result: list[str] = []
  for item in value:
    if not isinstance(item, str):
      continue
    skill_id = item.strip()
    if not skill_id or skill_id in result:
      continue
    result.append(skill_id)
    break
  return result


def normalize_conversation_system_prompt(value: Any) -> dict[str, str] | None:
  if not isinstance(value, dict):
    return None
  prompt = _clean_text(
    value.get("content"),
    maximum=MAX_PROMPT_LENGTH,
    field="System prompt",
  )
  if not prompt:
    return None
  template_id = str(value.get("id") or "").strip()
  if template_id and not CONVERSATION_ID_RE.fullmatch(template_id):
    template_id = ""
  return {
    "id": template_id,
    "title": _clean_text(
      value.get("title") or "System Prompt",
      maximum=MAX_TITLE_LENGTH,
      field="System prompt title",
      required=True,
    ),
    "content": prompt,
  }


def _set_conversation_context(
  conversation: dict[str, Any],
  payload: dict[str, Any],
) -> None:
  has_system_prompt = "systemPromptTemplate" in payload
  has_skills = "skillIds" in payload
  system_prompt = (
    normalize_conversation_system_prompt(payload.get("systemPromptTemplate"))
    if has_system_prompt
    else None
  )
  skill_ids = (
    normalize_conversation_skill_ids(payload.get("skillIds"))
    if has_skills
    else []
  )

  if has_system_prompt and system_prompt:
    conversation["systemPromptTemplate"] = system_prompt
    conversation["skillIds"] = []
    return
  if has_skills and skill_ids:
    conversation["skillIds"] = skill_ids
    conversation.pop("systemPromptTemplate", None)
    return
  if has_system_prompt:
    conversation.pop("systemPromptTemplate", None)
    if has_skills:
      conversation["skillIds"] = []
    return
  if has_skills:
    conversation["skillIds"] = skill_ids
    return

  if conversation.get("systemPromptTemplate"):
    conversation["skillIds"] = []
  else:
    conversation["skillIds"] = normalize_conversation_skill_ids(
      conversation.get("skillIds")
    )


def _conversation_message(
  conversation: dict[str, Any],
  raw_message: Any,
  index: int,
) -> tuple[dict[str, Any] | None, bool]:
  if not isinstance(raw_message, dict):
    return None, True
  role = str(raw_message.get("role", "")).strip()
  if role not in {"user", "assistant"}:
    return None, True
  content = _clean_text(
    raw_message.get("content"),
    maximum=MAX_PROMPT_LENGTH,
    field="Message content",
  )
  attachments = []
  raw_attachments = raw_message.get("attachments")
  if isinstance(raw_attachments, list):
    for raw_attachment in raw_attachments:
      try:
        attachments.append(_normalize_attachment(raw_attachment))
      except PromptDataError:
        continue
  if not content and not attachments:
    return None, True

  changed = False
  message_id = str(raw_message.get("id") or "").strip()
  if not MESSAGE_ID_RE.fullmatch(message_id):
    message_id = uuid.uuid4().hex
    changed = True

  raw_timestamp = raw_message.get("timestamp")
  try:
    timestamp = float(raw_timestamp)
  except (TypeError, ValueError):
    timestamp = 0
  if timestamp <= 0:
    created_at = conversation.get("createdAt")
    try:
      base_timestamp = float(created_at)
    except (TypeError, ValueError):
      base_timestamp = time.time()
    timestamp = base_timestamp + index * 0.0001
    changed = True

  request_id = str(raw_message.get("requestId") or "").strip()
  if request_id and not MESSAGE_ID_RE.fullmatch(request_id):
    request_id = ""
    changed = True

  item = {
    "id": message_id,
    "role": role,
    "content": content,
    "timestamp": timestamp,
  }
  if attachments:
    item["attachments"] = attachments
    if raw_attachments != attachments:
      changed = True
  if request_id:
    item["requestId"] = request_id
  if raw_message.get("id") != message_id:
    changed = True
  if raw_message.get("timestamp") != timestamp:
    changed = True
  return item, changed


def _load_conversations(data_directory: str) -> list[dict[str, Any]]:
  payload = _read_json(
    _conversations_path(data_directory),
    {"version": 1, "conversations": []},
  )
  conversations = payload.get("conversations")
  if not isinstance(conversations, list):
    return []
  normalized = [
    item
    for item in conversations
    if isinstance(item, dict) and item.get("id")
  ]
  changed = False
  for conversation in normalized:
    system_prompt = normalize_conversation_system_prompt(
      conversation.get("systemPromptTemplate")
    )
    if system_prompt:
      conversation["systemPromptTemplate"] = system_prompt
      conversation["skillIds"] = []
    else:
      conversation.pop("systemPromptTemplate", None)
      conversation["skillIds"] = normalize_conversation_skill_ids(
        conversation.get("skillIds")
      )
    messages = conversation.get("messages")
    messages = messages if isinstance(messages, list) else []
    normalized_messages = []
    for index, message in enumerate(messages):
      normalized_message, message_changed = _conversation_message(
        conversation,
        message,
        index,
      )
      changed = changed or message_changed
      if normalized_message:
        normalized_messages.append(normalized_message)
    if normalized_messages != messages:
      changed = True
    conversation["messages"] = normalized_messages
  if changed:
    _save_conversations(data_directory, normalized)
  return normalized


def _save_conversations(
  data_directory: str,
  conversations: list[dict[str, Any]],
) -> None:
  _atomic_write_json(
    _conversations_path(data_directory),
    {"version": 1, "conversations": conversations},
  )


def _conversation_summary(conversation: dict[str, Any]) -> dict[str, Any]:
  messages = conversation.get("messages")
  messages = messages if isinstance(messages, list) else []
  system_prompt = normalize_conversation_system_prompt(
    conversation.get("systemPromptTemplate")
  )
  skill_ids = (
    []
    if system_prompt
    else normalize_conversation_skill_ids(conversation.get("skillIds"))
  )
  return {
    "id": conversation.get("id"),
    "title": conversation.get("title") or "Untitled Conversation",
    "messageCount": len(messages),
    "createdAt": conversation.get("createdAt"),
    "updatedAt": conversation.get("updatedAt"),
    "skillIds": skill_ids,
    "systemPromptTemplate": (
      {
        "id": system_prompt["id"],
        "title": system_prompt["title"],
      }
      if system_prompt
      else None
    ),
    "attachments": copy.deepcopy(conversation.get("attachments") or []),
  }


def list_conversations(data_directory: str) -> dict[str, Any]:
  conversations = _load_conversations(data_directory)
  summaries = [_conversation_summary(item) for item in conversations]
  summaries.sort(key=lambda item: -float(item.get("updatedAt") or 0))
  return {"items": summaries, "total": len(summaries)}


def create_conversation(
  data_directory: str,
  payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
  payload = payload or {}
  conversations = _load_conversations(data_directory)
  if len(conversations) >= MAX_CONVERSATIONS:
    raise PromptDataError(
      f"At most {MAX_CONVERSATIONS} conversations can be saved"
    )
  conversation_id = _safe_conversation_id(
    payload.get("id"),
    create=True,
  )
  if any(item.get("id") == conversation_id for item in conversations):
    raise PromptDataError("Conversation ID already exists")
  now = time.time()
  conversation = {
    "id": conversation_id,
    "title": _clean_text(
      payload.get("title") or "New Conversation",
      maximum=MAX_TITLE_LENGTH,
      field="Conversation title",
      required=True,
    ),
    "messages": [],
    "skillIds": [],
    "attachments": _normalize_attachments(payload.get("attachments")),
    "createdAt": now,
    "updatedAt": now,
  }
  _set_conversation_context(conversation, payload)
  conversations.append(conversation)
  _save_conversations(data_directory, conversations)
  return conversation


def get_or_create_conversation(
  data_directory: str,
  conversation_id: str,
) -> dict[str, Any]:
  conversation_id = _safe_conversation_id(conversation_id)
  conversations = _load_conversations(data_directory)
  found = next(
    (item for item in conversations if item.get("id") == conversation_id),
    None,
  )
  if found is not None:
    return copy.deepcopy(found)
  return create_conversation(
    data_directory,
    {
      "id": conversation_id,
      "title": (
        "Canvas Chat" if conversation_id == "canvas" else "New Conversation"
      ),
    },
  )


def get_conversation(data_directory: str, conversation_id: str) -> dict[str, Any]:
  conversation_id = _safe_conversation_id(conversation_id)
  for item in _load_conversations(data_directory):
    if item.get("id") == conversation_id:
      return copy.deepcopy(item)
  raise FileNotFoundError("Conversation not found")


def update_conversation(
  data_directory: str,
  conversation_id: str,
  payload: dict[str, Any],
) -> dict[str, Any]:
  conversation_id = _safe_conversation_id(conversation_id)
  conversations = _load_conversations(data_directory)
  conversation = next(
    (item for item in conversations if item.get("id") == conversation_id),
    None,
  )
  if conversation is None:
    raise FileNotFoundError("Conversation not found")
  if "title" in payload:
    conversation["title"] = _clean_text(
      payload.get("title"),
      maximum=MAX_TITLE_LENGTH,
      field="Conversation title",
      required=True,
    )
  _set_conversation_context(conversation, payload)
  if "attachments" in payload:
    conversation["attachments"] = _normalize_attachments(
      payload.get("attachments")
    )
  conversation["updatedAt"] = time.time()
  _save_conversations(data_directory, conversations)
  return copy.deepcopy(conversation)


def append_conversation_messages(
  data_directory: str,
  conversation_id: str,
  messages: list[dict[str, Any]],
) -> dict[str, Any]:
  conversation_id = _safe_conversation_id(conversation_id)
  conversations = _load_conversations(data_directory)
  conversation = next(
    (item for item in conversations if item.get("id") == conversation_id),
    None,
  )
  if conversation is None:
    raise FileNotFoundError("Conversation not found")
  accepted = []
  now = time.time()
  for index, message in enumerate(messages):
    if not isinstance(message, dict):
      continue
    role = str(message.get("role", "")).strip()
    if role not in {"user", "assistant"}:
      continue
    content = _clean_text(
      message.get("content"),
      maximum=MAX_PROMPT_LENGTH,
      field="Message content",
    )
    attachments = _normalize_attachments(message.get("attachments"))
    if not content and not attachments:
      continue
    message_id = str(message.get("id") or "").strip()
    if not MESSAGE_ID_RE.fullmatch(message_id):
      message_id = uuid.uuid4().hex
    try:
      timestamp = float(message.get("timestamp"))
    except (TypeError, ValueError):
      timestamp = now + index * 0.0001
    if timestamp <= 0:
      timestamp = now + index * 0.0001
    request_id = str(message.get("requestId") or "").strip()
    if request_id and not MESSAGE_ID_RE.fullmatch(request_id):
      request_id = ""
    item = {
      "id": message_id,
      "role": role,
      "content": content,
      "timestamp": timestamp,
    }
    if attachments:
      item["attachments"] = attachments
    if request_id:
      item["requestId"] = request_id
    accepted.append(item)
  stored = conversation.get("messages")
  stored = stored if isinstance(stored, list) else []
  stored.extend(accepted)
  conversation["messages"] = stored[-MAX_MESSAGES_PER_CONVERSATION:]
  conversation["updatedAt"] = now
  if (
    not conversation.get("title")
    or conversation.get("title") in {"新会话", "New Conversation"}
  ):
    first_user = next(
      (item for item in stored if item.get("role") == "user"),
      None,
    )
    if first_user:
      first_attachment = (
        first_user.get("attachments")[0]
        if isinstance(first_user.get("attachments"), list)
        and first_user["attachments"]
        else {}
      )
      conversation["title"] = str(
        first_user.get("content")
        or first_attachment.get("name")
        or "Image message"
      )[:48]
  _save_conversations(data_directory, conversations)
  return copy.deepcopy(conversation)


def delete_conversation_message(
  data_directory: str,
  conversation_id: str,
  message_id: str,
) -> dict[str, Any]:
  conversation_id = _safe_conversation_id(conversation_id)
  message_id = str(message_id or "").strip()
  if not MESSAGE_ID_RE.fullmatch(message_id):
    raise PromptDataError("Invalid message ID")
  conversations = _load_conversations(data_directory)
  conversation = next(
    (item for item in conversations if item.get("id") == conversation_id),
    None,
  )
  if conversation is None:
    raise FileNotFoundError("Conversation not found")
  stored = conversation.get("messages")
  stored = stored if isinstance(stored, list) else []
  remaining = [item for item in stored if item.get("id") != message_id]
  if len(remaining) == len(stored):
    raise FileNotFoundError("Message not found or already deleted")
  conversation["messages"] = remaining
  conversation["updatedAt"] = time.time()
  _save_conversations(data_directory, conversations)
  return {
    "ok": True,
    "id": message_id,
    "conversationId": conversation_id,
    "deleted": 1,
    "conversation": copy.deepcopy(conversation),
  }


def delete_conversation(
  data_directory: str,
  conversation_id: str,
) -> dict[str, Any]:
  conversation_id = _safe_conversation_id(conversation_id)
  conversations = _load_conversations(data_directory)
  remaining = [item for item in conversations if item.get("id") != conversation_id]
  if len(remaining) == len(conversations):
    raise FileNotFoundError("Conversation not found")
  _save_conversations(data_directory, remaining)
  return {"ok": True, "id": conversation_id, "deleted": 1}
