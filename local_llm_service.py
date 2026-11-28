from __future__ import annotations

import copy
import gc
import inspect
import os
import re
import threading
from functools import wraps
from typing import Any, Callable

from .prompt_library import _atomic_write_json, _read_json


LOCAL_LLM_CONFIG_FILENAME = "local-llm-config.json"

DEFAULT_LOCAL_LLM_CONFIG: dict[str, Any] = {
  "version": 2,
  "modelPath": "",
  "visionModelPath": "",
  "nCtx": 8192,
  "nBatch": 2048,
  "nUbatch": 512,
  "maxTokens": 1024,
  "maxRounds": 12,
  "temperature": 0.7,
  "topP": 0.95,
  "topK": 40,
  "minP": 0.05,
  "repeatPenalty": 1.1,
  "frequencyPenalty": 0.0,
  "presencePenalty": 0.0,
  "gpuLayers": -1,
  "threads": 0,
  "seed": 42,
  "maxImageEdge": 1024,
  "imageJpegQuality": 90,
  "flashAttention": "auto",
  "kvCacheTypeK": "default",
  "kvCacheTypeV": "default",
  "enableThinking": False,
  "preserveThinking": False,
  "reasoningEffort": "xhigh",
  "useMmap": True,
  "contextCheckpoints": 0,
}


class LocalLLMError(ValueError):
  pass


def _config_path(data_directory: str) -> str:
  return os.path.join(
    os.path.abspath(str(data_directory)),
    LOCAL_LLM_CONFIG_FILENAME,
  )


def local_llm_models_root() -> str:
  roots: list[str] = []
  try:
    import folder_paths

    getter = getattr(folder_paths, "get_folder_paths", None)
    if callable(getter):
      configured = getter("LLM")
      if isinstance(configured, (list, tuple)):
        roots.extend(str(item) for item in configured if str(item).strip())
  except Exception:
    pass

  try:
    import folder_paths

    models_directory = getattr(folder_paths, "models_dir", None)
    if not models_directory:
      base_path = getattr(
        folder_paths,
        "base_path",
        os.path.dirname(os.path.abspath(folder_paths.__file__)),
      )
      models_directory = os.path.join(base_path, "models")
    roots.append(os.path.join(str(models_directory), "LLM"))
  except Exception:
    plugin_root = os.path.dirname(os.path.abspath(__file__))
    nodes_root = os.path.dirname(plugin_root)
    comfy_root = os.path.dirname(nodes_root)
    roots.append(os.path.join(comfy_root, "models", "LLM"))

  seen: set[str] = set()
  candidates: list[str] = []
  for root in roots:
    normalized = os.path.abspath(os.path.expanduser(root))
    key = os.path.normcase(normalized)
    if key in seen:
      continue
    seen.add(key)
    candidates.append(normalized)
  for candidate in candidates:
    if os.path.isdir(candidate):
      return candidate
  return candidates[0]


def _model_relative_path(
  value: Any,
  models_root: str,
  *,
  require_file: bool,
  vision_model: bool = False,
) -> str:
  raw = str(value or "").strip()
  if not raw:
    return ""
  # Reject absolute, drive and UNC values from the text alone, before any
  # file-system call: resolving or stat-ing a network share would make the
  # server connect to it with the current Windows account.
  if raw.startswith(("\\", "/")) or re.match(r"^[A-Za-z]:", raw):
    raise LocalLLMError("Local model path must be a relative path under ComfyUI/models/LLM")
  parts = [
    part for part in raw.replace("\\", "/").split("/") if part not in {"", "."}
  ]
  if any(part == ".." for part in parts):
    raise LocalLLMError("Local model path is outside the ComfyUI/models/LLM directory")
  root = os.path.realpath(os.path.abspath(models_root))
  candidate = os.path.realpath(os.path.join(root, *parts))
  try:
    inside_root = os.path.commonpath([root, candidate]) == root
  except ValueError as error:
    raise LocalLLMError("Local model path is outside the ComfyUI/models/LLM directory") from error
  if not inside_root:
    raise LocalLLMError("Local model path is outside the ComfyUI/models/LLM directory")
  if os.path.splitext(candidate)[1].casefold() != ".gguf":
    raise LocalLLMError("Local model must be a .gguf file")
  is_vision_projection = "mmproj" in os.path.basename(candidate).casefold()
  if vision_model and not is_vision_projection:
    raise LocalLLMError("Vision projection model must be a .gguf file whose name contains mmproj")
  if not vision_model and is_vision_projection:
    raise LocalLLMError("mmproj is a vision projection file and cannot be used as the main chat model")
  if require_file and not os.path.isfile(candidate):
    raise LocalLLMError("The selected local GGUF model does not exist; refresh the model list")
  relative = os.path.relpath(candidate, root).replace("\\", "/")
  if relative == "." or relative.startswith("../"):
    raise LocalLLMError("Invalid local model path")
  return relative


