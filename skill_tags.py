from __future__ import annotations

import copy
import json
import os
import re
import shutil
import threading
import uuid
from typing import Any

try:
  from .prompt_library import default_data_directory
except ImportError:
  from prompt_library import default_data_directory


STATE_VERSION = 2
DEFAULTS_VERSION = 3
MAX_CATEGORIES = 100
MAX_SUBCATEGORIES = 500
MAX_TAGS = 2000
MAX_NAME_LENGTH = 80
MAX_SKILL_ID_LENGTH = 2000
LEGACY_DEFAULT_CATEGORY_NAME = "通用"
BUILTIN_CLOTHING_CATEGORY_ID = uuid.uuid5(
  uuid.NAMESPACE_URL,
  "https://astral.local/comfyui-assets/skill-tags/category/clothing",
).hex
TAG_COLORS = (
  "#69a8dc",
  "#72c29a",
  "#d7b45f",
  "#de8875",
  "#b28ad8",
  "#69c5c1",
  "#9eacbd",
)
DEFAULT_SKILL_TAG_GROUPS = (
  (
    "character",
    "人物",
    TAG_COLORS[0],
    (
      "单人",
      "女人",
      "男人",
      "公主",
      "女仆",
      "舞者",
      "长发",
      "双马尾",
      "异色瞳",
      "微笑",
      "全身",
      "半身像",
    ),
  ),
  (
    "scene",
    "场景",
    TAG_COLORS[1],
    (
      "大海",
      "森林",
      "星空",
      "落日",
      "公园",
      "咖啡厅",
      "城市风景",
      "街道",
      "建筑",
      "在房间内",
      "单色背景",
      "埃菲尔铁塔",
    ),
  ),
  (
    "clothing",
    "服饰",
    TAG_COLORS[2],
    (
      "连衣裙",
      "衬衫",
      "牛仔裤",
      "裙子",
      "运动套装",
      "校服",
      "水手服",
      "女仆装",
      "旗袍",
      "汉服",
      "和服",
      "洛丽塔风格",
    ),
  ),
  (
    "props",
    "道具",
    TAG_COLORS[3],
    (
      "翅膀",
      "天使翅膀",
      "恶魔翅膀",
      "蝴蝶翅膀",
      "尾巴",
      "猫尾",
      "狐狸尾",
      "猫耳",
      "兔耳",
      "恶魔之角",
      "龙之角",
      "机械角",
    ),
  ),
)
DEFAULT_SUBCATEGORY_GROUPS = {
  "character": (
    "数量",
    "性别",
    "年龄",
    "肤色",
    "身材",
    "发型",
    "表情",
    "动作",
  ),
  "clothing": (
    "上衣",
    "裤子",
    "套装",
    "鞋",
    "饰品",
  ),
  "scene": (
    "天气",
    "时间",
    "光照",
    "镜头视角",
    "地点",
  ),
  "props": (),
}
RETIRED_DEFAULT_SUBCATEGORIES = (
  ("clothing", "男装"),
  ("clothing", "女装"),
)
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
_LOCK = threading.RLock()


class SkillTagDataError(ValueError):
  pass


def _builtin_subcategory_id(group_key: str, name: str) -> str:
  return uuid.uuid5(
    uuid.NAMESPACE_URL,
    (
      "https://astral.local/comfyui-assets/skill-tags/subcategory/"
      f"{group_key}/{name}"
    ),
  ).hex


def _state_path(data_directory: str) -> str:
  directory = os.path.abspath(str(data_directory))
  os.makedirs(directory, exist_ok=True)
  return os.path.join(directory, "skill-tags.json")


def _default_state() -> dict[str, Any]:
  categories: list[dict[str, Any]] = []
  subcategories: list[dict[str, Any]] = []
  tags: list[dict[str, Any]] = []
  for category_index, (key, name, color, tag_names) in enumerate(
    DEFAULT_SKILL_TAG_GROUPS
  ):
    category_id = uuid.uuid5(
      uuid.NAMESPACE_URL,
      f"https://astral.local/comfyui-assets/skill-tags/category/{key}",
    ).hex
    categories.append(
      {
        "id": category_id,
        "name": name,
        "order": category_index,
      }
    )
    for subcategory_index, subcategory_name in enumerate(
      DEFAULT_SUBCATEGORY_GROUPS[key]
    ):
      subcategories.append(
        {
          "id": _builtin_subcategory_id(key, subcategory_name),
          "categoryId": category_id,
          "name": subcategory_name,
          "order": subcategory_index,
        }
      )
    for tag_name in tag_names:
      tags.append(
        {
          "id": uuid.uuid5(
            uuid.NAMESPACE_URL,
            (
              "https://astral.local/comfyui-assets/skill-tags/tag/"
              f"{key}/{tag_name}"
            ),
          ).hex,
          "name": tag_name,
          "categoryId": category_id,
          "subcategoryId": "",
          "color": color,
          "favorite": False,
          "order": len(tags),
        }
      )
  return {
    "version": STATE_VERSION,
    "defaultsVersion": DEFAULTS_VERSION,
    "categories": categories,
    "subcategories": subcategories,
    "tags": tags,
    "assignments": {},
  }


