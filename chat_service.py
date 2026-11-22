from __future__ import annotations

import asyncio
import base64
import binascii
import copy
import hashlib
import io
import json
import os
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any, Callable

from PIL import Image, ImageOps

from .asset_library import (
  AssetPathError,
  media_kind,
  resolve_asset_path,
)
from .local_llm_service import (
  LOCAL_LLM_MANAGER,
  generate_local_chat,
  load_local_llm_config,
  local_model_family,
  release_local_llm_memory,
)
from .prompt_library import (
  PromptDataError,
  append_conversation_messages,
  get_or_create_conversation,
  get_template,
  normalize_conversation_skill_ids,
  resolve_api_config,
  update_conversation,
)
from .skill_library import SkillLibraryError, build_skill_context


MAX_IMAGE_BYTES = 40 * 1024 * 1024
MAX_AUDIO_BYTES = 40 * 1024 * 1024
MAX_AUDIO_SOURCE_BYTES = 500 * 1024 * 1024
AUDIO_COMPRESSION_THRESHOLD_BYTES = 1 * 1024 * 1024
AUDIO_MP3_BITRATE = "96k"
AUDIO_SAMPLE_RATE = 44_100
MAX_VIDEO_FRAMES = 6
MAX_IMAGE_EDGE = 1280
IMAGE_JPEG_QUALITY = 85
MAX_RESPONSE_CHARS = 2_000_000
MAX_GENERATED_IMAGES = 8
MAX_GENERATED_IMAGE_BYTES = 40 * 1024 * 1024
CHAT_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
CHAT_PRE_CANCEL_TTL_SECONDS = 60
CHAT_IMAGE_DIRECTORY = "assets-astral-chat"
WINDOWS_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
GENERATED_IMAGE_EXTENSIONS = {
  "PNG": ".png",
  "JPEG": ".jpg",
  "WEBP": ".webp",
  "GIF": ".gif",
  "BMP": ".bmp",
  "TIFF": ".tiff",
  "AVIF": ".avif",
}

_CHAT_REQUESTS_LOCK = threading.Lock()
_CHAT_REQUESTS: dict[str, dict[str, Any]] = {}
_CHAT_PRE_CANCELLED: dict[str, float] = {}


class ChatServiceError(RuntimeError):
  pass


class ChatCancelled(ChatServiceError):
  pass


class ChatAPIError(ChatServiceError):
  def __init__(self, message: str, status: int | None = None):
    super().__init__(message)
    self.status = status


@dataclass(frozen=True)
class ResponseImage:
  url: str = ""
  data: bytes = b""
  mime_type: str = ""


class ChatCompletionText(str):
  def __new__(
    cls,
    value: str,
    images: tuple[ResponseImage, ...] = (),
  ) -> "ChatCompletionText":
    instance = super().__new__(cls, value)
    instance.images = images
    return instance


def normalize_chat_request_id(value: Any) -> str:
  request_id = str(value or "").strip()
  if not request_id:
    return uuid.uuid4().hex
  if not CHAT_REQUEST_ID_RE.fullmatch(request_id):
    raise ChatServiceError("请求 ID 格式无效")
  return request_id


def register_chat_request(value: Any) -> str:
  request_id = normalize_chat_request_id(value)
  with _CHAT_REQUESTS_LOCK:
    if request_id in _CHAT_REQUESTS:
      raise ChatServiceError("该请求 ID 正在处理中")
    cancelled_at = _CHAT_PRE_CANCELLED.pop(request_id, None)
    event = threading.Event()
    if cancelled_at is not None:
      event.set()
    _CHAT_REQUESTS[request_id] = {
      "event": event,
      "closers": [],
    }
  return request_id


def finish_chat_request(request_id: str) -> None:
  with _CHAT_REQUESTS_LOCK:
    normalized = str(request_id or "")
    _CHAT_REQUESTS.pop(normalized, None)
    _CHAT_PRE_CANCELLED.pop(normalized, None)


def cancel_chat_request(request_id: str) -> bool:
  normalized = str(request_id or "").strip()
  with _CHAT_REQUESTS_LOCK:
    state = _CHAT_REQUESTS.get(normalized)
    if state is None:
      if not CHAT_REQUEST_ID_RE.fullmatch(normalized):
        return False
      now = time.monotonic()
      cutoff = now - CHAT_PRE_CANCEL_TTL_SECONDS
      for key, timestamp in list(_CHAT_PRE_CANCELLED.items()):
        if timestamp < cutoff:
          _CHAT_PRE_CANCELLED.pop(key, None)
      _CHAT_PRE_CANCELLED[normalized] = now
      return True
    state["event"].set()
    closers = list(state.get("closers") or [])
  for close in closers:
    try:
      close()
    except Exception:
      pass
  return True


def _raise_if_cancelled(request_id: str | None) -> None:
  if not request_id:
    return
  with _CHAT_REQUESTS_LOCK:
    state = _CHAT_REQUESTS.get(request_id)
    cancelled = bool(state and state["event"].is_set())
  if cancelled:
    raise ChatCancelled("操作已停止")


def _register_request_closer(
  request_id: str | None,
  closer: Callable[[], Any],
) -> bool:
  if not request_id:
    return False
  with _CHAT_REQUESTS_LOCK:
    state = _CHAT_REQUESTS.get(request_id)
    if state is None:
      return False
    state["closers"].append(closer)
  return True


def _unregister_request_closer(
  request_id: str | None,
  closer: Callable[[], Any],
) -> None:
  if not request_id:
    return
  with _CHAT_REQUESTS_LOCK:
    state = _CHAT_REQUESTS.get(request_id)
    if state is None:
      return
    closers = state.get("closers") or []
    state["closers"] = [item for item in closers if item is not closer]


def normalize_chat_url(base_url: str) -> str:
  url = str(base_url or "").strip()
  if not url:
    raise ChatServiceError("请先填写 API 地址")
  if not re.match(r"^https?://", url, re.IGNORECASE):
    raise ChatServiceError("API 地址必须使用 http:// 或 https://")
  if url.endswith("#"):
    return url[:-1].rstrip("/")
  parsed = urllib.parse.urlsplit(url)
  path = parsed.path.rstrip("/")
  if path.endswith("/chat/completions"):
    return urllib.parse.urlunsplit(
      (parsed.scheme, parsed.netloc, path, parsed.query, parsed.fragment)
    )
  if (
    parsed.hostname
    and parsed.hostname.casefold() == "api.openai.com"
    and not path.startswith("/v1")
  ):
    path = f"/v1{path}"
  path = f"{path}/chat/completions".replace("//", "/")
  return urllib.parse.urlunsplit(
    (parsed.scheme, parsed.netloc, path, parsed.query, parsed.fragment)
  )


def normalize_models_url(base_url: str) -> str:
  url = str(base_url or "").strip()
  if not url:
    raise ChatServiceError("请先填写 API 地址")
  if not re.match(r"^https?://", url, re.IGNORECASE):
    raise ChatServiceError("API 地址必须使用 http:// 或 https://")
  if url.endswith("#"):
    url = url[:-1].rstrip("/")
  parsed = urllib.parse.urlsplit(url)
  path = parsed.path.rstrip("/")
  for suffix in ("/chat/completions", "/models"):
    if path.endswith(suffix):
      path = path[: -len(suffix)]
      break
  if (
    parsed.hostname
    and parsed.hostname.casefold() == "api.openai.com"
    and not path.startswith("/v1")
  ):
    path = f"/v1{path}"
  path = f"{path}/models".replace("//", "/")
  return urllib.parse.urlunsplit(
    (parsed.scheme, parsed.netloc, path, parsed.query, parsed.fragment)
  )


def merge_system_messages(
  messages: list[dict[str, Any]],
) -> list[dict[str, Any]]:
  system_contents: list[str] = []
  other_messages: list[dict[str, Any]] = []
  for raw_message in messages:
    if not isinstance(raw_message, dict):
      continue
    message = copy.deepcopy(raw_message)
    if message.get("role") == "system":
      content = message.get("content")
      if isinstance(content, str) and content.strip():
        system_contents.append(content.strip())
      elif isinstance(content, list):
        text = "\n".join(
          str(part.get("text", ""))
          for part in content
          if isinstance(part, dict) and part.get("type") == "text"
        ).strip()
        if text:
          system_contents.append(text)
    else:
      other_messages.append(message)
  if not system_contents:
    return other_messages
  return [
    {"role": "system", "content": "\n\n".join(system_contents)},
    *other_messages,
  ]


def trim_conversation_history(
  messages: list[dict[str, Any]],
  max_rounds: int,
) -> list[dict[str, Any]]:
  rounds = max(1, int(max_rounds))
  accepted = [
    copy.deepcopy(message)
    for message in messages
    if isinstance(message, dict)
    and message.get("role") in {"user", "assistant"}
    and (
      str(message.get("content") or "").strip()
      or (
        isinstance(message.get("attachments"), list)
        and message.get("attachments")
      )
    )
  ]
  user_indexes = [
    index for index, message in enumerate(accepted) if message.get("role") == "user"
  ]
  if len(user_indexes) <= rounds:
    return accepted
  return accepted[user_indexes[-rounds] :]


def strip_think_blocks(value: str) -> str:
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
  return (
    text.replace("<think>", "")
    .replace("</think>", "")
    .strip()
  )


def _asset_roots() -> tuple[str, str]:
  import folder_paths

  return (
    folder_paths.get_input_directory(),
    folder_paths.get_output_directory(),
  )


def _attachment_path(attachment: dict[str, Any]) -> str:
  input_root, output_root = _asset_roots()
  return resolve_asset_path(
    str(attachment.get("root", "")),
    str(attachment.get("path", "")),
    input_root,
    output_root,
  )