def resolve_local_llm_model_path(
  value: Any,
  *,
  models_root: str | None = None,
  require_file: bool = True,
) -> str:
  root = models_root or local_llm_models_root()
  relative = _model_relative_path(value, root, require_file=require_file)
  if not relative:
    raise LocalLLMError("Please select a model in \"Local LLM Config\" first")
  return os.path.join(os.path.realpath(os.path.abspath(root)), *relative.split("/"))


def resolve_local_llm_vision_model_path(
  value: Any,
  *,
  models_root: str | None = None,
  require_file: bool = True,
) -> str:
  raw = str(value or "").strip()
  if not raw:
    return ""
  root = models_root or local_llm_models_root()
  relative = _model_relative_path(
    raw,
    root,
    require_file=require_file,
    vision_model=True,
  )
  return os.path.join(
    os.path.realpath(os.path.abspath(root)),
    *relative.split("/"),
  )


def _list_local_llm_files(
  models_root: str | None,
  *,
  vision_models: bool,
) -> list[dict[str, Any]]:
  root = os.path.realpath(os.path.abspath(models_root or local_llm_models_root()))
  if not os.path.isdir(root):
    return []
  models: list[dict[str, Any]] = []
  for directory, _subdirectories, files in os.walk(root):
    for filename in files:
      lower_name = filename.casefold()
      is_vision_projection = "mmproj" in lower_name
      if (
        not lower_name.endswith(".gguf")
        or (vision_models and not is_vision_projection)
        or (not vision_models and is_vision_projection)
      ):
        continue
      absolute = os.path.join(directory, filename)
      try:
        size = os.path.getsize(absolute)
      except OSError:
        size = 0
      relative = os.path.relpath(absolute, root).replace("\\", "/")
      models.append(
        {
          "name": os.path.splitext(filename)[0],
          "fileName": filename,
          "path": relative,
          "directory": os.path.dirname(relative).replace("\\", "/"),
          "size": size,
        }
      )
  models.sort(key=lambda item: str(item["path"]).casefold())
  return models


def list_local_llm_models(
  models_root: str | None = None,
) -> list[dict[str, Any]]:
  return _list_local_llm_files(models_root, vision_models=False)


def list_local_llm_vision_models(
  models_root: str | None = None,
) -> list[dict[str, Any]]:
  return _list_local_llm_files(models_root, vision_models=True)


def _integer(
  payload: dict[str, Any],
  key: str,
  default: int,
  minimum: int,
  maximum: int,
) -> int:
  raw = payload.get(key, default)
  try:
    number = int(raw)
  except (TypeError, ValueError) as error:
    raise LocalLLMError(f"Local LLM parameter {key} must be an integer") from error
  if number < minimum or number > maximum:
    raise LocalLLMError(
      f"Local LLM parameter {key} must be between {minimum} and {maximum}"
    )
  return number


def _number(
  payload: dict[str, Any],
  key: str,
  default: float,
  minimum: float,
  maximum: float,
) -> float:
  raw = payload.get(key, default)
  try:
    number = float(raw)
  except (TypeError, ValueError) as error:
    raise LocalLLMError(f"Local LLM parameter {key} must be a number") from error
  if not minimum <= number <= maximum:
    raise LocalLLMError(
      f"Local LLM parameter {key} must be between {minimum} and {maximum}"
    )
  return number


def _boolean(
  payload: dict[str, Any],
  key: str,
  default: bool,
) -> bool:
  raw = payload.get(key, default)
  if isinstance(raw, bool):
    return raw
  if isinstance(raw, (int, float)) and raw in {0, 1}:
    return bool(raw)
  normalized = str(raw or "").strip().casefold()
  if normalized in {"true", "1", "yes", "on", "开启", "是"}:
    return True
  if normalized in {"false", "0", "no", "off", "关闭", "否", ""}:
    return False
  raise LocalLLMError(f"Local LLM parameter {key} must be a boolean value")


def _choice(
  payload: dict[str, Any],
  key: str,
  default: str,
  choices: set[str],
) -> str:
  value = str(payload.get(key, default) or default).strip().casefold()
  if value not in choices:
    raise LocalLLMError(
      f"Local LLM parameter {key} must be one of: {', '.join(sorted(choices))}"
    )
  return value