def _read_state_file(path: str) -> dict[str, Any]:
  if not os.path.isfile(path):
    return _default_state()
  candidates = (path, f"{path}.bak")
  last_error: Exception | None = None
  for candidate in candidates:
    if not os.path.isfile(candidate):
      continue
    try:
      with open(candidate, "r", encoding="utf-8-sig") as source:
        payload = json.load(source)
      if not isinstance(payload, dict):
        raise SkillTagDataError("Skill 标签数据格式错误")
      return payload
    except (OSError, json.JSONDecodeError, UnicodeDecodeError) as error:
      last_error = error
  raise SkillTagDataError(
    f"无法读取 Skill 标签数据：{os.path.basename(path)}"
  ) from last_error


def _atomic_write_state(path: str, payload: dict[str, Any]) -> None:
  directory = os.path.dirname(path)
  temporary = os.path.join(
    directory,
    f".{os.path.basename(path)}.{uuid.uuid4().hex}.tmp",
  )
  try:
    with open(temporary, "w", encoding="utf-8", newline="\n") as target:
      json.dump(payload, target, ensure_ascii=False, indent=2)
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


def _clean_name(value: Any, field: str = "名称") -> str:
  name = str(value or "").strip()
  if not name:
    raise SkillTagDataError(f"{field}不能为空")
  if len(name) > MAX_NAME_LENGTH:
    raise SkillTagDataError(f"{field}不能超过 {MAX_NAME_LENGTH} 个字符")
  if "\x00" in name:
    raise SkillTagDataError(f"{field}包含无效字符")
  return name


def _clean_color(value: Any, fallback: str = TAG_COLORS[0]) -> str:
  color = str(value or fallback).strip()
  if not _COLOR_RE.fullmatch(color):
    raise SkillTagDataError("标签颜色必须是 #RRGGBB 格式")
  return color.casefold()


def _clean_skill_id(value: Any) -> str:
  skill_id = str(value or "").replace("\\", "/").strip("/")
  if not skill_id:
    raise SkillTagDataError("Skill ID 不能为空")
  if len(skill_id) > MAX_SKILL_ID_LENGTH or "\x00" in skill_id:
    raise SkillTagDataError("Skill ID 格式错误")
  return skill_id


def _unique_name(
  records: list[dict[str, Any]],
  name: str,
  *,
  exclude_id: str = "",
) -> None:
  key = name.casefold()
  if any(
    item.get("id") != exclude_id
    and str(item.get("name", "")).casefold() == key
    for item in records
  ):
    raise SkillTagDataError(f"“{name}”已存在")


def _defaults_version(payload: dict[str, Any]) -> int:
  try:
    return int(payload.get("defaultsVersion") or 0)
  except (TypeError, ValueError):
    return 0


def _is_legacy_empty_default(state: dict[str, Any]) -> bool:
  categories = state["categories"]
  return (
    len(categories) == 1
    and categories[0]["name"] == LEGACY_DEFAULT_CATEGORY_NAME
    and not state["tags"]
    and not state["assignments"]
  )


