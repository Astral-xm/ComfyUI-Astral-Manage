import shutil
import sys
import unittest
import uuid
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
  sys.path.insert(0, str(PACKAGE_ROOT))

import skill_library


class SkillLibraryTests(unittest.TestCase):
  def setUp(self):
    self.temp_path = (
      PACKAGE_ROOT
      / ".asset-library-tests"
      / f"skills-{uuid.uuid4().hex}"
    )
    self.skills_root = self.temp_path / "skills"
    self.skill_path = self.skills_root / "writing" / "scene-designer"
    self.skill_path.mkdir(parents=True)
    (self.skill_path / "SKILL.md").write_text(
      "# English fallback\n\nEnglish instructions.",
      encoding="utf-8",
    )
    (self.skill_path / "SKILL.cn.md").write_text(
      "---\n"
      "name: 场景设计师\n"
      "description: >\n"
      "  设计连续、可拍摄的场景说明。\n"
      "  优先保持角色一致性。\n"
      "---\n\n"
      "# 场景设计师\n\n"
      "输出镜头列表。",
      encoding="utf-8",
    )
    references = self.skill_path / "references"
    references.mkdir()
    (references / "style.md").write_text(
      "# Style\n\nUse restrained color.",
      encoding="utf-8",
    )

  def tearDown(self):
    shutil.rmtree(self.temp_path, ignore_errors=True)

  def test_discovers_chinese_skill_and_references(self):
    skills = skill_library.discover_skills(str(self.skills_root))

    self.assertEqual(len(skills), 1)
    self.assertEqual(skills[0]["id"], "writing/scene-designer")
    self.assertEqual(skills[0]["name"], "场景设计师")
    self.assertEqual(skills[0]["fileName"], "SKILL.cn.md")
    self.assertIn("设计连续", skills[0]["description"])
    self.assertEqual(skills[0]["references"], ["references/style.md"])

  def test_default_scan_root_is_custom_nodes(self):
    scan_root = Path(skill_library.default_skills_directory())

    self.assertEqual(scan_root.name.casefold(), "custom_nodes")
    self.assertEqual(scan_root.resolve(), PACKAGE_ROOT.parent.resolve())

  def test_default_scan_roots_include_custom_nodes_and_input(self):
    roots = [Path(root) for root in skill_library.default_skill_directories()]

    self.assertEqual(len(roots), 2)
    self.assertEqual(roots[0].name.casefold(), "custom_nodes")
    self.assertEqual(roots[1].name.casefold(), "input")
    self.assertEqual(roots[0].parent, roots[1].parent)

  def test_discovers_skills_across_custom_node_packages(self):
    custom_nodes = self.temp_path / "custom_nodes"
    first = custom_nodes / "Package-A" / "skills" / "first"
    second = custom_nodes / "Package-B" / "skills" / "second"
    ignored = custom_nodes / "Package-C" / "node_modules" / "ignored"
    first.mkdir(parents=True)
    second.mkdir(parents=True)
    ignored.mkdir(parents=True)
    (first / "SKILL.md").write_text("# First\n\nFirst package skill.", encoding="utf-8")
    (second / "SKILL.cn.md").write_text(
      "---\nname: 第二个技能\n---\n\n# 第二个技能\n\nSecond package skill.",
      encoding="utf-8",
    )
    (ignored / "SKILL.md").write_text("# Ignored\n\nShould not load.", encoding="utf-8")

    skills = skill_library.discover_skills(str(custom_nodes))

    self.assertEqual(
      {skill["id"] for skill in skills},
      {
        "Package-A/skills/first",
        "Package-B/skills/second",
      },
    )
    loaded = skill_library.load_skill_text(
      "Package-A/skills/first",
      str(custom_nodes),
    )
    self.assertIn("First package skill.", loaded["content"])

  def test_discovers_input_skills_with_input_namespace(self):
    custom_nodes = self.temp_path / "custom_nodes"
    input_root = self.temp_path / "input"
    custom_skill = custom_nodes / "Package-A" / "skills" / "first"
    input_skill = input_root / "skills" / "input-helper"
    custom_skill.mkdir(parents=True)
    input_skill.mkdir(parents=True)
    (custom_skill / "SKILL.md").write_text(
      "# Custom\n\nCustom node skill.",
      encoding="utf-8",
    )
    (input_skill / "SKILL.cn.md").write_text(
      "---\nname: 输入目录技能\n---\n\n# 输入目录技能\n\nInput skill.",
      encoding="utf-8",
    )

    skills = skill_library.discover_skills(
      str(custom_nodes),
      input_root=str(input_root),
    )

    self.assertEqual(
      {skill["id"] for skill in skills},
      {
        "Package-A/skills/first",
        "input/skills/input-helper",
      },
    )
    by_id = {skill["id"]: skill for skill in skills}
    self.assertEqual(by_id["input/skills/input-helper"]["source"], "input")
    loaded = skill_library.load_skill_text(
      "input/skills/input-helper",
      str(custom_nodes),
      input_root=str(input_root),
    )
    self.assertIn("Input skill.", loaded["content"])

  def test_loads_skill_text_and_builds_deduplicated_context(self):
    loaded = skill_library.load_skill_text(
      "writing/scene-designer",
      str(self.skills_root),
    )
    self.assertIn("输出镜头列表", loaded["content"])

    records, context = skill_library.build_skill_context(
      ["writing/scene-designer", "writing/scene-designer"],
      skills_root=str(self.skills_root),
    )
    self.assertEqual(len(records), 1)
    self.assertIn("<skill id=\"writing/scene-designer\"", context)
    self.assertIn("Use restrained color.", context)
    self.assertEqual(context.count("<skill id="), 1)

  def test_resolves_existing_skill_file_for_explorer_selection(self):
    resolved = skill_library.resolve_skill_file(
      "writing/scene-designer",
      str(self.skills_root),
    )

    self.assertEqual(
      Path(resolved),
      (self.skill_path / "SKILL.cn.md").resolve(),
    )

  def test_missing_skill_is_reported_without_path_escape(self):
    with self.assertRaises(FileNotFoundError):
      skill_library.load_skill_text("../outside", str(self.skills_root))


if __name__ == "__main__":
  unittest.main()
