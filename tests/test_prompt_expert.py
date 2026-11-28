import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

PACKAGE_ROOT = Path(__file__).resolve().parents[1]

fake_nodes = types.ModuleType("nodes")
fake_nodes.LoraLoader = type("LoraLoader", (), {})
sys.modules.setdefault("nodes", fake_nodes)

package = types.ModuleType("astral_manage")
package.__path__ = [str(PACKAGE_ROOT)]
sys.modules["astral_manage"] = package


def load_module(name, filename):
  spec = importlib.util.spec_from_file_location(name, PACKAGE_ROOT / filename)
  module = importlib.util.module_from_spec(spec)
  sys.modules[name] = module
  spec.loader.exec_module(module)
  return module


nodes_module = load_module("astral_manage.nodes", "nodes.py")

fake_chat = types.ModuleType("astral_manage.chat_service")
fake_chat.run_prompt_task = mock.MagicMock()
fake_prompt_library = types.ModuleType("astral_manage.prompt_library")
fake_prompt_library.default_data_directory = lambda: "data-dir"
fake_prompt_library.DEFAULT_API_CONFIG = {
  "baseUrl": "https://api.openai.com/v1",
  "model": "",
  "apiKey": "",
  "temperature": 0.7,
  "topP": 0.95,
  "maxTokens": 2048,
  "systemPrompt": "system",
}
fake_local = types.ModuleType("astral_manage.local_llm_service")


def fake_build_local_llm_config(payload, **_kwargs):
  return dict(payload)


fake_local.build_local_llm_config = fake_build_local_llm_config
sys.modules["astral_manage.chat_service"] = fake_chat
sys.modules["astral_manage.prompt_library"] = fake_prompt_library
sys.modules["astral_manage.local_llm_service"] = fake_local

prompt_expert = load_module("astral_manage.prompt_expert", "prompt_expert.py")


def history_payload(skill="", messages=None):
  return json.dumps(
    {"version": 1, "skill": skill, "messages": messages or []},
    ensure_ascii=False,
  )


def profiles_payload(*profiles):
  entries = []
  for index in range(prompt_expert.API_PROFILE_LIMIT):
    entry = profiles[index] if index < len(profiles) else {}
    entries.append(
      {
        "name": entry.get("name", f"Profile {index + 1}"),
        "baseUrl": entry.get("baseUrl", ""),
        "apiKey": entry.get("apiKey", ""),
        "model": entry.get("model", ""),
      }
    )
  return json.dumps(entries)


def inline_skill(name, content):
  return {"inline_file": {"name": name, "content": content}}


class PromptExpertRegistrationTests(unittest.TestCase):
  def test_node_registration(self):
    node_class = prompt_expert.AstralPromptExpert
    self.assertEqual(node_class.NAME, "Prompt Processor")
    self.assertEqual(
      node_class.RETURN_NAMES,
      ("prompt", "reply", "chat_history", "report"),
    )
    self.assertTrue(node_class.OUTPUT_NODE)
    self.assertEqual(node_class.FUNCTION, "run")
    self.assertIn(
      "Prompt Processor",
      prompt_expert.NODE_CLASS_MAPPINGS,
    )
    self.assertEqual(
      prompt_expert.NODE_DISPLAY_NAME_MAPPINGS["Prompt Processor"],
      "Prompt Processor",
    )

  def test_widget_defaults(self):
    required = prompt_expert.AstralPromptExpert.INPUT_TYPES()["required"]
    self.assertNotIn("operation", required)
    self.assertEqual(required["mode"][1]["default"], "api")
    self.assertFalse(required["multi_turn"][1]["default"])
    self.assertEqual(required["api_active"][1]["default"], 1)
    self.assertEqual(
      required["api_profiles"][1]["default"],
      prompt_expert.EMPTY_API_PROFILES,
    )
    self.assertEqual(
      required["chat_history"][1]["default"],
      prompt_expert.EMPTY_EXPERT_HISTORY,
    )
    self.assertIn("prompt_text", required)
    self.assertIn("conversations", required)
    self.assertNotIn("api_seed", required)
    self.assertNotIn("local_preserve_thinking", required)
    self.assertEqual(
      required["conversations"][1]["default"],
      prompt_expert.EMPTY_EXPERT_CONVERSATIONS,
    )
    for name in (
      "local_top_p",
      "local_top_k",
      "local_min_p",
      "local_repeat_penalty",
      "local_max_image_edge",
      "local_flash_attention",
      "local_use_mmap",
    ):
      self.assertIn(name, required)

  def test_text_and_skill_ports_come_first(self):
    optional = prompt_expert.AstralPromptExpert.INPUT_TYPES()["optional"]
    self.assertEqual(
      list(optional)[:3],
      ["system_prompt", "skill", "user_prompt"],
    )
    self.assertTrue(optional["system_prompt"][1]["forceInput"])
    self.assertTrue(optional["user_prompt"][1]["forceInput"])
    self.assertEqual(optional["skill"][0], "QWEN_TE_SKILL")
    for name in ("image", "image_9", "video_3", "audio_3"):
      self.assertIn(name, optional)


