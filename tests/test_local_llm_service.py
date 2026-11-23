import importlib.util
import shutil
import sys
import types
import unittest
import uuid
from pathlib import Path
from unittest import mock


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
TEST_PACKAGE = "assets_astral_local_llm_tests"

package = types.ModuleType(TEST_PACKAGE)
package.__path__ = [str(PACKAGE_ROOT)]
sys.modules[TEST_PACKAGE] = package

for module_name in ("prompt_library", "local_llm_service"):
  qualified_name = f"{TEST_PACKAGE}.{module_name}"
  spec = importlib.util.spec_from_file_location(
    qualified_name,
    PACKAGE_ROOT / f"{module_name}.py",
  )
  module = importlib.util.module_from_spec(spec)
  sys.modules[qualified_name] = module
  spec.loader.exec_module(module)

local_llm_service = sys.modules[f"{TEST_PACKAGE}.local_llm_service"]


class LocalLLMServiceTests(unittest.TestCase):
  def setUp(self):
    self.temp_path = (
      PACKAGE_ROOT
      / ".asset-library-tests"
      / f"local-llm-{uuid.uuid4().hex}"
    )
    self.models_root = self.temp_path / "models" / "LLM"
    self.data_directory = self.temp_path / "data"
    self.models_root.mkdir(parents=True)
    self.data_directory.mkdir(parents=True)
    (self.models_root / "chat.gguf").write_bytes(b"gguf")
    (self.models_root / "mmproj-model.gguf").write_bytes(b"projector")
    nested = self.models_root / "nested"
    nested.mkdir()
    (nested / "other.GGUF").write_bytes(b"gguf")

  def tearDown(self):
    shutil.rmtree(self.temp_path, ignore_errors=True)

  def test_lists_only_main_gguf_models_recursively(self):
    models = local_llm_service.list_local_llm_models(str(self.models_root))
    self.assertEqual(
      [model["path"] for model in models],
      ["chat.gguf", "nested/other.GGUF"],
    )
    self.assertTrue(all("mmproj" not in model["path"].casefold() for model in models))
    vision_models = local_llm_service.list_local_llm_vision_models(
      str(self.models_root)
    )
    self.assertEqual(
      [model["path"] for model in vision_models],
      ["mmproj-model.gguf"],
    )

  def test_resolves_model_inside_llm_root_and_rejects_escape(self):
    resolved = local_llm_service.resolve_local_llm_model_path(
      "nested/other.GGUF",
      models_root=str(self.models_root),
    )
    self.assertEqual(Path(resolved), (self.models_root / "nested" / "other.GGUF").resolve())
    vision_model = local_llm_service.resolve_local_llm_vision_model_path(
      "mmproj-model.gguf",
      models_root=str(self.models_root),
    )
    self.assertEqual(
      Path(vision_model),
      (self.models_root / "mmproj-model.gguf").resolve(),
    )
    with self.assertRaisesRegex(
      local_llm_service.LocalLLMError,
      "outside the ComfyUI/models/LLM directory",
    ):
      local_llm_service.resolve_local_llm_model_path(
        "../outside.gguf",
        models_root=str(self.models_root),
        require_file=False,
      )
    with self.assertRaisesRegex(
      local_llm_service.LocalLLMError,
      "mmproj",
    ):
      local_llm_service.resolve_local_llm_model_path(
        "mmproj-model.gguf",
        models_root=str(self.models_root),
      )
    with self.assertRaisesRegex(
      local_llm_service.LocalLLMError,
      "Vision projection model",
    ):
      local_llm_service.resolve_local_llm_vision_model_path(
        "chat.gguf",
        models_root=str(self.models_root),
      )

  def test_saves_and_validates_local_config(self):
    saved = local_llm_service.save_local_llm_config(
      str(self.data_directory),
      {
        "modelPath": "nested/other.GGUF",
        "nCtx": 4096,
        "maxTokens": 768,
        "maxRounds": 8,
        "temperature": 0.65,
        "topP": 0.9,
        "topK": 32,
        "repeatPenalty": 1.05,
        "gpuLayers": -1,
        "threads": 0,
        "seed": 7,
        "systemPrompt": "local prompt",
      },
      models_root=str(self.models_root),
    )
    self.assertEqual(saved["modelPath"], "nested/other.GGUF")
    self.assertNotIn("systemPrompt", saved)
    loaded = local_llm_service.load_local_llm_config(
      str(self.data_directory),
      models_root=str(self.models_root),
    )
    self.assertNotIn("systemPrompt", loaded)
    with self.assertRaisesRegex(
      local_llm_service.LocalLLMError,
      "temperature",
    ):
      local_llm_service._normalize_local_llm_config(
        {**saved, "temperature": 5},
        models_root=str(self.models_root),
        require_model_file=True,
      )

  def test_manager_reuses_model_and_reloads_when_load_parameters_change(self):
    created = []
    closed = []

    class FakeLlama:
      def __init__(self, **kwargs):
        self.kwargs = kwargs
        created.append(kwargs)

      def create_chat_completion(self, **kwargs):
        return {"choices": [{"message": {"content": "local reply"}}]}

      def close(self):
        closed.append(True)

    manager = local_llm_service.LocalLlamaManager(llama_factory=FakeLlama)
    config = {
      **local_llm_service.DEFAULT_LOCAL_LLM_CONFIG,
      "modelPath": "nested/other.GGUF",
    }
    messages = [{"role": "user", "content": "hello"}]
    self.assertEqual(
      manager.chat(config, messages, models_root=str(self.models_root)),
      "local reply",
    )
    self.assertEqual(
      manager.chat(config, messages, models_root=str(self.models_root)),
      "local reply",
    )
    self.assertEqual(len(created), 1)
    self.assertEqual(closed, [])
    vision_config = {
      **config,
      "visionModelPath": "mmproj-model.gguf",
    }
    manager.chat(
      vision_config,
      messages,
      models_root=str(self.models_root),
    )
    self.assertEqual(len(created), 2)
    self.assertEqual(
      created[-1]["mmproj_path"],
      str((self.models_root / "mmproj-model.gguf").resolve()),
    )
    manager.chat(
      vision_config,
      messages,
      models_root=str(self.models_root),
    )
    self.assertEqual(len(created), 2)
    manager.chat(
      {**vision_config, "nCtx": 4096},
      messages,
      models_root=str(self.models_root),
    )
    self.assertEqual(len(created), 3)
    self.assertEqual(closed, [True, True])
    manager.reset()
    self.assertEqual(closed, [True, True, True])

  def test_manager_applies_request_seed_without_reloading_model(self):
    created = []
    sampled_seeds = []

    class FakeLlama:
      def __init__(self, **kwargs):
        created.append(kwargs)

      def create_chat_completion(self, **kwargs):
        sampled_seeds.append(kwargs["seed"])
        return {"choices": [{"message": {"content": "local reply"}}]}

    manager = local_llm_service.LocalLlamaManager(llama_factory=FakeLlama)
    config = {
      **local_llm_service.DEFAULT_LOCAL_LLM_CONFIG,
      "modelPath": "chat.gguf",
      "seed": 7,
    }
    messages = [{"role": "user", "content": "hello"}]

    manager.chat(
      config,
      messages,
      models_root=str(self.models_root),
      seed=101,
    )
    manager.chat(
      config,
      messages,
      models_root=str(self.models_root),
      seed=202,
    )
    manager.chat(
      config,
      messages,
      models_root=str(self.models_root),
    )

    self.assertEqual(len(created), 1)
    self.assertEqual(created[0]["seed"], 7)
    self.assertEqual(sampled_seeds, [101, 202, 7])

  def test_global_unload_hook_releases_cached_local_model(self):
    events = []

    class FakeLlama:
      def __init__(self, **kwargs):
        pass

      def create_chat_completion(self, **kwargs):
        return {"choices": [{"message": {"content": "local reply"}}]}

      def close(self):
        events.append("closed")

    def original_unload():
      events.append("original-unload")

    model_management = types.SimpleNamespace(
      unload_all_models=original_unload,
      soft_empty_cache=lambda: events.append("empty-cache"),
    )
    manager = local_llm_service.LocalLlamaManager(llama_factory=FakeLlama)
    config = {
      **local_llm_service.DEFAULT_LOCAL_LLM_CONFIG,
      "modelPath": "chat.gguf",
    }

    with mock.patch.object(
      local_llm_service,
      "LOCAL_LLM_MANAGER",
      manager,
    ):
      manager.chat(
        config,
        [{"role": "user", "content": "hello"}],
        models_root=str(self.models_root),
      )
      self.assertIsNotNone(manager._llama)
      self.assertTrue(
        local_llm_service.install_global_unload_hook(model_management)
      )
      self.assertFalse(
        local_llm_service.install_global_unload_hook(model_management)
      )

      model_management.unload_all_models()

    self.assertEqual(
      events,
      ["closed", "original-unload", "empty-cache"],
    )
    self.assertIsNone(manager._llama)
    self.assertIsNone(manager._load_key)

  def test_local_messages_preserve_image_and_audio_parts(self):
    messages = local_llm_service._local_messages(
      [
        {
          "role": "user",
          "content": [
            {"type": "text", "text": "describe"},
            {
              "type": "image_url",
              "image_url": {"url": "data:image/jpeg;base64,AAAA"},
            },
            {
              "type": "input_audio",
              "input_audio": {"data": "BBBB", "format": "wav"},
            },
          ],
        }
      ]
    )
    self.assertEqual(
      messages[0]["content"],
      [
        {"type": "text", "text": "describe"},
        {
          "type": "image_url",
          "image_url": {"url": "data:image/jpeg;base64,AAAA"},
        },
        {
          "type": "input_audio",
          "input_audio": {"data": "BBBB", "format": "wav"},
        },
      ],
    )

  def test_presence_penalty_alias_matches_llama_cpp_signature(self):
    class FakeLlama:
      def create_chat_completion(
        self,
        *,
        messages,
        present_penalty,
      ):
        return {
          "messages": messages,
          "present_penalty": present_penalty,
        }

    result = local_llm_service._call_chat_completion(
      FakeLlama(),
      messages=[{"role": "user", "content": "hello"}],
      params={
        "temperature": 0.7,
        "presence_penalty": 0.4,
      },
    )
    self.assertEqual(result["present_penalty"], 0.4)

  def test_model_family_sampling_uses_llama_te_recommendations(self):
    base = {
      **local_llm_service.DEFAULT_LOCAL_LLM_CONFIG,
      "modelPath": "Qwen3.8-VL.gguf",
    }
    self.assertEqual(
      local_llm_service.effective_local_sampling(
        base,
        base["modelPath"],
      ),
      {
        "temperature": 0.7,
        "topP": 0.8,
        "topK": 20,
        "minP": 0.0,
      },
    )
    thinking = local_llm_service.effective_local_sampling(
      {**base, "enableThinking": True},
      base["modelPath"],
    )
    self.assertEqual(
      thinking,
      {
        "temperature": 1.0,
        "topP": 0.95,
        "topK": 20,
        "minP": 0.0,
      },
    )
    gemma = local_llm_service.effective_local_sampling(
      {
        **local_llm_service.DEFAULT_LOCAL_LLM_CONFIG,
        "modelPath": "gemma4-chat.gguf",
      },
      "gemma4-chat.gguf",
    )
    self.assertEqual(
      gemma,
      {
        "temperature": 1.0,
        "topP": 0.95,
        "topK": 64,
        "minP": 0.05,
      },
    )


if __name__ == "__main__":
  unittest.main()
