import re
import base64
import wave
from io import BytesIO
from typing import Any

from nodes import LoraLoader


class AnyType(str):
  def __ne__(self, _value: object) -> bool:
    return False


class FlexibleOptionalInputType(dict):
  def __init__(self, input_type, data: dict | None = None):
    self.input_type = input_type
    self.data = data or {}
    super().__init__(self.data)

  def __getitem__(self, key):
    return self.data[key] if key in self.data else (self.input_type,)

  def __contains__(self, _key):
    return True


def _iter_loras(inputs: dict[str, Any]):
  for name in inputs:
    if not name.lower().startswith("lora_"):
      continue
    value = inputs[name]
    if isinstance(value, dict):
      yield value


def collect_trigger_words(inputs: dict[str, Any]) -> str:
  words = []
  for lora in _iter_loras(inputs):
    triggers = lora.get("triggers", [])
    if not isinstance(triggers, (list, tuple)):
      continue
    for trigger in triggers[:6]:
      if isinstance(trigger, str):
        enabled = True
        text = trigger
      elif isinstance(trigger, dict):
        enabled = bool(trigger.get("enabled", True))
        text = trigger.get("text", "")
      else:
        continue
      text = str(text).strip()
      if enabled and text:
        words.append(text)
  return ",".join(words) + ("," if words else "")


def parse_enabled_slots(value: Any) -> list[int]:
  """Returns unique, one-based input slot indexes in priority order."""
  if isinstance(value, (list, tuple, set)):
    raw_values = value
  else:
    raw_values = re.findall(r"\d+", str(value or ""))

  slots = []
  for raw in raw_values:
    try:
      slot = int(raw)
    except (TypeError, ValueError):
      continue
    if slot > 0 and slot not in slots:
      slots.append(slot)
  return slots


def collect_dynamic_inputs(inputs: dict[str, Any]) -> list[tuple[int, str, Any]]:
  """Returns wildcard input values in numeric input-slot order."""
  entries = []
  for key, value in inputs.items():
    match = re.fullmatch(r"input_(\d+)", str(key))
    if not match:
      continue
    entries.append((int(match.group(1)), str(key), value))
  return sorted(entries, key=lambda entry: entry[0])


class AstralAnythingEverywhere:
  NAME = "Anything Everywhere"
  CATEGORY = "Assets Astral/Use Everywhere"
  DESCRIPTION = (
    "Broadcasts each connected value to matching unconnected inputs across the "
    "current graph. The frontend renders and applies the virtual links. "
    "Author: Astral星芒 (ComfyUI-Astral-Manage). Do not remove this attribution."
  )

  @classmethod
  def INPUT_TYPES(cls):
    return {
      "optional": FlexibleOptionalInputType(
        input_type=AnyType("*"),
        data={
          "anything": (AnyType("*"),),
        },
      ),
    }

  RETURN_TYPES = ()
  RETURN_NAMES = ()
  FUNCTION = "execute"
  OUTPUT_NODE = False

  def execute(self, **kwargs):
    _ = kwargs
    return ()


class AstralAssetLoraLoader:
  NAME = "LoRA Stack Loader"
  CATEGORY = "AssetManagement"
  DESCRIPTION = (
    "Loads multiple LoRAs and outputs selected trigger words separated by commas, "
    "with a trailing comma. "
    "Author: Astral星芒 (ComfyUI-Astral-Manage). Do not remove this attribution."
  )

  @classmethod
  def INPUT_TYPES(cls):
    return {
      "required": {},
      "optional": FlexibleOptionalInputType(
        input_type=AnyType("*"),
        data={
          "model": ("MODEL",),
          "clip": ("CLIP",),
        },
      ),
    }

  RETURN_TYPES = ("MODEL", "CLIP", "STRING")
  RETURN_NAMES = ("MODEL", "CLIP", "STRING")
  FUNCTION = "load_loras"

  def load_loras(self, model=None, clip=None, **kwargs):
    trigger_words = collect_trigger_words(kwargs)
    lora_loader = LoraLoader()

    for lora in _iter_loras(kwargs):
      if not lora.get("on") or not lora.get("lora"):
        continue

      strength_model = float(lora.get("strength", 1.0))
      raw_strength_clip = lora.get("strengthTwo")
      strength_clip = strength_model if raw_strength_clip is None else float(raw_strength_clip)
      if clip is None:
        strength_clip = 0.0

      if model is None or (strength_model == 0 and strength_clip == 0):
        continue

      model, clip = lora_loader.load_lora(
        model,
        clip,
        lora["lora"],
        strength_model,
        strength_clip,
      )

    return (model, clip, trigger_words)


