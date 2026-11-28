import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest import mock


PACKAGE_ROOT = Path(__file__).resolve().parents[1]


class FakeLoraLoader:
  calls = []

  def load_lora(self, model, clip, lora, strength_model, strength_clip):
    self.calls.append((model, clip, lora, strength_model, strength_clip))
    return (f"model:{lora}", f"clip:{lora}")


fake_nodes = types.ModuleType("nodes")
fake_nodes.LoraLoader = FakeLoraLoader
sys.modules["nodes"] = fake_nodes

spec = importlib.util.spec_from_file_location("asset_nodes", PACKAGE_ROOT / "nodes.py")
asset_nodes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(asset_nodes)


class TriggerWordTests(unittest.TestCase):
  def setUp(self):
    FakeLoraLoader.calls.clear()

  def test_node_registration(self):
    self.assertEqual(
      asset_nodes.AstralAssetLoraLoader.NAME,
      "LoRA Stack Loader",
    )
    self.assertIn("LoRA Stack Loader", asset_nodes.NODE_CLASS_MAPPINGS)
    self.assertEqual(
      asset_nodes.NODE_DISPLAY_NAME_MAPPINGS["LoRA Stack Loader"],
      "LoRA Stack Loader",
    )
    self.assertEqual(
      asset_nodes.AstralAssetLoraLoader.RETURN_NAMES,
      ("MODEL", "CLIP", "STRING"),
    )

  def test_collects_checked_trimmed_triggers_in_row_and_number_order(self):
    inputs = {
      "lora_10": {
        "triggers": [
          {"enabled": True, "text": " ten "},
          {"enabled": True, "text": "later row"},
        ],
      },
      "lora_2": {
        "triggers": [
          {"enabled": True, "text": "two"},
          {"enabled": False, "text": "not selected"},
          {"enabled": True, "text": "  "},
          {"enabled": True, "text": "four"},
          {"enabled": True, "text": "five"},
          {"enabled": True, "text": "past the limit"},
        ],
      },
    }

    self.assertEqual(
      asset_nodes.collect_trigger_words(inputs),
      "ten,later row,two,four,five,past the limit,",
    )

  def test_collects_at_most_six_trigger_slots(self):
    inputs = {
      "lora_1": {
        "triggers": [
          {"enabled": True, "text": "one"},
          {"enabled": True, "text": "two"},
          {"enabled": True, "text": "three"},
          {"enabled": True, "text": "four"},
          {"enabled": True, "text": "five"},
          {"enabled": True, "text": "six"},
          {"enabled": True, "text": "ignored"},
        ],
      },
    }

    self.assertEqual(
      asset_nodes.collect_trigger_words(inputs),
      "one,two,three,four,five,six,",
    )

  def test_empty_output_has_no_trailing_comma(self):
    inputs = {
      "lora_1": {
        "triggers": [
          {"enabled": False, "text": "ignored"},
          {"enabled": True, "text": ""},
        ],
      },
    }

    self.assertEqual(asset_nodes.collect_trigger_words(inputs), "")

  def test_loads_loras_in_visual_order_with_expected_strengths(self):
    loader = asset_nodes.AstralAssetLoraLoader()
    result = loader.load_loras(
      model="model",
      clip="clip",
      lora_9={
        "on": True,
        "lora": "first.safetensors",
        "strength": 0.75,
        "strengthTwo": 0.5,
        "triggers": [{"enabled": True, "text": "first"}],
      },
      lora_2={
        "on": True,
        "lora": "second.safetensors",
        "strength": 1.25,
        "strengthTwo": None,
        "triggers": [{"enabled": True, "text": "second"}],
      },
    )

    self.assertEqual(
      FakeLoraLoader.calls,
      [
        ("model", "clip", "first.safetensors", 0.75, 0.5),
        ("model:first.safetensors", "clip:first.safetensors", "second.safetensors", 1.25, 1.25),
      ],
    )
    self.assertEqual(
      result,
      (
        "model:second.safetensors",
        "clip:second.safetensors",
        "first,second,",
      ),
    )

  def test_disabled_lora_does_not_load_but_checked_triggers_still_output(self):
    loader = asset_nodes.AstralAssetLoraLoader()
    result = loader.load_loras(
      model="model",
      clip="clip",
      lora_1={
        "on": False,
        "lora": "disabled.safetensors",
        "strength": 1,
        "triggers": [{"enabled": True, "text": "selected"}],
      },
    )

    self.assertEqual(FakeLoraLoader.calls, [])
    self.assertEqual(result, ("model", "clip", "selected,"))