def _add_missing_builtin_defaults(state: dict[str, Any]) -> None:
  defaults = _default_state()
  categories = state["categories"]
  subcategories = state["subcategories"]
  tags = state["tags"]
  category_by_id = {str(item["id"]): item for item in categories}
  category_by_name = {
    str(item["name"]).casefold(): item for item in categories
  }

  for default_category in defaults["categories"]:
    category = category_by_id.get(default_category["id"])
    if category is None:
      category = category_by_name.get(default_category["name"].casefold())
    if category is None:
      category = copy.deepcopy(default_category)
      category["order"] = len(categories)
      categories.append(category)
      category_by_id[category["id"]] = category
      category_by_name[category["name"].casefold()] = category

    default_subcategory_ids: dict[str, str] = {}
    existing_subcategory_by_name = {
      str(item["name"]).casefold(): item
      for item in subcategories
      if item["categoryId"] == category["id"]
    }
    for default_subcategory in defaults["subcategories"]:
      if default_subcategory["categoryId"] != default_category["id"]:
        continue
      subcategory = existing_subcategory_by_name.get(
        default_subcategory["name"].casefold()
      )
      if subcategory is None:
        subcategory = copy.deepcopy(default_subcategory)
        subcategory["categoryId"] = category["id"]
        subcategory["order"] = len(subcategories)
        subcategories.append(subcategory)
        existing_subcategory_by_name[
          subcategory["name"].casefold()
        ] = subcategory
      default_subcategory_ids[default_subcategory["id"]] = subcategory["id"]

    existing_tag_names = {
      str(item["name"]).casefold()
      for item in tags
      if item["categoryId"] == category["id"]
    }
    for default_tag in defaults["tags"]:
      if default_tag["categoryId"] != default_category["id"]:
        continue
      if default_tag["name"].casefold() in existing_tag_names:
        continue
      tag = copy.deepcopy(default_tag)
      tag["categoryId"] = category["id"]
      tag["subcategoryId"] = default_subcategory_ids.get(
        default_tag.get("subcategoryId"),
        "",
      )
      tag["order"] = len(tags)
      tags.append(tag)
      existing_tag_names.add(tag["name"].casefold())


def _normalize_state(payload: dict[str, Any]) -> dict[str, Any]:
  payload_defaults_version = _defaults_version(payload)
  categories_raw = payload.get("categories")
  subcategories_raw = payload.get("subcategories")
  tags_raw = payload.get("tags")
  assignments_raw = payload.get("assignments")
  categories: list[dict[str, Any]] = []
  category_ids: set[str] = set()
  category_names: set[str] = set()
  for raw in categories_raw if isinstance(categories_raw, list) else []:
    if not isinstance(raw, dict):
      continue
    category_id = str(raw.get("id") or "").strip()
    try:
      name = _clean_name(raw.get("name"), "分类名称")
    except SkillTagDataError:
      continue
    name_key = name.casefold()
    if (
      not category_id
      or category_id in category_ids
      or name_key in category_names
    ):
      continue
    category_ids.add(category_id)
    category_names.add(name_key)
    categories.append(
      {
        "id": category_id,
        "name": name,
        "order": len(categories),
      }
    )
  if not categories:
    defaults = _default_state()
    categories = defaults["categories"]
    category_ids = {item["id"] for item in categories}

  if payload_defaults_version < DEFAULTS_VERSION:
    clothing_category = next(
      (
        item
        for item in categories
        if item["id"] == BUILTIN_CLOTHING_CATEGORY_ID
        and item["name"] == "服装"
      ),
      None,
    )
    if clothing_category is not None and not any(
      item["name"].casefold() == "服饰".casefold()
      for item in categories
      if item["id"] != clothing_category["id"]
    ):
      clothing_category["name"] = "服饰"
      category_names = {
        str(item["name"]).casefold() for item in categories
      }

  subcategories: list[dict[str, Any]] = []
  subcategory_ids: set[str] = set()
  subcategory_names_by_category: set[tuple[str, str]] = set()
  subcategory_parent_by_id: dict[str, str] = {}
  for raw in subcategories_raw if isinstance(subcategories_raw, list) else []:
    if not isinstance(raw, dict):
      continue
    subcategory_id = str(raw.get("id") or "").strip()
    category_id = str(raw.get("categoryId") or "").strip()
    if (
      not subcategory_id
      or subcategory_id in subcategory_ids
      or category_id not in category_ids
    ):
      continue
    try:
      name = _clean_name(raw.get("name"), "二级分类名称")
    except SkillTagDataError:
      continue
    name_key = (category_id, name.casefold())
    if name_key in subcategory_names_by_category:
      continue
    subcategory_ids.add(subcategory_id)
    subcategory_names_by_category.add(name_key)
    subcategory_parent_by_id[subcategory_id] = category_id
    subcategories.append(
      {
        "id": subcategory_id,
        "categoryId": category_id,
        "name": name,
        "order": len(subcategories),
      }
    )

  if payload_defaults_version < DEFAULTS_VERSION:
    retired_ids = {
      _builtin_subcategory_id(group_key, name)
      for group_key, name in RETIRED_DEFAULT_SUBCATEGORIES
    }
    removed_ids = {
      item["id"]
      for item in subcategories
      if item["id"] in retired_ids
      and item["categoryId"] == BUILTIN_CLOTHING_CATEGORY_ID
    }
    if removed_ids:
      subcategories = [
        item for item in subcategories if item["id"] not in removed_ids
      ]
      for index, item in enumerate(subcategories):
        item["order"] = index
      subcategory_ids.difference_update(removed_ids)
      subcategory_names_by_category = {
        (item["categoryId"], item["name"].casefold())
        for item in subcategories
      }
      for subcategory_id in removed_ids:
        subcategory_parent_by_id.pop(subcategory_id, None)

  tags: list[dict[str, Any]] = []
  tag_ids: set[str] = set()
  names_by_category: set[tuple[str, str]] = set()
  for raw in tags_raw if isinstance(tags_raw, list) else []:
    if not isinstance(raw, dict):
      continue
    tag_id = str(raw.get("id") or "").strip()
    category_id = str(raw.get("categoryId") or "").strip()
    if not tag_id or tag_id in tag_ids or category_id not in category_ids:
      continue
    try:
      name = _clean_name(raw.get("name"), "标签名称")
      color = _clean_color(raw.get("color"))
    except SkillTagDataError:
      continue
    name_key = (category_id, name.casefold())
    if name_key in names_by_category:
      continue
    subcategory_id = str(raw.get("subcategoryId") or "").strip()
    if subcategory_parent_by_id.get(subcategory_id) != category_id:
      subcategory_id = ""
    tag_ids.add(tag_id)
    names_by_category.add(name_key)
    tags.append(
      {
        "id": tag_id,
        "name": name,
        "categoryId": category_id,
        "subcategoryId": subcategory_id,
        "color": color,
        "favorite": bool(raw.get("favorite")),
        "order": len(tags),
      }
    )

  assignments: dict[str, list[str]] = {}
  if isinstance(assignments_raw, dict):
    for raw_skill_id, raw_tag_ids in assignments_raw.items():
      try:
        skill_id = _clean_skill_id(raw_skill_id)
      except SkillTagDataError:
        continue
      selected: list[str] = []
      seen: set[str] = set()
      for raw_tag_id in raw_tag_ids if isinstance(raw_tag_ids, list) else []:
        tag_id = str(raw_tag_id or "").strip()
        if tag_id in tag_ids and tag_id not in seen:
          seen.add(tag_id)
          selected.append(tag_id)
      if selected:
        assignments[skill_id] = selected

  state = {
    "version": STATE_VERSION,
    "defaultsVersion": DEFAULTS_VERSION,
    "categories": categories,
    "subcategories": subcategories,
    "tags": tags,
    "assignments": assignments,
  }
  if payload_defaults_version < DEFAULTS_VERSION:
    if _is_legacy_empty_default(state):
      defaults = _default_state()
      state["categories"] = defaults["categories"]
      state["subcategories"] = defaults["subcategories"]
      state["tags"] = defaults["tags"]
    else:
      _add_missing_builtin_defaults(state)
  return state