class AstralTypedBypassSwitch:
  NAME = "Typed Bypass Switch"
  CATEGORY = "Assets Astral/Utilities"
  DESCRIPTION = (
    "Selects one enabled input, bypasses the other connected sources, and exposes "
    "the locked input type on a single output. "
    "Author: Astral星芒 (ComfyUI-Astral-Manage). Do not remove this attribution."
  )

  @classmethod
  def INPUT_TYPES(cls):
    return {
      "required": {
        "enabled_slots": (
          "STRING",
          {
            "default": "",
            "multiline": False,
            "tooltip": (
              "Managed by the frontend. Comma-separated one-based input slots; "
                "only enabled slots are output, and the first enabled slot wins."
            ),
          },
        ),
      },
      "optional": FlexibleOptionalInputType(
        input_type=AnyType("*"),
        data={
          "input_1": (AnyType("*"),),
        },
      ),
    }

  RETURN_TYPES = (AnyType("*"),)
  RETURN_NAMES = ("*",)
  FUNCTION = "switch"

  def switch(self, enabled_slots="", **kwargs):
    entries = collect_dynamic_inputs(kwargs)
    values_by_slot = {slot: value for slot, _key, value in entries}

    for slot in parse_enabled_slots(enabled_slots):
      if slot in values_by_slot:
        return (values_by_slot[slot],)

    return (None,)


class AstralStringModeSelector:
  NAME = "String Mode Selector"
  CATEGORY = "Assets Astral/Utilities"
  DESCRIPTION = (
    "Selects one titled prompt mode in the node UI and returns its prompt as "
    "a STRING without exposing an input port. "
    "Author: Astral星芒 (ComfyUI-Astral-Manage). Do not remove this attribution."
  )

  @classmethod
  def INPUT_TYPES(cls):
    return {
      "required": {
        "selected_string": (
          "STRING",
          {
            "default": "",
            "multiline": False,
            "tooltip": (
              "Managed by the frontend from the active mode's prompt. "
              "The editor widget is hidden because this node has no input ports."
            ),
          },
        ),
      },
    }

  RETURN_TYPES = ("STRING",)
  RETURN_NAMES = ("STRING",)
  FUNCTION = "select_string"

  def select_string(self, selected_string=""):
    return ("" if selected_string is None else str(selected_string),)


class AstralPrompt:
  NAME = "Assets Prompt"
  CATEGORY = "Assets Astral/Prompt"
  DESCRIPTION = (
    "A saved prompt template placed on the canvas. The title and prompt widgets "
    "are filled by Asset Manager and the prompt is returned as STRING. "
    "Author: Astral星芒 (ComfyUI-Astral-Manage). Do not remove this attribution."
  )

  @classmethod
  def INPUT_TYPES(cls):
    return {
      "required": {
        "title": (
          "STRING",
          {
            "default": "Prompt",
            "multiline": False,
          },
        ),
        "prompt": (
          "STRING",
          {
            "default": "",
            "multiline": True,
          },
        ),
      },
    }

  RETURN_TYPES = ("STRING",)
  RETURN_NAMES = ("STRING",)
  FUNCTION = "get_prompt"

  def get_prompt(self, title="", prompt=""):
    _ = title
    return ("" if prompt is None else str(prompt),)


PROMPT_PROCESSOR_OPERATIONS = (
  "auto",
  "expand",
  "invert",
)
PROMPT_PROCESSOR_MODES = ("api", "local")
PROMPT_PROCESSOR_MAX_IMAGES = 9
PROMPT_PROCESSOR_MAX_VIDEOS = 3
PROMPT_PROCESSOR_MAX_AUDIOS = 3
PROMPT_PROCESSOR_VIDEO_FRAMES = 6
PROMPT_PROCESSOR_MAX_AUDIO_BYTES = 40 * 1024 * 1024