class NodeRegistrationTests(unittest.TestCase):
  def test_combo_clone_is_not_registered(self):
    self.assertNotIn("Combo Clone", asset_nodes.NODE_CLASS_MAPPINGS)
    self.assertNotIn("Combo Clone", asset_nodes.NODE_DISPLAY_NAME_MAPPINGS)
    self.assertFalse(hasattr(asset_nodes, "AstralComboClone"))

  def test_anything_everywhere_is_not_registered(self):
    self.assertNotIn("Anything Everywhere", asset_nodes.NODE_CLASS_MAPPINGS)
    self.assertNotIn("Anything Everywhere", asset_nodes.NODE_DISPLAY_NAME_MAPPINGS)
    self.assertFalse(hasattr(asset_nodes, "AstralAnythingEverywhere"))

  def test_prompt_expert_is_registered_outside_nodes(self):
    self.assertNotIn("Prompt Processor", asset_nodes.NODE_CLASS_MAPPINGS)
    self.assertFalse(hasattr(asset_nodes, "AstralPromptExpert"))

  def test_typed_bypass_switch_is_not_registered(self):
    self.assertNotIn("Typed Bypass Switch", asset_nodes.NODE_CLASS_MAPPINGS)
    self.assertNotIn("Typed Bypass Switch", asset_nodes.NODE_DISPLAY_NAME_MAPPINGS)
    self.assertFalse(hasattr(asset_nodes, "AstralTypedBypassSwitch"))

class StringModeSelectorTests(unittest.TestCase):
  def test_node_registration_and_ports(self):
    selector_class = asset_nodes.AstralStringModeSelector
    inputs = selector_class.INPUT_TYPES()

    self.assertEqual(selector_class.NAME, "String Mode Selector")
    self.assertIn("String Mode Selector", asset_nodes.NODE_CLASS_MAPPINGS)
    self.assertEqual(
      asset_nodes.NODE_DISPLAY_NAME_MAPPINGS["String Mode Selector"],
      "String Mode Selector",
    )
    self.assertNotIn("optional", inputs)
    self.assertEqual(
      selector_class.RETURN_TYPES,
      ("STRING",),
    )
    self.assertEqual(
      selector_class.RETURN_NAMES,
      ("STRING",),
    )
    self.assertEqual(selector_class.FUNCTION, "select_string")

  def test_returns_selected_prompt_unchanged(self):
    selector = asset_nodes.AstralStringModeSelector()
    prompt = "portrait, cinematic lighting, detailed skin,"

    self.assertEqual(selector.select_string(prompt), (prompt,))
    self.assertEqual(selector.select_string(None), ("",))
    self.assertEqual(selector.select_string(123), ("123",))