def _load_state_unlocked(path: str) -> dict[str, Any]:
  return _normalize_state(_read_state_file(path))


def _save_state_unlocked(path: str, state: dict[str, Any]) -> None:
  normalized = _normalize_state(state)
  _atomic_write_state(path, normalized)


def get_skill_tag_state(data_directory: str) -> dict[str, Any]:
  path = _state_path(data_directory)
  with _LOCK:
    state = _load_state_unlocked(path)
    if (
      not os.path.isfile(path)
      or _defaults_version(_read_state_file(path)) < DEFAULTS_VERSION
    ):
      _save_state_unlocked(path, state)
    return copy.deepcopy(state)


def create_tag_category(data_directory: str, name: Any) -> dict[str, Any]:
  path = _state_path(data_directory)
  clean_name = _clean_name(name, "分类名称")
  with _LOCK:
    state = _load_state_unlocked(path)
    categories = state["categories"]
    if len(categories) >= MAX_CATEGORIES:
      raise SkillTagDataError(f"最多创建 {MAX_CATEGORIES} 个标签分类")
    _unique_name(categories, clean_name)
    category = {
      "id": uuid.uuid4().hex,
      "name": clean_name,
      "order": len(categories),
    }
    categories.append(category)
    _save_state_unlocked(path, state)
    return {"category": copy.deepcopy(category), **state}


def rename_tag_category(
  data_directory: str,
  category_id: Any,
  name: Any,
) -> dict[str, Any]:
  path = _state_path(data_directory)
  requested_id = str(category_id or "").strip()
  clean_name = _clean_name(name, "分类名称")
  with _LOCK:
    state = _load_state_unlocked(path)
    categories = state["categories"]
    category = next(
      (item for item in categories if item["id"] == requested_id),
      None,
    )
    if category is None:
      raise FileNotFoundError("标签分类不存在")
    _unique_name(categories, clean_name, exclude_id=requested_id)
    category["name"] = clean_name
    _save_state_unlocked(path, state)
    return copy.deepcopy(state)