def _normalize_local_llm_config(
  payload: Any,
  *,
  models_root: str | None = None,
  require_model_file: bool,
) -> dict[str, Any]:
  if not isinstance(payload, dict):
    raise LocalLLMError("Invalid local LLM config format")
  root = models_root or local_llm_models_root()
  config = {
    "version": 2,
    "modelPath": _model_relative_path(
      payload.get("modelPath"),
      root,
      require_file=require_model_file,
    ),
    "visionModelPath": _model_relative_path(
      payload.get("visionModelPath"),
      root,
      require_file=require_model_file,
      vision_model=True,
    ),
    "nCtx": _integer(payload, "nCtx", 8192, 512, 131072),
    "nBatch": _integer(payload, "nBatch", 2048, 32, 65536),
    "nUbatch": _integer(payload, "nUbatch", 512, 32, 65536),
    "maxTokens": _integer(payload, "maxTokens", 1024, 1, 32768),
    "maxRounds": _integer(payload, "maxRounds", 12, 1, 50),
    "temperature": _number(payload, "temperature", 0.7, 0.0, 2.0),
    "topP": _number(payload, "topP", 0.95, 0.01, 1.0),
    "topK": _integer(payload, "topK", 40, 1, 200),
    "minP": _number(payload, "minP", 0.05, 0.0, 1.0),
    "repeatPenalty": _number(
      payload,
      "repeatPenalty",
      1.1,
      0.5,
      2.0,
    ),
    "frequencyPenalty": _number(
      payload,
      "frequencyPenalty",
      0.0,
      -2.0,
      2.0,
    ),
    "presencePenalty": _number(
      payload,
      "presencePenalty",
      0.0,
      -2.0,
      2.0,
    ),
    "gpuLayers": _integer(payload, "gpuLayers", -1, -1, 1000),
    "threads": _integer(payload, "threads", 0, 0, 128),
    "seed": _integer(payload, "seed", 42, 0, 4_294_967_295),
    "maxImageEdge": _integer(payload, "maxImageEdge", 1024, 256, 4096),
    "imageJpegQuality": _integer(
      payload,
      "imageJpegQuality",
      90,
      40,
      100,
    ),
    "flashAttention": _choice(
      payload,
      "flashAttention",
      "auto",
      {"auto", "enabled", "disabled"},
    ),
    "kvCacheTypeK": _choice(
      payload,
      "kvCacheTypeK",
      "default",
      {"default", "q8_0"},
    ),
    "kvCacheTypeV": _choice(
      payload,
      "kvCacheTypeV",
      "default",
      {"default", "q8_0"},
    ),
    "enableThinking": _boolean(payload, "enableThinking", False),
    "preserveThinking": _boolean(payload, "preserveThinking", False),
    "reasoningEffort": _choice(
      payload,
      "reasoningEffort",
      "xhigh",
      {"xhigh", "medium", "low"},
    ),
    "useMmap": _boolean(payload, "useMmap", True),
    "contextCheckpoints": _integer(
      payload,
      "contextCheckpoints",
      0,
      0,
      64,
    ),
  }
  if config["nUbatch"] > config["nBatch"]:
    raise LocalLLMError("n_ubatch cannot be greater than n_batch")
  return config


def build_local_llm_config(
  payload: Any,
  *,
  models_root: str | None = None,
  require_model_file: bool = True,
) -> dict[str, Any]:
  """Normalize an in-memory local LLM config without reading or writing files."""
  return _normalize_local_llm_config(
    payload,
    models_root=models_root,
    require_model_file=require_model_file,
  )


def load_local_llm_config(
  data_directory: str,
  *,
  models_root: str | None = None,
) -> dict[str, Any]:
  path = _config_path(data_directory)
  payload = _read_json(path, DEFAULT_LOCAL_LLM_CONFIG)
  return _normalize_local_llm_config(
    payload,
    models_root=models_root,
    require_model_file=False,
  )


def save_local_llm_config(
  data_directory: str,
  payload: dict[str, Any],
  *,
  models_root: str | None = None,
) -> dict[str, Any]:
  config = _normalize_local_llm_config(
    payload,
    models_root=models_root,
    require_model_file=True,
  )
  _atomic_write_json(_config_path(data_directory), config)
  return copy.deepcopy(config)


def _local_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
  normalized: list[dict[str, Any]] = []
  for message in messages:
    if not isinstance(message, dict):
      continue
    role = str(message.get("role") or "").strip().lower()
    if role not in {"system", "user", "assistant"}:
      continue
    content = message.get("content")
    if isinstance(content, list):
      parts: list[dict[str, Any]] = []
      for raw_part in content:
        if not isinstance(raw_part, dict):
          continue
        part_type = str(raw_part.get("type") or "text").strip()
        if part_type == "text":
          text = str(raw_part.get("text") or "").strip()
          if text:
            parts.append({"type": "text", "text": text})
        elif part_type in {"image_url", "input_audio"}:
          parts.append(copy.deepcopy(raw_part))
      if not parts:
        continue
      if len(parts) == 1 and parts[0].get("type") == "text":
        normalized.append({"role": role, "content": parts[0]["text"]})
      else:
        normalized.append({"role": role, "content": parts})
    else:
      text = str(content or "").strip()
      if text:
        normalized.append({"role": role, "content": text})
  if not normalized:
    raise LocalLLMError("Messages sent to the local model are empty")
  return normalized