def _read_limited(path: str, maximum: int, label: str) -> bytes:
  size = os.path.getsize(path)
  if size > maximum:
    raise ChatServiceError(
      f"{label}文件过大（{size / 1024 / 1024:.1f} MB），上限为 "
      f"{maximum / 1024 / 1024:.0f} MB"
    )
  with open(path, "rb") as source:
    return source.read()


def _compress_image_payload(
  payload: bytes,
  label: str,
  *,
  max_edge: int = MAX_IMAGE_EDGE,
  jpeg_quality: int = IMAGE_JPEG_QUALITY,
  progressive: bool = False,
) -> bytes:
  try:
    with Image.open(io.BytesIO(payload)) as source:
      image = ImageOps.exif_transpose(source)
      image.thumbnail(
        (max_edge, max_edge),
        Image.Resampling.LANCZOS,
      )
      if image.mode in {"RGBA", "LA"} or "transparency" in image.info:
        rgba = image.convert("RGBA")
        background = Image.new("RGB", rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.getchannel("A"))
        image = background
      else:
        image = image.convert("RGB")
      output = io.BytesIO()
      image.save(
        output,
        format="JPEG",
        quality=jpeg_quality,
        optimize=True,
        progressive=bool(progressive),
      )
  except (Image.DecompressionBombError, Image.UnidentifiedImageError, OSError) as error:
    raise ChatServiceError(
      f"无法压缩{label}，请检查图片是否损坏"
    ) from error
  return output.getvalue()


def _compressed_image_data_url(
  path: str,
  *,
  max_edge: int = MAX_IMAGE_EDGE,
  jpeg_quality: int = IMAGE_JPEG_QUALITY,
  progressive: bool = False,
) -> str:
  payload = _read_limited(path, MAX_IMAGE_BYTES, "图片")
  compressed = _compress_image_payload(
    payload,
    f"图片 {os.path.basename(path)}",
    max_edge=max_edge,
    jpeg_quality=jpeg_quality,
    progressive=progressive,
  )
  encoded = base64.b64encode(compressed).decode("ascii")
  return f"data:image/jpeg;base64,{encoded}"


def _inline_image_payload(
  value: Any,
  *,
  label: str,
) -> bytes:
  if isinstance(value, bytes):
    raw = value
  else:
    text = str(value or "").strip()
    if not text:
      raise ChatServiceError(f"{label}没有可读取的图片数据")
    if text.startswith("data:"):
      header, separator, encoded = text.partition(",")
      if not separator or ";base64" not in header.casefold():
        raise ChatServiceError(f"{label}不是有效的 base64 图片")
      mime_type = header[5:].split(";", 1)[0].strip().casefold()
      if not mime_type.startswith("image/"):
        raise ChatServiceError(f"{label}的数据类型不是图片")
      text = encoded
    try:
      raw = base64.b64decode(
        re.sub(r"\s+", "", text),
        validate=True,
      )
    except (ValueError, binascii.Error) as error:
      raise ChatServiceError(f"{label}不是有效的 base64 图片") from error
  if not raw:
    raise ChatServiceError(f"{label}没有可读取的图片数据")
  if len(raw) > MAX_IMAGE_BYTES:
    raise ChatServiceError(
      f"{label}过大（{len(raw) / 1024 / 1024:.1f} MB），"
      f"上限为 {MAX_IMAGE_BYTES / 1024 / 1024:.0f} MB"
    )
  return raw


def _inline_audio_payload(
  value: Any,
  *,
  label: str,
) -> bytes:
  if isinstance(value, bytes):
    raw = value
  else:
    text = str(value or "").strip()
    if not text:
      raise ChatServiceError(f"{label}没有可读取的音频数据")
    if text.startswith("data:"):
      header, separator, encoded = text.partition(",")
      if not separator or ";base64" not in header.casefold():
        raise ChatServiceError(f"{label}不是有效的 base64 音频")
      mime_type = header[5:].split(";", 1)[0].strip().casefold()
      if not mime_type.startswith("audio/"):
        raise ChatServiceError(f"{label}的数据类型不是音频")
      text = encoded
    try:
      raw = base64.b64decode(
        re.sub(r"\s+", "", text),
        validate=True,
      )
    except (ValueError, binascii.Error) as error:
      raise ChatServiceError(f"{label}不是有效的 base64 音频") from error
  if not raw:
    raise ChatServiceError(f"{label}没有可读取的音频数据")
  if len(raw) > MAX_AUDIO_BYTES:
    raise ChatServiceError(
      f"{label}过大（{len(raw) / 1024 / 1024:.1f} MB），"
      f"上限为 {MAX_AUDIO_BYTES / 1024 / 1024:.0f} MB"
    )
  return raw


def _find_media_tool(name: str) -> str:
  candidates = [
    shutil.which(name),
    os.path.expandvars(rf"%LOCALAPPDATA%\Microsoft\WinGet\Links\{name}.exe"),
  ]
  path = next((item for item in candidates if item and os.path.isfile(item)), None)
  if not path:
    raise ChatServiceError(
      f"未找到 {name}，无法从视频中抽取画面。请安装 ffmpeg 后重试。"
    )
  return path


def _video_duration(path: str, ffprobe: str) -> float | None:
  try:
    process = subprocess.run(
      [
        ffprobe,
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        path,
      ],
      capture_output=True,
      text=True,
      encoding="utf-8",
      errors="replace",
      timeout=20,
      creationflags=WINDOWS_NO_WINDOW,
    )
  except (OSError, subprocess.SubprocessError):
    return None
  if process.returncode != 0:
    return None
  try:
    duration = float(process.stdout.strip())
  except ValueError:
    return None
  return duration if duration > 0 else None


def _sample_video_frames(
  path: str,
  maximum: int = MAX_VIDEO_FRAMES,
  *,
  max_edge: int = MAX_IMAGE_EDGE,
) -> list[bytes]:
  ffmpeg = _find_media_tool("ffmpeg")
  ffprobe = _find_media_tool("ffprobe")
  duration = _video_duration(path, ffprobe)
  try:
    import folder_paths

    cache_root = os.path.join(
      folder_paths.get_temp_directory(),
      "assets_astral_chat_frames",
    )
  except Exception:
    cache_root = os.path.join(os.path.dirname(__file__), ".chat-frame-cache")
  os.makedirs(cache_root, exist_ok=True)

  frames: list[bytes] = []
  with tempfile.TemporaryDirectory(
    prefix="assets-astral-",
    dir=cache_root,
  ) as temporary_directory:
    if duration:
      sample_count = min(maximum, 6)
      if sample_count == 1:
        timestamps = [duration / 2]
      else:
        timestamps = [
          duration * (index + 1) / (sample_count + 1)
          for index in range(sample_count)
        ]
      for index, timestamp in enumerate(timestamps):
        frame_path = os.path.join(temporary_directory, f"frame-{index}.jpg")
        command = [
          ffmpeg,
          "-hide_banner",
          "-loglevel",
          "error",
          "-ss",
          f"{timestamp:.3f}",
          "-i",
          path,
          "-frames:v",
          "1",
          "-vf",
          f"scale='min({int(max_edge)},iw)':-2",
          "-q:v",
          "3",
          "-y",
          frame_path,
        ]
        try:
          process = subprocess.run(
            command,
            capture_output=True,
            timeout=30,
            creationflags=WINDOWS_NO_WINDOW,
          )
        except (OSError, subprocess.SubprocessError):
          continue
        if process.returncode == 0 and os.path.isfile(frame_path):
          frames.append(_read_limited(frame_path, 8 * 1024 * 1024, "视频帧"))
    else:
      output_pattern = os.path.join(temporary_directory, "thumb-%02d.jpg")
      try:
        process = subprocess.run(
          [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            path,
            "-vf",
            f"thumbnail=90,scale='min({int(max_edge)},iw)':-2",
            "-frames:v",
            str(maximum),
            "-q:v",
            "3",
            "-y",
            output_pattern,
          ],
          capture_output=True,
          timeout=60,
          creationflags=WINDOWS_NO_WINDOW,
        )
      except (OSError, subprocess.SubprocessError) as error:
        raise ChatServiceError("从视频抽取画面失败") from error
      if process.returncode != 0:
        raise ChatServiceError("ffmpeg 无法从视频抽取画面")
      for index in range(1, maximum + 1):
        frame_path = os.path.join(
          temporary_directory,
          f"thumb-{index:02d}.jpg",
        )
        if os.path.isfile(frame_path):
          frames.append(_read_limited(frame_path, 8 * 1024 * 1024, "视频帧"))
  if not frames:
    raise ChatServiceError("未能从视频中抽取到可发送的画面")
  return frames


def _audio_format(path: str) -> str:
  extension = os.path.splitext(path)[1].lower().lstrip(".")
  if extension in {"oga", "opus"}:
    return "ogg"
  return extension or "wav"


def _media_cache_root(name: str) -> str:
  try:
    import folder_paths

    cache_root = os.path.join(folder_paths.get_temp_directory(), name)
  except Exception:
    cache_root = os.path.join(os.path.dirname(__file__), f".{name}")
  os.makedirs(cache_root, exist_ok=True)
  return cache_root


def _original_audio_payload(path: str, source_size: int, audio_format: str) -> tuple[bytes, str]:
  if source_size > MAX_AUDIO_BYTES:
    raise ChatServiceError(
      f"音频压缩失败，且原始文件超过 {MAX_AUDIO_BYTES / 1024 / 1024:.0f} MB"
    )
  return _read_limited(path, MAX_AUDIO_BYTES, "音频"), audio_format