def delete_tag_category(
  data_directory: str,
  category_id: Any,
) -> dict[str, Any]:
  path = _state_path(data_directory)
  requested_id = str(category_id or "").strip()
  with _LOCK:
    state = _load_state_unlocked(path)
    categories = state["categories"]
    if not any(item["id"] == requested_id for item in categories):
      raise FileNotFoundError("标签分类不存在")
    if len(categories) <= 1:
      raise SkillTagDataError("至少需要保留一个标签分类")
    removed_tag_ids = {
      item["id"]
      for item in state["tags"]
      if item["categoryId"] == requested_id
    }
    state["categories"] = [
      item for item in categories if item["id"] != requested_id
    ]
    state["subcategories"] = [
      item
      for item in state["subcategories"]
      if item["categoryId"] != requested_id
    ]
    state["tags"] = [
      item for item in state["tags"] if item["categoryId"] != requested_id
    ]
    assignments = {}
    for skill_id, tag_ids in state["assignments"].items():
      remaining = [
        tag_id for tag_id in tag_ids if tag_id not in removed_tag_ids
      ]
      if remaining:
        assignments[skill_id] = remaining
    state["assignments"] = assignments
    for index, item in enumerate(state["categories"]):
      item["order"] = index
    for index, item in enumerate(state["subcategories"]):
      item["order"] = index
    for index, item in enumerate(state["tags"]):
      item["order"] = index
    _save_state_unlocked(path, state)
    return copy.deepcopy(state)


def create_tag_subcategory(
  data_directory: str,
  *,
  category_id: Any,
  name: Any,
) -> dict[str, Any]:
  path = _state_path(data_directory)
  requested_category_id = str(category_id or "").strip()
  clean_name = _clean_name(name, "二级分类名称")
  with _LOCK:
    state = _load_state_unlocked(path)
    if not any(
      item["id"] == requested_category_id for item in state["categories"]
    ):
      raise FileNotFoundError("标签分类不存在")
    if len(state["subcategories"]) >= MAX_SUBCATEGORIES:
      raise SkillTagDataError(
        f"最多创建 {MAX_SUBCATEGORIES} 个二级分类"
      )
    siblings = [
      item
      for item in state["subcategories"]
      if item["categoryId"] == requested_category_id
    ]
    _unique_name(siblings, clean_name)
    subcategory = {
      "id": uuid.uuid4().hex,
      "categoryId": requested_category_id,
      "name": clean_name,
      "order": len(state["subcategories"]),
    }
    state["subcategories"].append(subcategory)
    _save_state_unlocked(path, state)
    return {"subcategory": copy.deepcopy(subcategory), **state}


def rename_tag_subcategory(
  data_directory: str,
  subcategory_id: Any,
  name: Any,
) -> dict[str, Any]:
  path = _state_path(data_directory)
  requested_id = str(subcategory_id or "").strip()
  clean_name = _clean_name(name, "二级分类名称")
  with _LOCK:
    state = _load_state_unlocked(path)
    subcategory = next(
      (
        item
        for item in state["subcategories"]
        if item["id"] == requested_id
      ),
      None,
    )
    if subcategory is None:
      raise FileNotFoundError("二级分类不存在")
    siblings = [
      item
      for item in state["subcategories"]
      if item["categoryId"] == subcategory["categoryId"]
      and item["id"] != requested_id
    ]
    _unique_name(siblings, clean_name)
    subcategory["name"] = clean_name
    _save_state_unlocked(path, state)
    return copy.deepcopy(state)


def delete_tag_subcategory(
  data_directory: str,
  subcategory_id: Any,
) -> dict[str, Any]:
  path = _state_path(data_directory)
  requested_id = str(subcategory_id or "").strip()
  with _LOCK:
    state = _load_state_unlocked(path)
    if not any(
      item["id"] == requested_id for item in state["subcategories"]
    ):
      raise FileNotFoundError("二级分类不存在")
    state["subcategories"] = [
      item
      for item in state["subcategories"]
      if item["id"] != requested_id
    ]
    for tag in state["tags"]:
      if tag.get("subcategoryId") == requested_id:
        tag["subcategoryId"] = ""
    for index, item in enumerate(state["subcategories"]):
      item["order"] = index
    _save_state_unlocked(path, state)
    return copy.deepcopy(state)