def _strip_think_blocks(value: str) -> str:
  text = str(value or "")
  text = re.sub(
    r"<think\b[^>]*>.*?</think>",
    "",
    text,
    flags=re.DOTALL | re.IGNORECASE,
  )
  if re.search(r"</think>", text, flags=re.IGNORECASE):
    text = re.sub(
      r"^.*?</think>\s*",
      "",
      text,
      count=1,
      flags=re.DOTALL | re.IGNORECASE,
    )
  return text.replace("<think>", "").replace("</think>", "").strip()


def _response_text(result: Any) -> str:
  if not isinstance(result, dict):
    raise LocalLLMError("The local model returned an unrecognized response format")
  choices = result.get("choices")
  if not isinstance(choices, list) or not choices:
    error = result.get("error")
    if isinstance(error, dict):
      error = error.get("message") or error
    raise LocalLLMError(f"The local model returned no reply: {error or 'unknown reason'}")
  first = choices[0] if isinstance(choices[0], dict) else {}
  message = first.get("message")
  content = message.get("content") if isinstance(message, dict) else None
  if isinstance(content, list):
    text = "\n".join(
      str(part.get("text") or "")
      for part in content
      if isinstance(part, dict)
    )
  else:
    text = str(content or "")
  text = _strip_think_blocks(text)
  if not text:
    raise LocalLLMError("The local model returned an empty message")
  return text


def local_model_family(model_path: str) -> str:
  name = os.path.basename(str(model_path or "")).casefold()
  compact = re.sub(r"[\s._-]+", "", name)
  if "gemma4" in compact or ("gemma" in compact and re.search(r"gemma-?4", name)):
    return "gemma4"
  if "qwen38" in compact or re.search(
    r"qwen[\s._-]*3[\s._-]*8",
    name,
  ):
    return "qwen3.8"
  if "qwen36" in compact or "qwen35" in compact or re.search(
    r"qwen[\s._-]*3[\s._-]*(?:5|6)",
    name,
  ):
    return "qwen3.5/3.6"
  if "qwen3vl" in compact or re.search(
    r"qwen[\s._-]*3[\s._-]*vl",
    name,
  ):
    return "qwen3-vl"
  return "generic"


def _load_chat_handler_class(
  module_names: tuple[str, ...],
  class_name: str,
) -> Any:
  import importlib

  for module_name in module_names:
    try:
      module = importlib.import_module(module_name)
      handler_class = getattr(module, class_name)
      return handler_class
    except (ImportError, AttributeError):
      continue
  raise LocalLLMError(
    f"The current llama-cpp-python does not support {class_name}; please update llama-cpp-python."
  )


def _create_multimodal_handler(
  handler_class: Callable[..., Any],
  mmproj_path: str,
  **kwargs: Any,
) -> Any:
  try:
    return handler_class(mmproj_path=mmproj_path, **kwargs)
  except TypeError as error:
    message = str(error).casefold()
    if (
      "mmproj_path" not in message
      or "unexpected" not in message
    ) and (
      "clip_model_path" not in message
      or "required" not in message
    ):
      raise
    return handler_class(clip_model_path=mmproj_path, **kwargs)


def _create_qwen35_handler(
  mmproj_path: str,
  *,
  enable_thinking: bool,
  preserve_thinking: bool,
  reasoning_effort: str | None = None,
  chat_template_override: str | None = None,
) -> Any:
  handler_class = _load_chat_handler_class(
    ("llama_cpp.llama_chat_format",),
    "Qwen35ChatHandler",
  )
  shared: dict[str, Any] = {"verbose": False}
  if reasoning_effort:
    shared["extra_template_arguments"] = {
      "reasoning_effort": reasoning_effort,
    }
  if chat_template_override:
    shared["chat_template_override"] = chat_template_override
  candidates = [
    {
      "enable_thinking": enable_thinking,
      "add_vision_id": True,
      "preserve_thinking": preserve_thinking,
      **shared,
    },
    {
      "enable_thinking": enable_thinking,
      "preserve_thinking": preserve_thinking,
      **shared,
    },
    {
      "enable_thinking": enable_thinking,
      "add_vision_id": True,
      **shared,
    },
    {"enable_thinking": enable_thinking, **shared},
  ]
  last_error: TypeError | None = None
  for kwargs in candidates:
    try:
      return _create_multimodal_handler(
        handler_class,
        mmproj_path,
        **kwargs,
      )
    except TypeError as error:
      last_error = error
  if last_error is not None:
    raise last_error
  raise LocalLLMError("Failed to create the Qwen3.5/3.6 vision chat handler")


