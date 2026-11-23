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


class UseEverywhereNodeTests(unittest.TestCase):
  def test_anything_everywhere_keeps_upstream_type_id(self):
    self.assertIs(
      asset_nodes.NODE_CLASS_MAPPINGS["Anything Everywhere"],
      asset_nodes.AstralAnythingEverywhere,
    )
    self.assertEqual(
      asset_nodes.NODE_DISPLAY_NAME_MAPPINGS["Anything Everywhere"],
      "Anything Everywhere (Astral)",
    )

  def test_combo_clone_is_not_registered(self):
    self.assertNotIn("Combo Clone", asset_nodes.NODE_CLASS_MAPPINGS)
    self.assertNotIn("Combo Clone", asset_nodes.NODE_DISPLAY_NAME_MAPPINGS)
    self.assertFalse(hasattr(asset_nodes, "AstralComboClone"))

  def test_anything_everywhere_accepts_dynamic_wildcard_inputs(self):
    node_class = asset_nodes.AstralAnythingEverywhere
    optional = node_class.INPUT_TYPES()["optional"]

    self.assertIn("anything", optional)
    self.assertIn("anything13", optional)
    self.assertIsInstance(optional["anything13"][0], asset_nodes.AnyType)
    self.assertEqual(optional["anything13"][0], "*")
    self.assertEqual(node_class.RETURN_TYPES, ())
    self.assertEqual(node_class.FUNCTION, "execute")
    self.assertEqual(asset_nodes.AstralAnythingEverywhere().execute(), ())

class TypedBypassSwitchTests(unittest.TestCase):
  def test_node_registration(self):
    switch_class = asset_nodes.AstralTypedBypassSwitch
    self.assertEqual(switch_class.NAME, "Typed Bypass Switch")
    self.assertIn("Typed Bypass Switch", asset_nodes.NODE_CLASS_MAPPINGS)
    self.assertEqual(
      asset_nodes.NODE_DISPLAY_NAME_MAPPINGS["Typed Bypass Switch"],
      "Typed Bypass Switch",
    )
    self.assertEqual(switch_class.RETURN_NAMES, ("*",))
    self.assertEqual(switch_class.FUNCTION, "switch")

  def test_parses_and_deduplicates_enabled_slots(self):
    self.assertEqual(
      asset_nodes.parse_enabled_slots("2, 1,2, invalid, 0, 3"),
      [2, 1, 3],
    )
    self.assertEqual(asset_nodes.parse_enabled_slots([3, "1", None, -1]), [3, 1])

  def test_first_enabled_input_wins(self):
    switch = asset_nodes.AstralTypedBypassSwitch()
    result = switch.switch(
      enabled_slots="2,1",
      input_1="first",
      input_2="second",
      input_3="third",
    )
    self.assertEqual(result, ("second",))

  def test_disabled_inputs_are_ignored(self):
    switch = asset_nodes.AstralTypedBypassSwitch()
    result = switch.switch(
      enabled_slots="2,3",
      input_1="first",
      input_2=None,
      input_3="third",
    )
    self.assertEqual(result, (None,))

  def test_only_enabled_inputs_are_output(self):
    switch = asset_nodes.AstralTypedBypassSwitch()
    result = switch.switch(
      enabled_slots="2",
      input_1="first",
      input_2=None,
      input_3="third",
    )
    self.assertEqual(result, (None,))

    result = switch.switch(
      enabled_slots="9",
      input_1=None,
      input_2="second",
    )
    self.assertEqual(result, (None,))

  def test_empty_inputs_return_none(self):
    switch = asset_nodes.AstralTypedBypassSwitch()
    self.assertEqual(switch.switch(enabled_slots="", input_1=None), (None,))


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
    node_name = "Assets Prompt"
    self.assertIn(node_name, asset_nodes.NODE_CLASS_MAPPINGS)
    self.assertEqual(
      asset_nodes.NODE_DISPLAY_NAME_MAPPINGS[node_name],
      node_name,
    )
    self.assertIs(
      asset_nodes.NODE_CLASS_MAPPINGS["Assets Astral Prompt"],
      asset_nodes.NODE_CLASS_MAPPINGS[node_name],
    )

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


