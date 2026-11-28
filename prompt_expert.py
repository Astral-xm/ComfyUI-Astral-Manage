"""Prompt Processor: node-local API / local GGUF chat with optional multi-turn history."""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from typing import Any

from .nodes import (
  _prompt_processor_enabled,
  _prompt_processor_mode,
  build_prompt_processor_attachments,
)

API_PROFILE_LIMIT = 5
MAX_EXPERT_HISTORY_ROUNDS = 50
EMPTY_EXPERT_HISTORY = '{"version":1,"skill":"","messages":[]}'
EMPTY_API_PROFILES = "[]"
EMPTY_EXPERT_CONVERSATIONS = '{"version":1,"active":0,"items":[]}'

_SKILL_STATE_RE = re.compile(
  r"<[^>\s]*skill_state[^>]*>[\s\S]*?</[^>\s]*skill_state>",
  re.IGNORECASE,
)
_FENCED_BLOCK_RE = re.compile(r"```[^\n`]*\n([\s\S]*?)```")
_PROMPT_FILLER_RE = re.compile(
  r"^(?:您需要的(?:提示词|结果)如下|以下是(?:为您)?(?:扩写|反推|生成|优化)?的?(?:提示词|结果)"
  r"|here(?:'s| is| are) (?:the )?(?:final |expanded |generated )?(?:prompt|result)s?"
  r"|the (?:final )?prompt is|prompt)[\s:：]*$",
  re.IGNORECASE,
)


def _text(value: Any) -> str:
  return str(value or "").strip()


def _prompt_expert_history(value: Any) -> tuple[str, list[dict[str, Any]]]:
  raw = _text(value)
  if not raw:
    return "", []
  try:
    payload = json.loads(raw)
  except (TypeError, ValueError):
    return "", []
  if isinstance(payload, list):
    skill = ""
    entries = payload
  elif isinstance(payload, dict):
    skill = _text(payload.get("skill"))
    entries = payload.get("messages")
  else:
    return "", []
  if not isinstance(entries, list):
    return skill, []
  messages: list[dict[str, Any]] = []
  for entry in entries:
    if not isinstance(entry, dict):
      continue
    role = _text(entry.get("role")).lower()
    content = entry.get("content")
    if role not in {"user", "assistant"} or not isinstance(content, str):
      continue
    content = content.strip()
    if not content:
      continue
    record: dict[str, Any] = {"role": role, "content": content}
    prompt = entry.get("prompt")
    if role == "assistant" and isinstance(prompt, str) and prompt.strip():
      record["prompt"] = prompt.strip()
    timestamp = entry.get("time")
    if isinstance(timestamp, (int, float)):
      record["time"] = int(timestamp)
    messages.append(record)
  return skill, messages


def _serialize_expert_history(
  skill: str,
  messages: list[dict[str, Any]],
) -> str:
  return json.dumps(
    {"version": 1, "skill": _text(skill), "messages": messages},
    ensure_ascii=False,
    separators=(",", ":"),
  )


def _trim_expert_history(
  messages: list[dict[str, Any]],
  max_rounds: int = MAX_EXPERT_HISTORY_ROUNDS,
) -> list[dict[str, Any]]:
  limit = max(1, int(max_rounds)) * 2
  trimmed = list(messages[-limit:])
  while trimmed and trimmed[0].get("role") == "assistant":
    trimmed.pop(0)
  return trimmed


