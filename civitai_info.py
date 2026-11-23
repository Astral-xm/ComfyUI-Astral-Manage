from __future__ import annotations

import html
import math
import re
from typing import Any


_NUMBER = r"[+-]?(?:\d+(?:\.\d+)?|\.\d+)"
_RANGE = (
  rf"(?:\s*(?:-|~|～|－|–|—|to|至|到)\s*(?P<high>{_NUMBER}))?"
)
_STRENGTH_PATTERNS = (
  re.compile(
    rf"(?:推荐|建议|最佳)(?:的)?(?:LoRA\s*)?(?:权重|强度|系数)"
    rf"\s*(?:为|是|[:：]|约|在|使用)?\s*(?P<low>{_NUMBER}){_RANGE}",
    re.IGNORECASE,
  ),
  re.compile(
    rf"(?:LoRA\s*)?(?:权重|强度|系数)\s*(?:推荐|建议|最佳)"
    rf"(?:为|是|[:：]|约|在|使用)?\s*(?P<low>{_NUMBER}){_RANGE}",
    re.IGNORECASE,
  ),
  re.compile(
    rf"\b(?:recommended|suggested|optimal|ideal|best)\s+"
    rf"(?:LoRA\s+)?(?:strength|weight|scale)(?:\s+range)?"
    rf"\s*(?:is|of|around|between|from|[:])?\s*"
    rf"(?P<low>{_NUMBER}){_RANGE}",
    re.IGNORECASE,
  ),
  re.compile(
    rf"\b(?:LoRA\s+)?(?:strength|weight|scale)(?:\s+range)?\s+"
    rf"(?:is\s+|of\s+)?(?:recommended|suggested|optimal|ideal|best)"
    rf"\s*(?:at|around|between|from|[:])?\s*"
    rf"(?P<low>{_NUMBER}){_RANGE}",
    re.IGNORECASE,
  ),
)


def _plain_text(value: Any) -> str:
  if not isinstance(value, str):
    return ""
  text = html.unescape(value)
  text = re.sub(r"(?i)<br\s*/?>", "\n", text)
  text = re.sub(r"(?i)</(?:p|div|li|h[1-6])>", "\n", text)
  text = re.sub(r"<[^>]+>", " ", text)
  text = text.replace("\xa0", " ")
  return re.sub(r"\s+", " ", text).strip()


def _format_number(value: float) -> str:
  text = f"{value:.4f}".rstrip("0").rstrip(".")
  return "0" if text in {"-0", ""} else text


def _make_strength(low: float, high: float | None, source: str) -> dict[str, Any] | None:
  if not math.isfinite(low):
    return None
  if high is not None and not math.isfinite(high):
    return None
  low = low if high is None else min(low, high)
  high = low if high is None else max(low, high)
  if abs(low) > 20 or abs(high) > 20:
    return None

  return {
    "text": (
      _format_number(low)
      if low == high
      else f"{_format_number(low)} - {_format_number(high)}"
    ),
    "value": round((low + high) / 2, 2),
    "min": round(low, 4),
    "max": round(high, 4),
    "source": source,
  }


def extract_recommended_strength_from_text(
  text: Any,
  source: str,
) -> dict[str, Any] | None:
  """Extract only explicit recommendation language from a model card."""
  plain = _plain_text(text)
  if not plain:
    return None
  for pattern in _STRENGTH_PATTERNS:
    match = pattern.search(plain)
    if not match:
      continue
    recommendation = _make_strength(
      float(match.group("low")),
      float(match.group("high")) if match.group("high") else None,
      source,
    )
    if recommendation:
      return recommendation
  return None


def extract_recommended_strength(data: dict[str, Any]) -> dict[str, Any] | None:
  """Prefer explicit recommendations, then matching Civitai example-image weights."""
  model = data.get("model") if isinstance(data.get("model"), dict) else {}
  for description in (data.get("description"), model.get("description")):
    recommendation = extract_recommended_strength_from_text(
      description,
      "Civitai description",
    )
    if recommendation:
      return recommendation

  version_id = _as_int(data.get("id"))
  sample_weights: list[float] = []
  for image in data.get("images") or []:
    if not isinstance(image, dict):
      continue
    meta = image.get("meta")
    if not isinstance(meta, dict):
      continue
    resources = []
    for key in ("resources", "civitaiResources"):
      if isinstance(meta.get(key), list):
        resources.extend(meta[key])
    for resource in resources:
      if not isinstance(resource, dict):
        continue
      if str(resource.get("type", "")).lower() != "lora":
        continue
      resource_version_id = _as_int(resource.get("modelVersionId"))
      if version_id is not None and resource_version_id != version_id:
        continue
      weight = _as_float(resource.get("weight"))
      if weight is not None:
        sample_weights.append(weight)

  if sample_weights:
    return _make_strength(
      min(sample_weights),
      max(sample_weights),
      "Civitai preview weight",
    )
  return None


def extract_triggers(data: dict[str, Any], limit: int = 50) -> list[str]:
  raw_words = data.get("trainedWords")
  if not isinstance(raw_words, list):
    raw_words = data.get("triggerWords")
  if not isinstance(raw_words, list):
    return []

  triggers: list[str] = []
  seen: set[str] = set()
  for raw_word in raw_words:
    if isinstance(raw_word, dict):
      raw_word = raw_word.get("word")
    if not isinstance(raw_word, str):
      continue
    text = html.unescape(raw_word).replace("\r", "\n")
    for part in re.split(r"\s*,\s*|\n+", text):
      word = " ".join(part.split()).strip()
      key = word.casefold()
      if not word or key in seen:
        continue
      seen.add(key)
      triggers.append(word)
      if len(triggers) >= limit:
        return triggers
  return triggers


def normalize_civitai_model_version(
  data: dict[str, Any],
  file: str,
  sha256: str,
) -> dict[str, Any]:
  model = data.get("model") if isinstance(data.get("model"), dict) else {}
  model_name = str(model.get("name") or "").strip()
  version_name = str(data.get("name") or "").strip()
  name = " - ".join(part for part in (model_name, version_name) if part)

  model_id = _as_int(data.get("modelId"))
  version_id = _as_int(data.get("id"))
  url = None
  if model_id is not None:
    url = f"https://civitai.com/models/{model_id}"
    if version_id is not None:
      url += f"?modelVersionId={version_id}"

  return {
    "file": file,
    "name": name or file,
    "url": url,
    "sha256": sha256,
    "baseModel": data.get("baseModel"),
    "recommendedStrength": extract_recommended_strength(data),
    "triggers": extract_triggers(data),
    "modelId": model_id,
    "modelVersionId": version_id,
  }


def error_message_for_status(status: int) -> str:
  if status == 404:
    return "Civitai did not find this model; the local LoRA SHA256 does not match a public model version."
  if status in (401, 403):
    return "Civitai requires login or an API key, so this model cannot be read."
  if status == 429:
    return "Civitai is receiving too many requests. Try again later."
  if status >= 500:
    return f"Civitai is temporarily unavailable (HTTP {status})."
  return f"Civitai returned HTTP {status}."


def _as_int(value: Any) -> int | None:
  try:
    return int(value)
  except (TypeError, ValueError):
    return None


def _as_float(value: Any) -> float | None:
  try:
    number = float(value)
  except (TypeError, ValueError):
    return None
  return number if math.isfinite(number) else None
