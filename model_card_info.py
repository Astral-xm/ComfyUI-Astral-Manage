from __future__ import annotations

import html
import json
import re
from typing import Any


_TRIGGER_LIST_SEPARATOR = re.compile(r"\s*(?:,|，|;|；|\n)\s*")
_TRIGGER_LABEL = re.compile(
  r"^\s*(?:[-*]\s*)?(?:\*\*|__)?\s*"
  r"(?:trigger[\s_-]*words?|trigger[\s_-]*phrases?|"
  r"trained[\s_-]*words?|instance[\s_-]*prompt|触发词|触发词组|实例提示词)"
  r"\s*(?:\*\*|__)?\s*(?::|：|=|为|是)\s*(.*?)\s*$",
  re.IGNORECASE,
)
_TRIGGER_LIST_HEADER = re.compile(
  r"^\s*(?:trigger[\s_-]*words?|trigger[\s_-]*phrases?|"
  r"trained[\s_-]*words?|instance[\s_-]*prompt|触发词|触发词组|实例提示词)"
  r"\s*(?:\*\*|__)?\s*:\s*$",
  re.IGNORECASE,
)
_TRIGGER_LIST_ITEM = re.compile(r"^\s*-\s+(.+?)\s*$")
_TRIGGER_TABLE = re.compile(
  r"^\s*\|\s*(?:trigger[\s_-]*words?|trigger[\s_-]*phrases?|"
  r"trained[\s_-]*words?|instance[\s_-]*prompt|触发词|触发词组|实例提示词)"
  r"\s*\|\s*(.*?)\s*\|",
  re.IGNORECASE,
)
_NO_TRIGGER_PATTERNS = (
  re.compile(
    r"\bno\s+(?:specific\s+)?trigger(?:\s+(?:word|words|phrase|phrases))?"
    r"\s+(?:is|are)\s+(?:needed|required)\b",
    re.IGNORECASE,
  ),
  re.compile(
    r"\b(?:does\s+not|doesn't)\s+(?:need|require)"
    r"(?:\s+any)?\s+trigger(?:\s+(?:word|words|phrase|phrases))?\b",
    re.IGNORECASE,
  ),
  re.compile(r"(?:无需|不需要|没有|无)(?:特定的)?触发词"),
)
_EMPTY_TRIGGER_VALUES = {
  "",
  "[]",
  "{}",
  "none",
  "null",
  "n/a",
  "na",
  "无",
  "空",
  "无需",
}


def _clean_trigger_text(value: str) -> str:
  text = html.unescape(str(value or "")).strip()
  text = text.strip("`'\"[](){} ")
  return " ".join(text.split())


def _trigger_values(value: Any):
  if value is None:
    return
  if isinstance(value, dict):
    for key in (
      "word",
      "words",
      "trigger",
      "triggers",
      "triggerWords",
      "trigger_words",
      "value",
      "text",
    ):
      if key in value:
        yield from _trigger_values(value[key])
    return
  if isinstance(value, (list, tuple, set)):
    for item in value:
      yield from _trigger_values(item)
    return
  if not isinstance(value, str):
    yield str(value)
    return

  text = value.strip()
  if not text:
    return
  if text[:1] in "[{":
    try:
      parsed = json.loads(text)
    except (TypeError, ValueError):
      parsed = None
    if parsed is not None and parsed != text:
      yield from _trigger_values(parsed)
      return
  for part in _TRIGGER_LIST_SEPARATOR.split(text):
    cleaned = _clean_trigger_text(part)
    if cleaned:
      yield cleaned


def normalize_trigger_words(value: Any, limit: int = 50) -> list[str]:
  triggers: list[str] = []
  seen: set[str] = set()
  for raw in _trigger_values(value):
    word = _clean_trigger_text(raw)
    key = word.casefold()
    if not word or key in _EMPTY_TRIGGER_VALUES or key in seen:
      continue
    seen.add(key)
    triggers.append(word)
    if len(triggers) >= limit:
      break
  return triggers


def _plain_model_card(value: Any) -> str:
  if not isinstance(value, str):
    return ""
  text = html.unescape(value)
  text = re.sub(r"(?i)<br\s*/?>", "\n", text)
  text = re.sub(r"(?i)</(?:p|div|li|h[1-6]|tr)>", "\n", text)
  text = re.sub(r"(?i)</t[dh]>", " | ", text)
  text = re.sub(r"<[^>]+>", " ", text)
  text = text.replace("\xa0", " ").replace("\r\n", "\n").replace("\r", "\n")
  lines = [" ".join(line.split()) for line in text.split("\n")]
  return "\n".join(line for line in lines if line)


def has_no_trigger_statement(text: str) -> bool:
  plain = _plain_model_card(text)
  return any(pattern.search(plain) for pattern in _NO_TRIGGER_PATTERNS)


def extract_trigger_words_from_model_card(
  text: Any,
  limit: int = 50,
) -> list[str]:
  """Read explicit trigger fields only; never treat model tags or titles as triggers."""
  plain = _plain_model_card(text)
  if not plain:
    return []

  values: list[str] = []
  lines = plain.splitlines()
  for index, line in enumerate(lines):
    match = _TRIGGER_LABEL.match(line) or _TRIGGER_TABLE.match(line)
    if match:
      value = match.group(1).strip()
      if value:
        values.append(value)
        continue

    if not _TRIGGER_LIST_HEADER.match(line):
      continue
    for item in lines[index + 1 :]:
      item_match = _TRIGGER_LIST_ITEM.match(item)
      if not item_match:
        break
      values.append(item_match.group(1))

  triggers = normalize_trigger_words(values, limit=limit)
  if triggers:
    return triggers
  return []
