import json
import shutil
import sys
import unittest
import uuid
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
  sys.path.insert(0, str(PACKAGE_ROOT))

import skill_tags


class SkillTagTests(unittest.TestCase):
  def setUp(self):
    self.temp_path = (
      PACKAGE_ROOT
      / ".asset-library-tests"
      / f"skill-tags-{uuid.uuid4().hex}"
    )

  def tearDown(self):
    shutil.rmtree(self.temp_path, ignore_errors=True)

  def _state_path(self) -> Path:
    return self.temp_path / "skill-tags.json"

  def _category_id(self, name: str) -> str:
    state = skill_tags.get_skill_tag_state(str(self.temp_path))
    return next(
      item["id"] for item in state["categories"] if item["name"] == name
    )

  def _default_category_id(self) -> str:
    return self._category_id("Characters")

  def _legacy_default_state(self) -> dict:
    category_legacy = {
      english: chinese
      for chinese, english in skill_tags.BUILTIN_DISPLAY_RENAMES["category"].items()
    }
    subcategory_legacy = {
      key: {
        english: chinese
        for chinese, english in renames.items()
      }
      for key, renames in skill_tags.BUILTIN_DISPLAY_RENAMES[
        "subcategory"
      ].items()
    }
    tag_legacy = {
      key: {
        english: chinese
        for chinese, english in renames.items()
      }
      for key, renames in skill_tags.BUILTIN_DISPLAY_RENAMES["tag"].items()
    }
    categories = []
    subcategories = []
    tags = []
    for category_index, (key, name, color, tag_names) in enumerate(
      skill_tags.DEFAULT_SKILL_TAG_GROUPS
    ):
      category_id = skill_tags._builtin_category_id(key)
      categories.append(
        {
          "id": category_id,
          "name": category_legacy[name],
          "order": category_index,
        }
      )
      for subcategory_index, subcategory_name in enumerate(
        skill_tags.DEFAULT_SUBCATEGORY_GROUPS[key]
      ):
        legacy_name = subcategory_legacy[key][subcategory_name]
        subcategories.append(
          {
            "id": skill_tags._builtin_subcategory_id(key, legacy_name),
            "categoryId": category_id,
            "name": legacy_name,
            "order": subcategory_index,
          }
        )
      for tag_name in tag_names:
        legacy_name = tag_legacy[key][tag_name]
        tags.append(
          {
            "id": skill_tags._builtin_tag_id(key, legacy_name),
            "name": legacy_name,
            "categoryId": category_id,
            "subcategoryId": "",
            "color": color,
            "favorite": False,
            "order": len(tags),
          }
        )
    return {
      "version": 1,
      "defaultsVersion": 1,
      "categories": categories,
      "subcategories": subcategories,
      "tags": tags,
      "assignments": {},
    }

  def _subcategory_id(self, category_name: str, name: str) -> str:
    state = skill_tags.get_skill_tag_state(str(self.temp_path))
    category_id = self._category_id(category_name)
    return next(
      item["id"]
      for item in state["subcategories"]
      if item["categoryId"] == category_id and item["name"] == name
    )

  def test_default_state_is_persisted_with_four_seeded_categories(self):
    state = skill_tags.get_skill_tag_state(str(self.temp_path))

    self.assertTrue(self._state_path().is_file())
    self.assertEqual(state["version"], 2)
    self.assertEqual(state["defaultsVersion"], 4)
    self.assertEqual(
      [item["name"] for item in state["categories"]],
      ["Characters", "Scenes", "Clothing", "Props"],
    )
    self.assertEqual(len(state["tags"]), 48)
    self.assertEqual(len(state["subcategories"]), 18)
    self.assertTrue(
      all(item["subcategoryId"] == "" for item in state["tags"])
    )
    subcategory_names = {
      item["name"] for item in state["subcategories"]
    }
    self.assertTrue(
      {
        "Count",
        "Gender",
        "Age",
        "Skin Tone",
        "Body Type",
        "Hairstyle",
        "Expression",
        "Pose",
        "Shoes",
        "Weather",
        "Camera Angle",
        "Location",
      }.issubset(subcategory_names)
    )
    self.assertFalse({"男装", "女装"}.intersection(subcategory_names))
    category_ids = {item["id"] for item in state["categories"]}
    for category_id in category_ids:
      self.assertEqual(
        len(
          [
            item
            for item in state["tags"]
            if item["categoryId"] == category_id
          ]
        ),
        12,
      )
    tag_names = {item["name"] for item in state["tags"]}
    self.assertTrue(
      {"Solo", "Starry Sky", "Sailor Uniform", "Cat Ears"}.issubset(tag_names)
    )
    self.assertEqual(state["assignments"], {})
    self.assertEqual(
      skill_tags.get_skill_tag_state(str(self.temp_path)),
      state,
    )

  def test_legacy_empty_generic_state_migrates_to_default_groups(self):
    self.temp_path.mkdir(parents=True)
    self._state_path().write_text(
      json.dumps(
        {
          "version": 1,
          "categories": [
            {
              "id": uuid.uuid4().hex,
              "name": "通用",
              "order": 0,
            }
          ],
          "tags": [],
          "assignments": {},
        },
        ensure_ascii=False,
      ),
      encoding="utf-8",
    )

    state = skill_tags.get_skill_tag_state(str(self.temp_path))

    self.assertEqual(
      [item["name"] for item in state["categories"]],
      ["Characters", "Scenes", "Clothing", "Props"],
    )
    self.assertEqual(len(state["tags"]), 48)
    persisted = json.loads(self._state_path().read_text("utf-8"))
    self.assertEqual(persisted["defaultsVersion"], 4)
    self.assertEqual(len(persisted["subcategories"]), 18)

  def test_custom_state_keeps_user_data_and_defaults_are_not_restored(self):
    self.temp_path.mkdir(parents=True)
    custom_category_id = uuid.uuid4().hex
    custom_tag_id = uuid.uuid4().hex
    self._state_path().write_text(
      json.dumps(
        {
          "version": 1,
          "categories": [
            {
              "id": custom_category_id,
              "name": "我的分类",
              "order": 0,
            }
          ],
          "tags": [
            {
              "id": custom_tag_id,
              "name": "我的标签",
              "categoryId": custom_category_id,
              "color": "#69a8dc",
              "favorite": False,
              "order": 0,
            }
          ],
          "assignments": {},
        },
        ensure_ascii=False,
      ),
      encoding="utf-8",
    )

    migrated = skill_tags.get_skill_tag_state(str(self.temp_path))
    category_names = [item["name"] for item in migrated["categories"]]
    self.assertIn("我的分类", category_names)
    self.assertTrue(
      {"Characters", "Scenes", "Clothing", "Props"}.issubset(category_names)
    )
    self.assertTrue(
      any(item["id"] == custom_tag_id for item in migrated["tags"])
    )

    skill_tags.delete_tag_category(
      str(self.temp_path),
      self._category_id("Characters"),
    )
    after_delete = skill_tags.get_skill_tag_state(str(self.temp_path))
    self.assertNotIn(
      "Characters",
      [item["name"] for item in after_delete["categories"]],
    )

  def test_category_create_rename_reorder_and_last_category_guard(self):
    default_id = self._default_category_id()
    original_ids = [
      item["id"]
      for item in skill_tags.get_skill_tag_state(str(self.temp_path))[
        "categories"
      ]
    ]
    created = skill_tags.create_tag_category(str(self.temp_path), "绘画")
    drawing_id = created["category"]["id"]
    renamed = skill_tags.rename_tag_category(
      str(self.temp_path),
      drawing_id,
      "图像生成",
    )

    self.assertEqual(renamed["categories"][-1]["name"], "图像生成")
    reordered_ids = [
      drawing_id,
      *[item_id for item_id in original_ids if item_id != default_id],
      default_id,
    ]
    reordered = skill_tags.reorder_skill_tags(
      str(self.temp_path),
      "categories",
      reordered_ids,
    )
    self.assertEqual(
      [item["id"] for item in reordered["categories"]],
      reordered_ids,
    )

    skill_tags.delete_tag_category(str(self.temp_path), drawing_id)
    remaining = skill_tags.get_skill_tag_state(str(self.temp_path))[
      "categories"
    ]
    for category in remaining[1:]:
      skill_tags.delete_tag_category(str(self.temp_path), category["id"])
    with self.assertRaises(skill_tags.SkillTagDataError):
      skill_tags.delete_tag_category(
        str(self.temp_path),
        remaining[0]["id"],
      )

  def test_tag_crud_favorite_move_and_duplicate_validation(self):
    default_id = self._default_category_id()
    second = skill_tags.create_tag_category(str(self.temp_path), "视频")
    second_id = second["category"]["id"]
    created = skill_tags.create_skill_tag(
      str(self.temp_path),
      name="转场",
      category_id=default_id,
      color="#72C29A",
    )
    tag_id = created["tag"]["id"]

    with self.assertRaises(skill_tags.SkillTagDataError):
      skill_tags.create_skill_tag(
        str(self.temp_path),
        name="转场",
        category_id=default_id,
      )

    updated = skill_tags.update_skill_tag(
      str(self.temp_path),
      tag_id,
      {
        "name": "视频转场",
        "categoryId": second_id,
        "color": "#d7b45f",
        "favorite": True,
      },
    )
    tag = next(item for item in updated["tags"] if item["id"] == tag_id)
    self.assertEqual(tag["name"], "视频转场")
    self.assertEqual(tag["categoryId"], second_id)
    self.assertEqual(tag["color"], "#d7b45f")
    self.assertTrue(tag["favorite"])

    skill_tags.delete_skill_tag(str(self.temp_path), tag_id)
    remaining = skill_tags.get_skill_tag_state(str(self.temp_path))
    self.assertFalse(any(item["id"] == tag_id for item in remaining["tags"]))
    self.assertEqual(len(remaining["tags"]), 48)

  def test_subcategory_create_rename_reorder_and_parent_scoped_names(self):
    character_id = self._default_category_id()
    first = skill_tags.create_tag_subcategory(
      str(self.temp_path),
      category_id=character_id,
      name="职业",
    )
    subcategory_id = first["subcategory"]["id"]
    self.assertEqual(first["subcategory"]["categoryId"], character_id)

    with self.assertRaises(skill_tags.SkillTagDataError):
      skill_tags.create_tag_subcategory(
        str(self.temp_path),
        category_id=character_id,
        name="职业",
      )
    same_name_elsewhere = skill_tags.create_tag_subcategory(
      str(self.temp_path),
      category_id=self._category_id("Props"),
      name="职业",
    )
    self.assertEqual(same_name_elsewhere["subcategory"]["name"], "职业")

    renamed = skill_tags.rename_tag_subcategory(
      str(self.temp_path),
      subcategory_id,
      "人物职业",
    )
    renamed_item = next(
      item for item in renamed["subcategories"] if item["id"] == subcategory_id
    )
    self.assertEqual(renamed_item["name"], "人物职业")

    all_ids = [
      item["id"]
      for item in skill_tags.get_skill_tag_state(str(self.temp_path))[
        "subcategories"
      ]
    ]
    reordered = skill_tags.reorder_skill_tags(
      str(self.temp_path),
      "subcategories",
      list(reversed(all_ids)),
    )
    self.assertEqual(
      [item["id"] for item in reordered["subcategories"]],
      list(reversed(all_ids)),
    )

  def test_tag_can_move_between_subcategories_and_validates_parent(self):
    character_id = self._default_category_id()
    scene_id = self._category_id("Scenes")
    hair_id = self._subcategory_id("Characters", "Hairstyle")
    gender_id = self._subcategory_id("Characters", "Gender")
    weather_id = self._subcategory_id("Scenes", "Weather")
    created = skill_tags.create_skill_tag(
      str(self.temp_path),
      name="银灰短发",
      category_id=character_id,
      subcategory_id=hair_id,
    )
    tag_id = created["tag"]["id"]
    self.assertEqual(created["tag"]["subcategoryId"], hair_id)

    moved = skill_tags.update_skill_tag(
      str(self.temp_path),
      tag_id,
      {"subcategoryId": gender_id},
    )
    self.assertEqual(
      next(item for item in moved["tags"] if item["id"] == tag_id)[
        "subcategoryId"
      ],
      gender_id,
    )

    with self.assertRaises(FileNotFoundError):
      skill_tags.update_skill_tag(
        str(self.temp_path),
        tag_id,
        {"categoryId": scene_id, "subcategoryId": hair_id},
      )

    moved_to_scene = skill_tags.update_skill_tag(
      str(self.temp_path),
      tag_id,
      {"categoryId": scene_id, "subcategoryId": weather_id},
    )
    moved_tag = next(
      item for item in moved_to_scene["tags"] if item["id"] == tag_id
    )
    self.assertEqual(moved_tag["categoryId"], scene_id)
    self.assertEqual(moved_tag["subcategoryId"], weather_id)

    reset_to_parent = skill_tags.update_skill_tag(
      str(self.temp_path),
      tag_id,
      {"subcategoryId": ""},
    )
    self.assertEqual(
      next(
        item for item in reset_to_parent["tags"] if item["id"] == tag_id
      )["subcategoryId"],
      "",
    )

  def test_deleting_subcategory_preserves_tags_and_assignments(self):
    character_id = self._default_category_id()
    subcategory_id = self._subcategory_id("Characters", "Hairstyle")
    created = skill_tags.create_skill_tag(
      str(self.temp_path),
      name="银色卷发",
      category_id=character_id,
      subcategory_id=subcategory_id,
    )
    tag_id = created["tag"]["id"]
    skill_tags.assign_skill_tags(
      str(self.temp_path),
      "input/skills/style/SKILL.md",
      [tag_id],
    )

    state = skill_tags.delete_tag_subcategory(
      str(self.temp_path),
      subcategory_id,
    )

    self.assertFalse(
      any(item["id"] == subcategory_id for item in state["subcategories"])
    )
    tag = next(item for item in state["tags"] if item["id"] == tag_id)
    self.assertEqual(tag["categoryId"], character_id)
    self.assertEqual(tag["subcategoryId"], "")
    self.assertEqual(
      state["assignments"]["input/skills/style/SKILL.md"],
      [tag_id],
    )

  def test_version_one_state_migrates_clothing_name_and_subcategories(self):
    legacy = self._legacy_default_state()
    legacy["version"] = 1
    legacy["defaultsVersion"] = 1
    legacy.pop("subcategories")
    clothing_category = next(
      item for item in legacy["categories"] if item["name"] == "服饰"
    )
    clothing_category["name"] = "服装"
    for tag in legacy["tags"]:
      tag.pop("subcategoryId", None)
    self.temp_path.mkdir(parents=True)
    self._state_path().write_text(
      json.dumps(legacy, ensure_ascii=False),
      encoding="utf-8",
    )

    migrated = skill_tags.get_skill_tag_state(str(self.temp_path))

    self.assertEqual(migrated["version"], 2)
    self.assertEqual(migrated["defaultsVersion"], 4)
    self.assertIn(
      "Clothing",
      [item["name"] for item in migrated["categories"]],
    )
    self.assertNotIn(
      "服装",
      [item["name"] for item in migrated["categories"]],
    )
    self.assertEqual(len(migrated["subcategories"]), 18)
    self.assertTrue(
      all(item["subcategoryId"] == "" for item in migrated["tags"])
    )

  def test_version_two_defaults_remove_retired_items_and_add_new_groups(self):
    legacy = self._legacy_default_state()
    legacy["version"] = 2
    legacy["defaultsVersion"] = 2
    legacy["subcategories"] = [
      item
      for item in legacy["subcategories"]
      if item["name"] not in {"表情", "动作", "地点"}
    ]
    clothing_category_id = next(
      item["id"]
      for item in legacy["categories"]
      if item["name"] == "服饰"
    )
    retired_entries = [
      (
        skill_tags._builtin_subcategory_id("clothing", name),
        name,
      )
      for name in ("男装", "女装")
    ]
    retired_ids = {item[0] for item in retired_entries}
    for index, (subcategory_id, name) in enumerate(retired_entries):
      legacy["subcategories"].append(
        {
          "id": subcategory_id,
          "categoryId": clothing_category_id,
          "name": name,
          "order": len(legacy["subcategories"]) + index,
        }
      )
    tag = next(item for item in legacy["tags"] if item["name"] == "连衣裙")
    tag["subcategoryId"] = skill_tags._builtin_subcategory_id(
      "clothing",
      "男装",
    )
    self.temp_path.mkdir(parents=True)
    self._state_path().write_text(
      json.dumps(legacy, ensure_ascii=False),
      encoding="utf-8",
    )

    migrated = skill_tags.get_skill_tag_state(str(self.temp_path))

    self.assertEqual(migrated["defaultsVersion"], 4)
    self.assertEqual(len(migrated["subcategories"]), 18)
    migrated_ids = {item["id"] for item in migrated["subcategories"]}
    self.assertFalse(retired_ids.intersection(migrated_ids))
    migrated_names = {item["name"] for item in migrated["subcategories"]}
    self.assertTrue({"Expression", "Pose", "Location"}.issubset(migrated_names))
    migrated_tag = next(
      item for item in migrated["tags"] if item["id"] == tag["id"]
    )
    self.assertEqual(migrated_tag["subcategoryId"], "")

  def test_skill_assignments_are_deduplicated_and_cleaned_up(self):
    category_id = self._default_category_id()
    first = skill_tags.create_skill_tag(
      str(self.temp_path),
      name="角色",
      category_id=category_id,
    )["tag"]["id"]
    second = skill_tags.create_skill_tag(
      str(self.temp_path),
      name="工具",
      category_id=category_id,
    )["tag"]["id"]

    assigned = skill_tags.assign_skill_tags(
      str(self.temp_path),
      "custom_nodes/example/SKILL.md",
      [first, second, first],
    )
    self.assertEqual(
      assigned["assignments"]["custom_nodes/example/SKILL.md"],
      [first, second],
    )

    after_delete = skill_tags.delete_skill_tag(str(self.temp_path), first)
    self.assertEqual(
      after_delete["assignments"]["custom_nodes/example/SKILL.md"],
      [second],
    )
    cleared = skill_tags.assign_skill_tags(
      str(self.temp_path),
      "custom_nodes/example/SKILL.md",
      [],
    )
    self.assertEqual(cleared["assignments"], {})

  def test_deleting_category_removes_its_tags_and_assignments(self):
    default_id = self._default_category_id()
    extra = skill_tags.create_tag_category(str(self.temp_path), "音频")
    extra_id = extra["category"]["id"]
    tag_id = skill_tags.create_skill_tag(
      str(self.temp_path),
      name="配音",
      category_id=extra_id,
    )["tag"]["id"]
    skill_tags.assign_skill_tags(
      str(self.temp_path),
      "input/skills/voice/SKILL.md",
      [tag_id],
    )

    state = skill_tags.delete_tag_category(str(self.temp_path), extra_id)
    self.assertEqual(len(state["categories"]), 4)
    self.assertIn(default_id, [item["id"] for item in state["categories"]])
    self.assertFalse(
      any(item["categoryId"] == extra_id for item in state["tags"])
    )
    self.assertEqual(state["assignments"], {})

  def test_reorder_rejects_partial_or_duplicate_id_lists(self):
    category_id = self._default_category_id()
    existing_tag_ids = [
      item["id"]
      for item in skill_tags.get_skill_tag_state(str(self.temp_path))["tags"]
    ]
    tag_ids = [
      skill_tags.create_skill_tag(
        str(self.temp_path),
        name=name,
        category_id=category_id,
      )["tag"]["id"]
      for name in ("一", "二", "三")
    ]
    all_tag_ids = [*existing_tag_ids, *tag_ids]
    with self.assertRaises(skill_tags.SkillTagDataError):
      skill_tags.reorder_skill_tags(
        str(self.temp_path),
        "tags",
        all_tag_ids[:2],
      )
    with self.assertRaises(skill_tags.SkillTagDataError):
      skill_tags.reorder_skill_tags(
        str(self.temp_path),
        "tags",
        [all_tag_ids[0], all_tag_ids[0], *all_tag_ids[1:]],
      )

    reordered = skill_tags.reorder_skill_tags(
      str(self.temp_path),
      "tags",
      list(reversed(all_tag_ids)),
    )
    self.assertEqual(
      [item["id"] for item in reordered["tags"]],
      list(reversed(all_tag_ids)),
    )

  def test_backup_is_used_when_primary_state_is_corrupt(self):
    category_id = self._default_category_id()
    skill_tags.create_skill_tag(
      str(self.temp_path),
      name="备份标签",
      category_id=category_id,
    )
    self.assertTrue(self._state_path().with_suffix(".json.bak").is_file())

    self._state_path().write_text("{broken", encoding="utf-8")
    recovered = skill_tags.get_skill_tag_state(str(self.temp_path))
    self.assertEqual(len(recovered["categories"]), 4)
    self.assertIsInstance(recovered["tags"], list)
    self.assertIsInstance(
      json.loads(self._state_path().with_suffix(".json.bak").read_text("utf-8")),
      dict,
    )

  def test_batch_create_adds_tags_in_one_target_and_skips_duplicates(self):
    category_id = self._default_category_id()
    subcategory_id = self._subcategory_id("Characters", "Hairstyle")
    existing_color = next(
      item["color"]
      for item in skill_tags.get_skill_tag_state(str(self.temp_path))["tags"]
      if item["categoryId"] == category_id
    )

    created = skill_tags.create_skill_tags(
      str(self.temp_path),
      names=[" 批量一 ", "批量二", "批量一", "Woman", "批量三"],
      category_id=category_id,
      subcategory_id=subcategory_id,
    )

    self.assertEqual(created["createdCount"], 3)
    self.assertEqual(created["skippedDuplicates"], 2)
    self.assertEqual(created["warnings"], [])
    self.assertEqual(
      [item["name"] for item in created["createdTags"]],
      ["批量一", "批量二", "批量三"],
    )
    for tag in created["createdTags"]:
      self.assertEqual(tag["categoryId"], category_id)
      self.assertEqual(tag["subcategoryId"], subcategory_id)
      self.assertEqual(tag["color"], existing_color)
    persisted = skill_tags.get_skill_tag_state(str(self.temp_path))
    self.assertTrue(
      {"批量一", "批量二", "批量三"}
      .issubset({item["name"] for item in persisted["tags"]})
    )

  def test_batch_create_reports_invalid_names_and_keeps_category_scope(self):
    character_id = self._default_category_id()
    scene_id = self._category_id("Scenes")
    long_name = "长" * (skill_tags.MAX_NAME_LENGTH + 1)

    created = skill_tags.create_skill_tags(
      str(self.temp_path),
      names=[long_name, "跨分类同名"],
      category_id=character_id,
    )
    self.assertEqual(created["createdCount"], 1)
    self.assertEqual(len(created["warnings"]), 1)

    other_category = skill_tags.create_skill_tags(
      str(self.temp_path),
      names=["跨分类同名"],
      category_id=scene_id,
    )
    self.assertEqual(other_category["createdCount"], 1)
    self.assertEqual(other_category["skippedDuplicates"], 0)

  def test_batch_create_validates_target_and_name_payload(self):
    with self.assertRaises(skill_tags.SkillTagDataError):
      skill_tags.create_skill_tags(
        str(self.temp_path),
        names="不是列表",
        category_id=self._default_category_id(),
      )
    with self.assertRaises(FileNotFoundError):
      skill_tags.create_skill_tags(
        str(self.temp_path),
        names=["测试标签"],
        category_id="missing-category",
      )

  def test_batch_delete_removes_tags_and_skill_assignments(self):
    category_id = self._default_category_id()
    tag_ids = [
      skill_tags.create_skill_tag(
        str(self.temp_path),
        name=name,
        category_id=category_id,
      )["tag"]["id"]
      for name in ("批量删除一", "批量删除二", "保留标签")
    ]
    skill_tags.assign_skill_tags(
      str(self.temp_path),
      "skill-batch-delete",
      tag_ids,
    )

    deleted = skill_tags.delete_skill_tags(
      str(self.temp_path),
      [tag_ids[0], tag_ids[1], tag_ids[0]],
    )

    self.assertEqual(deleted["deletedIds"], tag_ids[:2])
    self.assertEqual(deleted["deletedCount"], 2)
    self.assertEqual(deleted["missingCount"], 0)
    self.assertEqual(
      [item["name"] for item in deleted["tags"] if item["id"] in tag_ids],
      ["保留标签"],
    )
    self.assertEqual(
      deleted["assignments"]["skill-batch-delete"],
      [tag_ids[2]],
    )
    persisted = skill_tags.get_skill_tag_state(str(self.temp_path))
    self.assertFalse(
      {item["id"] for item in persisted["tags"]}.intersection(tag_ids[:2])
    )

  def test_batch_delete_skips_missing_ids_and_requires_a_selection(self):
    tag_id = skill_tags.create_skill_tag(
      str(self.temp_path),
      name="缺失测试标签",
      category_id=self._default_category_id(),
    )["tag"]["id"]

    deleted = skill_tags.delete_skill_tags(
      str(self.temp_path),
      [tag_id, "missing-tag", "missing-tag"],
    )

    self.assertEqual(deleted["deletedIds"], [tag_id])
    self.assertEqual(deleted["deletedCount"], 1)
    self.assertEqual(deleted["missingCount"], 1)
    with self.assertRaises(skill_tags.SkillTagDataError):
      skill_tags.delete_skill_tags(str(self.temp_path), [])

  def test_batch_move_tags_to_category_and_subcategory(self):
    source_category_id = self._default_category_id()
    target_category_id = self._category_id("Scenes")
    target_subcategory_id = self._subcategory_id("Scenes", "Weather")
    tag_ids = [
      skill_tags.create_skill_tag(
        str(self.temp_path),
        name=name,
        category_id=source_category_id,
      )["tag"]["id"]
      for name in ("批量移动一", "批量移动二")
    ]

    moved = skill_tags.move_skill_tags(
      str(self.temp_path),
      tag_ids,
      category_id=target_category_id,
      subcategory_id=target_subcategory_id,
    )

    self.assertEqual(moved["movedIds"], tag_ids)
    self.assertEqual(moved["movedCount"], 2)
    self.assertEqual(moved["skippedDuplicates"], 0)
    self.assertEqual(moved["missingCount"], 0)
    self.assertEqual(moved["targetCategory"]["name"], "Scenes")
    self.assertEqual(moved["targetSubcategory"]["name"], "Weather")
    for tag in moved["tags"]:
      if tag["id"] in tag_ids:
        self.assertEqual(tag["categoryId"], target_category_id)
        self.assertEqual(tag["subcategoryId"], target_subcategory_id)

  def test_batch_move_skips_same_name_in_target_category(self):
    source_category_id = self._default_category_id()
    target_category_id = self._category_id("Scenes")
    source_tag_id = skill_tags.create_skill_tag(
      str(self.temp_path),
      name="跨分类同名移动",
      category_id=source_category_id,
    )["tag"]["id"]
    target_tag_id = skill_tags.create_skill_tag(
      str(self.temp_path),
      name="跨分类同名移动",
      category_id=target_category_id,
    )["tag"]["id"]

    moved = skill_tags.move_skill_tags(
      str(self.temp_path),
      [source_tag_id],
      category_id=target_category_id,
    )

    self.assertEqual(moved["movedIds"], [])
    self.assertEqual(moved["skippedDuplicates"], 1)
    self.assertEqual(moved["skippedNames"], ["跨分类同名移动"])
    source_tag = next(
      item for item in moved["tags"] if item["id"] == source_tag_id
    )
    target_tag = next(
      item for item in moved["tags"] if item["id"] == target_tag_id
    )
    self.assertEqual(source_tag["categoryId"], source_category_id)
    self.assertEqual(target_tag["categoryId"], target_category_id)

  def test_batch_move_skips_duplicate_names_inside_the_same_batch(self):
    character_id = self._default_category_id()
    scene_id = self._category_id("Scenes")
    target_category_id = self._category_id("Props")
    tag_ids = [
      skill_tags.create_skill_tag(
        str(self.temp_path),
        name="同批同名移动",
        category_id=category_id,
      )["tag"]["id"]
      for category_id in (character_id, scene_id)
    ]

    moved = skill_tags.move_skill_tags(
      str(self.temp_path),
      tag_ids,
      category_id=target_category_id,
    )

    self.assertEqual(moved["movedCount"], 1)
    self.assertEqual(moved["skippedDuplicates"], 1)
    self.assertEqual(len(moved["movedIds"]), 1)
    target_tags = [
      item
      for item in moved["tags"]
      if item["categoryId"] == target_category_id
      and item["name"] == "同批同名移动"
    ]
    self.assertEqual(len(target_tags), 1)

  def test_batch_move_validates_target_category_and_subcategory(self):
    tag_id = skill_tags.create_skill_tag(
      str(self.temp_path),
      name="无效目标测试",
      category_id=self._default_category_id(),
    )["tag"]["id"]

    with self.assertRaises(FileNotFoundError):
      skill_tags.move_skill_tags(
        str(self.temp_path),
        [tag_id],
        category_id="missing-category",
      )
    with self.assertRaises(FileNotFoundError):
      skill_tags.move_skill_tags(
        str(self.temp_path),
        [tag_id],
        category_id=self._category_id("Scenes"),
        subcategory_id=self._subcategory_id("Characters", "Hairstyle"),
      )


if __name__ == "__main__":
  unittest.main()