def _adapt_qwen38_multimodal_template(chat_template: str) -> str:
  if not chat_template or "<|image_pad|>" not in chat_template:
    return chat_template
  output_pattern = (
    r"\{\{-?\s*(['\"])<\|vision_start\|><\|image_pad\|>"
    r"<\|vision_end\|>\1\s*-?\}\}"
  )
  replacement = (
    "{{- '<|vision_start|>' }}"
    "{%- if item.image_url is string %}"
    "{{- item.image_url }}"
    "{%- else %}"
    "{{- item.image_url.url }}"
    "{%- endif %}"
    "{{- '<|vision_end|>' }}"
  )
  adapted, count = re.subn(output_pattern, replacement, chat_template)
  if count == 0:
    raise LocalLLMError(
      "Qwen3.8 chat template contains <|image_pad|> but cannot be adapted to the current vision handler"
    )
  return adapted


def _create_qwen38_vision_handler(
  mmproj_path: str,
  *,
  chat_template: str,
  config: dict[str, Any],
) -> Any:
  generic_error: Exception | None = None
  try:
    generic_class = _load_chat_handler_class(
      (
        "llama_cpp.llama_multimodal",
        "llama_cpp.llama_chat_format",
      ),
      "GenericMTMDChatHandler",
    )
    return _create_multimodal_handler(
      generic_class,
      mmproj_path,
      chat_format=chat_template,
      extra_template_arguments={
        "add_vision_id": True,
        "enable_thinking": bool(config["enableThinking"]),
        "preserve_thinking": bool(config["preserveThinking"]),
        "reasoning_effort": str(config["reasoningEffort"]),
      },
      verbose=False,
    )
  except Exception as error:
    generic_error = error

  try:
    return _create_qwen35_handler(
      mmproj_path,
      enable_thinking=bool(config["enableThinking"]),
      preserve_thinking=bool(config["preserveThinking"]),
      reasoning_effort=str(config["reasoningEffort"]),
      chat_template_override=_adapt_qwen38_multimodal_template(
        chat_template
      ),
    )
  except Exception as fallback_error:
    raise LocalLLMError(
      "Unable to create the Qwen3.8 vision chat handler: "
      f"GenericMTMD={generic_error or 'unavailable'}; "
      f"Qwen35 fallback={fallback_error}"
    ) from fallback_error


def _create_qwen38_text_handler(
  llama: Any,
  *,
  config: dict[str, Any],
) -> Any:
  try:
    from llama_cpp.llama_chat_format import (
      Jinja2ChatFormatter,
      chat_formatter_to_chat_completion_handler,
    )
  except Exception as error:
    raise LocalLLMError(
      "The current llama-cpp-python does not support the Qwen3.8 chat template"
    ) from error
  metadata = getattr(llama, "metadata", {}) or {}
  chat_template = metadata.get("tokenizer.chat_template")
  if not chat_template:
    raise LocalLLMError(
      "Qwen3.8 GGUF is missing tokenizer.chat_template; cannot apply reasoning settings"
    )
  model = getattr(llama, "_model", None)

  def token_text(token_id: int) -> str:
    if token_id == -1 or model is None or not hasattr(model, "token_get_text"):
      return ""
    return model.token_get_text(token_id)

  eos_token_id = llama.token_eos()
  bos_token_id = llama.token_bos()
  eot_token_id = llama.token_eot()
  stop_token_ids = [
    token_id
    for token_id in (eos_token_id, eot_token_id)
    if token_id != -1
  ] or None
  formatter = Jinja2ChatFormatter(
    template=chat_template,
    eos_token=token_text(eos_token_id),
    bos_token=token_text(bos_token_id),
    stop_token_ids=stop_token_ids,
  )

  def qwen38_formatter(*, messages: list[dict[str, Any]], **kwargs: Any) -> Any:
    kwargs.update(
      {
        "enable_thinking": bool(config["enableThinking"]),
        "preserve_thinking": bool(config["preserveThinking"]),
        "reasoning_effort": str(config["reasoningEffort"]),
      }
    )
    return formatter(messages=messages, **kwargs)

  return chat_formatter_to_chat_completion_handler(qwen38_formatter)


