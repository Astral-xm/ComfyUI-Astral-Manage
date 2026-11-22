import json
import shutil
import sys
import unittest
import uuid
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
  sys.path.insert(0, str(PACKAGE_ROOT))

import prompt_library


class PromptLibraryTests(unittest.TestCase):
  def setUp(self):
    self.temp_path = (
      PACKAGE_ROOT
      / ".asset-library-tests"
      / f"prompts-{uuid.uuid4().hex}"
    )

  def tearDown(self):
    shutil.rmtree(self.temp_path, ignore_errors=True)

  def test_template_create_update_search_and_delete(self):
    created = prompt_library.save_template(
      str(self.temp_path),
      {
        "title": "电影感人像",
        "category": "image",
        "prompt": "cinematic portrait, soft light",
      },
    )

    self.assertTrue(created["id"])
    self.assertEqual(created["category"], "image")
    listing = prompt_library.list_templates(
      str(self.temp_path),
      query="soft light",
      category="image",
    )
    self.assertEqual(listing["total"], 1)
    self.assertEqual(listing["items"][0]["title"], "电影感人像")

    updated = prompt_library.save_template(
      str(self.temp_path),
      {
        "id": created["id"],
        "title": "电影感人像 2",
        "category": "image",
        "prompt": "cinematic portrait, rim light",
      },
    )
    self.assertEqual(updated["createdAt"], created["createdAt"])
    self.assertGreaterEqual(updated["updatedAt"], created["updatedAt"])
    self.assertEqual(updated["title"], "电影感人像 2")

    result = prompt_library.delete_template(
      str(self.temp_path),
      created["id"],
    )
    self.assertEqual(result["deleted"], 1)
    self.assertEqual(
      prompt_library.list_templates(str(self.temp_path))["total"],
      0,
    )

  def test_template_validates_category_and_required_fields(self):
    with self.assertRaises(prompt_library.PromptDataError):
      prompt_library.save_template(
        str(self.temp_path),
        {"title": "bad", "category": "workflow", "prompt": "text"},
      )
    with self.assertRaises(prompt_library.PromptDataError):
      prompt_library.save_template(
        str(self.temp_path),
        {"title": "", "category": "text", "prompt": "text"},
      )

  def test_prompt_task_categories_save_and_filter_independently(self):
    expand = prompt_library.save_template(
      str(self.temp_path),
      {
        "title": "电影感扩写",
        "category": "expand",
        "prompt": "补充镜头、光线和材质细节。",
      },
    )
    invert = prompt_library.save_template(
      str(self.temp_path),
      {
        "title": "通用反推",
        "category": "invert",
        "prompt": "按主体、构图和光线反推提示词。",
      },
    )

    expand_listing = prompt_library.list_templates(
      str(self.temp_path),
      category="expand",
    )
    invert_listing = prompt_library.list_templates(
      str(self.temp_path),
      category="invert",
    )
    self.assertEqual(expand_listing["total"], 1)
    self.assertEqual(expand_listing["items"][0]["id"], expand["id"])
    self.assertEqual(invert_listing["total"], 1)
    self.assertEqual(invert_listing["items"][0]["id"], invert["id"])
    self.assertIn("expand", expand_listing["categories"])
    self.assertIn("invert", expand_listing["categories"])

  def test_api_key_is_masked_and_preserved_until_cleared(self):
    public = prompt_library.save_api_config(
      str(self.temp_path),
      {
        "baseUrl": "https://example.com/v1",
        "model": "vision-model",
        "apiKey": "sk-test-1234",
      },
    )

    self.assertEqual(public["apiKey"], "••••••••")
    self.assertTrue(public["hasApiKey"])
    self.assertEqual(public["apiKeyHint"], "已保存")
    self.assertNotIn("1234", public["apiKeyHint"])
    self.assertNotIn("sk-test-1234", str(public))

    prompt_library.save_api_config(
      str(self.temp_path),
      {
        "apiKey": "••••••••",
        "model": "another-model",
      },
    )
    secret = prompt_library.load_api_config(
      str(self.temp_path),
      include_secret=True,
    )
    self.assertEqual(secret["apiKey"], "sk-test-1234")
    self.assertEqual(secret["model"], "another-model")

    prompt_library.save_api_config(
      str(self.temp_path),
      {"clearApiKey": True},
    )
    secret = prompt_library.load_api_config(
      str(self.temp_path),
      include_secret=True,
    )
    self.assertEqual(secret["apiKey"], "")

  def test_multi_provider_config_keeps_task_routes_and_secrets(self):
    payload = {
      "version": 2,
      "activeApiId": "chat-api",
      "providers": [
        {
          "id": "chat-api",
          "name": "对话 API",
          "baseUrl": "https://chat.example.com/v1",
          "model": "chat-default",
          "apiKey": "sk-chat-1234",
        },
        {
          "id": "media-api",
          "name": "媒体 API",
          "baseUrl": "https://media.example.com/v1",
          "model": "media-default",
          "apiKey": "sk-media-5678",
        },
      ],
      "tasks": {
        "text": {"apiId": "media-api", "model": "optimize-model"},
        "image": {"apiId": "media-api", "model": "vision-model"},
        "multimodal": {"apiId": "chat-api", "model": "chat-model"},
      },
    }
    public = prompt_library.save_api_config(str(self.temp_path), payload)

    self.assertEqual(len(public["providers"]), 2)
    self.assertTrue(all(
      provider["apiKey"] == "••••••••"
      for provider in public["providers"]
    ))
    self.assertNotIn("sk-chat-1234", str(public))
    self.assertNotIn("sk-media-5678", str(public))

    expected = {
      "text": ("media-api", "optimize-model", "sk-media-5678"),
      "image": ("media-api", "vision-model", "sk-media-5678"),
      "multimodal": ("chat-api", "chat-model", "sk-chat-1234"),
    }
    for task, (provider_id, model, api_key) in expected.items():
      resolved = prompt_library.resolve_api_config(
        str(self.temp_path),
        task,
      )
      self.assertEqual(resolved["providerId"], provider_id)
      self.assertEqual(resolved["model"], model)
      self.assertEqual(resolved["apiKey"], api_key)

    public["providers"][0]["name"] = "改名后的对话 API"
    public["providers"][1]["model"] = "media-default-v2"
    saved_again = prompt_library.save_api_config(
      str(self.temp_path),
      public,
    )
    self.assertEqual(len(saved_again["providers"]), 2)
    self.assertEqual(
      prompt_library.resolve_api_config(
        str(self.temp_path),
        "multimodal",
      )["apiKey"],
      "sk-chat-1234",
    )
    self.assertEqual(
      prompt_library.resolve_api_config(
        str(self.temp_path),
        "text",
      )["apiKey"],
      "sk-media-5678",
    )

  def test_api_common_generation_settings_are_normalized(self):
    prompt_library.save_api_config(
      str(self.temp_path),
      {
        "temperature": 3,
        "topP": -1,
        "maxTokens": 160000,
        "maxRounds": 99,
        "frequencyPenalty": -3,
        "presencePenalty": 4,
        "seed": 4294967296,
        "stop": "first\nsecond\nsecond\nthird",
        "responseFormat": "json_object",
        "reasoningEffort": "high",
        "systemPrompt": "只输出最终提示词。",
      },
    )

    config = prompt_library.resolve_api_config(
      str(self.temp_path),
      "text",
    )
    self.assertEqual(config["temperature"], 2.0)
    self.assertEqual(config["topP"], 0.0)
    self.assertEqual(config["maxTokens"], 128000)
    self.assertEqual(config["maxRounds"], 50)
    self.assertEqual(config["frequencyPenalty"], -2.0)
    self.assertEqual(config["presencePenalty"], 2.0)
    self.assertEqual(config["seed"], 4294967295)
    self.assertEqual(config["stop"], ["first", "second", "third"])
    self.assertEqual(config["responseFormat"], "json_object")
    self.assertEqual(config["reasoningEffort"], "high")
    self.assertEqual(config["systemPrompt"], "只输出最终提示词。")

  def test_legacy_task_bindings_migrate_into_three_modes(self):
    prompt_library.save_api_config(
      str(self.temp_path),
      {
        "version": 2,
        "activeApiId": "chat-api",
        "providers": [
          {
            "id": "chat-api",
            "name": "对话 API",
            "baseUrl": "https://chat.example.com/v1",
            "model": "chat-default",
            "apiKey": "sk-chat",
          },
          {
            "id": "text-api",
            "name": "文本 API",
            "baseUrl": "https://text.example.com/v1",
            "model": "text-default",
            "apiKey": "sk-text",
          },
          {
            "id": "image-api",
            "name": "图片 API",
            "baseUrl": "https://image.example.com/v1",
            "model": "image-default",
            "apiKey": "sk-image",
          },
        ],
        "tasks": {
          "chat": {"apiId": "chat-api", "model": "chat-model"},
          "translate": {"apiId": "text-api", "model": "translate-model"},
          "optimize": {"apiId": "text-api", "model": "optimize-model"},
          "invert": {"apiId": "image-api", "model": "invert-model"},
        },
      },
    )

    expected = {
      "text": ("text-api", "optimize-model"),
      "image": ("image-api", "invert-model"),
      "multimodal": ("chat-api", "chat-model"),
    }
    for task, (provider_id, model) in expected.items():
      resolved = prompt_library.resolve_api_config(str(self.temp_path), task)
      self.assertEqual(resolved["providerId"], provider_id)
      self.assertEqual(resolved["model"], model)

  def test_legacy_single_api_config_migrates_and_updates_inherited_models(self):
    self.temp_path.mkdir(parents=True, exist_ok=True)
    (self.temp_path / "api-config.json").write_text(
      json.dumps(
        {
          "version": 1,
          "config": {
            "baseUrl": "https://legacy.example.com/v1",
            "model": "legacy-model",
            "apiKey": "legacy-secret",
            "temperature": 0.4,
          },
        }
      ),
      encoding="utf-8",
    )

    public = prompt_library.load_api_configuration(str(self.temp_path))
    self.assertEqual(public["activeApiId"], "default")
    self.assertEqual(len(public["providers"]), 1)
    self.assertEqual(public["providers"][0]["model"], "legacy-model")
    self.assertEqual(public["providers"][0]["apiKey"], "••••••••")
    self.assertEqual(public["temperature"], 0.4)

    for task in prompt_library.API_TASKS:
      resolved = prompt_library.resolve_api_config(
        str(self.temp_path),
        task,
      )
      self.assertEqual(resolved["model"], "legacy-model")
      self.assertEqual(resolved["apiKey"], "legacy-secret")

    prompt_library.save_api_config(
      str(self.temp_path),
      {"model": "legacy-model-v2"},
    )
    for task in prompt_library.API_TASKS:
      resolved = prompt_library.resolve_api_config(
        str(self.temp_path),
        task,
      )
      self.assertEqual(resolved["model"], "legacy-model-v2")
      self.assertEqual(resolved["apiKey"], "legacy-secret")

  def test_removing_provider_reassigns_stale_task_bindings(self):
    prompt_library.save_api_config(
      str(self.temp_path),
      {
        "version": 2,
        "activeApiId": "primary",
        "providers": [
          {
            "id": "primary",
            "name": "主 API",
            "baseUrl": "https://primary.example.com/v1",
            "model": "primary-model",
            "apiKey": "primary-secret",
          },
          {
            "id": "temporary",
            "name": "临时 API",
            "baseUrl": "https://temporary.example.com/v1",
            "model": "temporary-model",
            "apiKey": "temporary-secret",
          },
        ],
        "tasks": {
          task: {"apiId": "temporary", "model": "temporary-model"}
          for task in prompt_library.API_TASKS
        },
      },
    )

    remaining = prompt_library.save_api_config(
      str(self.temp_path),
      {
        "version": 2,
        "activeApiId": "primary",
        "providers": [
          {
            "id": "primary",
            "name": "主 API",
            "baseUrl": "https://primary.example.com/v1",
            "model": "primary-model",
            "apiKey": "••••••••",
          }
        ],
      },
    )
    self.assertEqual(
      [provider["id"] for provider in remaining["providers"]],
      ["primary"],
    )
    for task in prompt_library.API_TASKS:
      resolved = prompt_library.resolve_api_config(
        str(self.temp_path),
        task,
      )
      self.assertEqual(resolved["providerId"], "primary")
      self.assertEqual(resolved["model"], "primary-model")
      self.assertEqual(resolved["apiKey"], "primary-secret")

  def test_conversation_context_is_mutually_exclusive_and_persists(self):
    conversation = prompt_library.create_conversation(
      str(self.temp_path),
      {
        "id": "canvas-test",
        "title": "新会话",
        "skillIds": ["demo"],
        "systemPromptTemplate": {
          "id": "system-template",
          "title": "角色设定",
          "content": "你是一名电影摄影指导。",
        },
        "attachments": [
          {
            "root": "input",
            "path": "reference/hero.png",
            "kind": "image",
            "mention": "image1",
          },
        ],
      },
    )
    self.assertEqual(conversation["id"], "canvas-test")
    self.assertEqual(conversation["skillIds"], [])
    self.assertEqual(
      conversation["systemPromptTemplate"]["content"],
      "你是一名电影摄影指导。",
    )
    self.assertEqual(conversation["attachments"][0]["mention"], "image1")

    updated = prompt_library.update_conversation(
      str(self.temp_path),
      "canvas-test",
      {
        "skillIds": ["video-helper"],
        "systemPromptTemplate": {
          "id": "system-template-2",
          "title": "视频分镜",
          "content": "你是一名分镜导演。",
        },
        "attachments": [
          {
            "root": "output",
            "path": "clips/final.mp4",
            "kind": "video",
            "mention": "video2",
          },
        ],
      },
    )
    self.assertEqual(updated["skillIds"], [])
    self.assertEqual(updated["attachments"][0]["root"], "output")
    self.assertEqual(updated["attachments"][0]["mention"], "video2")
    self.assertEqual(
      updated["systemPromptTemplate"]["title"],
      "视频分镜",
    )

    skill_switched = prompt_library.update_conversation(
      str(self.temp_path),
      "canvas-test",
      {"skillIds": ["demo", "video-helper"]},
    )
    self.assertEqual(skill_switched["skillIds"], ["demo"])
    self.assertNotIn("systemPromptTemplate", skill_switched)

    prompt_switched = prompt_library.update_conversation(
      str(self.temp_path),
      "canvas-test",
      {
        "systemPromptTemplate": {
          "id": "system-template-3",
          "title": "摄影指导",
          "content": "你是一名电影摄影指导。",
        },
      },
    )
    self.assertEqual(prompt_switched["skillIds"], [])
    self.assertEqual(
      prompt_switched["systemPromptTemplate"]["title"],
      "摄影指导",
    )

    prompt_library.append_conversation_messages(
      str(self.temp_path),
      "canvas-test",
      [
        {"role": "user", "content": "分析这个镜头"},
        {"role": "assistant", "content": "镜头节奏较慢。"},
      ],
    )
    stored = prompt_library.get_conversation(
      str(self.temp_path),
      "canvas-test",
    )
    self.assertEqual(stored["title"], "分析这个镜头")
    self.assertEqual(
      [message["role"] for message in stored["messages"]],
      ["user", "assistant"],
    )
    self.assertEqual(stored["skillIds"], [])
    summaries = prompt_library.list_conversations(str(self.temp_path))
    self.assertEqual(summaries["total"], 1)
    self.assertEqual(summaries["items"][0]["messageCount"], 2)
    self.assertEqual(
      summaries["items"][0]["systemPromptTemplate"],
      {"id": "system-template-3", "title": "摄影指导"},
    )
    self.assertEqual(
      stored["systemPromptTemplate"]["content"],
      "你是一名电影摄影指导。",
    )

    prompt_library.delete_conversation(str(self.temp_path), "canvas-test")
    with self.assertRaises(FileNotFoundError):
      prompt_library.get_conversation(str(self.temp_path), "canvas-test")

  def test_legacy_conversation_with_both_contexts_prefers_system_prompt(self):
    prompt_library._save_conversations(
      str(self.temp_path),
      [
        {
          "id": "legacy",
          "title": "旧会话",
          "messages": [],
          "skillIds": ["demo"],
          "systemPromptTemplate": {
            "id": "system-template",
            "title": "旧系统提示词",
            "content": "优先使用系统提示词。",
          },
          "createdAt": 1,
          "updatedAt": 1,
        }
      ],
    )

    conversation = prompt_library.get_conversation(
      str(self.temp_path),
      "legacy",
    )
    self.assertEqual(conversation["skillIds"], [])
    self.assertEqual(
      conversation["systemPromptTemplate"]["title"],
      "旧系统提示词",
    )
    summary = prompt_library.list_conversations(str(self.temp_path))["items"][0]
    self.assertEqual(summary["skillIds"], [])
    self.assertEqual(
      summary["systemPromptTemplate"]["title"],
      "旧系统提示词",
    )

  def test_legacy_message_ids_and_timestamps_migrate_once_and_stay_stable(self):
    prompt_library._save_conversations(
      str(self.temp_path),
      [
        {
          "id": "legacy-messages",
          "title": "旧消息",
          "messages": [
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "second"},
          ],
          "skillIds": [],
          "attachments": [],
          "createdAt": 1000,
          "updatedAt": 1000,
        }
      ],
    )

    first = prompt_library.get_conversation(
      str(self.temp_path),
      "legacy-messages",
    )
    first_ids = [message["id"] for message in first["messages"]]
    first_timestamps = [
      message["timestamp"] for message in first["messages"]
    ]
    self.assertEqual(len(first_ids), 2)
    self.assertTrue(
      all(
        prompt_library.MESSAGE_ID_RE.fullmatch(message_id)
        for message_id in first_ids
      )
    )
    self.assertEqual(first_timestamps, [1000, 1000.0001])

    second = prompt_library.get_conversation(
      str(self.temp_path),
      "legacy-messages",
    )
    self.assertEqual(
      [message["id"] for message in second["messages"]],
      first_ids,
    )
    self.assertEqual(
      [message["timestamp"] for message in second["messages"]],
      first_timestamps,
    )

  def test_deleting_a_conversation_message_is_persistent(self):
    prompt_library.create_conversation(
      str(self.temp_path),
      {"id": "delete-message"},
    )
    conversation = prompt_library.append_conversation_messages(
      str(self.temp_path),
      "delete-message",
      [
        {"id": "message-user", "role": "user", "content": "keep"},
        {
          "id": "message-assistant",
          "role": "assistant",
          "content": "delete",
        },
      ],
    )
    self.assertEqual(len(conversation["messages"]), 2)

    result = prompt_library.delete_conversation_message(
      str(self.temp_path),
      "delete-message",
      "message-assistant",
    )
    self.assertEqual(result["deleted"], 1)
    stored = prompt_library.get_conversation(
      str(self.temp_path),
      "delete-message",
    )
    self.assertEqual(
      [(message["id"], message["content"]) for message in stored["messages"]],
      [("message-user", "keep")],
    )
    with self.assertRaises(FileNotFoundError):
      prompt_library.delete_conversation_message(
        str(self.temp_path),
        "delete-message",
        "message-assistant",
      )

  def test_conversation_rejects_attachment_path_traversal(self):
    with self.assertRaises(prompt_library.PromptDataError):
      prompt_library.create_conversation(
        str(self.temp_path),
        {
          "id": "unsafe",
          "attachments": [
            {"root": "input", "path": "../outside.png"},
          ],
        },
      )
    with self.assertRaises(prompt_library.PromptDataError):
      prompt_library.create_conversation(
        str(self.temp_path),
        {
          "id": "unsafe",
          "attachments": [
            {"root": "C:\\Windows", "path": "outside.png"},
          ],
        },
      )

  def test_conversation_attachment_limit_is_30(self):
    attachments = [
      {"root": "input", "path": f"references/image-{index}.png"}
      for index in range(1, prompt_library.MAX_CONVERSATION_ATTACHMENTS + 1)
    ]
    conversation = prompt_library.create_conversation(
      str(self.temp_path),
      {
        "id": "attachment-limit",
        "attachments": attachments,
      },
    )
    self.assertEqual(
      len(conversation["attachments"]),
      prompt_library.MAX_CONVERSATION_ATTACHMENTS,
    )
    self.assertEqual(
      prompt_library.MAX_CONVERSATION_ATTACHMENTS,
      30,
    )

    with self.assertRaises(prompt_library.PromptDataError):
      prompt_library.update_conversation(
        str(self.temp_path),
        "attachment-limit",
        {
          "attachments": attachments
          + [{"root": "input", "path": "references/image-31.png"}],
        },
      )


if __name__ == "__main__":
  unittest.main()