class SkillResolutionTests(unittest.TestCase):
  def test_inline_skill_file_wins(self):
    text, key = prompt_expert.resolve_skill_input(
      inline_skill("custom.md", "BODY OF THE SKILL")
    )
    self.assertEqual(key, "inline:custom.md")
    self.assertIn("BODY OF THE SKILL", text)
    self.assertIn("# Skill: custom.md", text)

  def test_selected_skill_is_read_from_a_skills_folder(self):
    with tempfile.TemporaryDirectory() as directory:
      skill_file = Path(directory) / "writing" / "SKILL.md"
      skill_file.parent.mkdir()
      skill_file.write_text("SKILL FROM DISK", encoding="utf-8")
      value = {
        "selected": "writing/SKILL.md",
        "skills": [
          {
            "id": "writing/SKILL.md",
            "name": "Writing",
            "skill_file": "SKILL.md",
            "skill_dir": "writing",
            "skill_path": "writing/SKILL.md",
          }
        ],
        "inline_file": None,
      }
      with mock.patch.object(prompt_expert, "_skill_roots", return_value=[directory]):
        text, key = prompt_expert.resolve_skill_input(value)
    self.assertEqual(key, "file:writing/SKILL.md")
    self.assertIn("# Skill: Writing", text)
    self.assertIn("SKILL FROM DISK", text)

  def test_missing_skill_file_raises(self):
    with mock.patch.object(prompt_expert, "_skill_roots", return_value=[]):
      with self.assertRaisesRegex(ValueError, "Skill file was not found"):
        prompt_expert.resolve_skill_input({"selected": "missing/SKILL.md", "skills": []})

  def test_empty_skill_value_is_ignored(self):
    self.assertEqual(prompt_expert.resolve_skill_input(None), ("", ""))
    self.assertEqual(
      prompt_expert.resolve_skill_input({"selected": "", "skills": []}),
      ("", ""),
    )


class ApiProfileTests(unittest.TestCase):
  def test_profiles_are_padded_to_five(self):
    profiles = prompt_expert._api_profiles(
      profiles_payload({"name": "Fast", "baseUrl": "https://a", "model": "m1"})
    )
    self.assertEqual(len(profiles), prompt_expert.API_PROFILE_LIMIT)
    self.assertEqual(profiles[0]["name"], "Fast")
    self.assertEqual(profiles[0]["model"], "m1")
    self.assertEqual(profiles[1]["name"], "Profile 2")

  def test_active_profile_is_clamped(self):
    raw = profiles_payload(
      {"name": "One", "baseUrl": "https://one", "model": "m1"},
      {"name": "Two", "baseUrl": "https://two", "model": "m2"},
    )
    profile, index = prompt_expert._active_api_profile(raw, 2)
    self.assertEqual(index, 2)
    self.assertEqual(profile["baseUrl"], "https://two")
    profile, index = prompt_expert._active_api_profile(raw, 99)
    self.assertEqual(index, prompt_expert.API_PROFILE_LIMIT)
    self.assertEqual(profile["name"], "Profile 5")


