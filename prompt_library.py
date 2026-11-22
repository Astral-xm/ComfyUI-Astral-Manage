from __future__ import annotations

import copy
import json
import os
import re
import shutil
import time
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
  "systemPrompt": "你是一个严谨、有帮助的 AI 助手。",
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


class PromptDataError(ValueError):
  pass


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
        raise PromptDataError(f"无法读取数据文件：{os.path.basename(path)}") from error
    else:
      raise PromptDataError(f"无法读取数据文件：{os.path.basename(path)}") from error
  if not isinstance(payload, dict):
    raise PromptDataError(f"数据文件格式错误：{os.path.basename(path)}")
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
    raise PromptDataError(f"{field}不能为空")
  if len(text) > maximum:
    raise PromptDataError(f"{field}不能超过 {maximum} 个字符")
  return text


def _clean_category(value: Any) -> str:
  category = str(value or "text").strip().lower()
  if category not in TEMPLATE_CATEGORIES:
    raise PromptDataError(
      "提示词分类必须是 text、image、audio、video、expand 或 invert"
    )
  return category


def _safe_conversation_id(value: Any, *, create: bool = False) -> str:
  conversation_id = str(value or "").strip()
  if not conversation_id and create:
    return uuid.uuid4().hex
  if not CONVERSATION_ID_RE.fullmatch(conversation_id):
    raise PromptDataError("会话 ID 只能包含字母、数字、点、下划线或短横线")
  return conversation_id