def _compressed_audio_payload(path: str) -> tuple[bytes, str]:
  source_size = os.path.getsize(path)
  if source_size > MAX_AUDIO_SOURCE_BYTES:
    raise ChatServiceError(
      f"音频文件过大（{source_size / 1024 / 1024:.1f} MB），无法自动压缩"
    )

  audio_format = _audio_format(path)
  if (
    audio_format in {"mp3", "wav"}
    and source_size <= AUDIO_COMPRESSION_THRESHOLD_BYTES
  ):
    return _read_limited(path, MAX_AUDIO_BYTES, "音频"), audio_format

  try:
    ffmpeg = _find_media_tool("ffmpeg")
    cache_root = _media_cache_root("assets-astral-audio-cache")
    with tempfile.TemporaryDirectory(
      prefix="compress-",
      dir=cache_root,
    ) as temporary_directory:
      output_path = os.path.join(temporary_directory, "audio.mp3")
      process = subprocess.run(
        [
          ffmpeg,
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-i",
          path,
          "-map",
          "0:a:0",
          "-vn",
          "-map_metadata",
          "-1",
          "-ac",
          "2",
          "-ar",
          str(AUDIO_SAMPLE_RATE),
          "-codec:a",
          "libmp3lame",
          "-b:a",
          AUDIO_MP3_BITRATE,
          "-y",
          output_path,
        ],
        capture_output=True,
        timeout=180,
        creationflags=WINDOWS_NO_WINDOW,
      )
      if process.returncode == 0 and os.path.isfile(output_path):
        compressed = _read_limited(
          output_path,
          MAX_AUDIO_BYTES,
          "压缩后的音频",
        )
        if compressed and (
          len(compressed) < source_size
          or audio_format not in {"mp3", "wav"}
        ):
          return compressed, "mp3"
  except (OSError, subprocess.SubprocessError, ChatServiceError):
    pass

  return _original_audio_payload(path, source_size, audio_format)


def build_attachment_parts(
  attachments: list[dict[str, Any]] | None,
  *,
  max_image_edge: int = MAX_IMAGE_EDGE,
  image_jpeg_quality: int = IMAGE_JPEG_QUALITY,
  progressive_jpeg: bool = False,
) -> list[dict[str, Any]]:
  prepared: list[dict[str, Any]] = []
  for attachment in attachments or ():
    if not isinstance(attachment, dict):
      continue
    inline_data = attachment.get("data")
    path = ""
    payload: bytes | None = None
    payload_format = ""
    if inline_data not in (None, ""):
      declared_kind = str(attachment.get("kind") or "").strip().lower()
      mime_type = str(attachment.get("mimeType") or "").strip().lower()
      data_prefix = (
        str(inline_data or "")[:64].casefold()
        if not isinstance(inline_data, bytes)
        else ""
      )
      kind = declared_kind or (
        "image"
        if mime_type.startswith("image/") or "image/" in data_prefix
        else (
          "audio"
          if mime_type.startswith("audio/") or "audio/" in data_prefix
          else ""
        )
      )
      name = str(attachment.get("name") or "内联图片")
      if kind == "image":
        payload = _inline_image_payload(
          inline_data,
          label=f"附件 {name}",
        )
        payload_format = "image/jpeg"
      elif kind == "audio":
        payload = _inline_audio_payload(
          inline_data,
          label=f"附件 {name}",
        )
        payload_format = (
          str(attachment.get("format") or "").strip().lower()
          or mime_type.partition("/")[2]
          or "wav"
        )
      else:
        raise ChatServiceError("内联附件目前只支持图片和音频")
    else:
      try:
        path = _attachment_path(attachment)
      except (AssetPathError, FileNotFoundError, PermissionError) as error:
        raise ChatServiceError(
          f"无法读取附件 {attachment.get('root', '')}/"
          f"{attachment.get('path', '')}：{error}"
        ) from error
      kind = media_kind(path)
      name = str(attachment.get("name") or os.path.basename(path))
    mention_match = re.fullmatch(
      r"(image|video|audio)([1-9]\d{0,2})",
      str(attachment.get("mention") or "").strip().lower(),
    )
    mention = ""
    if mention_match and mention_match.group(1) == kind:
      mention = mention_match.group(0)
    prepared.append(
      {
        "path": path,
        "kind": kind,
        "name": name,
        "mention": mention,
        "payload": payload,
        "format": payload_format,
      }
    )

  mentions = [""] * len(prepared)
  maximums: dict[str, int] = {}
  used_mentions: set[str] = set()
  for index, item in enumerate(prepared):
    mention = item["mention"]
    if not mention or mention in used_mentions:
      continue
    mentions[index] = mention
    used_mentions.add(mention)
    maximums[item["kind"]] = max(
      maximums.get(item["kind"], 0),
      int(mention[len(item["kind"]):]),
    )
  for index, item in enumerate(prepared):
    if mentions[index]:
      continue
    kind = item["kind"]
    number = maximums.get(kind, 0) + 1
    while f"{kind}{number}" in used_mentions:
      number += 1
    mention = f"{kind}{number}"
    mentions[index] = mention
    maximums[kind] = number
    used_mentions.add(mention)

  parts: list[dict[str, Any]] = []
  for item, mention in zip(prepared, mentions):
    path = item["path"]
    kind = item["kind"]
    name = item["name"]
    if kind == "image":
      if item["payload"] is not None:
        compressed = _compress_image_payload(
          item["payload"],
          f"图片 {name}",
          max_edge=max_image_edge,
          jpeg_quality=image_jpeg_quality,
          progressive=progressive_jpeg,
        )
        encoded = base64.b64encode(compressed).decode("ascii")
        image_url = f"data:image/jpeg;base64,{encoded}"
      else:
        image_url = _compressed_image_data_url(
          path,
          max_edge=max_image_edge,
          jpeg_quality=image_jpeg_quality,
          progressive=progressive_jpeg,
        )
      parts.append(
        {
          "type": "image_url",
          "image_url": {"url": image_url},
        }
      )
      parts.append(
        {"type": "text", "text": f"[图片素材 @{mention}：{name}]"}
      )
    elif kind == "audio":
      if item["payload"] is not None:
        audio_payload = item["payload"]
        audio_format = item["format"] or "wav"
      else:
        audio_payload, audio_format = _compressed_audio_payload(path)
      encoded = base64.b64encode(audio_payload).decode("ascii")
      parts.append(
        {
          "type": "input_audio",
          "input_audio": {
            "data": encoded,
            "format": audio_format,
          },
        }
      )
      parts.append(
        {"type": "text", "text": f"[音频素材 @{mention}：{name}]"}
      )
    elif kind == "video":
      frames = _sample_video_frames(
        path,
        max_edge=max_image_edge,
      )
      parts.append(
        {
          "type": "text",
          "text": (
            f"[视频素材 @{mention}：{name}，"
            f"按时间顺序抽取了 {len(frames)} 帧供分析]"
          ),
        }
      )
      for index, frame in enumerate(frames, start=1):
        compressed = _compress_image_payload(
          frame,
          f"视频帧 {index}",
          max_edge=max_image_edge,
          jpeg_quality=image_jpeg_quality,
          progressive=progressive_jpeg,
        )
        encoded = base64.b64encode(compressed).decode("ascii")
        parts.append(
          {
            "type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{encoded}"},
          }
        )
    else:
      raise ChatServiceError(f"附件不是受支持的图片、音频或视频：{name}")
  return parts


def build_user_content(
  text: str,
  attachments: list[dict[str, Any]] | None,
  *,
  max_image_edge: int = MAX_IMAGE_EDGE,
  image_jpeg_quality: int = IMAGE_JPEG_QUALITY,
  progressive_jpeg: bool = False,
) -> str | list[dict[str, Any]]:
  message = str(text or "").strip()
  parts = build_attachment_parts(
    attachments,
    max_image_edge=max_image_edge,
    image_jpeg_quality=image_jpeg_quality,
    progressive_jpeg=progressive_jpeg,
  )
  if not message and not parts:
    raise ChatServiceError("消息内容不能为空")
  if not parts:
    return message
  return [
    *([{"type": "text", "text": message}] if message else []),
    *parts,
  ]


def _message_content(
  message: dict[str, Any],
  *,
  include_attachments: bool,
  max_image_edge: int = MAX_IMAGE_EDGE,
  image_jpeg_quality: int = IMAGE_JPEG_QUALITY,
  progressive_jpeg: bool = False,
) -> Any:
  text = str(message.get("content") or "").strip()
  attachments = (
    message.get("attachments")
    if include_attachments and isinstance(message.get("attachments"), list)
    else []
  )
  if not text and not attachments:
    return ""
  if not attachments:
    return text
  return build_user_content(
    text,
    attachments,
    max_image_edge=max_image_edge,
    image_jpeg_quality=image_jpeg_quality,
    progressive_jpeg=progressive_jpeg,
  )


def prepare_api_messages(
  config: dict[str, Any],
  conversation: dict[str, Any],
  user_message: str,
  *,
  attachments: list[dict[str, Any]] | None = None,
  skill_ids: list[str] | None = None,
  max_rounds: int | None = None,
  max_image_edge: int = MAX_IMAGE_EDGE,
  image_jpeg_quality: int = IMAGE_JPEG_QUALITY,
  progressive_jpeg: bool = False,
) -> list[dict[str, Any]]:
  selected_system_prompt = conversation.get("systemPromptTemplate")
  conversation_system_prompt = (
    str(selected_system_prompt.get("content") or "").strip()
    if isinstance(selected_system_prompt, dict)
    else ""
  )
  selected_skill_ids = (
    []
    if conversation_system_prompt
    else normalize_conversation_skill_ids(skill_ids)
  )
  if selected_skill_ids:
    loaded_skills, skill_context = build_skill_context(selected_skill_ids)
  else:
    loaded_skills, skill_context = [], ""
  system_parts = [
    conversation_system_prompt or str(config.get("systemPrompt") or "").strip(),
    skill_context.strip(),
  ]
  messages: list[dict[str, Any]] = []
  system_prompt = "\n\n".join(part for part in system_parts if part)
  if system_prompt:
    messages.append({"role": "system", "content": system_prompt})

  history = trim_conversation_history(
    conversation.get("messages")
    if isinstance(conversation.get("messages"), list)
    else [],
    int(max_rounds or config.get("maxRounds") or 12),
  )
  for message in history:
    role = message.get("role")
    if role not in {"user", "assistant"}:
      continue
    content = _message_content(
      message,
      include_attachments=role == "user",
      max_image_edge=max_image_edge,
      image_jpeg_quality=image_jpeg_quality,
      progressive_jpeg=progressive_jpeg,
    )
    if content:
      messages.append({"role": role, "content": content})
  messages.append(
    {
      "role": "user",
      "content": build_user_content(
        user_message,
        attachments,
        max_image_edge=max_image_edge,
        image_jpeg_quality=image_jpeg_quality,
        progressive_jpeg=progressive_jpeg,
      ),
    }
  )
  # Tag loaded skills only after the request has been assembled, so callers can
  # persist the exact set that was sent without mutating stored history.
  _ = loaded_skills
  return merge_system_messages(messages)