def create_skill_tag(
  data_directory: str,
  *,
  name: Any,
  category_id: Any,
  subcategory_id: Any = "",
  color: Any = "",
  favorite: Any = False,
) -> dict[str, Any]:
  path = _state_path(data_directory)
  clean_name = _clean_name(name, "标签名称")
  requested_category_id = str(category_id or "").strip()
  clean_color = _clean_color(color or TAG_COLORS[0])
  with _LOCK:
    state = _load_state_unlocked(path)
    if not any(
      item["id"] == requested_category_id for item in state["categories"]
    ):
      raise FileNotFoundError("标签分类不存在")
    if len(state["tags"]) >= MAX_TAGS:
      raise SkillTagDataError(f"最多创建 {MAX_TAGS} 个标签")
    requested_subcategory_id = str(subcategory_id or "").strip()
    if requested_subcategory_id and not any(
      item["id"] == requested_subcategory_id
      and item["categoryId"] == requested_category_id
      for item in state["subcategories"]
    ):
      raise FileNotFoundError("标签二级分类不存在")
    siblings = [
      item for item in state["tags"] if item["categoryId"] == requested_category_id
    ]
    _unique_name(siblings, clean_name)
    tag = {
      "id": uuid.uuid4().hex,
      "name": clean_name,
      "categoryId": requested_category_id,
      "subcategoryId": requested_subcategory_id,
      "color": clean_color,
      "favorite": bool(favorite),
      "order": len(state["tags"]),
    }
    state["tags"].append(tag)
    _save_state_unlocked(path, state)
    return {"tag": copy.deepcopy(tag), **state}


def create_skill_tags(
  data_directory: str,
  *,
  names: Any,
  category_id: Any,
  subcategory_id: Any = "",
  color: Any = "",
) -> dict[str, Any]:
  if not isinstance(names, list):
    raise SkillTagDataError("批量标签名称必须是列表")
  path = _state_path(data_directory)
  requested_category_id = str(category_id or "").strip()
  requested_subcategory_id = str(subcategory_id or "").strip()
  with _LOCK:
    state_file_existed = os.path.isfile(path)
    stored_defaults_version = (
      _defaults_version(_read_state_file(path))
      if state_file_existed
      else 0
    )
    state = _load_state_unlocked(path)
    category_index = next(
      (
        index
        for index, item in enumerate(state["categories"])
        if item["id"] == requested_category_id
      ),
      None,
    )
    if category_index is None:
      raise FileNotFoundError("标签分类不存在")
    if requested_subcategory_id and not any(
      item["id"] == requested_subcategory_id
      and item["categoryId"] == requested_category_id
      for item in state["subcategories"]
    ):
      raise FileNotFoundError("标签二级分类不存在")

    category_tags = [
      item
      for item in state["tags"]
      if item["categoryId"] == requested_category_id
    ]
    clean_color = _clean_color(
      color
      or (
        category_tags[0]["color"]
        if category_tags
        else TAG_COLORS[category_index % len(TAG_COLORS)]
      )
    )
    existing_names = {
      str(item["name"]).casefold() for item in category_tags
    }
    requested_names: set[str] = set()
    created_tags: list[dict[str, Any]] = []
    skipped_duplicates = 0
    warnings: list[str] = []

    for position, raw_name in enumerate(names, start=1):
      try:
        clean_name = _clean_name(raw_name, "标签名称")
      except SkillTagDataError as error:
        warnings.append(f"第 {position} 项：{error}，已跳过。")
        continue
      name_key = clean_name.casefold()
      if name_key in existing_names or name_key in requested_names:
        skipped_duplicates += 1
        continue
      if len(state["tags"]) + len(created_tags) >= MAX_TAGS:
        warnings.append(
          f"最多只能有 {MAX_TAGS} 个标签，其余标签未创建。"
        )
        break
      tag = {
        "id": uuid.uuid4().hex,
        "name": clean_name,
        "categoryId": requested_category_id,
        "subcategoryId": requested_subcategory_id,
        "color": clean_color,
        "favorite": False,
        "order": len(state["tags"]) + len(created_tags),
      }
      created_tags.append(tag)
      requested_names.add(name_key)

    state["tags"].extend(created_tags)
    if (
      created_tags
      or not state_file_existed
      or stored_defaults_version < DEFAULTS_VERSION
    ):
      _save_state_unlocked(path, state)
    return {
      "createdTags": copy.deepcopy(created_tags),
      "createdCount": len(created_tags),
      "skippedDuplicates": skipped_duplicates,
      "warnings": warnings,
      **copy.deepcopy(state),
    }


