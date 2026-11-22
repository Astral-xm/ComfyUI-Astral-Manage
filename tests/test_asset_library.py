import json
import os
import shutil
import sys
import unittest
import uuid
from pathlib import Path
from unittest import mock

from PIL import Image, PngImagePlugin

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
  sys.path.insert(0, str(PACKAGE_ROOT))

import asset_library


class AssetLibraryTests(unittest.TestCase):
  def setUp(self):
    self.temp_path = (
      PACKAGE_ROOT
      / ".asset-library-tests"
      / f"case-{uuid.uuid4().hex}"
    )
    self.input_root = self.temp_path / "input"
    self.output_root = self.temp_path / "output"
    self.input_root.mkdir(parents=True)
    self.output_root.mkdir(parents=True)

  def tearDown(self):
    shutil.rmtree(self.temp_path, ignore_errors=True)

  def test_rejects_absolute_and_parent_paths(self):
    with self.assertRaises(asset_library.AssetPathError):
      asset_library.resolve_asset_path(
        "input",
        "../secret.png",
        str(self.input_root),
        str(self.output_root),
      )
    with self.assertRaises(asset_library.AssetPathError):
      asset_library.resolve_asset_path(
        "input",
        r"C:\Windows\secret.png",
        str(self.input_root),
        str(self.output_root),
      )

  def test_workspace_browser_lists_directories_and_files_safely(self):
    workflows = self.temp_path / "workflows"
    nested = workflows / "nested"
    nested.mkdir(parents=True)
    (workflows / "base.json").write_text("{}", encoding="utf-8")
    (nested / "child.json").write_text("{}", encoding="utf-8")

    roots = {"workflows": str(workflows)}
    result = asset_library.list_workspace_entries(
      "workflows",
      "",
      roots,
    )

    self.assertEqual(result["root"], "workflows")
    self.assertEqual(result["directoryCount"], 1)
    self.assertEqual(result["fileCount"], 1)
    self.assertEqual(
      [item["name"] for item in result["items"]],
      ["nested", "base.json"],
    )
    self.assertEqual(
      asset_library.resolve_workspace_directory(
        "workflows",
        "nested",
        roots,
      ),
      str(nested.resolve()),
    )
    with self.assertRaises(asset_library.AssetPathError):
      asset_library.resolve_workspace_directory(
        "workflows",
        "../outside",
        roots,
      )
    with self.assertRaises(asset_library.AssetPathError):
      asset_library.resolve_workspace_directory(
        "outside",
        "",
        roots,
      )

  def test_lists_filters_and_paginates_images_and_videos(self):
    (self.input_root / "portrait.png").write_bytes(b"not read while listing")
    (self.output_root / "nested").mkdir()
    (self.output_root / "nested" / "clip.mp4").write_bytes(b"video")
    (self.output_root / "notes.txt").write_text("ignored", encoding="utf-8")

    result = asset_library.list_assets(
      str(self.input_root),
      str(self.output_root),
      root_filter="all",
      kind_filter="video",
      query="clip",
      limit=10,
    )

    self.assertEqual(result["total"], 1)
    self.assertEqual(result["items"][0]["root"], "output")
    self.assertEqual(result["items"][0]["path"], "nested/clip.mp4")
    self.assertEqual(result["items"][0]["kind"], "video")

  def test_exact_path_lists_only_direct_files(self):
    (self.input_root / "root.png").write_bytes(b"image")
    (self.output_root / "direct.png").write_bytes(b"image")
    (self.output_root / "direct.mp4").write_bytes(b"video")
    (self.output_root / "nested").mkdir()
    (self.output_root / "nested" / "clip.mp4").write_bytes(b"video")
    (self.output_root / "nested" / "deeper").mkdir()
    (self.output_root / "nested" / "deeper" / "frame.png").write_bytes(b"image")

    root_result = asset_library.list_assets(
      str(self.input_root),
      str(self.output_root),
      root_filter="output",
      exact_path=True,
      limit=10,
    )
    nested_result = asset_library.list_assets(
      str(self.input_root),
      str(self.output_root),
      root_filter="output",
      relative_path="nested",
      exact_path=True,
      limit=10,
    )

    self.assertEqual(
      {item["path"] for item in root_result["items"]},
      {"direct.png", "direct.mp4"},
    )
    self.assertEqual(
      {item["path"] for item in nested_result["items"]},
      {"nested/clip.mp4"},
    )

  def test_reads_api_prompt_and_loadable_ui_workflow_from_png(self):
    api_prompt = {
      "1": {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": "cinematic portrait, soft light"},
      },
      "2": {
        "class_type": "KSampler",
        "inputs": {"positive": ["1", 0], "negative": ["3", 0]},
      },
      "3": {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": "blurry"},
      },
    }
    workflow = {
      "nodes": [
        {
          "id": 1,
          "type": "CLIPTextEncode",
          "widgets_values": ["cinematic portrait, soft light"],
          "inputs": [],
        },
        {
          "id": 2,
          "type": "KSampler",
          "widgets_values": [],
          "inputs": [{"name": "positive", "link": 10}],
        },
      ],
      "links": [[10, 1, 0, 2, 0, "CONDITIONING"]],
    }
    png_info = PngImagePlugin.PngInfo()
    png_info.add_text("prompt", json.dumps(api_prompt))
    png_info.add_text("workflow", json.dumps(workflow))
    image_path = self.output_root / "result.png"
    Image.new("RGB", (32, 24), "#336699").save(image_path, pnginfo=png_info)

    detail = asset_library.read_asset_detail(
      "output",
      "result.png",
      str(self.input_root),
      str(self.output_root),
    )

    self.assertEqual(detail["prompt"], "cinematic portrait, soft light")
    self.assertTrue(detail["metadata"]["hasPrompt"])
    self.assertTrue(detail["metadata"]["hasWorkflow"])
    self.assertTrue(detail["metadata"]["hasApiPrompt"])
    self.assertEqual(detail["workflow"]["data"], workflow)

  def test_reads_api_prompt_through_switch_and_recorded_text_helper(self):
    api_prompt = {
      "1": {
        "class_type": "PrimitiveStringMultiline",
        "inputs": {"value": "user prompt"},
      },
      "2": {
        "class_type": "TextGenerate",
        "inputs": {"prompt": ["1", 0], "system_prompt": "ignore me"},
      },
      "3": {
        "class_type": "ComfySwitchNode",
        "inputs": {"switch": True, "on_true": ["2", 0], "on_false": ["1", 0]},
      },
      "4": {
        "class_type": "PreviewAny",
        "inputs": {"source": ["3", 0]},
      },
      "5": {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": ["4", 0]},
      },
      "6": {
        "class_type": "ShowText|pysssss",
        "inputs": {"text_0": "recorded final prompt", "text": ["2", 0]},
      },
      "7": {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": ["6", 0]},
      },
      "8": {
        "class_type": "KSampler",
        "inputs": {
          "positive": ["5", 0],
          "negative": ["7", 0],
        },
      },
    }
    workflow = {"nodes": [], "links": []}
    png_info = PngImagePlugin.PngInfo()
    png_info.add_text("prompt", json.dumps(api_prompt))
    png_info.add_text("workflow", json.dumps(workflow))
    image_path = self.output_root / "switch.png"
    Image.new("RGB", (24, 24), "#222222").save(image_path, pnginfo=png_info)

    detail = asset_library.read_asset_detail(
      "output",
      "switch.png",
      str(self.input_root),
      str(self.output_root),
    )

    self.assertEqual(detail["promptCandidates"], ["user prompt"])

    api_prompt["8"]["inputs"]["positive"] = ["7", 0]
    png_info = PngImagePlugin.PngInfo()
    png_info.add_text("prompt", json.dumps(api_prompt))
    png_info.add_text("workflow", json.dumps(workflow))
    Image.new("RGB", (24, 24), "#333333").save(
      image_path,
      pnginfo=png_info,
    )

    detail = asset_library.read_asset_detail(
      "output",
      "switch.png",
      str(self.input_root),
      str(self.output_root),
    )
    self.assertEqual(detail["promptCandidates"], ["recorded final prompt"])

  def test_reads_workflow_from_sidecar_and_creates_thumbnail(self):
    image_path = self.output_root / "frame.webp"
    Image.new("RGB", (64, 48), "#884422").save(image_path, "WEBP")
    workflow = {"nodes": [{"id": 1, "type": "KSampler"}], "links": []}
    (self.output_root / "frame.workflow.json").write_text(
      json.dumps(workflow),
      encoding="utf-8",
    )

    detail = asset_library.read_asset_detail(
      "output",
      "frame.webp",
      str(self.input_root),
      str(self.output_root),
    )
    thumbnail = asset_library.create_thumbnail(
      str(image_path),
      str(self.temp_path / "thumbs"),
      "frame-token",
    )

    self.assertTrue(detail["metadata"]["hasWorkflow"])
    self.assertIn("frame.workflow.json", detail["metadata"]["sidecars"])
    self.assertTrue(Path(thumbnail).is_file())
    self.assertEqual(Path(thumbnail).suffix, ".webp")

  def test_batch_renames_images_with_incrementing_prefix(self):
    nested = self.input_root / "nested"
    nested.mkdir()
    (nested / "first.png").write_bytes(b"png")
    (nested / "second.webp").write_bytes(b"webp")

    result = asset_library.rename_asset_files(
      str(self.input_root),
      str(self.output_root),
      [
        {"root": "input", "path": "nested/first.png"},
        {"root": "input", "path": "nested/second.webp"},
      ],
      mode="prefix",
      prefix="image",
    )

    self.assertEqual(result["count"], 2)
    self.assertTrue((nested / "image1.png").is_file())
    self.assertTrue((nested / "image2.webp").is_file())
    self.assertFalse((nested / "first.png").exists())
    self.assertEqual(
      [item["path"] for item in result["items"]],
      ["nested/image1.png", "nested/image2.webp"],
    )

  def test_rename_rejects_extension_changes(self):
    image = self.input_root / "original.png"
    image.write_bytes(b"image")

    with self.assertRaises(asset_library.AssetPathError):
      asset_library.rename_asset_files(
        str(self.input_root),
        str(self.output_root),
        [{"root": "input", "path": "original.png"}],
        mode="single",
        new_name="renamed.jpg",
      )
    self.assertTrue(image.is_file())

  def test_recycles_confirmed_selection_with_injected_operation(self):
    first = self.input_root / "one.png"
    second = self.output_root / "two.png"
    first.write_bytes(b"one")
    second.write_bytes(b"two")
    recycled = []

    result = asset_library.recycle_asset_files(
      str(self.input_root),
      str(self.output_root),
      [
        {"root": "input", "path": "one.png"},
        {"root": "output", "path": "two.png"},
      ],
      confirm=True,
      recycle_function=recycled.extend,
    )

    self.assertEqual(result["count"], 2)
    self.assertEqual(
      {Path(path) for path in recycled},
      {first.resolve(), second.resolve()},
    )
    self.assertTrue(first.is_file())
    self.assertTrue(second.is_file())

  def test_resolves_file_and_folder_for_external_file_manager(self):
    folder = self.output_root / "archive"
    folder.mkdir()
    image = folder / "frame.png"
    image.write_bytes(b"image")

    selected, selected_kind = asset_library.resolve_asset_open_target(
      "output",
      "archive/frame.png",
      str(self.input_root),
      str(self.output_root),
      select=True,
    )
    opened, opened_kind = asset_library.resolve_asset_open_target(
      "output",
      "archive",
      str(self.input_root),
      str(self.output_root),
      select=False,
    )

    self.assertEqual(selected, str(image.resolve()))
    self.assertEqual(selected_kind, "file")
    self.assertEqual(opened, str(folder.resolve()))
    self.assertEqual(opened_kind, "directory")

  @unittest.skipUnless(os.name == "nt", "Windows Explorer path formatting")
  def test_opens_file_selection_with_one_explorer_argument(self):
    folder = self.output_root / "folder with spaces"
    folder.mkdir()
    image = folder / "frame 1.png"
    image.write_bytes(b"image")

    with (
      mock.patch("asset_library.subprocess.Popen") as popen,
      mock.patch(
        "asset_library._focus_windows_explorer",
        return_value=True,
      ) as focus,
    ):
      asset_library.open_asset_target(str(image), "file")

    popen.assert_called_once_with(
      ["explorer.exe", f"/select,{os.path.abspath(image)}"],
      close_fds=True,
    )
    focus.assert_called_once_with(os.path.dirname(os.path.abspath(image)))

  @unittest.skipUnless(os.name == "nt", "Windows Explorer path formatting")
  def test_opens_directory_and_brings_explorer_to_front(self):
    folder = self.output_root / "folder with spaces"
    folder.mkdir()

    with (
      mock.patch("asset_library.os.startfile") as startfile,
      mock.patch(
        "asset_library._focus_windows_explorer",
        return_value=True,
      ) as focus,
    ):
      asset_library.open_asset_target(str(folder), "directory")

    startfile.assert_called_once_with(os.path.abspath(folder))
    focus.assert_called_once_with(os.path.abspath(folder))

  def test_reveals_file_in_macos_finder(self):
    image = self.output_root / "frame 1.png"
    image.write_bytes(b"image")

    with (
      mock.patch.object(asset_library.sys, "platform", "darwin"),
      mock.patch(
        "asset_library.shutil.which",
        return_value="/usr/bin/open",
      ),
      mock.patch("asset_library.subprocess.Popen") as popen,
      mock.patch(
        "asset_library._activate_macos_finder",
        return_value=True,
      ) as activate,
    ):
      reveal_mode = asset_library.open_asset_target(str(image), "file")

    self.assertEqual(reveal_mode, "selected")
    popen.assert_called_once_with(
      ["/usr/bin/open", "-R", os.path.abspath(image)],
      close_fds=True,
    )
    activate.assert_called_once_with()

  def test_opens_directory_in_macos_finder(self):
    folder = self.output_root / "folder with spaces"
    folder.mkdir()

    with (
      mock.patch.object(asset_library.sys, "platform", "darwin"),
      mock.patch(
        "asset_library.shutil.which",
        return_value="/usr/bin/open",
      ),
      mock.patch("asset_library.subprocess.Popen") as popen,
      mock.patch(
        "asset_library._activate_macos_finder",
        return_value=True,
      ) as activate,
    ):
      reveal_mode = asset_library.open_asset_target(str(folder), "directory")

    self.assertEqual(reveal_mode, "opened")
    popen.assert_called_once_with(
      ["/usr/bin/open", os.path.abspath(folder)],
      close_fds=True,
    )
    activate.assert_called_once_with()

  def test_activates_macos_finder_with_osascript(self):
    with (
      mock.patch(
        "asset_library.shutil.which",
        return_value="/usr/bin/osascript",
      ),
      mock.patch(
        "asset_library.subprocess.run",
        return_value=mock.Mock(returncode=0),
      ) as run,
    ):
      activated = asset_library._activate_macos_finder()

    self.assertTrue(activated)
    command = run.call_args.args[0]
    self.assertEqual(command[:2], ["/usr/bin/osascript", "-e"])
    self.assertIn('tell application "Finder" to activate', command[2])

  def test_reveals_file_with_linux_file_manager1(self):
    image = self.output_root / "frame 1.png"
    image.write_bytes(b"image")

    def which(command):
      return "/usr/bin/gdbus" if command == "gdbus" else None

    completed = mock.Mock(returncode=0)
    with (
      mock.patch.object(asset_library.sys, "platform", "linux"),
      mock.patch("asset_library.shutil.which", side_effect=which),
      mock.patch(
        "asset_library.subprocess.run",
        return_value=completed,
      ) as run,
      mock.patch("asset_library.subprocess.Popen") as popen,
      mock.patch(
        "asset_library._activate_linux_file_manager_window",
        return_value=True,
      ) as activate,
    ):
      reveal_mode = asset_library.open_asset_target(str(image), "file")

    self.assertEqual(reveal_mode, "selected")
    popen.assert_not_called()
    activate.assert_called_once_with(os.path.abspath(image))
    command = run.call_args.args[0]
    self.assertEqual(command[0], "/usr/bin/gdbus")
    self.assertIn("org.freedesktop.FileManager1.ShowItems", command)
    self.assertIn(
      f"['{Path(os.path.abspath(image)).as_uri()}']",
      command,
    )

  def test_linux_selection_falls_back_to_parent_directory(self):
    image = self.output_root / "frame 1.png"
    image.write_bytes(b"image")

    def which(command):
      return {
        "gdbus": "/usr/bin/gdbus",
        "xdg-open": "/usr/bin/xdg-open",
      }.get(command)

    with (
      mock.patch.object(asset_library.sys, "platform", "linux"),
      mock.patch("asset_library.shutil.which", side_effect=which),
      mock.patch(
        "asset_library.subprocess.run",
        return_value=mock.Mock(returncode=1),
      ),
      mock.patch("asset_library.subprocess.Popen") as popen,
      mock.patch(
        "asset_library._activate_linux_file_manager_window",
        return_value=True,
      ) as activate,
    ):
      reveal_mode = asset_library.open_asset_target(str(image), "file")

    self.assertEqual(reveal_mode, "parent-opened")
    popen.assert_called_once_with(
      ["/usr/bin/xdg-open", os.path.dirname(os.path.abspath(image))],
      close_fds=True,
    )
    activate.assert_called_once_with(os.path.dirname(os.path.abspath(image)))

  def test_opens_directory_with_linux_xdg_open(self):
    folder = self.output_root / "folder with spaces"
    folder.mkdir()

    with (
      mock.patch.object(asset_library.sys, "platform", "linux"),
      mock.patch(
        "asset_library.shutil.which",
        return_value="/usr/bin/xdg-open",
      ),
      mock.patch("asset_library.subprocess.Popen") as popen,
      mock.patch(
        "asset_library._activate_linux_file_manager_window",
        return_value=True,
      ) as activate,
    ):
      reveal_mode = asset_library.open_asset_target(str(folder), "directory")

    self.assertEqual(reveal_mode, "opened")
    popen.assert_called_once_with(
      ["/usr/bin/xdg-open", os.path.abspath(folder)],
      close_fds=True,
    )
    activate.assert_called_once_with(os.path.abspath(folder))

  def test_activates_linux_file_manager_window_with_wmctrl(self):
    folder = self.output_root / "folder with spaces"
    folder.mkdir()
    listing = mock.Mock(
      returncode=0,
      stdout=(
        "0x001 0 browser.Browser host folder with spaces\n"
        "0x002 0 org.gnome.Nautilus.Nautilus host folder with spaces\n"
      ),
    )

    def run(command, **_kwargs):
      if command[1:] == ["-l", "-x"]:
        return listing
      if command[1:] == ["-i", "-a", "0x002"]:
        return mock.Mock(returncode=0)
      return mock.Mock(returncode=1)

    with (
      mock.patch(
        "asset_library.shutil.which",
        side_effect=lambda command: (
          "/usr/bin/wmctrl" if command == "wmctrl" else None
        ),
      ),
      mock.patch("asset_library.subprocess.run", side_effect=run),
    ):
      activated = asset_library._activate_linux_file_manager_window(
        str(folder)
      )

    self.assertTrue(activated)

  def test_activates_linux_file_manager_window_with_xdotool(self):
    folder = self.output_root / "folder with spaces"
    folder.mkdir()

    def run(command, **_kwargs):
      if command[1:3] == ["search", "--onlyvisible"]:
        return mock.Mock(returncode=0, stdout="401\n")
      if command[1:2] == ["getwindowclassname"]:
        return mock.Mock(returncode=0, stdout="org.gnome.Nautilus\n")
      if command[1:2] == ["windowactivate"]:
        return mock.Mock(returncode=0)
      return mock.Mock(returncode=1)

    with (
      mock.patch(
        "asset_library.shutil.which",
        side_effect=lambda command: (
          "/usr/bin/xdotool" if command == "xdotool" else None
        ),
      ),
      mock.patch("asset_library.subprocess.run", side_effect=run),
    ):
      activated = asset_library._activate_linux_file_manager_window(
        str(folder)
      )

    self.assertTrue(activated)

  def test_linux_reports_missing_xdg_open(self):
    folder = self.output_root / "folder with spaces"
    folder.mkdir()

    with (
      mock.patch.object(asset_library.sys, "platform", "linux"),
      mock.patch("asset_library.shutil.which", return_value=None),
    ):
      with self.assertRaisesRegex(FileNotFoundError, "xdg-utils"):
        asset_library.open_asset_target(str(folder), "directory")

  def test_matches_explorer_file_url_to_folder_case_insensitively(self):
    folder = self.output_root / "folder with spaces"
    folder.mkdir()
    location = folder.resolve().as_uri().replace(
      "folder%20with%20spaces",
      "folder with spaces",
    )

    self.assertTrue(
      asset_library._explorer_location_matches(location, str(folder))
    )
    self.assertFalse(
      asset_library._explorer_location_matches(
        (self.output_root / "another folder").resolve().as_uri(),
        str(folder),
      )
    )


if __name__ == "__main__":
  unittest.main()