class AssetPromptNodeTests(unittest.TestCase):
  def test_prompt_node_is_registered(self):
    node_name = "System Prompt"
    self.assertIn(node_name, asset_nodes.NODE_CLASS_MAPPINGS)
    self.assertEqual(
      asset_nodes.NODE_DISPLAY_NAME_MAPPINGS[node_name],
      "System Prompt",
    )

  def test_legacy_prompt_api_id_is_not_registered(self):
    for mapping in (
      asset_nodes.NODE_CLASS_MAPPINGS,
      asset_nodes.NODE_DISPLAY_NAME_MAPPINGS,
    ):
      self.assertNotIn("Assets Astral Prompt", mapping)

  def test_node_keys_do_not_mention_assets(self):
    for mapping in (
      asset_nodes.NODE_CLASS_MAPPINGS,
      asset_nodes.NODE_DISPLAY_NAME_MAPPINGS,
    ):
      for node_name in mapping:
        self.assertNotIn("assets", node_name.lower(), node_name)

  def test_chat_nodes_are_not_registered(self):
    for node_name in (
      "Assets Astral Chat Input",
      "Assets Astral Chat Output",
    ):
      with self.subTest(node_name=node_name):
        self.assertNotIn(node_name, asset_nodes.NODE_CLASS_MAPPINGS)
        self.assertNotIn(node_name, asset_nodes.NODE_DISPLAY_NAME_MAPPINGS)

  def test_prompt_node_returns_prompt_as_string(self):
    prompt = asset_nodes.AstralPrompt()
    self.assertEqual(prompt.get_prompt("Title", "portrait, soft light"), ("portrait, soft light",))
    self.assertEqual(prompt.get_prompt("Title", None), ("",))


class PromptAttachmentTests(unittest.TestCase):
  def test_media_categories_have_independent_limits_and_audio_conversion(self):
    import base64
    import wave
    from io import BytesIO
    import numpy as np

    image = np.zeros((12, 12, 16, 3), dtype=np.float32)
    image_batch = np.ones((4, 8, 8, 3), dtype=np.float32)
    video = {"images": np.ones((8, 12, 16, 3), dtype=np.float32)}
    video_2 = {"frames": np.ones((8, 12, 16, 3), dtype=np.float32)}
    video_3 = {"images": np.ones((8, 12, 16, 3), dtype=np.float32)}
    audio = {
      "waveform": np.zeros((1, 1, 800), dtype=np.float32),
      "sample_rate": 8000,
    }
    audio_2 = {
      "waveform": np.ones((1, 1, 800), dtype=np.float32) * 0.25,
      "sample_rate": 8000,
    }
    audio_3 = {
      "waveform": np.ones((1, 1, 800), dtype=np.float32) * -0.25,
      "sample_rate": 8000,
    }

    attachments = asset_nodes.build_prompt_processor_attachments(
      image,
      video,
      image_2=image_batch,
      video_2=video_2,
      video_3=video_3,
      audio=audio,
      audio_2=audio_2,
      audio_3=audio_3,
    )

    image_attachments = [
      attachment
      for attachment in attachments
      if attachment["kind"] == "image"
    ]
    audio_attachments = [
      attachment
      for attachment in attachments
      if attachment["kind"] == "audio"
    ]
    self.assertEqual(len(image_attachments), 27)
    self.assertEqual(len(audio_attachments), 3)
    self.assertEqual(image_attachments[0]["name"], "image-1.jpg")
    self.assertEqual(image_attachments[8]["name"], "image-9.jpg")
    self.assertEqual(
      image_attachments[9]["name"],
      "video-1-frame-1.jpg",
    )
    self.assertEqual(
      image_attachments[-1]["name"],
      "video-3-frame-6.jpg",
    )
    for attachment in image_attachments:
      self.assertEqual(attachment["kind"], "image")
      self.assertEqual(attachment["mimeType"], "image/jpeg")
      self.assertTrue(
        attachment["data"].startswith("data:image/jpeg;base64,")
      )
    self.assertEqual(
      [attachment["name"] for attachment in audio_attachments],
      ["audio-1.wav", "audio-2.wav", "audio-3.wav"],
    )
    payload = base64.b64decode(
      audio_attachments[1]["data"].split(",", 1)[1]
    )
    with wave.open(BytesIO(payload), "rb") as decoded:
      self.assertEqual(decoded.getnchannels(), 1)
      self.assertEqual(decoded.getsampwidth(), 2)
      self.assertEqual(decoded.getframerate(), 8000)
      self.assertEqual(decoded.getnframes(), 800)


if __name__ == "__main__":
  unittest.main()