def _prompt_processor_operation(value: Any) -> str:
  normalized = str(value or "auto").strip().casefold()
  aliases = {
    "自动": "auto",
    "自动判断": "auto",
    "扩写": "expand",
    "提示词扩写": "expand",
    "反推": "invert",
    "图像反推": "invert",
    "automatic": "auto",
    "expansion": "expand",
    "inversion": "invert",
  }
  normalized = aliases.get(normalized, normalized)
  if normalized not in PROMPT_PROCESSOR_OPERATIONS:
    raise ValueError("Prompt processor operation must be auto, expand, or invert")
  return normalized


def _prompt_processor_mode(value: Any) -> str:
  normalized = str(value or "api").strip().casefold()
  if normalized in {
    "api",
    "api纯文本模式",
    "api图片模式",
    "api模式",
    "api text mode",
    "api text-only mode",
    "api image mode",
  }:
    return "api"
  if normalized in {"local", "本地", "本地模式", "local mode"}:
    return "local"
  raise ValueError(
    "Prompt processor service must be either API text-only mode or local mode"
  )


def _prompt_processor_enabled(value: Any) -> bool:
  if isinstance(value, bool):
    return value
  if isinstance(value, (int, float)) and value in {0, 1}:
    return bool(value)
  return str(value or "").strip().casefold() in {
    "1",
    "true",
    "yes",
    "on",
  }


def _media_array(value: Any) -> Any:
  if value is None:
    return None
  detach = getattr(value, "detach", None)
  if callable(detach):
    value = detach()
  cpu = getattr(value, "cpu", None)
  if callable(cpu):
    value = cpu()
  numpy = getattr(value, "numpy", None)
  if callable(numpy):
    value = numpy()
  try:
    import numpy as np

    return np.asarray(value)
  except Exception:
    return value


def _video_frame_array(value: Any) -> Any:
  """Extract the image batch from the current VIDEO object variants."""
  if value is None:
    return None

  components_getter = getattr(value, "get_components", None)
  if callable(components_getter):
    try:
      components = components_getter()
      for attribute in ("images", "frames"):
        frames = getattr(components, attribute, None)
        if frames is not None:
          return _media_array(frames)
      if isinstance(components, dict):
        for key in ("images", "frames"):
          if components.get(key) is not None:
            return _media_array(components[key])
    except Exception:
      pass

  if isinstance(value, dict):
    for key in ("images", "frames", "video", "frames_batch"):
      if value.get(key) is not None:
        frames = _video_frame_array(value[key])
        if frames is not None:
          return frames
  else:
    for attribute in ("images", "frames"):
      frames = getattr(value, attribute, None)
      if frames is not None and frames is not value:
        converted = _video_frame_array(frames)
        if converted is not None:
          return converted

  if isinstance(value, (list, tuple)):
    if not value:
      return None
    arrays = [_media_array(item) for item in value]
    try:
      import numpy as np

      normalized = [
        np.asarray(item)[None, ...] if np.asarray(item).ndim == 3 else np.asarray(item)
        for item in arrays
      ]
      if normalized and all(item.ndim == 4 for item in normalized):
        return np.concatenate(normalized, axis=0)
    except Exception:
      pass
    return None

  return _media_array(value)