def clean_prompt_reply(reply: Any) -> str:
  """Return the prompt carried by an assistant reply, without conversational filler."""
  text = _SKILL_STATE_RE.sub("", str(reply or "")).strip()
  if not text:
    return ""
  fenced = _FENCED_BLOCK_RE.search(text)
  if fenced:
    text = fenced.group(1).strip()
  lines = text.splitlines()
  while lines:
    first = lines[0].strip()
    if not first:
      lines.pop(0)
      continue
    if _PROMPT_FILLER_RE.match(first):
      lines.pop(0)
      continue
    if len(first) <= 24 and first.endswith(("：", ":", "如下")):
      lines.pop(0)
      continue
    break
  while lines:
    last = lines[-1].strip()
    if not last:
      lines.pop()
      continue
    if len(last) <= 24 and last.endswith(("：", ":")):
      lines.pop()
      continue
    break
  text = "\n".join(lines).strip()
  if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'“”‘’「」『』":
    text = text[1:-1].strip()
  wrapped = re.fullmatch(r"\*\*(.+?)\*\*", text, flags=re.DOTALL)
  if wrapped:
    text = wrapped.group(1).strip()
  return text.strip()


def _skill_roots() -> list[str]:
  """Candidate skills folders, most specific first."""
  roots: list[str] = []
  try:
    import folder_paths

    for base in folder_paths.get_folder_paths("custom_nodes") or []:
      try:
        entries = sorted(os.listdir(base))
      except OSError:
        continue
      for name in entries:
        skills_dir = os.path.join(base, name, "skills")
        if os.path.isdir(skills_dir):
          roots.append(skills_dir)
  except Exception:
    pass
  roots.sort(key=lambda path: ("llama-te" not in path.casefold(), path.casefold()))
  package_skills = os.path.join(
    os.path.dirname(os.path.realpath(__file__)),
    "skills",
  )
  if os.path.isdir(package_skills):
    roots.append(package_skills)
  return roots


def _read_skill_text(path: str) -> str:
  with open(path, "r", encoding="utf-8-sig") as file:
    return file.read()


def _skill_record(value: dict[str, Any], skill_id: str) -> dict[str, Any] | None:
  for record in value.get("skills") or []:
    if not isinstance(record, dict):
      continue
    if str(record.get("id") or "") == skill_id:
      return record
    if str(record.get("skill_path") or "") == skill_id:
      return record
  return None


def resolve_skill_input(value: Any) -> tuple[str, str]:
  """Return (system text, stable skill key) for a linked skill value."""
  if value is None or value == "":
    return "", ""
  if isinstance(value, str):
    text = value.strip()
    if not text:
      return "", ""
    key = f"text:{hashlib.sha1(text.encode('utf-8')).hexdigest()[:16]}"
    return text, key
  if not isinstance(value, dict):
    return "", ""

  inline = value.get("inline_file")
  if isinstance(inline, dict):
    content = _text(inline.get("content"))
    if content:
      name = _text(inline.get("name")) or "Skill"
      return f"# Skill: {name}\n\n{content}", f"inline:{name}"

  skill_id = _text(value.get("selected"))
  if not skill_id:
    return "", ""
  record = _skill_record(value, skill_id)
  candidates: list[str] = []
  if record:
    directory = _text(record.get("skill_dir")).strip("/")
    filename = _text(record.get("skill_file"))
    if filename:
      candidates.append(f"{directory}/{filename}".lstrip("/"))
    path = _text(record.get("skill_path")).strip("/")
    if path and path not in candidates:
      candidates.append(path)
  normalized = skill_id.replace("\\", "/").strip("/")
  if normalized and normalized not in candidates:
    candidates.append(normalized)

  for root in _skill_roots():
    root_real = os.path.realpath(root)
    for relative in candidates:
      path = os.path.realpath(
        os.path.join(root_real, *relative.split("/"))
      )
      if os.path.commonpath([root_real, path]) != root_real:
        continue
      if not os.path.isfile(path):
        continue
      content = _read_skill_text(path).strip()
      if not content:
        continue
      name = (
        _text(record.get("name")) if record else ""
      ) or os.path.splitext(os.path.basename(path))[0] or os.path.basename(path)
      return f"# Skill: {name}\n\n{content}", f"file:{relative}"
  raise ValueError(f"Skill file was not found for: {skill_id}")