class PromptProcessorTests(unittest.TestCase):
  def setUp(self):
    self.patch_data = mock.patch.object(
      asset_nodes,
      "_prompt_processor_data_directory",
      return_value="/fake/data",
    )
    self.patch_clear = mock.patch.object(
      asset_nodes,
      "_clear_prompt_processor_vram",
      return_value="",
    )
    self.patch_task = mock.patch.object(
      asset_nodes,
      "_run_prompt_processor_task",
    )
    self.patch_data.start()
    self.clear = self.patch_clear.start()
    self.task = self.patch_task.start()
    self.addCleanup(self.patch_task.stop)
    self.addCleanup(self.patch_clear.stop)
    self.addCleanup(self.patch_data.stop)

  def test_prompt_processor_is_registered(self):
    node_class = asset_nodes.AstralPromptProcessor
    self.assertIn(
      "Assets Astral Prompt Processor",
      asset_nodes.NODE_CLASS_MAPPINGS,
    )
    self.assertEqual(
      asset_nodes.NODE_DISPLAY_NAME_MAPPINGS[
        "Assets Astral Prompt Processor"
      ],
      "Prompt Processor",
    )
    self.assertEqual(
      node_class.RETURN_NAMES,
      ("prompt",),
    )
    self.assertEqual(node_class.RETURN_TYPES, ("STRING",))
    inputs = node_class.INPUT_TYPES()
    seed_input = inputs["required"]["seed"]
    self.assertEqual(seed_input[0], "INT")
    self.assertEqual(seed_input[1]["default"], 42)
    self.assertEqual(seed_input[1]["min"], 0)
    self.assertEqual(seed_input[1]["max"], 0xFFFFFFFFFFFFFFFF)
    self.assertTrue(seed_input[1]["control_after_generate"])
    for name in ("image", *(f"image_{index}" for index in range(2, 10))):
      self.assertEqual(inputs["optional"][name], ("IMAGE",))
    for name in ("video", "video_2", "video_3"):
      self.assertEqual(inputs["optional"][name], ("VIDEO",))
    for name in ("audio", "audio_2", "audio_3"):
      self.assertEqual(inputs["optional"][name], ("AUDIO",))

  def test_auto_without_media_only_expands(self):
    self.task.return_value = {"text": "expanded"}
    processor = asset_nodes.AstralPromptProcessor()

    result = processor.process(
      "portrait",
      operation="auto",
      mode="api",
      expand_rule="expand-rule",
      seed=123456,
    )

    self.assertEqual(result, ("expanded",))
    self.task.assert_called_once()
    kwargs = self.task.call_args.kwargs
    self.assertEqual(kwargs["task"], "expand")
    self.assertEqual(kwargs["rule_id"], "expand-rule")
    self.assertEqual(kwargs["skill_ids"], [])
    self.assertEqual(kwargs["seed"], 123456)
    self.clear.assert_not_called()

  def test_64_bit_seed_is_reduced_to_llama_cpp_range(self):
    self.task.return_value = {"text": "expanded"}
    processor = asset_nodes.AstralPromptProcessor()
    seed = 390_686_072_267_333

    result = processor.process(
      "portrait",
      operation="expand",
      mode="local",
      seed=seed,
    )

    self.assertEqual(result, ("expanded",))
    self.assertEqual(self.task.call_args.kwargs["seed"], seed & 0xFFFFFFFF)

  def test_auto_with_media_only_inverts(self):
    self.task.return_value = {"text": "reverse prompt"}
    processor = asset_nodes.AstralPromptProcessor()
    image_attachments = [
      {
        "kind": "image",
        "mimeType": "image/jpeg",
        "data": "data:image/jpeg;base64,ZmFrZQ==",
        "name": "image-1.jpg",
      }
    ]

    with mock.patch.object(
      asset_nodes,
      "build_prompt_processor_attachments",
      return_value=image_attachments,
    ):
      result = processor.process(
        "make it cinematic",
        operation="auto",
        mode="api",
        expand_rule="expand-rule",
        invert_rule="invert-rule",
        image="fake-image",
      )

    self.assertEqual(
      result,
      ("reverse prompt",),
    )
    self.task.assert_called_once()
    call = self.task.call_args
    self.assertEqual(call.kwargs["task"], "invert")
    self.assertEqual(call.kwargs["rule_id"], "invert-rule")
    self.assertEqual(call.kwargs["attachments"], image_attachments)
    self.assertFalse(call.kwargs["clear_vram"])

  def test_invert_requires_media(self):
    processor = asset_nodes.AstralPromptProcessor()
    with self.assertRaisesRegex(ValueError, "image, video, or audio"):
      processor.process(operation="invert", mode="api")
    self.task.assert_not_called()

  def test_all_media_inputs_are_forwarded_to_attachment_conversion(self):
    self.task.return_value = {"text": "reverse"}
    processor = asset_nodes.AstralPromptProcessor()
    image_values = {
      "image": "image-1",
      "image_2": "image-2",
      "image_3": "image-3",
      "image_4": "image-4",
      "image_5": "image-5",
      "image_6": "image-6",
      "image_7": "image-7",
      "image_8": "image-8",
      "image_9": "image-9",
    }

    with mock.patch.object(
      asset_nodes,
      "build_prompt_processor_attachments",
      return_value=[{"kind": "audio", "data": "data:audio/wav;base64,eA=="}],
    ) as build:
      processor.process(
        operation="invert",
        mode="api",
        video="video-1",
        video_2="video-2",
        video_3="video-3",
        audio="audio-1",
        audio_2="audio-2",
        audio_3="audio-3",
        **image_values,
      )

    build.assert_called_once_with(
      "image-1",
      "video-1",
      image_2="image-2",
      image_3="image-3",
      image_4="image-4",
      image_5="image-5",
      image_6="image-6",
      image_7="image-7",
      image_8="image-8",
      image_9="image-9",
      video_2="video-2",
      video_3="video-3",
      audio="audio-1",
      audio_2="audio-2",
      audio_3="audio-3",
    )

  def test_rule_and_skill_are_mutually_exclusive(self):
    processor = asset_nodes.AstralPromptProcessor()
    with self.assertRaisesRegex(ValueError, "Choose either a system prompt or a Skill, not both"):
      processor.process(
        "portrait",
        operation="expand",
        mode="api",
        expand_rule="rule",
        skill="skill",
      )
    self.task.assert_not_called()

  def test_local_vram_is_cleared_once_after_task(self):
    self.task.return_value = {"text": "reverse"}
    processor = asset_nodes.AstralPromptProcessor()

    with mock.patch.object(
      asset_nodes,
      "build_prompt_processor_attachments",
      return_value=[{"kind": "image", "data": "data:image/jpeg;base64,eA=="}],
    ):
      processor.process(
        operation="invert",
        mode="local",
        skill="vision-skill",
        clear_vram=True,
      )

    self.clear.assert_called_once_with()
    call = self.task.call_args
    self.assertEqual(call.kwargs["mode"], "local")
    self.assertEqual(call.kwargs["skill_ids"], ["vision-skill"])
    self.assertEqual(call.kwargs["rule_id"], "")
    self.assertFalse(call.kwargs["clear_vram"])

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