def _sampled_indexes(total: int, limit: int) -> list[int]:
  if total <= 0 or limit <= 0:
    return []
  if total <= limit:
    return list(range(total))
  if limit == 1:
    return [total // 2]
  return sorted(
    {
      round(index * (total - 1) / (limit - 1))
      for index in range(limit)
    }
  )


def _image_frame_attachment(frame: Any, name: str) -> dict[str, Any]:
  import numpy as np
  from PIL import Image

  array = np.asarray(frame)
  if array.ndim == 3 and array.shape[-1] not in {1, 3, 4}:
    if array.shape[0] in {1, 3, 4}:
      array = np.moveaxis(array, 0, -1)
  if array.ndim == 2:
    array = array[..., None]
  if array.ndim != 3 or array.shape[-1] not in {1, 3, 4}:
    raise ValueError("Image must be in [H,W,C] or [B,H,W,C] format")

  if array.dtype != np.uint8:
    array = np.nan_to_num(array.astype(np.float32, copy=False))
    if array.size and float(array.max()) <= 1.0:
      array = array * 255.0
    array = np.clip(array, 0.0, 255.0).astype(np.uint8)

  if array.shape[-1] == 1:
    array = np.repeat(array, 3, axis=-1)
  elif array.shape[-1] == 4:
    array = array[..., :3]

  image = Image.fromarray(array)
  output = BytesIO()
  image.save(output, format="JPEG", quality=92, optimize=True)
  encoded = base64.b64encode(output.getvalue()).decode("ascii")
  return {
    "kind": "image",
    "mimeType": "image/jpeg",
    "data": f"data:image/jpeg;base64,{encoded}",
    "name": name,
  }


def _image_batch_attachments(
  value: Any,
  *,
  prefix: str = "image",
  limit: int = PROMPT_PROCESSOR_MAX_IMAGES,
  start_index: int = 0,
) -> list[dict[str, Any]]:
  if value is None or limit <= 0:
    return []
  import numpy as np

  array = _media_array(value)
  array = np.asarray(array)
  if array.ndim == 2:
    array = array[None, ..., None]
  elif array.ndim == 3:
    if array.shape[-1] in {1, 3, 4}:
      array = array[None, ...]
    elif array.shape[0] in {1, 3, 4}:
      array = np.moveaxis(array, 0, -1)[None, ...]
  if array.ndim != 4:
    raise ValueError("Image must be in [B,H,W,C] format")
  if array.shape[-1] not in {1, 3, 4}:
    raise ValueError("Image must have 1, 3, or 4 channels")

  return [
    _image_frame_attachment(
      array[index],
      f"{prefix}-{start_index + position + 1}.jpg",
    )
    for position, index in enumerate(
      _sampled_indexes(int(array.shape[0]), limit)
    )
  ]


def _audio_waveform(value: Any) -> Any:
  if isinstance(value, dict):
    return value.get("waveform", value.get("audio"))
  return getattr(value, "waveform", value)


def _audio_sample_rate(value: Any) -> int:
  if isinstance(value, dict):
    sample_rate = value.get("sample_rate", value.get("sampleRate"))
  else:
    sample_rate = getattr(value, "sample_rate", None)
  try:
    normalized = int(sample_rate)
  except (TypeError, ValueError):
    normalized = 0
  if normalized <= 0:
    raise ValueError("Audio is missing a valid sample_rate")
  return normalized


def _audio_batch_attachments(
  value: Any,
  *,
  limit: int = PROMPT_PROCESSOR_MAX_AUDIOS,
  start_index: int = 0,
) -> list[dict[str, Any]]:
  if value is None or limit <= 0:
    return []
  import numpy as np

  sample_rate = _audio_sample_rate(value)
  array = np.asarray(_media_array(_audio_waveform(value)))
  if array.ndim == 1:
    array = array[None, None, ...]
  elif array.ndim == 2:
    array = array[None, ...]
  if array.ndim != 3:
    raise ValueError("Audio must be in [B,C,T] format")
  if array.shape[0] <= 0 or array.shape[1] <= 0 or array.shape[2] <= 0:
    raise ValueError("Audio waveform must not be empty")

  attachments: list[dict[str, Any]] = []
  for position, index in enumerate(
    _sampled_indexes(int(array.shape[0]), limit)
  ):
    waveform = np.asarray(array[index])
    if np.issubdtype(waveform.dtype, np.integer):
      pcm = np.clip(waveform, -32768, 32767).astype("<i2")
    else:
      waveform = np.nan_to_num(waveform.astype(np.float32, copy=False))
      pcm = np.rint(
        np.clip(waveform, -1.0, 1.0) * 32767.0
      ).astype("<i2")

    output = BytesIO()
    with wave.open(output, "wb") as wav:
      wav.setnchannels(int(pcm.shape[0]))
      wav.setsampwidth(2)
      wav.setframerate(sample_rate)
      wav.writeframes(pcm.tobytes(order="C"))
    payload = output.getvalue()
    if len(payload) > PROMPT_PROCESSOR_MAX_AUDIO_BYTES:
      raise ValueError(
        "Audio is too long; a single WAV attachment must not exceed "
        f"{PROMPT_PROCESSOR_MAX_AUDIO_BYTES // 1024 // 1024} MB"
      )
    audio_number = start_index + position + 1
    encoded = base64.b64encode(payload).decode("ascii")
    attachments.append(
      {
        "kind": "audio",
        "mimeType": "audio/wav",
        "format": "wav",
        "data": f"data:audio/wav;base64,{encoded}",
        "name": f"audio-{audio_number}.wav",
        "mention": f"audio{audio_number}",
      }
    )
  return attachments


def build_prompt_processor_attachments(
  image: Any = None,
  video: Any = None,
  *,
  image_2: Any = None,
  image_3: Any = None,
  image_4: Any = None,
  image_5: Any = None,
  image_6: Any = None,
  image_7: Any = None,
  image_8: Any = None,
  image_9: Any = None,
  video_2: Any = None,
  video_3: Any = None,
  audio: Any = None,
  audio_2: Any = None,
  audio_3: Any = None,
) -> list[dict[str, Any]]:
  image_attachments: list[dict[str, Any]] = []
  for value in (
    image,
    image_2,
    image_3,
    image_4,
    image_5,
    image_6,
    image_7,
    image_8,
    image_9,
  ):
    remaining = PROMPT_PROCESSOR_MAX_IMAGES - len(image_attachments)
    if value is None or remaining <= 0:
      continue
    image_attachments.extend(
      _image_batch_attachments(
        value,
        prefix="image",
        limit=remaining,
        start_index=len(image_attachments),
      )
    )

  for video_number, value in enumerate(
    (video, video_2, video_3),
    start=1,
  ):
    frames = _video_frame_array(value) if value is not None else None
    if frames is None:
      continue
    image_attachments.extend(
      _image_batch_attachments(
        frames,
        prefix=f"video-{video_number}-frame",
        limit=PROMPT_PROCESSOR_VIDEO_FRAMES,
      )
    )

  audio_attachments: list[dict[str, Any]] = []
  for value in (audio, audio_2, audio_3):
    remaining = PROMPT_PROCESSOR_MAX_AUDIOS - len(audio_attachments)
    if value is None or remaining <= 0:
      continue
    audio_attachments.extend(
      _audio_batch_attachments(
        value,
        limit=remaining,
        start_index=len(audio_attachments),
      )
    )
  return image_attachments + audio_attachments


def _run_prompt_processor_task(*args: Any, **kwargs: Any) -> dict[str, Any]:
  from .chat_service import run_prompt_task

  return run_prompt_task(*args, **kwargs)


def _prompt_processor_data_directory() -> str:
  from .prompt_library import default_data_directory

  return default_data_directory()


def _clear_prompt_processor_vram() -> str:
  from .chat_service import _clear_local_model_memory

  return _clear_local_model_memory()


class AstralPromptProcessor:
  NAME = "Prompt Processor"
  CATEGORY = "Assets Astral/Prompt"
  DESCRIPTION = (
    "Runs one stateless prompt expansion or media inversion task. "
    "Supports up to 9 images, 3 videos, and 3 audio inputs. "
    "The operation can be selected explicitly or inferred from the media inputs. "
    "Author: Astral星芒 (ComfyUI-Astral-Manage). Do not remove this attribution."
  )

  @classmethod
  def INPUT_TYPES(cls):
    return {
      "required": {
        "user_prompt": (
          "STRING",
          {
            "default": "",
            "multiline": True,
            "tooltip": "The prompt to expand; an optional hint when inverting.",
          },
        ),
        "operation": (
          list(PROMPT_PROCESSOR_OPERATIONS),
          {
            "default": "auto",
            "tooltip": "auto expands when no media is connected and inverts when media is connected.",
          },
        ),
        "mode": (
          list(PROMPT_PROCESSOR_MODES),
          {
            "default": "api",
            "tooltip": "API uses text-only or image mode; local mode uses a GGUF model.",
          },
        ),
        "expand_rule": (
          "STRING",
          {
            "default": "",
            "multiline": False,
            "tooltip": "System prompt ID from the \"Expand Prompt\" category.",
          },
        ),
        "invert_rule": (
          "STRING",
          {
            "default": "",
            "multiline": False,
            "tooltip": "System prompt ID from the \"Image Inversion\" category.",
          },
        ),
        "skill": (
          "STRING",
          {
            "default": "",
            "multiline": False,
            "tooltip": "Skill ID, exclusive with system prompt rules.",
          },
        ),
        "clear_vram": (
          "BOOLEAN",
          {
            "default": False,
            "tooltip": "Release the local GGUF and clear VRAM after all tasks finish in local mode.",
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
            "tooltip": "Random seed for local mode; supports ComfyUI 64-bit values. llama.cpp receives the low 32 bits; API mode does not use it.",
          },
        ),
      },
      "optional": {
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

  RETURN_TYPES = ("STRING",)
  RETURN_NAMES = ("prompt",)
  FUNCTION = "process"
  OUTPUT_NODE = False

  def process(
    self,
    user_prompt="",
    operation="auto",
    mode="api",
    expand_rule="",
    invert_rule="",
    skill="",
    clear_vram=False,
    seed=42,
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
    operation_id = _prompt_processor_operation(operation)
    mode_id = _prompt_processor_mode(mode)
    prompt = str(user_prompt or "").strip()
    skill_id = str(skill or "").strip()
    rules = {
      "expand": str(expand_rule or "").strip(),
      "invert": str(invert_rule or "").strip(),
    }
    if skill_id and any(rules.values()):
      raise ValueError("Choose either a system prompt or a Skill, not both")

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
    if operation_id == "auto":
      operation_id = "invert" if attachments else "expand"
    if operation_id == "invert" and not attachments:
      raise ValueError("Image inversion requires a connected image, video, or audio input")

    sampling_seed = int(seed) & 0xFFFFFFFF
    data_directory = _prompt_processor_data_directory()
    skill_ids = [skill_id] if skill_id else []
    output_prompt = ""
    try:
      if operation_id == "invert":
        result = _run_prompt_processor_task(
          data_directory,
          prompt,
          task="invert",
          mode=mode_id,
          rule_id="" if skill_id else rules["invert"],
          skill_ids=skill_ids,
          attachments=attachments,
          clear_vram=False,
          seed=sampling_seed,
        )
        output_prompt = str(result.get("text") or "").strip()
        if not output_prompt:
          raise ValueError("Image inversion returned no result")
      else:
        result = _run_prompt_processor_task(
          data_directory,
          prompt,
          task="expand",
          mode=mode_id,
          rule_id="" if skill_id else rules["expand"],
          skill_ids=skill_ids,
          clear_vram=False,
          seed=sampling_seed,
        )
        output_prompt = str(result.get("text") or "").strip()
        if not output_prompt:
          raise ValueError("Prompt expansion returned no result")
    finally:
      if mode_id == "local" and _prompt_processor_enabled(clear_vram):
        error = _clear_prompt_processor_vram()
        if error:
          print(
            "[ComfyUI-Astral-Manage] Unable to clear local prompt "
            f"processor VRAM: {error}"
          )

    return (output_prompt,)


NODE_CLASS_MAPPINGS = {
  "Anything Everywhere": AstralAnythingEverywhere,
  "LoRA Stack Loader": AstralAssetLoraLoader,
  "Typed Bypass Switch": AstralTypedBypassSwitch,
  "String Mode Selector": AstralStringModeSelector,
  "Assets Prompt": AstralPrompt,
  # Keep the old API id loadable while frontend workflows migrate to the new id.
  "Assets Astral Prompt": AstralPrompt,
  "Assets Astral Prompt Processor": AstralPromptProcessor,
}

NODE_DISPLAY_NAME_MAPPINGS = {
  "Anything Everywhere": "Anything Everywhere (Astral)",
  "LoRA Stack Loader": AstralAssetLoraLoader.NAME,
  "Typed Bypass Switch": AstralTypedBypassSwitch.NAME,
  "String Mode Selector": AstralStringModeSelector.NAME,
  "Assets Prompt": AstralPrompt.NAME,
  "Assets Astral Prompt": AstralPrompt.NAME,
  "Assets Astral Prompt Processor": AstralPromptProcessor.NAME,
}