def _normalize_attachment(raw: Any) -> dict[str, Any]:
  if not isinstance(raw, dict):
    raise PromptDataError("素材附件格式错误")
  root = str(raw.get("root", "")).strip().lower()
  if root not in ATTACHMENT_ROOTS:
    raise PromptDataError("素材附件根目录必须是 input 或 output")
  path = str(raw.get("path", "")).replace("\\", "/").strip("/")
  if not path or "\x00" in path:
    raise PromptDataError("素材附件路径不能为空")
  if re.match(r"^[A-Za-z]:", path) or any(part == ".." for part in path.split("/")):
    raise PromptDataError("素材附件必须使用 input/output 内的相对路径")
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
    raise PromptDataError("素材附件必须是数组")
  if len(value) > MAX_CONVERSATION_ATTACHMENTS:
    raise PromptDataError(
      f"一次最多附加 {MAX_CONVERSATION_ATTACHMENTS} 个素材"
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
    raise FileNotFoundError("提示词模板不存在")
  return copy.deepcopy(template)


def list_templates(
  data_directory: str,
  *,
  query: str = "",
  category: str = "",
) -> dict[str, Any]:
  normalized_query = " ".join(str(query or "").split()).casefold()
  normalized_category = str(category or "").strip().lower()
  if normalized_category and normalized_category not in TEMPLATE_CATEGORIES:
    raise PromptDataError("未知的提示词分类")
  templates = _load_templates(data_directory)
  if normalized_category:
    templates = [
      item for item in templates if str(item.get("category", "text")) == normalized_category
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
    "categories": list(TEMPLATE_CATEGORIES),
  }


def save_template(
  data_directory: str,
  payload: dict[str, Any],
) -> dict[str, Any]:
  if not isinstance(payload, dict):
    raise PromptDataError("提示词模板格式错误")
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
      field="标题",
      required=True,
    ),
    "category": _clean_category(payload.get("category")),
    "prompt": _clean_text(
      payload.get("prompt"),
      maximum=MAX_PROMPT_LENGTH,
      field="提示词",
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
      raise PromptDataError(f"提示词模板最多保存 {MAX_TEMPLATES} 条")
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
    raise FileNotFoundError("提示词模板不存在")
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
    field="系统提示词",
  )
  config["targetLanguage"] = _clean_text(
    config.get("targetLanguage"),
    maximum=60,
    field="目标语言",
  )
  config["sourceLanguage"] = _clean_text(
    config.get("sourceLanguage"),
    maximum=60,
    field="源语言",
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
      raise PromptDataError(f"{field}必须是数字") from error
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
      raise PromptDataError(f"{field}必须是整数") from error
    return min(maximum, max(minimum, value))

  config["temperature"] = bounded_float(
    "temperature",
    0.7,
    0.0,
    2.0,
    "temperature ",
  )
  config["topP"] = bounded_float("topP", 0.95, 0.0, 1.0, "Top P ")
  config["maxTokens"] = bounded_int(
    "maxTokens",
    2048,
    1,
    128_000,
    "最大输出 Token ",
  )
  config["maxRounds"] = bounded_int(
    "maxRounds",
    12,
    1,
    50,
    "最大对话轮数 ",
  )
  config["frequencyPenalty"] = bounded_float(
    "frequencyPenalty",
    0.0,
    -2.0,
    2.0,
    "频率惩罚 ",
  )
  config["presencePenalty"] = bounded_float(
    "presencePenalty",
    0.0,
    -2.0,
    2.0,
    "存在惩罚 ",
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
      "API Seed ",
    )

  raw_stop = config.get("stop")
  if isinstance(raw_stop, str):
    stop_values = raw_stop.splitlines() if "\n" in raw_stop else [raw_stop]
  elif isinstance(raw_stop, (list, tuple)):
    stop_values = raw_stop
  elif raw_stop is None:
    stop_values = []
  else:
    raise PromptDataError("停止序列必须是字符串或字符串数组")
  stop_sequences: list[str] = []
  for value in stop_values:
    sequence = _clean_text(
      value,
      maximum=200,
      field="停止序列",
    )
    if sequence and sequence not in stop_sequences:
      stop_sequences.append(sequence)
  config["stop"] = stop_sequences[:8]

  response_format = str(config.get("responseFormat") or "default").strip()
  if response_format not in {"default", "text", "json_object"}:
    raise PromptDataError("未知的 API 响应格式")
  config["responseFormat"] = response_format

  reasoning_effort = str(config.get("reasoningEffort") or "default").strip()
  if reasoning_effort not in {"default", "low", "medium", "high"}:
    raise PromptDataError("未知的 API 推理强度")
  config["reasoningEffort"] = reasoning_effort
  return config


def _safe_api_id(value: Any, *, create: bool = False) -> str:
  api_id = str(value or "").strip()
  if not api_id and create:
    return uuid.uuid4().hex
  if not API_ID_RE.fullmatch(api_id):
    raise PromptDataError("API 配置 ID 只能包含字母、数字、点、下划线或短横线")
  return api_id


def _api_key_value(
  raw: dict[str, Any],
  previous: dict[str, Any] | None = None,
) -> str:
  previous = previous or {}
  current_key = str(previous.get("apiKey") or "")
  if raw.get("clearApiKey") is True:
    return ""
  if "apiKey" not in raw:
    return current_key
  requested_key = str(raw.get("apiKey") or "").strip()
  if requested_key and "•" not in requested_key and requested_key != "[已保存]":
    return requested_key[:8000]
  return current_key


def _normalized_api_provider(
  raw: Any,
  previous: dict[str, Any] | None = None,
  *,
  index: int = 0,
) -> dict[str, Any]:
  if not isinstance(raw, dict):
    raise PromptDataError("API 配置项格式错误")
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
    field="API 名称",
  ) or f"API {index + 1}"
  base_url = _clean_text(
    raw.get("baseUrl", previous.get("baseUrl") or ""),
    maximum=2000,
    field="API 地址",
  )
  if base_url and not re.match(r"^https?://", base_url, re.I):
    raise PromptDataError("API 地址必须使用 http:// 或 https://")
  return {
    "id": provider_id,
    "name": name,
    "baseUrl": base_url,
    "model": _clean_text(
      raw.get("model", previous.get("model") or ""),
      maximum=300,
      field="模型名称",
    ),
    "apiKey": _api_key_value(raw, previous),
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
      raise PromptDataError(f"最多保存 {MAX_API_PROVIDERS} 个 API 配置")
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
        "name": raw.get("name") or "默认 API",
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
          "name": "默认 API",
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
        field="任务模型名称",
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
    public["apiKeyHint"] = "已保存"
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
      "apiKey": provider.get("apiKey", ""),
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
    public["apiKeyHint"] = "已保存"
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
    raise PromptDataError("未知的 API 任务类型")
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
      "apiKey": provider.get("apiKey", ""),
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
  if not isinstance(payload, dict):
    raise PromptDataError("API 配置格式错误")
  settings = _load_api_settings(data_directory, include_secret=True)
  provider_id = str(payload.get("id") or "").strip()
  previous = next(
    (
      provider
      for provider in settings["providers"]
      if provider.get("id") == provider_id
    ),
    {},
  )
  return _normalized_api_provider(payload, previous, index=0)


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
    raise PromptDataError("API 配置格式错误")
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
    field="系统提示词",
  )
  if not prompt:
    return None
  template_id = str(value.get("id") or "").strip()
  if template_id and not CONVERSATION_ID_RE.fullmatch(template_id):
    template_id = ""
  return {
    "id": template_id,
    "title": _clean_text(
      value.get("title") or "系统提示词",
      maximum=MAX_TITLE_LENGTH,
      field="系统提示词标题",
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
    field="消息内容",
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
    "title": conversation.get("title") or "未命名会话",
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
    raise PromptDataError(f"最多保存 {MAX_CONVERSATIONS} 个会话")
  conversation_id = _safe_conversation_id(
    payload.get("id"),
    create=True,
  )
  if any(item.get("id") == conversation_id for item in conversations):
    raise PromptDataError("会话 ID 已存在")
  now = time.time()
  conversation = {
    "id": conversation_id,
    "title": _clean_text(
      payload.get("title") or "新会话",
      maximum=MAX_TITLE_LENGTH,
      field="会话标题",
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
      "title": "画布对话" if conversation_id == "canvas" else "新会话",
    },
  )


def get_conversation(data_directory: str, conversation_id: str) -> dict[str, Any]:
  conversation_id = _safe_conversation_id(conversation_id)
  for item in _load_conversations(data_directory):
    if item.get("id") == conversation_id:
      return copy.deepcopy(item)
  raise FileNotFoundError("会话不存在")


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
    raise FileNotFoundError("会话不存在")
  if "title" in payload:
    conversation["title"] = _clean_text(
      payload.get("title"),
      maximum=MAX_TITLE_LENGTH,
      field="会话标题",
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
    raise FileNotFoundError("会话不存在")
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
      field="消息内容",
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
    or conversation.get("title") == "新会话"
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
        or "图片消息"
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
    raise PromptDataError("消息 ID 无效")
  conversations = _load_conversations(data_directory)
  conversation = next(
    (item for item in conversations if item.get("id") == conversation_id),
    None,
  )
  if conversation is None:
    raise FileNotFoundError("会话不存在")
  stored = conversation.get("messages")
  stored = stored if isinstance(stored, list) else []
  remaining = [item for item in stored if item.get("id") != message_id]
  if len(remaining) == len(stored):
    raise FileNotFoundError("消息不存在或已被删除")
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
    raise FileNotFoundError("会话不存在")
  _save_conversations(data_directory, remaining)
  return {"ok": True, "id": conversation_id, "deleted": 1}