class PromptExpertRunTests(unittest.TestCase):
  def setUp(self):
    fake_chat.run_prompt_task.reset_mock()
    fake_chat.run_prompt_task.return_value = {"text": "a clean prompt"}
    self.node = prompt_expert.AstralPromptExpert()
    self.attachments_patch = mock.patch.object(
      prompt_expert,
      "build_prompt_processor_attachments",
      return_value=[],
    )
    self.attachments = self.attachments_patch.start()
    self.addCleanup(self.attachments_patch.stop)

  def api_kwargs(self, **overrides):
    values = {
      "mode": "api",
      "api_profiles": profiles_payload(
        {
          "name": "Main",
          "baseUrl": "https://example.test/v1",
          "apiKey": "secret",
          "model": "model-x",
        }
      ),
      "api_active": 1,
      "multi_turn": True,
      "skill": inline_skill("style.md", "STYLE SKILL"),
    }
    values.update(overrides)
    return values

  def test_chat_uses_active_api_profile(self):
    result = self.node.run("hello", **self.api_kwargs())
    kwargs = fake_chat.run_prompt_task.call_args.kwargs
    self.assertEqual(kwargs["task"], "chat")
    self.assertEqual(kwargs["rule_id"], "")
    self.assertEqual(kwargs["skill_ids"], [])
    self.assertEqual(kwargs["api_config"]["baseUrl"], "https://example.test/v1")
    self.assertEqual(kwargs["api_config"]["apiKey"], "secret")
    self.assertEqual(kwargs["api_config"]["model"], "model-x")
    self.assertEqual(kwargs["api_config"]["systemPrompt"], "")
    self.assertIsNone(kwargs["local_config"])
    report = json.loads(result["result"][3])
    self.assertEqual(report["apiProfile"], 1)
    self.assertEqual(report["apiProfileName"], "Main")

  def test_second_profile_is_used_when_selected(self):
    profiles = profiles_payload(
      {"name": "One", "baseUrl": "https://one", "model": "m1"},
      {"name": "Two", "baseUrl": "https://two", "apiKey": "k2", "model": "m2"},
    )
    self.node.run(
      "hello",
      **self.api_kwargs(api_profiles=profiles, api_active=2),
    )
    kwargs = fake_chat.run_prompt_task.call_args.kwargs
    self.assertEqual(kwargs["api_config"]["baseUrl"], "https://two")
    self.assertEqual(kwargs["api_config"]["model"], "m2")

  def test_missing_api_fields_raise(self):
    with self.assertRaisesRegex(ValueError, "API base URL"):
      self.node.run(
        "hello",
        **self.api_kwargs(api_profiles=profiles_payload({}), api_active=1),
      )
    with self.assertRaisesRegex(ValueError, "API model name"):
      self.node.run(
        "hello",
        **self.api_kwargs(
          api_profiles=profiles_payload({"baseUrl": "https://x"}),
          api_active=1,
        ),
      )

  def test_media_attachments_are_sent_with_the_message(self):
    self.attachments.return_value = [{"kind": "image", "name": "image-1.jpg"}]
    self.node.run("describe this", **self.api_kwargs())
    kwargs = fake_chat.run_prompt_task.call_args.kwargs
    self.assertEqual(kwargs["task"], "chat")
    self.assertEqual(
      kwargs["attachments"],
      [{"kind": "image", "name": "image-1.jpg"}],
    )

  def test_empty_message_with_media_is_allowed(self):
    self.attachments.return_value = [{"kind": "image", "name": "image-1.jpg"}]
    self.node.run("", **self.api_kwargs())
    self.assertEqual(fake_chat.run_prompt_task.call_count, 1)

  def test_empty_message_without_media_raises(self):
    with self.assertRaisesRegex(ValueError, "Enter a message"):
      self.node.run("", **self.api_kwargs())

  def test_user_prompt_port_overrides_panel_text(self):
    self.node.run(
      "from the panel",
      user_prompt="from the port",
      **self.api_kwargs(),
    )
    sent_text = fake_chat.run_prompt_task.call_args.args[1]
    self.assertEqual(sent_text, "from the port")

  def test_system_prompt_and_skill_text_are_forwarded(self):
    result = self.node.run(
      "hello",
      system_prompt="CUSTOM SYSTEM",
      **self.api_kwargs(skill=inline_skill("style.md", "SKILL BODY")),
    )
    kwargs = fake_chat.run_prompt_task.call_args.kwargs
    self.assertEqual(kwargs["system_prompt"], "CUSTOM SYSTEM")
    self.assertIn("# Skill: style.md", kwargs["skill_context"])
    self.assertIn("SKILL BODY", kwargs["skill_context"])
    report = json.loads(result["result"][3])
    self.assertTrue(report["systemPrompt"])

  def test_local_mode_maps_every_parameter(self):
    self.node.run(
      "hello",
      mode="local",
      multi_turn=True,
      skill=inline_skill("style.md", "STYLE SKILL"),
      local_model="qwen.gguf",
      local_vision_model="mmproj.gguf",
      local_n_ctx=4096,
      local_n_batch=1024,
      local_n_ubatch=256,
      local_max_tokens=512,
      local_max_rounds=6,
      local_temperature=0.4,
      local_top_p=0.8,
      local_top_k=20,
      local_min_p=0.02,
      local_repeat_penalty=1.05,
      local_frequency_penalty=0.1,
      local_presence_penalty=0.2,
      local_gpu_layers=20,
      local_threads=8,
      local_max_image_edge=768,
      local_image_jpeg_quality=80,
      local_context_checkpoints=2,
      local_flash_attention="enabled",
      local_kv_cache_k="q8_0",
      local_kv_cache_v="q8_0",
      local_reasoning_effort="medium",
      local_enable_thinking=True,
      local_use_mmap=False,
    )
    kwargs = fake_chat.run_prompt_task.call_args.kwargs
    self.assertIsNone(kwargs["api_config"])
    config = kwargs["local_config"]
    self.assertEqual(config["modelPath"], "qwen.gguf")
    self.assertEqual(config["visionModelPath"], "mmproj.gguf")
    self.assertEqual(config["nCtx"], 4096)
    self.assertEqual(config["nBatch"], 1024)
    self.assertEqual(config["nUbatch"], 256)
    self.assertEqual(config["maxTokens"], 512)
    self.assertEqual(config["maxRounds"], 6)
    self.assertAlmostEqual(config["temperature"], 0.4)
    self.assertAlmostEqual(config["topP"], 0.8)
    self.assertEqual(config["topK"], 20)
    self.assertAlmostEqual(config["minP"], 0.02)
    self.assertAlmostEqual(config["repeatPenalty"], 1.05)
    self.assertAlmostEqual(config["frequencyPenalty"], 0.1)
    self.assertAlmostEqual(config["presencePenalty"], 0.2)
    self.assertEqual(config["gpuLayers"], 20)
    self.assertEqual(config["threads"], 8)
    self.assertEqual(config["maxImageEdge"], 768)
    self.assertEqual(config["imageJpegQuality"], 80)
    self.assertEqual(config["contextCheckpoints"], 2)
    self.assertEqual(config["flashAttention"], "enabled")
    self.assertEqual(config["kvCacheTypeK"], "q8_0")
    self.assertEqual(config["kvCacheTypeV"], "q8_0")
    self.assertEqual(config["reasoningEffort"], "medium")
    self.assertTrue(config["enableThinking"])
    self.assertFalse(config["preserveThinking"])
    self.assertFalse(config["useMmap"])

  def test_local_mode_requires_a_model(self):
    with self.assertRaisesRegex(ValueError, "local GGUF model"):
      self.node.run(
        "hello",
        mode="local",
        multi_turn=True,
        skill=inline_skill("style.md", "STYLE SKILL"),
      )

  def test_requires_a_linked_skill(self):
    kwargs = self.api_kwargs()
    kwargs.pop("skill")
    with self.assertRaisesRegex(ValueError, "Connect a Skill loader"):
      self.node.run("hello", **kwargs)

  def test_requires_multi_turn(self):
    with self.assertRaisesRegex(ValueError, "Enable multi-turn"):
      self.node.run("hello", **self.api_kwargs(multi_turn=False))

  def test_multi_turn_passes_history_when_enabled(self):
    history = history_payload(
      "inline:style.md",
      [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "hello"},
      ],
    )
    result = self.node.run(
      "next",
      chat_history=history,
      **self.api_kwargs(),
    )
    kwargs = fake_chat.run_prompt_task.call_args.kwargs
    self.assertEqual(
      kwargs["history"],
      [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "hello"},
      ],
    )
    report = json.loads(result["result"][3])
    self.assertTrue(report["multiTurn"])
    self.assertFalse(report["historyIgnored"])

  def test_api_generation_parameters_are_forwarded(self):
    self.node.run(
      "hello",
      api_top_p=0.7,
      api_frequency_penalty=0.1,
      api_presence_penalty=0.2,
      api_response_format="json_object",
      api_reasoning_effort="high",
      **self.api_kwargs(),
    )
    config = fake_chat.run_prompt_task.call_args.kwargs["api_config"]
    self.assertAlmostEqual(config["topP"], 0.7)
    self.assertAlmostEqual(config["frequencyPenalty"], 0.1)
    self.assertAlmostEqual(config["presencePenalty"], 0.2)
    self.assertEqual(config["seed"], 42)
    self.assertEqual(config["responseFormat"], "json_object")
    self.assertEqual(config["reasoningEffort"], "high")

  def test_native_seed_is_used_for_api_mode(self):
    self.node.run("hello", seed=123456, **self.api_kwargs())
    config = fake_chat.run_prompt_task.call_args.kwargs["api_config"]
    self.assertEqual(config["seed"], 123456)

  def test_api_history_rounds_limit_the_request_history(self):
    messages = []
    for index in range(20):
      messages.append({"role": "user", "content": f"u{index}"})
      messages.append({"role": "assistant", "content": f"a{index}"})
    self.node.run(
      "next",
      api_history_rounds=2,
      chat_history=history_payload("inline:style.md", messages),
      **self.api_kwargs(),
    )
    history = fake_chat.run_prompt_task.call_args.kwargs["history"]
    self.assertEqual(len(history), 4)
    self.assertEqual(history[0]["role"], "user")
    self.assertEqual(history[-1]["content"], "a19")

  def test_skill_switch_restarts_history(self):
    history = history_payload(
      "inline:old.md",
      [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}],
    )
    result = self.node.run(
      "next",
      chat_history=history,
      **self.api_kwargs(skill=inline_skill("new.md", "NEW SKILL")),
    )
    kwargs = fake_chat.run_prompt_task.call_args.kwargs
    self.assertEqual(kwargs["history"], [])
    report = json.loads(result["result"][3])
    self.assertTrue(report["skillChanged"])

  def test_history_records_cleaned_prompt_and_trims(self):
    messages = []
    for index in range(60):
      messages.append({"role": "user", "content": f"u{index}"})
      messages.append({"role": "assistant", "content": f"a{index}"})
    result = self.node.run(
      "next",
      chat_history=history_payload("inline:style.md", messages),
      **self.api_kwargs(),
    )
    stored = json.loads(result["result"][2])
    self.assertLessEqual(len(stored["messages"]), 100)
    self.assertEqual(stored["messages"][-2]["role"], "user")
    self.assertEqual(stored["messages"][-1]["role"], "assistant")
    self.assertEqual(stored["messages"][-1]["prompt"], "a clean prompt")
    self.assertIsInstance(stored["messages"][-1]["time"], int)
    self.assertIsInstance(stored["messages"][-2]["time"], int)


class CleanPromptReplyTests(unittest.TestCase):
  def test_prefers_fenced_code_block(self):
    reply = "Sure.\n```text\ncinematic portrait, soft light\n```\nHope this helps."
    self.assertEqual(
      prompt_expert.clean_prompt_reply(reply),
      "cinematic portrait, soft light",
    )

  def test_removes_filler_lines_and_quotes(self):
    self.assertEqual(
      prompt_expert.clean_prompt_reply("您需要的提示词如下：\n\"a quiet lake\""),
      "a quiet lake",
    )
    self.assertEqual(
      prompt_expert.clean_prompt_reply("Here is the prompt:\n\n**a red fox**"),
      "a red fox",
    )

  def test_removes_skill_state_blocks(self):
    reply = (
      "<mmx_skill_state>{\"stage\":\"final\"}</mmx_skill_state>\n"
      "a bronze statue at dusk"
    )
    self.assertEqual(
      prompt_expert.clean_prompt_reply(reply),
      "a bronze statue at dusk",
    )


if __name__ == "__main__":
  unittest.main()