def _request_payload(
  config: dict[str, Any],
  messages: list[dict[str, Any]],
  level: int,
  *,
  image_output: bool = False,
) -> dict[str, Any]:
  payload: dict[str, Any] = {
    "model": str(config.get("model") or "").strip(),
    "messages": messages,
    "stream": False,
  }
  if not payload["model"]:
    raise ChatServiceError("请先填写模型名称")
  if level <= 0:
    payload["temperature"] = float(config.get("temperature", 0.7))
    payload["top_p"] = float(config.get("topP", 0.95))
    payload["max_tokens"] = int(config.get("maxTokens", 2048))
    payload["frequency_penalty"] = float(
      config.get("frequencyPenalty", 0.0)
    )
    payload["presence_penalty"] = float(
      config.get("presencePenalty", 0.0)
    )
    seed = config.get("seed")
    if seed is not None and str(seed).strip() != "":
      payload["seed"] = int(seed)
    stop = config.get("stop")
    if isinstance(stop, str):
      stop = stop.splitlines() if "\n" in stop else [stop]
    if isinstance(stop, (list, tuple)):
      sequences = [
        str(value).strip()
        for value in stop
        if str(value).strip()
      ][:8]
      if sequences:
        payload["stop"] = sequences
    response_format = str(
      config.get("responseFormat") or "default"
    ).strip()
    if response_format in {"text", "json_object"}:
      payload["response_format"] = {"type": response_format}
    reasoning_effort = str(
      config.get("reasoningEffort") or "default"
    ).strip()
    if reasoning_effort in {"low", "medium", "high"}:
      payload["reasoning_effort"] = reasoning_effort
  # Some OpenAI-compatible image models only return generated images when this
  # output modality is requested. The final retry omits it for services that
  # understand the model name but reject the optional field.
  if image_output and level < 2:
    payload["modalities"] = ["image", "text"]
  return payload


