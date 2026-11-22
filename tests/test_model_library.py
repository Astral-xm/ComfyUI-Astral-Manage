import hashlib
import shutil
import sys
import unittest
import uuid
from pathlib import Path
from unittest import mock


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
  sys.path.insert(0, str(PACKAGE_ROOT))

import model_library


class ModelLibraryTests(unittest.TestCase):
  def setUp(self):
    self.temp_path = (
      PACKAGE_ROOT
      / ".asset-library-tests"
      / f"models-{uuid.uuid4().hex}"
    )
    self.models_root = self.temp_path / "models"
    self.models_root.mkdir(parents=True)
    self.categories = [
      {
        "name": "loras",
        "roots": [
          {
            "index": 0,
            "path": str(self.models_root),
            "exists": True,
          },
        ],
        "extensions": [".safetensors"],
      },
    ]

  def tearDown(self):
    shutil.rmtree(self.temp_path, ignore_errors=True)

  def test_lists_model_tree_and_filters_untracked_extensions(self):
    nested = self.models_root / "characters"
    nested.mkdir()
    (nested / "hero.safetensors").write_bytes(b"model")
    (nested / "notes.txt").write_text("ignored", encoding="utf-8")

    tree = model_library.list_model_tree(
      self.categories,
      "loras",
      0,
      "characters",
    )
    listing = model_library.list_model_files(
      self.categories,
      category_filter="loras",
      root_index=0,
      relative_path="characters",
    )

    self.assertEqual([item["name"] for item in tree["directories"]], [])
    self.assertEqual([item["name"] for item in tree["files"]], ["hero.safetensors"])
    self.assertEqual(listing["total"], 1)
    self.assertEqual(
      listing["items"][0]["relativePath"],
      "characters/hero.safetensors",
    )

  def test_lists_only_direct_files_and_reports_all_directories(self):
    characters = self.models_root / "characters"
    nested = characters / "nested"
    empty = self.models_root / "empty-target"
    nested.mkdir(parents=True)
    empty.mkdir()
    (self.models_root / "root.safetensors").write_bytes(b"root")
    (characters / "hero.safetensors").write_bytes(b"hero")
    (nested / "deep.safetensors").write_bytes(b"deep")
    (self.models_root / "notes.txt").write_text("ignored", encoding="utf-8")

    listing = model_library.list_model_files(
      self.categories,
      category_filter="loras",
      root_index=0,
      relative_path="",
      exact=True,
    )
    directories = model_library.list_model_directories(
      self.categories,
      category_filter="loras",
    )

    self.assertEqual(
      [item["relativePath"] for item in listing["items"]],
      ["root.safetensors"],
    )
    self.assertEqual(
      {item["relativePath"] for item in directories["directories"]},
      {"", "characters", "characters/nested", "empty-target"},
    )

  def test_recursively_lists_files_inside_selected_directory(self):
    characters = self.models_root / "characters"
    nested = characters / "nested"
    sibling = self.models_root / "vehicles"
    nested.mkdir(parents=True)
    sibling.mkdir()
    (self.models_root / "root.safetensors").write_bytes(b"root")
    (characters / "hero.safetensors").write_bytes(b"hero")
    (nested / "deep.safetensors").write_bytes(b"deep")
    (sibling / "car.safetensors").write_bytes(b"car")

    listing = model_library.list_model_files(
      self.categories,
      category_filter="loras",
      root_index=0,
      relative_path="characters",
      exact=False,
    )

    self.assertEqual(
      [item["relativePath"] for item in listing["items"]],
      ["characters/hero.safetensors", "characters/nested/deep.safetensors"],
    )

  def test_normalizes_registered_windows_model_names_for_source_lookup(self):
    names = [
      r"characters\hero.safetensors",
      r"characters\nested\deep.safetensors",
      "root.safetensors",
    ]

    lookup = model_library.normalized_model_name_lookup(names)

    self.assertEqual(
      lookup["characters/hero.safetensors"],
      r"characters\hero.safetensors",
    )
    self.assertEqual(
      lookup["characters/nested/deep.safetensors"],
      r"characters\nested\deep.safetensors",
    )
    self.assertEqual(lookup["root.safetensors"], "root.safetensors")

  def test_native_model_identifier_uses_server_path_separator(self):
    with mock.patch.object(model_library.os, "sep", "\\"):
      self.assertEqual(
        model_library.native_model_identifier(
          "Krea2/DC Celestial Dynasty v1.safetensors"
        ),
        r"Krea2\DC Celestial Dynasty v1.safetensors",
      )
    with mock.patch.object(model_library.os, "sep", "/"):
      self.assertEqual(
        model_library.native_model_identifier(
          r"Krea2\DC Celestial Dynasty v1.safetensors"
        ),
        "Krea2/DC Celestial Dynasty v1.safetensors",
      )

  def test_moves_selected_models_with_injected_operation(self):
    source_dir = self.models_root / "source"
    target_dir = self.models_root / "target"
    source_dir.mkdir()
    target_dir.mkdir()
    first = source_dir / "first.safetensors"
    second = source_dir / "second.safetensors"
    first.write_bytes(b"first")
    second.write_bytes(b"second")
    operations = []

    def fake_move(source, destination):
      operations.append((source, destination))

    result = model_library.move_model_files(
      self.categories,
      "loras",
      [
        {"rootIndex": 0, "relativePath": "source/first.safetensors"},
        {"rootIndex": 0, "relativePath": "source/second.safetensors"},
      ],
      0,
      "target",
      move_function=fake_move,
    )

    self.assertEqual(result["count"], 2)
    self.assertEqual(
      operations,
      [
        (str(first.resolve()), str((target_dir / first.name).resolve())),
        (str(second.resolve()), str((target_dir / second.name).resolve())),
      ],
    )
    self.assertTrue(first.is_file())
    self.assertTrue(second.is_file())

  def test_rejects_extension_mismatch_and_move_name_conflicts(self):
    source_dir = self.models_root / "source"
    target_dir = self.models_root / "target"
    source_dir.mkdir()
    target_dir.mkdir()
    (source_dir / "notes.txt").write_text("not a model", encoding="utf-8")
    (source_dir / "duplicate.safetensors").write_bytes(b"source")
    (target_dir / "duplicate.safetensors").write_bytes(b"target")
    operations = []

    with self.assertRaises(model_library.ModelPathError):
      model_library.move_model_files(
        self.categories,
        "loras",
        [{"rootIndex": 0, "relativePath": "source/notes.txt"}],
        0,
        "target",
        move_function=lambda source, destination: operations.append(
          (source, destination)
        ),
      )
    with self.assertRaises(FileExistsError):
      model_library.move_model_files(
        self.categories,
        "loras",
        [{"rootIndex": 0, "relativePath": "source/duplicate.safetensors"}],
        0,
        "target",
        move_function=lambda source, destination: operations.append(
          (source, destination)
        ),
      )

    self.assertEqual(operations, [])

  def test_discovers_all_models_directories_using_original_names(self):
    for name in (
      "audio_encoders",
      "configs",
      "FlashVSR-v1.1",
      "LLM",
      "RMBG",
      "ultralytics",
      "unet",
      "yolo",
    ):
      (self.models_root / name).mkdir()
    (self.models_root / "not-a-model-folder.txt").write_text(
      "ignored",
      encoding="utf-8",
    )
    mapping = {
      "configs": (
        [str(self.models_root / "configs")],
        [".yaml"],
      ),
      "diffusion_models": (
        [
          str(self.models_root / "unet"),
          str(self.models_root / "diffusion_models"),
        ],
        [".safetensors"],
      ),
      "custom_nodes": (
        [str(self.models_root.parent / "custom_nodes")],
        [],
      ),
    }

    categories = model_library.configured_model_categories(
      mapping,
      model_roots=[str(self.models_root)],
    )

    self.assertEqual(
      [category["name"] for category in categories],
      [
        "audio_encoders",
        "configs",
        "FlashVSR-v1.1",
        "LLM",
        "RMBG",
        "ultralytics",
        "unet",
        "yolo",
      ],
    )
    self.assertEqual(
      next(item for item in categories if item["name"] == "configs")["extensions"],
      [".yaml"],
    )
    self.assertEqual(
      next(item for item in categories if item["name"] == "unet")["extensions"],
      [".safetensors"],
    )

  def test_excludes_external_registered_roots_from_model_management(self):
    (self.models_root / "loras").mkdir()
    external_root = self.temp_path / "external-loras"
    external_root.mkdir()
    mapping = {
      "loras": (
        [
          str(self.models_root / "loras"),
          str(external_root),
        ],
        [".safetensors"],
      ),
    }

    categories = model_library.configured_model_categories(
      mapping,
      model_roots=[str(self.models_root)],
    )

    self.assertEqual([category["name"] for category in categories], ["loras"])
    self.assertEqual(
      [root["path"] for root in categories[0]["roots"]],
      [str((self.models_root / "loras").resolve())],
    )

  def test_rejects_parent_and_absolute_model_paths(self):
    for value in ("../outside.safetensors", "C:\\outside.safetensors"):
      with self.subTest(value=value):
        with self.assertRaises(model_library.ModelPathError):
          model_library.resolve_model_path(
            self.categories,
            "loras",
            0,
            value,
          )

  def test_duplicate_scan_groups_only_identical_content(self):
    first = self.models_root / "first.safetensors"
    second = self.models_root / "second.safetensors"
    different = self.models_root / "different.safetensors"
    first.write_bytes(b"same-model-bytes")
    second.write_bytes(b"same-model-bytes")
    different.write_bytes(b"different-model")

    result = model_library.scan_duplicate_models(self.categories)

    self.assertEqual(result["groupCount"], 1)
    self.assertEqual(result["fileCount"], 2)
    self.assertEqual(
      [item["relativePath"] for item in result["groups"][0]["items"]],
      ["first.safetensors", "second.safetensors"],
    )
    self.assertEqual(result["reclaimableBytes"], len(b"same-model-bytes"))

  def test_duplicate_scan_reports_progress_and_stops_when_cancelled(self):
    first = self.models_root / "first.safetensors"
    second = self.models_root / "second.safetensors"
    first.write_bytes(b"same-model-bytes")
    second.write_bytes(b"same-model-bytes")
    updates = []

    def cancel_when_hashing() -> bool:
      return any(
        update.get("phase") == "hashing"
        and int(update.get("hashedBytes") or 0) > 0
        for update in updates
      )

    with self.assertRaises(model_library.DuplicateScanCancelled):
      model_library.scan_duplicate_models(
        self.categories,
        progress_callback=updates.append,
        cancel_callback=cancel_when_hashing,
      )

    self.assertTrue(
      any(update.get("phase") == "discovering" for update in updates)
    )
    self.assertTrue(
      any(
        update.get("phase") == "hashing"
        and update.get("totalFilesToHash") == 2
        and update.get("totalBytesToHash") == len(b"same-model-bytes") * 2
        for update in updates
      )
    )
    self.assertGreater(max(int(update.get("hashedBytes") or 0) for update in updates), 0)

  def test_resolves_missing_models_by_path_name_and_hash(self):
    nested = self.models_root / "characters"
    nested.mkdir()
    payload = b"hero-model"
    hero = nested / "hero.safetensors"
    renamed = nested / "renamed-hero.safetensors"
    hero.write_bytes(payload)
    renamed.write_bytes(payload)

    result = model_library.resolve_missing_model_files(
      self.categories,
      [
        {
          "key": "path",
          "value": r"characters\hero.safetensors",
          "categories": ["loras"],
        },
        {
          "key": "name",
          "value": "hero.safetensors",
          "categories": ["loras"],
        },
        {
          "key": "hash",
          "value": "original-name.safetensors",
          "categories": ["loras"],
          "sha256": hashlib.sha256(payload).hexdigest(),
          "size": len(payload),
        },
      ],
    )

    by_key = {item["key"]: item for item in result["results"]}
    self.assertEqual(by_key["path"]["state"], "match")
    self.assertEqual(by_key["path"]["via"], "path")
    self.assertEqual(by_key["name"]["state"], "candidate")
    self.assertEqual(by_key["name"]["via"], "name")
    self.assertEqual(by_key["hash"]["state"], "match")
    self.assertEqual(by_key["hash"]["via"], "sha256")
    self.assertEqual(
      {
        item["relativePath"]
        for item in by_key["hash"]["candidates"]
      },
      {
        "characters/hero.safetensors",
        "characters/renamed-hero.safetensors",
      },
    )

  def test_missing_model_hash_mismatch_does_not_fall_back_to_name(self):
    same_name = self.models_root / "clip_l.safetensors"
    same_name.write_bytes(b"different-content")

    result = model_library.resolve_missing_model_files(
      self.categories,
      [
        {
          "key": "conflict",
          "value": "clip_l.safetensors",
          "categories": ["loras"],
          "sha256": hashlib.sha256(b"expected-content").hexdigest(),
        },
      ],
    )

    item = result["results"][0]
    self.assertEqual(item["state"], "conflict")
    self.assertEqual(item["via"], "sha256")
    self.assertEqual(item["candidates"], [])
    self.assertEqual(
      [candidate["relativePath"] for candidate in item["rejectedCandidates"]],
      ["clip_l.safetensors"],
    )

  def test_missing_model_with_multiple_names_requires_a_choice(self):
    first = self.models_root / "first"
    second = self.models_root / "second"
    first.mkdir()
    second.mkdir()
    (first / "same.safetensors").write_bytes(b"first")
    (second / "same.safetensors").write_bytes(b"second")

    result = model_library.resolve_missing_model_files(
      self.categories,
      [
        {
          "key": "ambiguous",
          "value": "same.safetensors",
          "categories": ["loras"],
        },
      ],
    )

    item = result["results"][0]
    self.assertEqual(item["state"], "ambiguous")
    self.assertEqual(len(item["candidates"]), 2)

  def test_recycle_requires_confirmation_and_uses_injected_operation(self):
    model = self.models_root / "disposable.safetensors"
    model.write_bytes(b"model")
    recycled = []

    with self.assertRaises(PermissionError):
      model_library.recycle_model_file(
        self.categories,
        "loras",
        0,
        "disposable.safetensors",
        confirm=False,
        recycle_function=lambda paths: recycled.extend(paths),
      )
    self.assertEqual(recycled, [])

    result = model_library.recycle_model_file(
      self.categories,
      "loras",
      0,
      "disposable.safetensors",
      confirm=True,
      recycle_function=lambda paths: recycled.extend(paths),
    )

    self.assertTrue(result["recycled"])
    self.assertEqual(recycled, [str(model.resolve())])
    self.assertTrue(model.is_file(), "The injected test operation must not delete files")

  def test_recycle_selected_models_in_one_confirmed_batch(self):
    first = self.models_root / "first.safetensors"
    second = self.models_root / "second.safetensors"
    first.write_bytes(b"first")
    second.write_bytes(b"second")
    batches = []
    items = [
      {"rootIndex": 0, "relativePath": "first.safetensors"},
      {"rootIndex": 0, "relativePath": "second.safetensors"},
    ]

    with self.assertRaises(PermissionError):
      model_library.recycle_model_files(
        self.categories,
        "loras",
        items,
        confirm=False,
        recycle_function=batches.append,
      )
    self.assertEqual(batches, [])

    result = model_library.recycle_model_files(
      self.categories,
      "loras",
      items,
      confirm=True,
      recycle_function=batches.append,
    )

    self.assertEqual(result["count"], 2)
    self.assertEqual(
      batches,
      [[str(first.resolve()), str(second.resolve())]],
    )
    self.assertTrue(first.is_file())
    self.assertTrue(second.is_file())


if __name__ == "__main__":
  unittest.main()