def _create_known_vision_handler(
  family: str,
  mmproj_path: str,
  config: dict[str, Any],
) -> Any:
  if family == "qwen3-vl":
    handler_class = _load_chat_handler_class(
      ("llama_cpp.llama_chat_format",),
      "Qwen3VLChatHandler",
    )
    thinking = bool(config["enableThinking"])
    try:
      return _create_multimodal_handler(
        handler_class,
        mmproj_path,
        force_reasoning=thinking,
        verbose=False,
      )
    except TypeError:
      try:
        return _create_multimodal_handler(
          handler_class,
          mmproj_path,
          use_think_prompt=thinking,
          verbose=False,
        )
      except TypeError:
        return _create_multimodal_handler(
          handler_class,
          mmproj_path,
          verbose=False,
        )
  if family == "qwen3.5/3.6":
    return _create_qwen35_handler(
      mmproj_path,
      enable_thinking=bool(config["enableThinking"]),
      preserve_thinking=bool(config["preserveThinking"]),
    )
  if family == "gemma4":
    handler_class = _load_chat_handler_class(
      ("llama_cpp.llama_chat_format",),
      "Gemma4ChatHandler",
    )
    return _create_multimodal_handler(
      handler_class,
      mmproj_path,
      enable_thinking=bool(config["enableThinking"]),
      verbose=False,
    )
  return None


def _supports_parameter(factory: Callable[..., Any], name: str) -> bool:
  try:
    parameters = inspect.signature(factory).parameters.values()
  except (TypeError, ValueError):
    return False
  return any(
    parameter.name == name
    or parameter.kind == inspect.Parameter.VAR_KEYWORD
    for parameter in parameters
  )


def effective_local_sampling(
  config: dict[str, Any],
  model_path: str,
) -> dict[str, float | int]:
  family = local_model_family(model_path)
  temperature = float(config["temperature"])
  top_p = float(config["topP"])
  top_k = int(config["topK"])
  min_p = float(config["minP"])
  if family == "qwen3.8":
    recommended = (
      (1.0, 0.95, 20)
      if bool(config["enableThinking"])
      else (0.7, 0.80, 20)
    )
    if abs(temperature - 0.7) < 1e-9:
      temperature = recommended[0]
    if abs(top_p - 0.95) < 1e-9:
      top_p = recommended[1]
    if top_k == 40:
      top_k = recommended[2]
    if abs(min_p - DEFAULT_LOCAL_LLM_CONFIG["minP"]) < 1e-9:
      min_p = 0.0
  elif family == "gemma4":
    if abs(temperature - 0.7) < 1e-9:
      temperature = 1.0
    if abs(top_p - 0.95) < 1e-9:
      top_p = 0.95
    if top_k == 40:
      top_k = 64
  return {
    "temperature": temperature,
    "topP": top_p,
    "topK": top_k,
    "minP": min_p,
  }


def _call_chat_completion(
  llama: Any,
  *,
  messages: list[dict[str, Any]],
  params: dict[str, Any],
) -> Any:
  kwargs = dict(params)
  kwargs["messages"] = messages
  try:
    signature = inspect.signature(llama.create_chat_completion)
    parameters = signature.parameters
    accepts_extra = any(
      parameter.kind == inspect.Parameter.VAR_KEYWORD
      for parameter in parameters.values()
    )
  except (TypeError, ValueError):
    parameters = {}
    accepts_extra = True

  if parameters:
    if (
      "presence_penalty" in kwargs
      and "presence_penalty" not in parameters
      and "present_penalty" in parameters
    ):
      kwargs["present_penalty"] = kwargs.pop("presence_penalty")
    elif (
      "present_penalty" in kwargs
      and "present_penalty" not in parameters
      and "presence_penalty" in parameters
    ):
      kwargs["presence_penalty"] = kwargs.pop("present_penalty")
    if not accepts_extra:
      kwargs = {
        key: value
        for key, value in kwargs.items()
        if key in parameters
      }
  return llama.create_chat_completion(**kwargs)


_CONTEXT_OVERFLOW_MARKERS = (
  "context shift is explicitly disabled",
  "context shift failed",
  "exceeded context limit",
  "larger than the entire context window",
)
_CONTEXT_N_CTX_MAX = 131072


def _is_context_overflow_error(error: BaseException) -> bool:
  text = str(error).casefold()
  return any(marker in text for marker in _CONTEXT_OVERFLOW_MARKERS)


def _context_overflow_message(n_ctx: int) -> str:
  message = (
    "Local model prompt exceeded the context window "
    f"(n_ctx={n_ctx}), and this model cannot shift context "
    "automatically (M-RoPE / vision models such as Qwen-VL)."
  )
  if n_ctx < _CONTEXT_N_CTX_MAX:
    suggested = min(_CONTEXT_N_CTX_MAX, n_ctx * 2)
    message += (
      f" Raise \"Context length n_ctx\" (local_n_ctx) to at least "
      f"{suggested}, or reduce history rounds (local_max_rounds), "
      "image edge (local_max_image_edge), the selected Skill or system "
      "prompt, or max reply tokens (local_max_tokens)."
    )
  else:
    message += (
      " n_ctx is already at the maximum; reduce history rounds "
      "(local_max_rounds), image edge (local_max_image_edge), the "
      "selected Skill or system prompt, or max reply tokens "
      "(local_max_tokens)."
    )
  return message