def _clean_tag_id_list(tag_ids: Any) -> list[str]:
  if not isinstance(tag_ids, list):
    raise SkillTagDataError("标签 ID 必须是列表")
  cleaned: list[str] = []
  seen: set[str] = set()
  for raw_tag_id in tag_ids:
    tag_id = str(raw_tag_id or "").strip()
    if tag_id and tag_id not in seen:
      seen.add(tag_id)
      cleaned.append(tag_id)
  if not cleaned:
    raise SkillTagDataError("请至少选择一个标签")
  return cleaned


def delete_skill_tags(data_directory: str, tag_ids: Any) -> dict[str, Any]:
  path = _state_path(data_directory)
  requested_ids = _clean_tag_id_list(tag_ids)
  requested_set = set(requested_ids)
  with _LOCK:
    state = _load_state_unlocked(path)
    available_ids = {item["id"] for item in state["tags"]}
    deleted_ids = [
      tag_id for tag_id in requested_ids if tag_id in available_ids
    ]
    deleted_set = set(deleted_ids)
    if deleted_ids:
      state["tags"] = [
        item for item in state["tags"] if item["id"] not in deleted_set
      ]
      assignments: dict[str, list[str]] = {}
      for skill_id, assigned_ids in state["assignments"].items():
        remaining = [
          tag_id for tag_id in assigned_ids if tag_id not in deleted_set
        ]
        if remaining:
          assignments[skill_id] = remaining
      state["assignments"] = assignments
      for index, item in enumerate(state["tags"]):
        item["order"] = index
      _save_state_unlocked(path, state)
    return {
      "deletedIds": deleted_ids,
      "deletedCount": len(deleted_ids),
      "missingCount": len(requested_set - available_ids),
      **copy.deepcopy(state),
    }


def move_skill_tags(
  data_directory: str,
  tag_ids: Any,
  *,
  category_id: Any,
  subcategory_id: Any = "",
) -> dict[str, Any]:
  path = _state_path(data_directory)
  requested_ids = _clean_tag_id_list(tag_ids)
  requested_set = set(requested_ids)
  requested_category_id = str(category_id or "").strip()
  requested_subcategory_id = str(subcategory_id or "").strip()
  with _LOCK:
    state = _load_state_unlocked(path)
    target_category = next(
      (
        item
        for item in state["categories"]
        if item["id"] == requested_category_id
      ),
      None,
    )
    if target_category is None:
      raise FileNotFoundError("目标标签分类不存在")
    target_subcategory = None
    if requested_subcategory_id:
      target_subcategory = next(
        (
          item
          for item in state["subcategories"]
          if item["id"] == requested_subcategory_id
          and item["categoryId"] == requested_category_id
        ),
        None,
      )
      if target_subcategory is None:
        raise FileNotFoundError("目标标签二级分类不存在")

    available_ids = {item["id"] for item in state["tags"]}
    missing_count = len(requested_set - available_ids)
    target_names = {
      str(item["name"]).casefold()
      for item in state["tags"]
      if item["categoryId"] == requested_category_id
      and item["id"] not in requested_set
    }
    moved_ids: list[str] = []
    skipped_names: list[str] = []
    for tag in state["tags"]:
      if tag["id"] not in requested_set:
        continue
      name_key = str(tag["name"]).casefold()
      if name_key in target_names:
        skipped_names.append(str(tag["name"]))
        continue
      tag["categoryId"] = requested_category_id
      tag["subcategoryId"] = requested_subcategory_id
      target_names.add(name_key)
      moved_ids.append(tag["id"])

    if moved_ids:
      _save_state_unlocked(path, state)
    return {
      "movedIds": moved_ids,
      "movedCount": len(moved_ids),
      "skippedDuplicates": len(skipped_names),
      "skippedNames": skipped_names,
      "missingCount": missing_count,
      "targetCategory": copy.deepcopy(target_category),
      "targetSubcategory": copy.deepcopy(target_subcategory),
      **copy.deepcopy(state),
    }