def _decode_image_data(value: str) -> bytes | None:
  cleaned = re.sub(r"\s+", "", str(value or ""))
  if not cleaned:
    return None
  if len(cleaned) > (MAX_GENERATED_IMAGE_BYTES * 4 // 3) + 64:
    return None
  cleaned = cleaned.replace("-", "+").replace("_", "/")
  if not re.fullmatch(r"[A-Za-z0-9+/]*={0,2}", cleaned):
    return None
  if len(cleaned.rstrip("=")) % 4 == 1:
    return None
  cleaned += "=" * (-len(cleaned) % 4)
  try:
    decoded = base64.b64decode(cleaned, validate=True)
  except (ValueError, TypeError):
    return None
  if not decoded or len(decoded) > MAX_GENERATED_IMAGE_BYTES:
    return None
  return decoded


def _generated_image_format(data: bytes) -> str:
  if not data:
    return ""
  try:
    with Image.open(io.BytesIO(data)) as image:
      image_format = str(image.format or "").upper()
      image.verify()
  except Exception:
    return ""
  return (
    image_format
    if image_format in GENERATED_IMAGE_EXTENSIONS
    else ""
  )


def _image_reference(value: Any) -> ResponseImage | None:
  if isinstance(value, ResponseImage):
    return value
  if isinstance(value, str):
    text = value.strip()
    match = re.match(
      r"^data:(image/[A-Za-z0-9.+-]+);base64,(.+)$",
      text,
      flags=re.DOTALL | re.IGNORECASE,
    )
    if match:
      decoded = _decode_image_data(match.group(2))
      return (
        ResponseImage(data=decoded, mime_type=match.group(1).lower())
        if decoded
        else None
      )
    if re.match(r"^https?://", text, flags=re.IGNORECASE):
      return ResponseImage(url=text)
    decoded = _decode_image_data(text)
    if decoded and _generated_image_format(decoded):
      return ResponseImage(data=decoded)
    return None
  if not isinstance(value, dict):
    return None

  for key in ("image_url", "output_image", "image", "source"):
    nested = value.get(key)
    if isinstance(nested, (str, dict)):
      reference = _image_reference(nested)
      if reference:
        return reference

  for key in ("b64_json", "base64"):
    encoded = value.get(key)
    if isinstance(encoded, str):
      decoded = _decode_image_data(encoded)
      if decoded:
        mime_type = str(
          value.get("mime_type")
          or value.get("mimeType")
          or value.get("media_type")
          or ""
        ).lower()
        return ResponseImage(data=decoded, mime_type=mime_type)

  data = value.get("data")
  mime_type = str(
    value.get("mime_type")
    or value.get("mimeType")
    or value.get("media_type")
    or ""
  ).lower()
  if isinstance(data, bytes):
    if data and len(data) <= MAX_GENERATED_IMAGE_BYTES:
      return ResponseImage(data=data, mime_type=mime_type)
  elif isinstance(data, str):
    decoded = _decode_image_data(data)
    if decoded and (mime_type.startswith("image/") or value.get("type") == "image"):
      return ResponseImage(data=decoded, mime_type=mime_type)

  for key in ("url", "uri"):
    url = value.get(key)
    if isinstance(url, str):
      reference = _image_reference(url)
      if reference:
        return reference
  return None


def _append_response_image(
  images: list[ResponseImage],
  seen: set[str],
  value: Any,
) -> None:
  reference = _image_reference(value)
  if reference is None:
    return
  if reference.data:
    key = f"data:{hashlib.sha256(reference.data).hexdigest()}"
  else:
    key = f"url:{reference.url}"
  if key in seen:
    return
  seen.add(key)
  images.append(reference)


def _collect_response_images(
  value: Any,
  images: list[ResponseImage],
  seen: set[str],
  visited: set[int] | None = None,
  *,
  depth: int = 0,
) -> None:
  if depth > 8 or len(images) >= MAX_GENERATED_IMAGES:
    return
  if isinstance(value, list):
    for item in value:
      _collect_response_images(
        item,
        images,
        seen,
        visited,
        depth=depth + 1,
      )
    return
  if not isinstance(value, dict):
    if isinstance(value, str):
      _append_response_image(images, seen, value)
    return
  visited = visited if visited is not None else set()
  identity = id(value)
  if identity in visited:
    return
  visited.add(identity)
  _append_response_image(images, seen, value)
  for key in (
    "content",
    "images",
    "image",
    "image_url",
    "output_image",
    "source",
    "data",
  ):
    if key in value:
      _collect_response_images(
        value[key],
        images,
        seen,
        visited,
        depth=depth + 1,
      )


def _content_text(value: Any) -> str:
  if isinstance(value, str):
    return value
  if isinstance(value, list):
    parts = []
    for part in value:
      if isinstance(part, str):
        parts.append(part)
      elif isinstance(part, dict):
        text = part.get("text")
        if isinstance(text, str):
          parts.append(text)
    return "\n".join(part for part in parts if part)
  if isinstance(value, dict):
    text = value.get("text")
    return text if isinstance(text, str) else ""
  return str(value or "")


_MARKDOWN_IMAGE_RE = re.compile(
  r"!\[([^\]]*)\]\((data:image/[^)\s]+|https?://[^)\s]+)\)",
  flags=re.IGNORECASE,
)
_BARE_DATA_IMAGE_RE = re.compile(
  r"data:image/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+",
  flags=re.IGNORECASE,
)
_BARE_BASE64_IMAGE_RE = re.compile(
  r"(?<![A-Za-z0-9+/=])([A-Za-z0-9+/]{128,}={0,2})(?![A-Za-z0-9+/=])",
)


def _extract_inline_images(
  text: str,
  images: list[ResponseImage],
  seen: set[str],
) -> str:
  def replace_markdown(match: re.Match[str]) -> str:
    _append_response_image(images, seen, match.group(2))
    return match.group(1).strip()

  cleaned = _MARKDOWN_IMAGE_RE.sub(replace_markdown, text)
  cleaned = _BARE_DATA_IMAGE_RE.sub(
    lambda match: (
      _append_response_image(images, seen, match.group(0))
      or "[图片]"
    ),
    cleaned,
  )

  def replace_bare_base64(match: re.Match[str]) -> str:
    encoded = match.group(1)
    decoded = _decode_image_data(encoded)
    if not decoded or not _generated_image_format(decoded):
      return match.group(0)
    _append_response_image(images, seen, encoded)
    return "[图片]"

  cleaned = _BARE_BASE64_IMAGE_RE.sub(replace_bare_base64, cleaned)
  return cleaned.strip()


def _response_text(payload: Any) -> ChatCompletionText:
  if not isinstance(payload, dict):
    raise ChatAPIError("API 返回了无法识别的响应格式")
  images: list[ResponseImage] = []
  seen_images: set[str] = set()
  choices = payload.get("choices")
  if not isinstance(choices, list) or not choices:
    error = payload.get("error")
    if isinstance(error, dict):
      raise ChatAPIError(str(error.get("message") or error))
    if error:
      raise ChatAPIError(str(error))
    _collect_response_images(
      payload.get("data"),
      images,
      seen_images,
    )
    _collect_response_images(
      payload.get("images"),
      images,
      seen_images,
    )
    if not images:
      raise ChatAPIError("API 响应中没有 choices")
    return ChatCompletionText("", tuple(images))
  first = choices[0] if isinstance(choices[0], dict) else {}
  message = first.get("message")
  content = (
    message.get("content")
    if isinstance(message, dict)
    else first.get("content", first.get("text"))
  )
  text = _content_text(content)
  text = strip_think_blocks(text)
  text = _extract_inline_images(text, images, seen_images)
  for source in (
    content,
    message,
    first,
    payload,
  ):
    _collect_response_images(
      source,
      images,
      seen_images,
    )
  if images:
    images = images[:MAX_GENERATED_IMAGES]
  if not text and not images:
    raise ChatAPIError("API 返回了空消息")
  if len(text) > MAX_RESPONSE_CHARS:
    text = text[:MAX_RESPONSE_CHARS]
  return ChatCompletionText(text, tuple(images))


def _generated_image_bytes(
  reference: ResponseImage,
  *,
  request_id: str | None,
  timeout: int = 60,
) -> tuple[bytes, str]:
  if reference.data:
    return reference.data, reference.mime_type
  if not reference.url:
    raise ChatServiceError("API 返回的图片没有可读取的地址")
  _raise_if_cancelled(request_id)
  request = urllib.request.Request(
    reference.url,
    method="GET",
    headers={"Accept": "image/*"},
  )
  try:
    with urllib.request.urlopen(request, timeout=timeout) as response:
      closer = response.close
      closer_registered = _register_request_closer(request_id, closer)
      try:
        _raise_if_cancelled(request_id)
        data = response.read(MAX_GENERATED_IMAGE_BYTES + 1)
      finally:
        if closer_registered:
          _unregister_request_closer(request_id, closer)
      mime_type = response.headers.get_content_type()
  except ChatCancelled:
    raise
  except Exception as error:
    _raise_if_cancelled(request_id)
    raise ChatServiceError(f"无法下载 API 返回的图片：{error}") from error
  if not data:
    raise ChatServiceError("API 返回的图片为空")
  if len(data) > MAX_GENERATED_IMAGE_BYTES:
    raise ChatServiceError("API 返回的图片超过 40 MB，已拒绝保存")
  return data, mime_type


def _save_generated_response_images(
  data_directory: str,
  conversation_id: str,
  images: tuple[ResponseImage, ...],
  *,
  request_id: str | None = None,
) -> list[dict[str, Any]]:
  if not images:
    return []
  _ = data_directory
  _, output_root = _asset_roots()
  safe_conversation_id = re.sub(
    r"[^A-Za-z0-9._-]+",
    "_",
    str(conversation_id or "canvas"),
  )[:80] or "canvas"
  target_directory = os.path.join(
    output_root,
    CHAT_IMAGE_DIRECTORY,
    safe_conversation_id,
  )
  os.makedirs(target_directory, exist_ok=True)
  attachments = []
  failures = []
  written_paths: list[str] = []
  for reference in images[:MAX_GENERATED_IMAGES]:
    _raise_if_cancelled(request_id)
    try:
      data, _mime_type = _generated_image_bytes(
        reference,
        request_id=request_id,
      )
      image_format = _generated_image_format(data)
      extension = GENERATED_IMAGE_EXTENSIONS.get(image_format)
      if not extension:
        raise ChatServiceError(
          f"API 返回了不支持的图片格式：{image_format or '未知'}"
        )
      filename = f"generated-{uuid.uuid4().hex[:16]}{extension}"
      target = os.path.join(target_directory, filename)
      with open(target, "xb") as output:
        output.write(data)
      written_paths.append(target)
      relative_path = os.path.relpath(target, output_root).replace("\\", "/")
      attachments.append(
        {
          "root": "output",
          "path": relative_path,
          "name": filename,
          "kind": "image",
        }
      )
    except ChatCancelled:
      for target in written_paths:
        try:
          os.remove(target)
        except OSError:
          pass
      raise
    except Exception as error:
      failures.append(str(error))
  if not attachments and images:
    detail = f"：{failures[0]}" if failures else ""
    raise ChatServiceError(f"API 返回了图片，但图片保存失败{detail}")
  return attachments


def _remove_generated_response_images(
  attachments: list[dict[str, Any]],
) -> None:
  if not attachments:
    return
  try:
    _, output_root = _asset_roots()
  except Exception:
    return
  generated_root = os.path.realpath(
    os.path.join(output_root, CHAT_IMAGE_DIRECTORY)
  )
  for attachment in attachments:
    if not isinstance(attachment, dict):
      continue
    try:
      path = resolve_asset_path(
        str(attachment.get("root") or ""),
        str(attachment.get("path") or ""),
        "",
        output_root,
      )
      resolved = os.path.realpath(path)
      if os.path.commonpath([resolved, generated_root]) != generated_root:
        continue
      os.remove(resolved)
    except (AssetPathError, OSError, ValueError):
      continue


def _http_post_json(
  url: str,
  headers: dict[str, str],
  payload: dict[str, Any],
  timeout: int,
  *,
  request_id: str | None = None,
) -> tuple[int, dict[str, Any] | None, str]:
  _raise_if_cancelled(request_id)
  request = urllib.request.Request(
    url,
    data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
    method="POST",
    headers={
      "Content-Type": "application/json",
      "Accept": "application/json",
      **headers,
    },
  )
  try:
    with urllib.request.urlopen(request, timeout=timeout) as response:
      closer = response.close
      closer_registered = _register_request_closer(request_id, closer)
      try:
        _raise_if_cancelled(request_id)
        raw = response.read().decode("utf-8", errors="replace")
      finally:
        if closer_registered:
          _unregister_request_closer(request_id, closer)
      try:
        return response.status, json.loads(raw), raw
      except json.JSONDecodeError as error:
        raise ChatAPIError(
          f"API 返回了无法解析的 JSON（HTTP {response.status}）",
          response.status,
        ) from error
  except urllib.error.HTTPError as error:
    _raise_if_cancelled(request_id)
    raw = error.read().decode("utf-8", errors="replace")
    _raise_if_cancelled(request_id)
    try:
      parsed = json.loads(raw)
    except json.JSONDecodeError:
      parsed = None
    return error.code, parsed if isinstance(parsed, dict) else None, raw
  except urllib.error.URLError as error:
    _raise_if_cancelled(request_id)
    reason = getattr(error, "reason", error)
    if isinstance(reason, (socket.timeout, TimeoutError)):
      raise ChatAPIError("API 请求超时，请检查服务状态或增大超时时间") from error
    raise ChatAPIError(f"无法连接 API：{reason}") from error
  except (socket.timeout, TimeoutError) as error:
    _raise_if_cancelled(request_id)
    raise ChatAPIError("API 请求超时，请检查服务状态或增大超时时间") from error
  except (ConnectionError, OSError) as error:
    _raise_if_cancelled(request_id)
    raise ChatAPIError(f"无法连接 API：{error}") from error
  except ChatCancelled:
    raise
  except Exception:
    _raise_if_cancelled(request_id)
    raise


def _http_get_json(
  url: str,
  headers: dict[str, str],
  timeout: int,
) -> tuple[int, dict[str, Any] | None, str]:
  request = urllib.request.Request(
    url,
    method="GET",
    headers={
      "Accept": "application/json",
      **headers,
    },
  )
  try:
    with urllib.request.urlopen(request, timeout=timeout) as response:
      raw = response.read().decode("utf-8", errors="replace")
      try:
        payload = json.loads(raw)
      except json.JSONDecodeError as error:
        raise ChatAPIError(
          f"API 返回了无法解析的 JSON（HTTP {response.status}）",
          response.status,
        ) from error
      if not isinstance(payload, dict):
        raise ChatAPIError("模型列表接口返回了无法识别的数据")
      return response.status, payload, raw
  except urllib.error.HTTPError as error:
    raw = error.read().decode("utf-8", errors="replace")
    try:
      parsed = json.loads(raw)
    except json.JSONDecodeError:
      parsed = None
    return error.code, parsed if isinstance(parsed, dict) else None, raw
  except urllib.error.URLError as error:
    reason = getattr(error, "reason", error)
    if isinstance(reason, (socket.timeout, TimeoutError)):
      raise ChatAPIError("拉取模型列表超时，请检查服务状态") from error
    raise ChatAPIError(f"无法连接模型列表接口：{reason}") from error
  except (socket.timeout, TimeoutError) as error:
    raise ChatAPIError("拉取模型列表超时，请检查服务状态") from error


def _api_error_message(
  status: int,
  payload: dict[str, Any] | None,
  raw: str,
) -> str:
  detail = ""
  if isinstance(payload, dict):
    error = payload.get("error")
    if isinstance(error, dict):
      detail = str(error.get("message") or error.get("detail") or "")
    elif error:
      detail = str(error)
    detail = detail or str(payload.get("message") or "")
  detail = detail or raw.strip()
  detail = re.sub(r"\s+", " ", detail)[:1000]
  if status == 401:
    return "API Key 无效或缺失"
  if status == 404:
    return f"API 地址或模型不存在（HTTP 404）{f'：{detail}' if detail else ''}"
  return f"API 请求失败（HTTP {status}）{f'：{detail}' if detail else ''}"


def list_api_models(
  config: dict[str, Any],
  *,
  timeout: int = 30,
  transport: Callable[
    [str, dict[str, str], int],
    tuple[int, dict[str, Any] | None, str],
  ] | None = None,
) -> list[str]:
  url = normalize_models_url(str(config.get("baseUrl") or ""))
  api_key = str(config.get("apiKey") or "").strip()
  headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
  get = transport or _http_get_json
  status, payload, raw = get(url, headers, timeout)
  if not (200 <= status < 300):
    message = _api_error_message(status, payload, raw)
    if status == 404:
      message = (
        "模型列表接口不可用（HTTP 404）。请确认 API 地址兼容 "
        "OpenAI /models，或直接手动填写模型名称。"
      )
    raise ChatAPIError(message, status)
  candidates: Any = None
  if isinstance(payload, dict):
    for key in ("data", "models", "items"):
      if isinstance(payload.get(key), list):
        candidates = payload[key]
        break
  if not isinstance(candidates, list):
    raise ChatAPIError("模型列表响应中没有 data、models 或 items 数组")
  models: list[str] = []
  seen: set[str] = set()
  for item in candidates:
    if isinstance(item, str):
      model_id = item.strip()
    elif isinstance(item, dict):
      model_id = str(
        item.get("id")
        or item.get("name")
        or item.get("model")
        or ""
      ).strip()
    else:
      model_id = ""
    if not model_id or model_id in seen:
      continue
    seen.add(model_id)
    models.append(model_id)
  if not models:
    raise ChatAPIError("模型列表为空")
  models.sort(key=str.casefold)
  return models[:5000]


def request_chat_completion(
  config: dict[str, Any],
  messages: list[dict[str, Any]],
  *,
  timeout: int = 180,
  request_id: str | None = None,
  image_output: bool = False,
  transport: Callable[
    [str, dict[str, str], dict[str, Any], int],
    tuple[int, dict[str, Any] | None, str],
  ] | None = None,
) -> str:
  url = normalize_chat_url(str(config.get("baseUrl") or ""))
  api_key = str(config.get("apiKey") or "").strip()
  headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
  if transport is not None:
    post = transport
  else:
    def post(
      request_url: str,
      request_headers: dict[str, str],
      request_payload: dict[str, Any],
      request_timeout: int,
    ) -> tuple[int, dict[str, Any] | None, str]:
      return _http_post_json(
        request_url,
        request_headers,
        request_payload,
        request_timeout,
        request_id=request_id,
      )

  last_error: ChatAPIError | None = None
  for level in range(3):
    _raise_if_cancelled(request_id)
    payload = _request_payload(
      config,
      messages,
      level,
      image_output=image_output,
    )
    status, response_payload, raw = post(url, headers, payload, timeout)
    _raise_if_cancelled(request_id)
    if 200 <= status < 300:
      return _response_text(response_payload)
    last_error = ChatAPIError(
      _api_error_message(status, response_payload, raw),
      status,
    )
    if status != 400 or level >= 2:
      raise last_error
  if last_error:
    raise last_error
  raise ChatAPIError("API 请求失败")


def run_chat_turn(
  data_directory: str,
  conversation_id: str,
  user_message: str,
  *,
  attachments: list[dict[str, Any]] | None = None,
  skill_ids: list[str] | None = None,
  task: str | None = None,
  persist: bool = True,
  request_id: str | None = None,
) -> dict[str, Any]:
  started_at = time.time()
  _raise_if_cancelled(request_id)
  conversation = get_or_create_conversation(
    data_directory,
    conversation_id,
  )
  selected_attachments = (
    attachments
    if attachments is not None
    else conversation.get("attachments", [])
  )
  selected_skills = normalize_conversation_skill_ids(
    skill_ids
    if skill_ids is not None
    else conversation.get("skillIds", [])
  )
  if attachments is not None or skill_ids is not None:
    conversation = update_conversation(
      data_directory,
      conversation_id,
      {
        **(
          {"attachments": selected_attachments}
          if attachments is not None
          else {}
        ),
        **({"skillIds": selected_skills} if skill_ids is not None else {}),
      },
    )
  selected_task = (
    str(task).strip().lower()
    if task is not None
    else ("multimodal" if selected_attachments else "text")
  )
  config = resolve_api_config(data_directory, selected_task)
  messages = prepare_api_messages(
    config,
    conversation,
    user_message,
    attachments=selected_attachments,
    skill_ids=selected_skills,
  )
  _raise_if_cancelled(request_id)
  request_options: dict[str, Any] = {}
  if request_id:
    request_options["request_id"] = request_id
  if selected_task == "image":
    request_options["image_output"] = True
  reply = request_chat_completion(config, messages, **request_options)
  _raise_if_cancelled(request_id)
  generated_images: list[dict[str, Any]] = []
  try:
    generated_images = _save_generated_response_images(
      data_directory,
      conversation_id,
      tuple(getattr(reply, "images", ())),
      request_id=request_id,
    )
    received_at = time.time()
    _raise_if_cancelled(request_id)
    if persist:
      conversation = append_conversation_messages(
        data_directory,
        conversation_id,
        [
          {
            "role": "user",
            "content": user_message,
            "attachments": selected_attachments,
            "timestamp": started_at,
            **({"requestId": request_id} if request_id else {}),
          },
          {
            "role": "assistant",
            "content": str(reply),
            "attachments": generated_images,
            "timestamp": received_at,
            **({"requestId": request_id} if request_id else {}),
          },
        ],
      )
  except Exception:
    _remove_generated_response_images(generated_images)
    raise
  return {
    "conversationId": conversation_id,
    "message": str(reply),
    "images": generated_images,
    "requestId": request_id,
    "sentAt": started_at,
    "receivedAt": received_at,
    "conversation": conversation,
  }


def translate_text(
  data_directory: str,
  text: str,
  target_language: str,
  *,
  source_language: str = "auto",
  request_id: str | None = None,
) -> str:
  messages = build_translation_messages(
    text,
    target_language,
    source_language=source_language,
  )
  config = resolve_api_config(data_directory, "text")
  return request_chat_completion(
    config,
    messages,
    **({"request_id": request_id} if request_id else {}),
  )


def build_translation_messages(
  text: str,
  target_language: str,
  *,
  source_language: str = "auto",
) -> list[dict[str, Any]]:
  cleaned = str(text or "").strip()
  if not cleaned:
    raise ChatServiceError("请先输入要翻译的文本")
  target = str(target_language or "").strip()
  if not target:
    raise ChatServiceError("请选择目标语言")
  messages = [
    {
      "role": "system",
      "content": (
        "你是专业翻译。只输出译文，不解释、不加引号、不添加原文。"
        "保留提示词格式、换行、Markdown、占位符和专有名词。"
      ),
    },
    {
      "role": "user",
      "content": (
        f"源语言：{source_language or 'auto'}\n"
        f"目标语言：{target}\n\n"
        f"{cleaned}"
      ),
    },
  ]
  return merge_system_messages(messages)


def run_translation_turn(
  data_directory: str,
  conversation_id: str,
  text: str,
  target_language: str,
  *,
  source_language: str = "auto",
  local_mode: bool = False,
  persist: bool = True,
  request_id: str | None = None,
) -> dict[str, Any]:
  started_at = time.time()
  _raise_if_cancelled(request_id)
  messages = build_translation_messages(
    text,
    target_language,
    source_language=source_language,
  )
  if local_mode:
    config = load_local_llm_config(data_directory)
    reply = generate_local_chat(config, messages)
    _raise_if_cancelled(request_id)
  else:
    config = resolve_api_config(data_directory, "text")
    reply = request_chat_completion(
      config,
      messages,
      **({"request_id": request_id} if request_id else {}),
    )

  received_at = time.time()
  _raise_if_cancelled(request_id)
  conversation = get_or_create_conversation(data_directory, conversation_id)
  if persist:
    conversation = append_conversation_messages(
      data_directory,
      conversation_id,
      [
        {
          "role": "user",
          "content": str(text or "").strip(),
          "timestamp": started_at,
          **({"requestId": request_id} if request_id else {}),
        },
        {
          "role": "assistant",
          "content": reply,
          "timestamp": received_at,
          **({"requestId": request_id} if request_id else {}),
        },
      ],
    )
  return {
    "conversationId": conversation_id,
    "message": reply,
    "text": reply,
    "targetLanguage": target_language,
    "requestId": request_id,
    "sentAt": started_at,
    "receivedAt": received_at,
    "conversation": conversation,
  }


def _validate_local_attachments(
  config: dict[str, Any],
  attachments: list[dict[str, Any]],
  conversation: dict[str, Any] | None = None,
) -> None:
  validation_items = list(attachments)
  history = (
    trim_conversation_history(
      conversation.get("messages")
      if isinstance(conversation.get("messages"), list)
      else [],
      int(config.get("maxRounds") or 12),
    )
    if isinstance(conversation, dict)
    else []
  )
  for message in history:
    if message.get("role") != "user":
      continue
    historical = message.get("attachments")
    if isinstance(historical, list):
      validation_items.extend(historical)

  kinds: set[str] = set()
  for attachment in validation_items:
    if not isinstance(attachment, dict):
      continue
    if attachment.get("data") not in (None, ""):
      kind = str(attachment.get("kind") or "").strip().lower()
      mime_type = str(attachment.get("mimeType") or "").strip().lower()
      if not kind and mime_type.startswith("image/"):
        kind = "image"
      path = str(attachment.get("name") or "内联附件")
    else:
      try:
        path = _attachment_path(attachment)
      except (AssetPathError, FileNotFoundError, PermissionError) as error:
        raise ChatServiceError(
          f"无法读取附件 {attachment.get('root', '')}/"
          f"{attachment.get('path', '')}：{error}"
        ) from error
      kind = media_kind(path)
    if kind not in {"image", "video", "audio"}:
      raise ChatServiceError(
        f"本地模型不支持这个素材：{attachment.get('name') or path}"
      )
    kinds.add(kind)

  vision_model = str(config.get("visionModelPath") or "").strip()
  if kinds & {"image", "video"} and not vision_model:
    raise ChatServiceError(
      "本地模型收到图片或视频素材，但尚未选择视觉投影模型（mmproj）。"
      "请到“本地 LLM 配置”选择与主模型匹配的 mmproj。"
    )
  if "audio" in kinds:
    family = local_model_family(str(config.get("modelPath") or ""))
    if family != "gemma4":
      raise ChatServiceError(
        "当前本地主模型不支持音频输入。音频对话仅支持 Gemma4。"
      )
    if not vision_model:
      raise ChatServiceError(
        "Gemma4 音频输入需要视觉投影模型（mmproj），"
        "请先选择与主模型匹配的 BF16 mmproj。"
      )


def run_local_chat_turn(
  data_directory: str,
  conversation_id: str,
  user_message: str,
  *,
  attachments: list[dict[str, Any]] | None = None,
  skill_ids: list[str] | None = None,
  persist: bool = True,
  models_root: str | None = None,
  request_id: str | None = None,
) -> dict[str, Any]:
  started_at = time.time()
  _raise_if_cancelled(request_id)
  cleaned = str(user_message or "").strip()
  conversation = get_or_create_conversation(
    data_directory,
    conversation_id,
  )
  selected_attachments = (
    attachments
    if attachments is not None
    else conversation.get("attachments", [])
  )
  if not isinstance(selected_attachments, list):
    selected_attachments = []
  if not cleaned and not selected_attachments:
    raise ChatServiceError("请先输入消息或选择素材")
  selected_skills = normalize_conversation_skill_ids(
    skill_ids
    if skill_ids is not None
    else conversation.get("skillIds", [])
  )
  config = load_local_llm_config(
    data_directory,
    models_root=models_root,
  )
  _validate_local_attachments(
    config,
    selected_attachments,
    conversation,
  )
  messages = prepare_api_messages(
    config,
    conversation,
    cleaned,
    attachments=selected_attachments,
    skill_ids=selected_skills,
    max_image_edge=int(config["maxImageEdge"]),
    image_jpeg_quality=int(config["imageJpegQuality"]),
    progressive_jpeg=True,
  )
  _raise_if_cancelled(request_id)
  reply = generate_local_chat(
    config,
    messages,
    models_root=models_root,
  )
  received_at = time.time()
  _raise_if_cancelled(request_id)
  if persist:
    if attachments is not None or skill_ids is not None:
      conversation = update_conversation(
        data_directory,
        conversation_id,
        {
          **(
            {"attachments": selected_attachments}
            if attachments is not None
            else {}
          ),
          **({"skillIds": selected_skills} if skill_ids is not None else {}),
        },
      )
    conversation = append_conversation_messages(
      data_directory,
      conversation_id,
      [
        {
          "role": "user",
          "content": cleaned,
          "attachments": selected_attachments,
          "timestamp": started_at,
          **({"requestId": request_id} if request_id else {}),
        },
        {
          "role": "assistant",
          "content": str(reply),
          "timestamp": received_at,
          **({"requestId": request_id} if request_id else {}),
        },
      ],
    )
  return {
    "conversationId": conversation_id,
    "message": str(reply),
    "images": [],
    "requestId": request_id,
    "sentAt": started_at,
    "receivedAt": received_at,
    "conversation": conversation,
  }


def optimize_prompt(
  data_directory: str,
  text: str,
  *,
  attachments: list[dict[str, Any]] | None = None,
  skill_ids: list[str] | None = None,
) -> str:
  cleaned = str(text or "").strip()
  if not cleaned:
    raise ChatServiceError("请先输入要优化的提示词")
  config = resolve_api_config(data_directory, "text")
  _, skill_context = build_skill_context(
    normalize_conversation_skill_ids(skill_ids)
  )
  system_parts = [
    str(config.get("systemPrompt") or "").strip(),
    skill_context.strip(),
    (
      "你是专业的生成式 AI 提示词编辑。优化用户提示词，使主体、构图、"
      "光线、风格和细节更清晰，但不得改变原始意图。只输出优化后的提示词，"
      "不要解释、不要标题、不要引号。"
    ),
  ]
  return request_chat_completion(
    config,
    [
      {
        "role": "system",
        "content": "\n\n".join(part for part in system_parts if part),
      },
      {
        "role": "user",
        "content": build_user_content(cleaned, attachments),
      },
    ],
  )


def normalize_inspiration_tags(tags: Any) -> list[dict[str, str]]:
  if tags is None:
    return []
  if not isinstance(tags, list):
    raise ChatServiceError("灵感标签必须是数组")
  normalized: list[dict[str, str]] = []
  seen: set[tuple[str, str]] = set()
  for raw_tag in tags:
    if isinstance(raw_tag, str):
      name = raw_tag.strip()
      category = ""
    elif isinstance(raw_tag, dict):
      name = str(raw_tag.get("name") or "").strip()
      category = str(raw_tag.get("category") or "").strip()
    else:
      continue
    if not name:
      continue
    name = name[:120]
    category = category[:80]
    key = (category.casefold(), name.casefold())
    if key in seen:
      continue
    seen.add(key)
    normalized.append({"name": name, "category": category})
    if len(normalized) >= 200:
      break
  return normalized


def _inspiration_target(value: Any) -> tuple[str, str]:
  normalized = str(value or "image").strip().casefold()
  if normalized in {"image", "t2i", "文生图", "图片"}:
    return "image", "文生图（静态画面）"
  if normalized in {"video", "t2v", "文生视频", "视频"}:
    return "video", "文生视频（连续镜头）"
  raise ChatServiceError("生成目标必须是文生图或文生视频")


def _inspiration_language(value: Any) -> tuple[str, str]:
  normalized = str(value or "en").strip().casefold()
  if normalized in {"en", "english", "英文"}:
    return "en", "English"
  if normalized in {"zh", "zh-cn", "chinese", "中文"}:
    return "zh", "简体中文"
  raise ChatServiceError("输出语言必须是英文或中文")


def _inspiration_mode(value: Any) -> str:
  normalized = str(value or "api").strip().casefold()
  if normalized in {
    "api",
    "api模式",
    "api纯文本模式",
    "外部api",
    "外部 api",
  }:
    return "api"
  if normalized in {"local", "本地", "本地模式"}:
    return "local"
  raise ChatServiceError("生成方式必须是 API纯文本模式或本地模式")


INSPIRATION_VISUAL_RULES = (
  "你是专业的生成式 AI 视觉提示词导演和编辑。用户提供的标签是创作"
  "灵感，不是固定 Tag 模板，不要机械地按逗号罗列。请把标签自然、"
  "具体地融入画面，允许补全合理细节，但不要改变用户明确意图。"
)


def generate_inspiration_prompt(
  data_directory: str,
  base_prompt: str,
  *,
  tags: Any = None,
  target: str = "image",
  language: str = "en",
  mode: str = "api",
) -> str:
  cleaned_prompt = str(base_prompt or "").strip()
  selected_tags = normalize_inspiration_tags(tags)
  if not cleaned_prompt and not selected_tags:
    raise ChatServiceError("请先输入画面想法或选择至少一个灵感标签")
  target_id, target_label = _inspiration_target(target)
  _, language_label = _inspiration_language(language)
  mode_id = _inspiration_mode(mode)
  config = (
    load_local_llm_config(data_directory)
    if mode_id == "local"
    else resolve_api_config(data_directory, "text")
  )

  grouped_tags: dict[str, list[str]] = {}
  for tag in selected_tags:
    category = tag["category"] or "灵感"
    grouped_tags.setdefault(category, []).append(tag["name"])
  tag_lines = "\n".join(
    f"- {category}：{'、'.join(names)}"
    for category, names in grouped_tags.items()
  )
  target_rules = (
    "扩写静态画面：明确主体外观与动作、场景关系、构图/景别、镜头角度、"
    "光线、色彩、材质、氛围和视觉风格。"
    if target_id == "image"
    else (
      "扩写连续视频：明确主体外观与动作变化、场景关系、起始构图、镜头"
      "运动、动作节奏、光影变化、空间连续性，并保持角色与服装一致；"
      "提示词应适合一个连贯镜头。"
    )
  )
  system_parts = [
    INSPIRATION_VISUAL_RULES,
    (
      f"{target_rules} 输出可直接用于生成模型的单段提示词；不要解释、"
      "不要标题、不要引号、不要 Markdown。"
    ),
  ]
  user_parts = [
    f"生成目标：{target_label}",
    f"输出语言：{language_label}",
    f"基础画面想法：{cleaned_prompt or '未提供，请依据灵感标签发起一个完整画面'}",
    f"灵感标签：\n{tag_lines or '- 未选择'}",
    (
      "如果标签之间存在冲突，以基础画面想法为准。中文标签在英文输出中"
      "应按语义转化为自然的英文视觉描述。"
    ),
  ]
  messages = [
    {
      "role": "system",
      "content": "\n\n".join(part for part in system_parts if part),
    },
    {"role": "user", "content": "\n\n".join(user_parts)},
  ]
  if mode_id == "local":
    return generate_local_chat(config, messages)
  return request_chat_completion(config, messages)


def invert_prompt(
  data_directory: str,
  *,
  hint: str = "",
  attachments: list[dict[str, Any]] | None = None,
  skill_ids: list[str] | None = None,
) -> str:
  if not attachments:
    raise ChatServiceError("提示词反推需要先选择图片或视频素材")
  config = resolve_api_config(data_directory, "image")
  _, skill_context = build_skill_context(
    normalize_conversation_skill_ids(skill_ids)
  )
  system_parts = [
    str(config.get("systemPrompt") or "").strip(),
    skill_context.strip(),
    (
      "你是专业的图像与视频提示词反推助手。观察附件的可见内容，输出可直接"
      "用于生成式模型的英文提示词，覆盖主体、动作、构图、镜头、光线、色彩、"
      "材质与风格。只输出提示词，不要解释、不要标题、不要引号。"
    ),
  ]
  user_text = str(hint or "").strip() or "请分析附件并反推生成提示词。"
  return request_chat_completion(
    config,
    [
      {
        "role": "system",
        "content": "\n\n".join(part for part in system_parts if part),
      },
      {
        "role": "user",
        "content": build_user_content(user_text, attachments),
      },
    ],
  )


def _prompt_task_kind(value: Any) -> str:
  normalized = str(value or "expand").strip().casefold()
  if normalized not in {"expand", "invert", "translate"}:
    raise ChatServiceError("提示词任务必须是扩写、反推或翻译")
  return normalized


def _prompt_task_mode(value: Any) -> str:
  normalized = str(value or "api").strip().casefold()
  if normalized in {
    "api",
    "api纯文本模式",
    "api模式",
    "api图片模式",
  }:
    return "api"
  if normalized in {"local", "本地", "本地模式"}:
    return "local"
  raise ChatServiceError("服务必须选择 API 模式或本地模式")


def _prompt_task_enabled(value: Any) -> bool:
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


def _clear_local_model_memory() -> str:
  errors: list[str] = []
  try:
    release_local_llm_memory()
  except Exception as error:
    errors.append(str(error))
  try:
    import comfy.model_management as model_management

    empty_cache = getattr(model_management, "soft_empty_cache", None)
    if callable(empty_cache):
      empty_cache()
  except Exception as error:
    errors.append(str(error))
  return "；".join(item for item in errors if item)


def _prompt_task_rule(
  data_directory: str,
  task: str,
  rule_id: str,
) -> dict[str, Any] | None:
  requested = str(rule_id or "").strip()
  if not requested:
    return None
  template = get_template(data_directory, requested)
  expected_category = {
    "expand": "expand",
    "invert": "invert",
  }.get(task)
  if expected_category is None:
    raise ChatServiceError("翻译任务不使用提示词扩写或图像反推规则")
  if str(template.get("category") or "") != expected_category:
    raise ChatServiceError(
      "提示词扩写只能使用“提示词扩写”分类的系统提示词"
      if task == "expand"
      else "图像反推只能使用“图像反推”分类的系统提示词"
    )
  content = str(template.get("prompt") or "").strip()
  if not content:
    raise ChatServiceError("所选系统提示词正文为空")
  return {
    "id": str(template.get("id") or ""),
    "title": str(template.get("title") or ""),
    "content": content,
    "category": str(template.get("category") or ""),
  }


PROMPT_TASK_LANGUAGE_NAMES = {
  "en": "English",
  "zh": "Simplified Chinese",
  "ja": "Japanese",
  "ko": "Korean",
  "fr": "French",
  "de": "German",
  "es": "Spanish",
  "ru": "Russian",
  "pt": "Portuguese",
  "it": "Italian",
  "ar": "Arabic",
}


def _prompt_task_messages(
  config: dict[str, Any],
  *,
  task: str,
  text: str,
  attachments: list[dict[str, Any]],
  rule_context: str,
  skill_context: str,
  target_language: str,
  source_language: str,
  max_image_edge: int = MAX_IMAGE_EDGE,
  image_jpeg_quality: int = IMAGE_JPEG_QUALITY,
  progressive_jpeg: bool = False,
) -> list[dict[str, Any]]:
  if task == "translate":
    return merge_system_messages(
      build_translation_messages(
        text,
        target_language,
        source_language=source_language,
      )
    )

  instructions = {
    "expand": (
      "你是专业的生成式 AI 提示词编辑。扩写用户提示词，使主体、动作、"
      "构图、镜头、光线、色彩、材质、氛围和风格更清晰具体，但不得改变"
      "用户原始意图。只输出扩写后的提示词，不要解释、标题、引号或 Markdown。"
    ),
    "invert": (
      "你是专业的图像与视频提示词反推助手。观察附件中的可见内容，输出"
      "可直接用于生成式模型的完整提示词，覆盖主体、动作、构图、镜头、"
      "光线、色彩、材质、空间关系与风格。只输出提示词，不要解释、标题、"
      "引号或 Markdown。"
    ),
  }[task]
  if task == "invert":
    language_name = PROMPT_TASK_LANGUAGE_NAMES.get(
      str(target_language or "").strip().casefold()
    )
    if language_name:
      instructions = (
        f"{instructions}\nOutput language: {language_name}. "
        f"Write the final prompt only in {language_name}."
      )
  system_parts = [
    str(config.get("systemPrompt") or "").strip(),
    rule_context.strip(),
    skill_context.strip(),
    instructions,
  ]
  user_text = text
  if task == "invert" and not user_text:
    user_text = "请分析附件并反推生成提示词。"
  return [
    {
      "role": "system",
      "content": "\n\n".join(part for part in system_parts if part),
    },
    {
      "role": "user",
      "content": build_user_content(
        user_text,
        attachments,
        max_image_edge=max_image_edge,
        image_jpeg_quality=image_jpeg_quality,
        progressive_jpeg=progressive_jpeg,
      ),
    },
  ]


def run_prompt_task(
  data_directory: str,
  text: str,
  *,
  task: str = "expand",
  mode: str = "api",
  rule_id: str = "",
  skill_ids: list[str] | None = None,
  attachments: list[dict[str, Any]] | None = None,
  clear_vram: bool = False,
  request_id: str | None = None,
  target_language: str = "en",
  source_language: str = "auto",
  seed: int | None = None,
) -> dict[str, Any]:
  """Run one stateless prompt operation without touching conversation history."""
  started_at = time.time()
  task_id = _prompt_task_kind(task)
  mode_id = _prompt_task_mode(mode)
  _raise_if_cancelled(request_id)
  cleaned = str(text or "").strip()
  selected_attachments = [
    item for item in (attachments or []) if isinstance(item, dict)
  ]
  if task_id in {"expand", "translate"} and not cleaned:
    raise ChatServiceError(
      "请先输入要扩写的提示词"
      if task_id == "expand"
      else "请先输入要翻译的文本"
    )
  if task_id == "invert" and not selected_attachments:
    raise ChatServiceError("图像反推需要先选择图片、视频或音频素材")

  selected_skills = normalize_conversation_skill_ids(skill_ids)
  selected_rule = _prompt_task_rule(
    data_directory,
    task_id,
    rule_id,
  )
  if selected_rule and selected_skills:
    raise ChatServiceError("系统提示词与 Skill 只能选择一个")
  _, skill_context = build_skill_context(selected_skills)

  reply = ""
  received_at = 0.0
  clear_vram_requested = mode_id == "local" and _prompt_task_enabled(
    clear_vram
  )
  cleared_vram = False
  clear_vram_error = ""
  try:
    if mode_id == "local":
      config = load_local_llm_config(data_directory)
      _validate_local_attachments(config, selected_attachments)
      messages = _prompt_task_messages(
        config,
        task=task_id,
        text=cleaned,
        attachments=selected_attachments,
        rule_context=(
          selected_rule["content"] if selected_rule else ""
        ),
        skill_context=skill_context,
        target_language=target_language,
        source_language=source_language,
        max_image_edge=int(config["maxImageEdge"]),
        image_jpeg_quality=int(config["imageJpegQuality"]),
        progressive_jpeg=True,
      )
      _raise_if_cancelled(request_id)
      closer = LOCAL_LLM_MANAGER.abort_current
      closer_registered = _register_request_closer(request_id, closer)
      try:
        reply = generate_local_chat(config, messages, seed=seed)
      except Exception:
        _raise_if_cancelled(request_id)
        raise
      finally:
        if closer_registered:
          _unregister_request_closer(request_id, closer)
    else:
      config = resolve_api_config(
        data_directory,
        "image" if task_id == "invert" else "text",
      )
      messages = _prompt_task_messages(
        config,
        task=task_id,
        text=cleaned,
        attachments=selected_attachments,
        rule_context=(
          selected_rule["content"] if selected_rule else ""
        ),
        skill_context=skill_context,
        target_language=target_language,
        source_language=source_language,
      )
      reply = request_chat_completion(
        config,
        messages,
        **({"request_id": request_id} if request_id else {}),
      )
    received_at = time.time()
    _raise_if_cancelled(request_id)
  finally:
    if clear_vram_requested:
      clear_vram_error = _clear_local_model_memory()
      cleared_vram = not clear_vram_error

  result = {
    "text": str(reply),
    "task": task_id,
    "mode": mode_id,
    "ruleId": selected_rule["id"] if selected_rule else "",
    "ruleTitle": selected_rule["title"] if selected_rule else "",
    "skillIds": selected_skills,
    "requestId": request_id,
    "sentAt": started_at,
    "receivedAt": received_at,
    "clearedVram": cleared_vram,
  }
  if clear_vram_error:
    result["clearVramError"] = clear_vram_error
  return result


async def run_chat_turn_async(*args: Any, **kwargs: Any) -> dict[str, Any]:
  return await asyncio.to_thread(run_chat_turn, *args, **kwargs)


async def run_local_chat_turn_async(
  *args: Any,
  **kwargs: Any,
) -> dict[str, Any]:
  return await asyncio.to_thread(run_local_chat_turn, *args, **kwargs)


async def run_translation_turn_async(
  *args: Any,
  **kwargs: Any,
) -> dict[str, Any]:
  return await asyncio.to_thread(run_translation_turn, *args, **kwargs)


async def run_prompt_task_async(
  *args: Any,
  **kwargs: Any,
) -> dict[str, Any]:
  return await asyncio.to_thread(run_prompt_task, *args, **kwargs)