def _api_profiles(value: Any) -> list[dict[str, str]]:
  """Return exactly API_PROFILE_LIMIT normalized profiles."""
  raw = _text(value)
  payload: Any = []
  if raw:
    try:
      payload = json.loads(raw)
    except (TypeError, ValueError):
      payload = []
  if isinstance(payload, dict):
    payload = payload.get("profiles") or []
  entries = payload if isinstance(payload, list) else []
  profiles: list[dict[str, str]] = []
  for index in range(API_PROFILE_LIMIT):
    entry = entries[index] if index < len(entries) else None
    entry = entry if isinstance(entry, dict) else {}
    profiles.append(
      {
        "name": _text(entry.get("name")) or f"Profile {index + 1}",
        "baseUrl": _text(entry.get("baseUrl")),
        "apiKey": _text(entry.get("apiKey")),
        "model": _text(entry.get("model")),
      }
    )
  return profiles


def _active_api_profile(
  profiles_value: Any,
  active: Any,
) -> tuple[dict[str, str], int]:
  profiles = _api_profiles(profiles_value)
  try:
    index = int(active) - 1
  except (TypeError, ValueError):
    index = 0
  index = min(max(index, 0), API_PROFILE_LIMIT - 1)
  return profiles[index], index + 1


def _prompt_expert_api_config(
  profile: dict[str, str],
  api_temperature: Any,
  api_max_tokens: Any,
  api_top_p: Any,
  api_frequency_penalty: Any,
  api_presence_penalty: Any,
  api_seed: Any,
  api_response_format: Any,
  api_reasoning_effort: Any,
) -> dict[str, Any]:
  from .prompt_library import DEFAULT_API_CONFIG

  base = _text(profile.get("baseUrl")).rstrip("/")
  model = _text(profile.get("model"))
  if not base:
    raise ValueError(
      "Enter the API base URL for the selected API profile"
    )
  if not model:
    raise ValueError(
      "Enter the API model name for the selected API profile"
    )
  seed = int(api_seed) if api_seed not in (None, "") else None
  config = dict(DEFAULT_API_CONFIG)
  config.update(
    {
      "baseUrl": base,
      "apiKey": _text(profile.get("apiKey")),
      "model": model,
      "temperature": float(api_temperature),
      "topP": float(api_top_p),
      "maxTokens": int(api_max_tokens),
      "frequencyPenalty": float(api_frequency_penalty),
      "presencePenalty": float(api_presence_penalty),
      "seed": seed,
      "responseFormat": _text(api_response_format) or "default",
      "reasoningEffort": _text(api_reasoning_effort) or "default",
      # The node supplies its own system prompt through the input port.
      "systemPrompt": "",
    }
  )
  return config


def _prompt_expert_local_config(payload: dict[str, Any]) -> dict[str, Any]:
  from .local_llm_service import build_local_llm_config

  if not _text(payload.get("modelPath")):
    raise ValueError(
      "Select a local GGUF model in the Local LLM configuration section"
    )
  return build_local_llm_config(payload, require_model_file=True)


