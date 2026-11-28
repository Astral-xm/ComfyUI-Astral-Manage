import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]

package = types.ModuleType("astral_manage")
package.__path__ = [str(PACKAGE_ROOT)]
sys.modules["astral_manage"] = package

fake_skill_library = types.ModuleType("astral_manage.skill_library")
fake_skill_library.discover_skills = lambda *args, **kwargs: []
sys.modules["astral_manage.skill_library"] = fake_skill_library

spec = importlib.util.spec_from_file_location(
  "astral_manage.prompt_skill_loader",
  PACKAGE_ROOT / "prompt_skill_loader.py",
)
loader_module = importlib.util.module_from_spec(spec)
sys.modules["astral_manage.prompt_skill_loader"] = loader_module
spec.loader.exec_module(loader_module)


def skill_record(path: Path, skill_id="writing/SKILL.md"):
  return {
    "id": skill_id,
    "name": "Writing",
    "label": "Writing [writing/SKILL.md]",
    "description": "Writes things",
    "fileName": path.name,
    "relativeDirectory": "writing",
    "source": "custom_nodes",
    "root": str(path.parent),
    "absolutePath": str(path),
    "references": [],
    "size": path.stat().st_size,
  }


class PromptSkillLoaderTests(unittest.TestCase):
  def setUp(self):
    self.temp = tempfile.TemporaryDirectory()
    self.addCleanup(self.temp.cleanup)
    root = Path(self.temp.name) / "pkg" / "skills" / "writing"
    root.mkdir(parents=True)
    self.skill_file = root / "SKILL.md"
    self.skill_file.write_text("SKILL BODY", encoding="utf-8")
    self.record = skill_record(self.skill_file)
    fake_skill_library.discover_skills = lambda *args, **kwargs: [self.record]
    self.node = loader_module.AstralPromptSkillLoader()

  def test_registration(self):
    self.assertEqual(
      loader_module.AstralPromptSkillLoader.NAME,
      "Prompt Skill Loader",
    )
    self.assertEqual(
      loader_module.AstralPromptSkillLoader.RETURN_TYPES,
      ("QWEN_TE_SKILL",),
    )
    self.assertFalse(loader_module.AstralPromptSkillLoader.OUTPUT_NODE)
    self.assertIn(
      "Prompt Skill Loader",
      loader_module.NODE_CLASS_MAPPINGS,
    )
    self.assertEqual(
      loader_module.NODE_DISPLAY_NAME_MAPPINGS[
        "Prompt Skill Loader"
      ],
      "Prompt Skill Loader",
    )

  def test_dropdown_only_scans_this_pack_skills_folder(self):
    calls = []

    def discover(root=None, **kwargs):
      calls.append(root)
      return [self.record]

    fake_skill_library.discover_skills = discover
    self.node.run(skill=loader_module.AUTO_LABEL)
    self.assertEqual(calls, [loader_module.PACKAGE_SKILLS_DIR])
    self.assertTrue(loader_module.PACKAGE_SKILLS_DIR.endswith("skills"))

  def test_schema_lists_discovered_skills(self):
    inputs = loader_module.AstralPromptSkillLoader.INPUT_TYPES()
    self.assertEqual(inputs["required"]["skill"][1]["default"], loader_module.AUTO_LABEL)
    self.assertEqual(
      inputs["required"]["skill"][0][0],
      loader_module.AUTO_LABEL,
    )
    self.assertIn("Writing [writing/SKILL.md]", inputs["required"]["skill"][0])
    for name in ("skill_path", "inline_name", "inline_content"):
      self.assertIn(name, inputs["optional"])

  def test_combo_selection_includes_inline_content(self):
    (payload,) = self.node.run(skill="Writing [writing/SKILL.md]")
    self.assertEqual(payload["selected"], "writing/SKILL.md")
    self.assertEqual(payload["inline_file"]["name"], "SKILL.md")
    self.assertEqual(payload["inline_file"]["content"], "SKILL BODY")
    self.assertEqual(payload["skills"][0]["skill_path"], "writing/SKILL.md")

  def test_pinned_path_is_loaded(self):
    (payload,) = self.node.run(skill_path=str(self.skill_file))
    self.assertEqual(payload["selected"], "")
    self.assertEqual(payload["inline_file"]["content"], "SKILL BODY")

  def test_inline_content_takes_precedence(self):
    (payload,) = self.node.run(
      skill_path=str(self.skill_file),
      inline_name="custom.md",
      inline_content="CUSTOM BODY",
    )
    self.assertEqual(payload["inline_file"]["name"], "custom.md")
    self.assertEqual(payload["inline_file"]["content"], "CUSTOM BODY")

  def test_auto_without_selection_returns_no_inline(self):
    (payload,) = self.node.run(skill=loader_module.AUTO_LABEL)
    self.assertEqual(payload["selected"], "")
    self.assertIsNone(payload["inline_file"])
    self.assertEqual(payload["skills"][0]["id"], "writing/SKILL.md")

  def test_missing_path_raises(self):
    with self.assertRaisesRegex(ValueError, "Skill file was not found"):
      self.node.run(skill_path=str(Path(self.temp.name) / "missing.md"))

  def test_unsupported_extension_raises(self):
    other = Path(self.temp.name) / "image.png"
    other.write_bytes(b"png")
    with self.assertRaisesRegex(ValueError, "only .md or .txt"):
      self.node.run(skill_path=str(other))

  def test_unknown_skill_raises(self):
    with self.assertRaisesRegex(ValueError, "was not found"):
      self.node.run(skill="Nope [nope/SKILL.md]")

  def test_oversized_file_raises(self):
    big = Path(self.temp.name) / "big.md"
    big.write_bytes(b"x" * (loader_module.MAX_SKILL_BYTES + 1))
    with self.assertRaisesRegex(ValueError, "4 MB or smaller"):
      self.node.run(skill_path=str(big))


if __name__ == "__main__":
  unittest.main()