class LocalLlamaManager:
  def __init__(
    self,
    llama_factory: Callable[..., Any] | None = None,
  ) -> None:
    self._llama_factory = llama_factory
    self._lock = threading.RLock()
    self._state_lock = threading.Lock()
    self._llama: Any = None
    self._load_key: tuple[Any, ...] | None = None
    self._active_llama: Any = None

  def _factory(self) -> Callable[..., Any]:
    if self._llama_factory is not None:
      return self._llama_factory
    try:
      from llama_cpp import Llama
    except Exception as error:
      raise LocalLLMError(
        "llama_cpp is not loaded. Please install "
        "llama-cpp-python in the ComfyUI Python environment first."
      ) from error
    return Llama

  def reset(self) -> None:
    with self._lock:
      llama = self._llama
      self._llama = None
      self._load_key = None
      with self._state_lock:
        self._active_llama = None
      close = getattr(llama, "close", None)
      if callable(close):
        try:
          close()
        except Exception:
          pass

  def abort_current(self) -> bool:
    """Ask the active llama.cpp completion to stop without waiting on chat's lock."""
    with self._state_lock:
      llama = self._active_llama
    abort = getattr(llama, "abort", None)
    if not callable(abort):
      return False
    try:
      abort()
    except Exception:
      return False
    return True

  def _get_llama(
    self,
    config: dict[str, Any],
    model_path: str,
    vision_model_path: str,
  ) -> Any:
    family = local_model_family(model_path)
    key = (
      os.path.normcase(os.path.realpath(model_path)),
      os.path.normcase(os.path.realpath(vision_model_path))
      if vision_model_path
      else "",
      family,
      int(config["nCtx"]),
      int(config["nBatch"]),
      int(config["nUbatch"]),
      int(config["gpuLayers"]),
      int(config["threads"]),
      int(config["seed"]),
      str(config["flashAttention"]),
      str(config["kvCacheTypeK"]),
      str(config["kvCacheTypeV"]),
      bool(config["enableThinking"]),
      bool(config["preserveThinking"]),
      str(config["reasoningEffort"]),
      bool(config["useMmap"]),
      int(config["contextCheckpoints"]),
    )
    if self._llama is not None and self._load_key == key:
      return self._llama
    if self._llama is not None:
      self.reset()
    factory = self._factory()
    kwargs: dict[str, Any] = {
      "model_path": model_path,
      "n_ctx": int(config["nCtx"]),
      "n_batch": int(config["nBatch"]),
      "n_ubatch": int(config["nUbatch"]),
      "n_gpu_layers": int(config["gpuLayers"]),
      "seed": int(config["seed"]),
      "verbose": False,
    }
    if int(config["threads"]) > 0:
      kwargs["n_threads"] = int(config["threads"])

    chat_handler = None
    deferred_handler = family == "qwen3.8"
    if vision_model_path:
      if deferred_handler:
        chat_handler = None
      elif family == "generic":
        kwargs["mmproj_path"] = vision_model_path
      else:
        chat_handler = _create_known_vision_handler(
          family,
          vision_model_path,
          config,
        )
    if chat_handler is not None:
      kwargs["chat_handler"] = chat_handler

    if _supports_parameter(factory, "use_mmap"):
      kwargs["use_mmap"] = bool(config["useMmap"])
    elif config["useMmap"]:
      raise LocalLLMError(
        "The current llama-cpp-python does not support use_mmap; please update the dependency"
      )

    flash_attention = str(config["flashAttention"])
    if flash_attention != "auto":
      if not _supports_parameter(factory, "flash_attn_type"):
        raise LocalLLMError(
          "The current llama-cpp-python does not support the Flash Attention setting"
        )
      kwargs["flash_attn_type"] = (
        1 if flash_attention == "enabled" else 0
      )

    for key_name in ("kvCacheTypeK", "kvCacheTypeV"):
      if config[key_name] == "q8_0":
        parameter = "type_k" if key_name == "kvCacheTypeK" else "type_v"
        if not _supports_parameter(factory, parameter):
          raise LocalLLMError(
            "The current llama-cpp-python does not support KV cache q8_0 quantization"
          )
        kwargs[parameter] = 8

    if _supports_parameter(factory, "ctx_checkpoints"):
      kwargs["ctx_checkpoints"] = int(config["contextCheckpoints"])

    try:
      llama = factory(**kwargs)
    except Exception as error:
      raise LocalLLMError(
        f"Unable to load local GGUF model \"{os.path.basename(model_path)}\": {error}"
      ) from error
    if deferred_handler:
      try:
        chat_template = (
          getattr(llama, "metadata", {}) or {}
        ).get("tokenizer.chat_template")
        if vision_model_path:
          chat_handler = _create_qwen38_vision_handler(
            vision_model_path,
            chat_template=str(chat_template or ""),
            config=config,
          )
        else:
          chat_handler = _create_qwen38_text_handler(
            llama,
            config=config,
          )
        llama.chat_handler = chat_handler
      except Exception:
        close = getattr(llama, "close", None)
        if callable(close):
          try:
            close()
          except Exception:
            pass
        raise
    self._llama = llama
    self._load_key = key
    return llama

  def chat(
    self,
    config: dict[str, Any],
    messages: list[dict[str, Any]],
    *,
    models_root: str | None = None,
    seed: int | None = None,
  ) -> str:
    normalized = _normalize_local_llm_config(
      config,
      models_root=models_root,
      require_model_file=True,
    )
    model_path = resolve_local_llm_model_path(
      normalized["modelPath"],
      models_root=models_root,
      require_file=True,
    )
    vision_model_path = resolve_local_llm_vision_model_path(
      normalized["visionModelPath"],
      models_root=models_root,
      require_file=True,
    )
    local_messages = _local_messages(messages)
    sampling_seed = (
      int(normalized["seed"])
      if seed is None
      else _integer(
        {"seed": seed},
        "seed",
        int(normalized["seed"]),
        0,
        4_294_967_295,
      )
    )
    with self._lock:
      llama = self._get_llama(
        normalized,
        model_path,
        vision_model_path,
      )
      sampling = effective_local_sampling(normalized, model_path)
      with self._state_lock:
        self._active_llama = llama
      try:
        result = _call_chat_completion(
          llama,
          messages=local_messages,
          params={
            "temperature": float(sampling["temperature"]),
            "top_p": float(sampling["topP"]),
            "top_k": int(sampling["topK"]),
            "min_p": float(sampling["minP"]),
            "repeat_penalty": float(normalized["repeatPenalty"]),
            "frequency_penalty": float(normalized["frequencyPenalty"]),
            "presence_penalty": float(normalized["presencePenalty"]),
            "seed": sampling_seed,
            "max_tokens": int(normalized["maxTokens"]),
            "stream": False,
            "stop": ["</s>"],
          },
        )
      except Exception as error:
        if _is_context_overflow_error(error):
          raise LocalLLMError(
            _context_overflow_message(int(normalized["nCtx"]))
          ) from error
        raise LocalLLMError(f"Local model inference failed: {error}") from error
      finally:
        with self._state_lock:
          if self._active_llama is llama:
            self._active_llama = None
    return _response_text(result)


