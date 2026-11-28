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


class AstralAssetLoraLoader:
  NAME = "LoRA Stack Loader"
  CATEGORY = "AssetManagement"
  DESCRIPTION = (
    "Loads multiple LoRAs and outputs selected trigger words separated by commas, "
    "with a trailing comma."
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


class AstralStringModeSelector:
  NAME = "String Mode Selector"
  CATEGORY = "Astral/Utilities"
  DESCRIPTION = (
    "Selects one titled prompt mode in the node UI and returns its prompt as "
    "a STRING without exposing an input port."
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
  NAME = "System Prompt"
  CATEGORY = "Astral/Prompt"
  DESCRIPTION = (
    "A saved system prompt placed on the canvas. The title and prompt widgets "
    "are filled by Asset Manager and the prompt is returned as STRING."
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


PROMPT_PROCESSOR_MAX_IMAGES = 9
PROMPT_PROCESSOR_MAX_VIDEOS = 3
PROMPT_PROCESSOR_MAX_AUDIOS = 3
PROMPT_PROCESSOR_VIDEO_FRAMES = 6
PROMPT_PROCESSOR_MAX_AUDIO_BYTES = 40 * 1024 * 1024


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


NODE_CLASS_MAPPINGS = {
  "LoRA Stack Loader": AstralAssetLoraLoader,
  "String Mode Selector": AstralStringModeSelector,
  "System Prompt": AstralPrompt,
}

NODE_DISPLAY_NAME_MAPPINGS = {
  "LoRA Stack Loader": AstralAssetLoraLoader.NAME,
  "String Mode Selector": AstralStringModeSelector.NAME,
  "System Prompt": AstralPrompt.NAME,
}