def update_skill_tag(
  data_directory: str,
  tag_id: Any,
  changes: dict[str, Any],
) -> dict[str, Any]:
  path = _state_path(data_directory)
  requested_id = str(tag_id or "").strip()
  if not isinstance(changes, dict):
    raise SkillTagDataError("标签更新参数格式错误")
  with _LOCK:
    state = _load_state_unlocked(path)
    tag = next(
      (item for item in state["tags"] if item["id"] == requested_id),
      None,
    )
    if tag is None:
      raise FileNotFoundError("标签不存在")
    category_id = str(changes.get("categoryId") or tag["categoryId"]).strip()
    if not any(item["id"] == category_id for item in state["categories"]):
      raise FileNotFoundError("标签分类不存在")
    if "subcategoryId" in changes:
      subcategory_id = str(changes.get("subcategoryId") or "").strip()
    else:
      subcategory_id = str(tag.get("subcategoryId") or "").strip()
      if not any(
        item["id"] == subcategory_id and item["categoryId"] == category_id
        for item in state["subcategories"]
      ):
        subcategory_id = ""
    if subcategory_id and not any(
      item["id"] == subcategory_id and item["categoryId"] == category_id
      for item in state["subcategories"]
    ):
      raise FileNotFoundError("标签二级分类不存在")
    name = (
      _clean_name(changes.get("name"), "标签名称")
      if "name" in changes
      else tag["name"]
    )
    siblings = [
      item
      for item in state["tags"]
      if item["categoryId"] == category_id and item["id"] != requested_id
    ]
    _unique_name(siblings, name)
    tag["name"] = name
    tag["categoryId"] = category_id
    tag["subcategoryId"] = subcategory_id
    if "color" in changes:
      tag["color"] = _clean_color(changes.get("color"), tag["color"])
    if "favorite" in changes:
      tag["favorite"] = bool(changes.get("favorite"))
    _save_state_unlocked(path, state)
    return copy.deepcopy(state)


def delete_skill_tag(data_directory: str, tag_id: Any) -> dict[str, Any]:
  path = _state_path(data_directory)
  requested_id = str(tag_id or "").strip()
  with _LOCK:
    state = _load_state_unlocked(path)
    if not any(item["id"] == requested_id for item in state["tags"]):
      raise FileNotFoundError("标签不存在")
    state["tags"] = [
      item for item in state["tags"] if item["id"] != requested_id
    ]
    assignments = {}
    for skill_id, tag_ids in state["assignments"].items():
      remaining = [item for item in tag_ids if item != requested_id]
      if remaining:
        assignments[skill_id] = remaining
    state["assignments"] = assignments
    for index, item in enumerate(state["tags"]):
      item["order"] = index
    _save_state_unlocked(path, state)
    return copy.deepcopy(state)


def assign_skill_tags(
  data_directory: str,
  skill_id: Any,
  tag_ids: Any,
) -> dict[str, Any]:
  path = _state_path(data_directory)
  clean_skill_id = _clean_skill_id(skill_id)
  if not isinstance(tag_ids, list):
    raise SkillTagDataError("Skill 标签必须是数组")
  with _LOCK:
    state = _load_state_unlocked(path)
    available_ids = {item["id"] for item in state["tags"]}
    selected: list[str] = []
    for raw_tag_id in tag_ids:
      tag_id = str(raw_tag_id or "").strip()
      if tag_id and tag_id not in available_ids:
        raise FileNotFoundError("要分配的标签不存在")
      if tag_id and tag_id not in selected:
        selected.append(tag_id)
    if selected:
      state["assignments"][clean_skill_id] = selected
    else:
      state["assignments"].pop(clean_skill_id, None)
    _save_state_unlocked(path, state)
    return copy.deepcopy(state)


def reorder_skill_tags(
  data_directory: str,
  kind: Any,
  ordered_ids: Any,
) -> dict[str, Any]:
  path = _state_path(data_directory)
  cleaned_kind = str(kind or "").strip().lower()
  if cleaned_kind not in {"categories", "subcategories", "tags"}:
    raise SkillTagDataError(
      "排序类型必须是 categories、subcategories 或 tags"
    )
  if not isinstance(ordered_ids, list):
    raise SkillTagDataError("排序 ID 必须是数组")
  requested_ids = [str(item or "").strip() for item in ordered_ids]
  with _LOCK:
    state = _load_state_unlocked(path)
    records = state[cleaned_kind]
    current_ids = [item["id"] for item in records]
    if len(requested_ids) != len(set(requested_ids)):
      raise SkillTagDataError("排序 ID 不能重复")
    if set(requested_ids) != set(current_ids):
      raise SkillTagDataError("排序必须包含当前全部条目")
    by_id = {item["id"]: item for item in records}
    state[cleaned_kind] = [by_id[item_id] for item_id in requested_ids]
    for index, item in enumerate(state[cleaned_kind]):
      item["order"] = index
    _save_state_unlocked(path, state)
    return copy.deepcopy(state)