LOCAL_LLM_MANAGER = LocalLlamaManager()
_GLOBAL_UNLOAD_HOOK_ATTRIBUTE = (
  "_assets_astral_local_llm_unload_hook_installed"
)


def release_local_llm_memory(
  manager: LocalLlamaManager | None = None,
) -> None:
  """Close the cached GGUF model and release its native memory."""
  try:
    (manager or LOCAL_LLM_MANAGER).reset()
  finally:
    gc.collect()


def install_global_unload_hook(
  model_management_module: Any | None = None,
) -> bool:
  """Make ComfyUI's global model unload also release local GGUF models."""
  if model_management_module is None:
    try:
      import comfy.model_management as model_management_module
    except Exception:
      return False
  if getattr(model_management_module, _GLOBAL_UNLOAD_HOOK_ATTRIBUTE, False):
    return False

  original = getattr(model_management_module, "unload_all_models", None)
  if not callable(original):
    return False

  @wraps(original)
  def wrapped_unload_all_models(*args: Any, **kwargs: Any) -> Any:
    try:
      release_local_llm_memory()
    except Exception:
      pass
    try:
      return original(*args, **kwargs)
    finally:
      soft_empty_cache = getattr(
        model_management_module,
        "soft_empty_cache",
        None,
      )
      if callable(soft_empty_cache):
        try:
          soft_empty_cache()
        except Exception:
          pass

  model_management_module.unload_all_models = wrapped_unload_all_models
  setattr(model_management_module, _GLOBAL_UNLOAD_HOOK_ATTRIBUTE, True)
  return True


def generate_local_chat(
  config: dict[str, Any],
  messages: list[dict[str, Any]],
  *,
  manager: LocalLlamaManager | None = None,
  models_root: str | None = None,
  seed: int | None = None,
) -> str:
  return (manager or LOCAL_LLM_MANAGER).chat(
    config,
    messages,
    models_root=models_root,
    seed=seed,
  )