class AstralPromptExpert:
  NAME = "Prompt Processor"
  CATEGORY = "Astral/Prompt"
  DESCRIPTION = (
    "Node-local API or local GGUF prompt processor with a collapsible configuration "
    "panel, optional multi-turn history, system prompt and Skill input ports."
  )

  @classmethod
  def INPUT_TYPES(cls):
    return {
      "required": {
        "prompt_text": (
          "STRING",
          {
            "default": "",
            "multiline": True,
            "tooltip": "Message typed in the node chat panel; a linked user_prompt input overrides it.",
          },
        ),
        "chat_history": (
          "STRING",
          {
            "default": EMPTY_EXPERT_HISTORY,
            "multiline": True,
            "tooltip": "Multi-turn history saved by the node panel with the workflow.",
          },
        ),
        "conversations": (
          "STRING",
          {
            "default": EMPTY_EXPERT_CONVERSATIONS,
            "multiline": True,
            "tooltip": "Conversation list saved by the node panel with the workflow.",
          },
        ),
        "mode": (
          ["api", "local"],
          {
            "default": "api",
            "tooltip": "API uses the selected API profile; local uses this node's GGUF configuration.",
          },
        ),
        "multi_turn": (
          "BOOLEAN",
          {
            "default": False,
            "tooltip": "Send the saved conversation history with each request.",
          },
        ),
        "seed": (
          "INT",
          {
            "default": 42,
            "min": 0,
            "max": 0xFFFFFFFFFFFFFFFF,
            "step": 1,
            "control_after_generate": True,
            "tooltip": "Random seed for local mode; llama.cpp receives the low 32 bits.",
          },
        ),
        "api_profiles": (
          "STRING",
          {
            "default": EMPTY_API_PROFILES,
            "multiline": True,
            "tooltip": "Up to 5 API profiles (name, base URL, key, model) saved with this node.",
          },
        ),
        "api_active": (
          "INT",
          {
            "default": 1,
            "min": 1,
            "max": API_PROFILE_LIMIT,
            "step": 1,
            "tooltip": "Which API profile is used in API mode.",
          },
        ),
        "local_model": (
          "STRING",
          {
            "default": "",
            "multiline": False,
            "tooltip": "GGUF file under ComfyUI/models/LLM used in local mode.",
          },
        ),
        "local_vision_model": (
          "STRING",
          {
            "default": "",
            "multiline": False,
            "tooltip": "Optional mmproj file for image inputs in local mode.",
          },
        ),
        "local_n_ctx": (
          "INT",
          {"default": 8192, "min": 512, "max": 131072, "step": 1, "tooltip": "Local context window size. Vision / M-RoPE models cannot shift context; raise it when using images or multi-turn history."},
        ),
        "local_n_batch": (
          "INT",
          {"default": 2048, "min": 32, "max": 65536, "step": 1, "tooltip": "Local prompt batch size."},
        ),
        "local_n_ubatch": (
          "INT",
          {"default": 512, "min": 32, "max": 65536, "step": 1, "tooltip": "Local micro-batch size."},
        ),
        "local_max_tokens": (
          "INT",
          {"default": 1024, "min": 1, "max": 32768, "step": 1, "tooltip": "Maximum reply length for local mode."},
        ),
        "local_max_rounds": (
          "INT",
          {"default": 12, "min": 1, "max": 50, "step": 1, "tooltip": "Local history rounds kept by the model."},
        ),
        "local_temperature": (
          "FLOAT",
          {"default": 0.7, "min": 0.0, "max": 2.0, "step": 0.01, "tooltip": "Sampling temperature for local mode."},
        ),
        "local_top_p": (
          "FLOAT",
          {"default": 0.95, "min": 0.01, "max": 1.0, "step": 0.01, "tooltip": "Local top-p sampling."},
        ),
        "local_top_k": (
          "INT",
          {"default": 40, "min": 1, "max": 200, "step": 1, "tooltip": "Local top-k sampling."},
        ),
        "local_min_p": (
          "FLOAT",
          {"default": 0.05, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "Local min-p sampling."},
        ),
        "local_repeat_penalty": (
          "FLOAT",
          {"default": 1.1, "min": 0.5, "max": 2.0, "step": 0.01, "tooltip": "Local repeat penalty."},
        ),
        "local_frequency_penalty": (
          "FLOAT",
          {"default": 0.0, "min": -2.0, "max": 2.0, "step": 0.01, "tooltip": "Local frequency penalty."},
        ),
        "local_presence_penalty": (
          "FLOAT",
          {"default": 0.0, "min": -2.0, "max": 2.0, "step": 0.01, "tooltip": "Local presence penalty."},
        ),
        "local_gpu_layers": (
          "INT",
          {"default": -1, "min": -1, "max": 1000, "step": 1, "tooltip": "Layers offloaded to the GPU; -1 offloads all."},
        ),
        "local_threads": (
          "INT",
          {"default": 0, "min": 0, "max": 128, "step": 1, "tooltip": "CPU threads; 0 lets llama.cpp decide."},
        ),
        "local_max_image_edge": (
          "INT",
          {"default": 1024, "min": 256, "max": 4096, "step": 1, "tooltip": "Longest edge for images sent to the local model."},
        ),
        "local_image_jpeg_quality": (
          "INT",
          {"default": 90, "min": 40, "max": 100, "step": 1, "tooltip": "JPEG quality for local image attachments."},
        ),
        "local_context_checkpoints": (
          "INT",
          {"default": 0, "min": 0, "max": 64, "step": 1, "tooltip": "llama.cpp context checkpoints."},
        ),
        "local_flash_attention": (
          ["auto", "enabled", "disabled"],
          {"default": "auto", "tooltip": "llama.cpp flash attention mode."},
        ),
        "local_kv_cache_k": (
          ["default", "q8_0"],
          {"default": "default", "tooltip": "K cache type."},
        ),
        "local_kv_cache_v": (
          ["default", "q8_0"],
          {"default": "default", "tooltip": "V cache type."},
        ),
        "local_reasoning_effort": (
          ["xhigh", "medium", "low"],
          {"default": "xhigh", "tooltip": "Reasoning effort for supported models."},
        ),
        "local_enable_thinking": (
          "BOOLEAN",
          {"default": False, "tooltip": "Request thinking output from the local model."},
        ),
        "local_use_mmap": (
          "BOOLEAN",
          {"default": True, "tooltip": "Memory-map the GGUF file."},
        ),
        "clear_vram": (
          "BOOLEAN",
          {"default": False, "tooltip": "Release the local GGUF and clear VRAM after the task."},
        ),
        "api_temperature": (
          "FLOAT",
          {"default": 0.7, "min": 0.0, "max": 2.0, "step": 0.01, "tooltip": "Sampling temperature for API mode."},
        ),
        "api_max_tokens": (
          "INT",
          {"default": 2048, "min": 1, "max": 128000, "step": 1, "tooltip": "Maximum reply length for API mode."},
        ),
        "api_top_p": (
          "FLOAT",
          {"default": 0.95, "min": 0.01, "max": 1.0, "step": 0.01, "tooltip": "API top-p sampling."},
        ),
        "api_frequency_penalty": (
          "FLOAT",
          {"default": 0.0, "min": -2.0, "max": 2.0, "step": 0.01, "tooltip": "API frequency penalty."},
        ),
        "api_presence_penalty": (
          "FLOAT",
          {"default": 0.0, "min": -2.0, "max": 2.0, "step": 0.01, "tooltip": "API presence penalty."},
        ),
        "api_response_format": (
          ["default", "text", "json_object"],
          {"default": "default", "tooltip": "API response format."},
        ),
        "api_reasoning_effort": (
          ["default", "low", "medium", "high"],
          {"default": "default", "tooltip": "API reasoning effort for supported models."},
        ),
        "api_history_rounds": (
          "INT",
          {"default": 12, "min": 1, "max": 50, "step": 1, "tooltip": "History rounds sent in API mode."},
        ),
      },
      "optional": {
        "system_prompt": (
          "STRING",
          {
            "forceInput": True,
            "tooltip": "Linked system prompt prepended to the built-in instructions.",
          },
        ),
        "skill": (
          "QWEN_TE_SKILL",
          {
            "tooltip": "Connect a Skill loader (Prompt Skill Loader or Qwen llama TE); its Skill text is added to the system prompt.",
          },
        ),
        "user_prompt": (
          "STRING",
          {
            "forceInput": True,
            "tooltip": "Linked text overrides the message typed in the chat panel.",
          },
        ),
        "image": ("IMAGE",),
        "image_2": ("IMAGE",),
        "image_3": ("IMAGE",),
        "image_4": ("IMAGE",),
        "image_5": ("IMAGE",),
        "image_6": ("IMAGE",),
        "image_7": ("IMAGE",),
        "image_8": ("IMAGE",),
        "image_9": ("IMAGE",),
        "video": ("VIDEO",),
        "video_2": ("VIDEO",),
        "video_3": ("VIDEO",),
        "audio": ("AUDIO",),
        "audio_2": ("AUDIO",),
        "audio_3": ("AUDIO",),
      },
    }

  RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING")
  RETURN_NAMES = ("prompt", "reply", "chat_history", "report")
  FUNCTION = "run"
  OUTPUT_NODE = True

  def run(
    self,
    prompt_text="",
    chat_history=EMPTY_EXPERT_HISTORY,
    conversations=EMPTY_EXPERT_CONVERSATIONS,
    mode="api",
    multi_turn=False,
    seed=42,
    api_profiles=EMPTY_API_PROFILES,
    api_active=1,
    local_model="",
    local_vision_model="",
    local_n_ctx=8192,
    local_n_batch=2048,
    local_n_ubatch=512,
    local_max_tokens=1024,
    local_max_rounds=12,
    local_temperature=0.7,
    local_top_p=0.95,
    local_top_k=40,
    local_min_p=0.05,
    local_repeat_penalty=1.1,
    local_frequency_penalty=0.0,
    local_presence_penalty=0.0,
    local_gpu_layers=-1,
    local_threads=0,
    local_max_image_edge=1024,
    local_image_jpeg_quality=90,
    local_context_checkpoints=0,
    local_flash_attention="auto",
    local_kv_cache_k="default",
    local_kv_cache_v="default",
    local_reasoning_effort="xhigh",
    local_enable_thinking=False,
    local_use_mmap=True,
    clear_vram=False,
    api_temperature=0.7,
    api_max_tokens=2048,
    api_top_p=0.95,
    api_frequency_penalty=0.0,
    api_presence_penalty=0.0,
    api_response_format="default",
    api_reasoning_effort="default",
    api_history_rounds=12,
    system_prompt=None,
    skill=None,
    user_prompt=None,
    image=None,
    image_2=None,
    image_3=None,
    image_4=None,
    image_5=None,
    image_6=None,
    image_7=None,
    image_8=None,
    image_9=None,
    video=None,
    video_2=None,
    video_3=None,
    audio=None,
    audio_2=None,
    audio_3=None,
  ):
    mode_id = _prompt_processor_mode(mode)
    linked_prompt = _text(user_prompt)
    prompt = linked_prompt or _text(prompt_text)
    system_text = _text(system_prompt)
    skill_text, skill_key = resolve_skill_input(skill)
    multi_turn_on = _prompt_processor_enabled(multi_turn)
    if not skill_text:
      raise ValueError(
        "Connect a Skill loader to the skill input before chatting"
      )
    if not multi_turn_on:
      raise ValueError("Enable multi-turn to use Prompt Processor")

    attachments = build_prompt_processor_attachments(
      image,
      video,
      image_2=image_2,
      image_3=image_3,
      image_4=image_4,
      image_5=image_5,
      image_6=image_6,
      image_7=image_7,
      image_8=image_8,
      image_9=image_9,
      video_2=video_2,
      video_3=video_3,
      audio=audio,
      audio_2=audio_2,
      audio_3=audio_3,
    )
    if not prompt and not attachments:
      raise ValueError("Enter a message before running Prompt Processor")

    prior_skill, prior_messages = _prompt_expert_history(chat_history)
    skill_changed = skill_key != prior_skill
    messages = [] if skill_changed else prior_messages
    history_rounds = (
      int(api_history_rounds)
      if mode_id == "api"
      else int(local_max_rounds)
    )
    request_history = (
      _trim_expert_history(messages, max(1, history_rounds))
      if multi_turn_on
      else None
    )

    api_config = None
    local_config = None
    profile_name = ""
    profile_index = 0
    if mode_id == "api":
      profile, profile_index = _active_api_profile(api_profiles, api_active)
      profile_name = profile["name"]
      api_config = _prompt_expert_api_config(
        profile,
        api_temperature,
        api_max_tokens,
        api_top_p,
        api_frequency_penalty,
        api_presence_penalty,
        int(seed),
        api_response_format,
        api_reasoning_effort,
      )
    else:
      local_config = _prompt_expert_local_config(
        {
          "modelPath": local_model,
          "visionModelPath": local_vision_model,
          "nCtx": local_n_ctx,
          "nBatch": local_n_batch,
          "nUbatch": local_n_ubatch,
          "maxTokens": local_max_tokens,
          "maxRounds": local_max_rounds,
          "temperature": local_temperature,
          "topP": local_top_p,
          "topK": local_top_k,
          "minP": local_min_p,
          "repeatPenalty": local_repeat_penalty,
          "frequencyPenalty": local_frequency_penalty,
          "presencePenalty": local_presence_penalty,
          "gpuLayers": local_gpu_layers,
          "threads": local_threads,
          "maxImageEdge": local_max_image_edge,
          "imageJpegQuality": local_image_jpeg_quality,
          "contextCheckpoints": local_context_checkpoints,
          "flashAttention": local_flash_attention,
          "kvCacheTypeK": local_kv_cache_k,
          "kvCacheTypeV": local_kv_cache_v,
          "reasoningEffort": local_reasoning_effort,
          "enableThinking": bool(local_enable_thinking),
          # Thinking text is never surfaced by this node.
          "preserveThinking": False,
          "useMmap": bool(local_use_mmap),
          "seed": int(seed) & 0xFFFFFFFF,
        }
      )

    from .chat_service import run_prompt_task
    from .prompt_library import default_data_directory

    result = run_prompt_task(
      default_data_directory(),
      prompt,
      task="chat",
      mode=mode_id,
      rule_id="",
      skill_ids=[],
      attachments=attachments,
      clear_vram=bool(mode_id == "local" and _prompt_processor_enabled(clear_vram)),
      seed=int(seed) & 0xFFFFFFFF,
      history=request_history,
      api_config=api_config,
      local_config=local_config,
      system_prompt=system_text,
      skill_context=skill_text,
    )
    reply = _text(result.get("text"))
    if not reply:
      raise ValueError("Prompt Processor returned no result")
    cleaned_prompt = clean_prompt_reply(reply) or reply

    timestamp = int(time.time() * 1000)
    updated_messages = list(messages)
    updated_messages.append(
      {
        "role": "user",
        "content": prompt or "(media attachment)",
        "time": timestamp,
      }
    )
    updated_messages.append(
      {
        "role": "assistant",
        "content": reply,
        "prompt": cleaned_prompt,
        "time": timestamp,
      }
    )
    updated_messages = _trim_expert_history(updated_messages)
    history_json = _serialize_expert_history(skill_key, updated_messages)

    report = {
      "mode": mode_id,
      "apiProfile": profile_index,
      "apiProfileName": profile_name,
      "multiTurn": multi_turn_on,
      "historyIgnored": bool(not multi_turn_on and messages),
      "skill": skill_key,
      "skillChanged": skill_changed,
      "systemPrompt": bool(system_text),
      "linkedPrompt": bool(linked_prompt),
      "attachments": len(attachments),
      "historyMessages": len(request_history or []),
      "rounds": len(updated_messages) // 2,
    }
    report_json = json.dumps(report, ensure_ascii=False, separators=(",", ":"))
    return {
      "ui": {
        "reply": [reply],
        "prompt_text": [cleaned_prompt],
        "chat_history": [history_json],
        "report": [report_json],
      },
      "result": (cleaned_prompt, reply, history_json, report_json),
    }


NODE_CLASS_MAPPINGS = {
  "Prompt Processor": AstralPromptExpert,
}

NODE_DISPLAY_NAME_MAPPINGS = {
  "Prompt Processor": AstralPromptExpert.NAME,
}
