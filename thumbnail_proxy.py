from __future__ import annotations

import hashlib
import io
import os
import re
from typing import Any
from urllib.parse import urlsplit

import requests
from PIL import Image, UnidentifiedImageError

from .source_resolver import request_with_system_proxy


MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024
MAX_REDIRECTS = 4
TRUSTED_HOST_SUFFIXES = (
  ".civitai.com",
  ".huggingface.co",
  ".hf.co",
  ".modelscope.cn",
  ".aliyuncs.com",
)
TRUSTED_HOSTS = {
  "civitai.com",
  "huggingface.co",
  "hf.co",
  "modelscope.cn",
  "www.modelscope.cn",
}
USER_AGENT = "ComfyUI-Astral-Manage/0.7.0"


class ThumbnailError(ValueError):
  pass


def validate_thumbnail_url(url: str) -> str:
  value = str(url or "").strip()
  parsed = urlsplit(value)
  if parsed.scheme.lower() != "https":
    raise ThumbnailError("Thumbnail URL must use HTTPS")
  if parsed.username or parsed.password:
    raise ThumbnailError("Thumbnail URL must not contain login credentials")
  host = (parsed.hostname or "").lower().rstrip(".")
  if not host:
    raise ThumbnailError("Thumbnail URL is missing a host name")
  trusted = host in TRUSTED_HOSTS or any(
    host.endswith(suffix) for suffix in TRUSTED_HOST_SUFFIXES
  )
  if not trusted:
    raise ThumbnailError("Thumbnail host is not in the allowlist")
  return value


def _image_extension(content_type: str, data: bytes) -> str:
  try:
    with Image.open(io.BytesIO(data)) as image:
      image.verify()
      image_format = str(image.format or "").upper()
  except (OSError, UnidentifiedImageError) as error:
    raise ThumbnailError("Downloaded content is not a valid image") from error
  mapping = {
    "JPEG": ".jpg",
    "PNG": ".png",
    "WEBP": ".webp",
    "GIF": ".gif",
    "AVIF": ".avif",
    "BMP": ".bmp",
  }
  if image_format not in mapping:
    raise ThumbnailError("Thumbnail image format is not supported")
  if not str(content_type or "").lower().startswith("image/"):
    raise ThumbnailError("Thumbnail response is not an image type")
  return mapping[image_format]


def _download_image(url: str) -> tuple[bytes, str, str]:
  current_url = validate_thumbnail_url(url)
  for _redirect in range(MAX_REDIRECTS + 1):
    try:
      response = request_with_system_proxy(
        "GET",
        current_url,
        headers={
          "Accept": "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8",
          "User-Agent": USER_AGENT,
        },
        timeout=(10, 25),
        allow_redirects=False,
        stream=True,
      )
    except requests.exceptions.RequestException as error:
      raise ThumbnailError(f"Thumbnail download failed: {error}") from error

    if response.status_code in {301, 302, 303, 307, 308}:
      location = response.headers.get("Location")
      response.close()
      if not location:
        raise ThumbnailError("Thumbnail redirect is missing a target URL")
      current_url = validate_thumbnail_url(
        requests.compat.urljoin(current_url, location)
      )
      continue
    if response.status_code != 200:
      response.close()
      raise ThumbnailError(f"Thumbnail server returned HTTP {response.status_code}")

    content_type = str(response.headers.get("Content-Type") or "").split(";", 1)[0]
    chunks: list[bytes] = []
    total = 0
    try:
      for chunk in response.iter_content(64 * 1024):
        if not chunk:
          continue
        total += len(chunk)
        if total > MAX_THUMBNAIL_BYTES:
          raise ThumbnailError("Thumbnail file exceeds the 8 MB limit")
        chunks.append(chunk)
    finally:
      response.close()
    data = b"".join(chunks)
    extension = _image_extension(content_type, data)
    return data, extension, content_type
  raise ThumbnailError("Too many thumbnail redirects")


def download_thumbnail_image(url: str) -> tuple[bytes, str]:
  data, extension, _content_type = _download_image(url)
  return data, extension


def cache_thumbnail(url: str, cache_directory: str) -> str:
  url = validate_thumbnail_url(url)
  os.makedirs(cache_directory, exist_ok=True)
  token = hashlib.sha256(url.encode("utf-8")).hexdigest()
  for extension in (".jpg", ".png", ".webp", ".gif", ".avif", ".bmp"):
    candidate = os.path.join(cache_directory, f"{token}{extension}")
    if os.path.isfile(candidate):
      return candidate
  data, extension, _content_type = _download_image(url)
  target = os.path.join(cache_directory, f"{token}{extension}")
  temporary = f"{target}.part"
  try:
    with open(temporary, "wb") as handle:
      handle.write(data)
    os.replace(temporary, target)
  finally:
    if os.path.exists(temporary):
      os.remove(temporary)
  return target
