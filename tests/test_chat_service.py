import base64
import importlib.util
import shutil
import sys
import types
import unittest
import uuid
from io import BytesIO
from pathlib import Path
from unittest import mock

from PIL import Image


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
TEST_PACKAGE = "assets_astral_chat_tests"

package = types.ModuleType(TEST_PACKAGE)
package.__path__ = [str(PACKAGE_ROOT)]
sys.modules[TEST_PACKAGE] = package

for module_name in (
  "asset_library",
  "prompt_library",
  "skill_library",
  "local_llm_service",
  "chat_service",
):
  qualified_name = f"{TEST_PACKAGE}.{module_name}"
  spec = importlib.util.spec_from_file_location(
    qualified_name,
    PACKAGE_ROOT / f"{module_name}.py",
  )
  module = importlib.util.module_from_spec(spec)
  sys.modules[qualified_name] = module
  spec.loader.exec_module(module)

chat_service = sys.modules[f"{TEST_PACKAGE}.chat_service"]
prompt_library = sys.modules[f"{TEST_PACKAGE}.prompt_library"]
local_llm_service = sys.modules[f"{TEST_PACKAGE}.local_llm_service"]


class ChatServiceTests(unittest.TestCase):
  def setUp(self):
    self.temp_path = (
      PACKAGE_ROOT
      / ".asset-library-tests"
      / f"chat-{uuid.uuid4().hex}"
    )
    self.input_root = self.temp_path / "input"
    self.output_root = self.temp_path / "output"
    self.data_directory = self.temp_path / "data"
    self.input_root.mkdir(parents=True)
    self.output_root.mkdir(parents=True)

  def tearDown(self):
    shutil.rmtree(self.temp_path, ignore_errors=True)

  def create_local_model_files(self, model_name="chat.gguf"):
    models_root = self.temp_path / "models" / "LLM"
    models_root.mkdir(parents=True, exist_ok=True)
    (models_root / model_name).write_bytes(b"gguf")
    (models_root / "mmproj-model.gguf").write_bytes(b"projector")
    return models_root

  def image_bytes(self, color="red", image_format="PNG"):
    buffer = BytesIO()
    Image.new("RGB", (24, 18), color).save(buffer, format=image_format)
    return buffer.getvalue()

  def create_prompt_rule(self, category, title, prompt):
    return prompt_library.save_template(
      str(self.data_directory),
      {
        "title": title,
        "category": category,
        "prompt": prompt,
      },
    )

  def image_attachment(self, color="red"):
    encoded = base64.b64encode(self.image_bytes(color)).decode("ascii")
    return {
      "kind": "image",
      "mimeType": "image/png",
      "data": f"data:image/png;base64,{encoded}",
      "name": "reference.png",
    }

  def test_normalizes_openai_compatible_chat_urls(self):
    self.assertEqual(
      chat_service.normalize_chat_url("https://api.openai.com"),
      "https://api.openai.com/v1/chat/completions",
    )
    self.assertEqual(
      chat_service.normalize_chat_url("https://example.com/v1/"),
      "https://example.com/v1/chat/completions",
    )
    self.assertEqual(
      chat_service.normalize_chat_url(
        "https://example.com/v1/chat/completions/"
      ),
      "https://example.com/v1/chat/completions",
    )
    with self.assertRaises(chat_service.ChatServiceError):
      chat_service.normalize_chat_url("file:///local")

  def test_normalizes_inspiration_tags_and_rejects_non_array_payloads(self):
    tags = chat_service.normalize_inspiration_tags(
      [
        {"name": " 少女 ", "category": " 人物 "},
        {"name": "少女", "category": "人物"},
        {"name": "霓虹灯", "category": "场景"},
        "雨夜",
        {"name": "   ", "category": "场景"},
        {"name": None, "category": "道具"},
        42,
      ]
    )

    self.assertEqual(
      tags,
      [
        {"name": "少女", "category": "人物"},
        {"name": "霓虹灯", "category": "场景"},
        {"name": "雨夜", "category": ""},
      ],
    )
    with self.assertRaises(chat_service.ChatServiceError):
      chat_service.normalize_inspiration_tags({"name": "少女"})

  def test_inspiration_requires_a_prompt_or_selected_tags(self):
    with self.assertRaises(chat_service.ChatServiceError) as raised:
      chat_service.generate_inspiration_prompt(
        str(self.data_directory),
        "   ",
        tags=[],
      )

    self.assertIn(
      "Please enter an image idea or select at least one inspiration tag",
      str(raised.exception),
    )

  def test_inspiration_validates_target_language_and_mode(self):
    self.assertEqual(
      chat_service._inspiration_target("文生图"),
      ("image", "文生图（静态画面）"),
    )
    self.assertEqual(
      chat_service._inspiration_target("video"),
      ("video", "文生视频（连续镜头）"),
    )
    self.assertEqual(
      chat_service._inspiration_language("中文"),
      ("zh", "简体中文"),
    )
    self.assertEqual(
      chat_service._inspiration_language("en"),
      ("en", "English"),
    )
    self.assertEqual(chat_service._inspiration_mode("API纯文本模式"), "api")
    self.assertEqual(chat_service._inspiration_mode("API模式"), "api")
    self.assertEqual(chat_service._inspiration_mode("本地模式"), "local")
    with self.assertRaises(chat_service.ChatServiceError):
      chat_service._inspiration_target("audio")
    with self.assertRaises(chat_service.ChatServiceError):
      chat_service._inspiration_language("日本語")
    with self.assertRaises(chat_service.ChatServiceError):
      chat_service._inspiration_mode("远程")

  def test_inspiration_uses_builtin_rules_and_weaves_tags_into_video_prompt(self):
    config = {
      "task": "text",
      "systemPrompt": "这段服务配置不应覆盖灵感扩写规则。",
      "model": "text-model",
    }
    with (
      mock.patch.object(
        chat_service,
        "resolve_api_config",
        return_value=config,
      ) as resolve_api_config,
      mock.patch.object(
        chat_service,
        "request_chat_completion",
        return_value="rain-soaked cinematic prompt",
      ) as request_chat_completion,
    ):
      result = chat_service.generate_inspiration_prompt(
        str(self.data_directory),
        "",
        tags=[
          {"name": "少女", "category": "人物"},
          {"name": "雨夜街道", "category": "场景"},
          {"name": "红色雨衣", "category": "服装"},
          {"name": "透明雨伞", "category": "道具"},
        ],
        target="video",
        language="en",
      )

    self.assertEqual(result, "rain-soaked cinematic prompt")
    resolve_api_config.assert_called_once_with(
      str(self.data_directory),
      "text",
    )
    request_config, messages = request_chat_completion.call_args.args
    self.assertIs(request_config, config)
    self.assertEqual(messages[0]["role"], "system")
    self.assertIn(chat_service.INSPIRATION_VISUAL_RULES, messages[0]["content"])
    self.assertNotIn("这段服务配置不应覆盖灵感扩写规则。", messages[0]["content"])
    self.assertIn("不要机械地按逗号罗列", messages[0]["content"])
    self.assertIn("镜头运动", messages[0]["content"])
    self.assertEqual(messages[1]["role"], "user")
    self.assertIn("生成目标：文生视频（连续镜头）", messages[1]["content"])
    self.assertIn("输出语言：English", messages[1]["content"])
    self.assertIn("- 人物：少女", messages[1]["content"])
    self.assertIn("- 场景：雨夜街道", messages[1]["content"])
    self.assertIn("- 服装：红色雨衣", messages[1]["content"])
    self.assertIn("- 道具：透明雨伞", messages[1]["content"])

  def test_inspiration_uses_local_gguf_model_when_requested(self):
    local_config = {
      "modelPath": "Qwen3-8B-Q4_K_M.gguf",
      "temperature": 0.7,
    }
    with (
      mock.patch.object(
        chat_service,
        "load_local_llm_config",
        return_value=local_config,
      ) as load_local_llm_config,
      mock.patch.object(
        chat_service,
        "generate_local_chat",
        return_value="local cinematic prompt",
      ) as generate_local_chat,
      mock.patch.object(
        chat_service,
        "resolve_api_config",
      ) as resolve_api_config,
      mock.patch.object(
        chat_service,
        "request_chat_completion",
      ) as request_chat_completion,
    ):
      result = chat_service.generate_inspiration_prompt(
        str(self.data_directory),
        "雨夜里的少女",
        tags=[
          {"name": "少女", "category": "人物"},
          {"name": "雨夜街道", "category": "场景"},
        ],
        target="image",
        language="zh",
        mode="local",
      )

    self.assertEqual(result, "local cinematic prompt")
    load_local_llm_config.assert_called_once_with(str(self.data_directory))
    generate_config, messages = generate_local_chat.call_args.args
    self.assertIs(generate_config, local_config)
    self.assertEqual(messages[0]["role"], "system")
    self.assertIn(chat_service.INSPIRATION_VISUAL_RULES, messages[0]["content"])
    self.assertIn("不要机械地按逗号罗列", messages[0]["content"])
    self.assertIn("构图/景别", messages[0]["content"])
    self.assertIn("生成目标：文生图（静态画面）", messages[1]["content"])
    self.assertIn("输出语言：简体中文", messages[1]["content"])
    self.assertIn("- 人物：少女", messages[1]["content"])
    self.assertIn("- 场景：雨夜街道", messages[1]["content"])
    resolve_api_config.assert_not_called()
    request_chat_completion.assert_not_called()

  def test_merges_system_messages_trims_old_rounds_and_strips_thinking(self):
    merged = chat_service.merge_system_messages(
      [
        {"role": "system", "content": "first"},
        {"role": "user", "content": "old"},
        {"role": "system", "content": "second"},
        {"role": "assistant", "content": "answer"},
      ]
    )
    self.assertEqual(merged[0], {"role": "system", "content": "first\n\nsecond"})

    trimmed = chat_service.trim_conversation_history(
      [
        {"role": "user", "content": "one"},
        {"role": "assistant", "content": "a"},
        {"role": "user", "content": "two"},
        {"role": "assistant", "content": "b"},
        {"role": "user", "content": "three"},
      ],
      2,
    )
    self.assertEqual(
      [message["content"] for message in trimmed],
      ["two", "b", "three"],
    )
    self.assertEqual(
      chat_service.strip_think_blocks("before<think>hidden</think>after"),
      "beforeafter",
    )

  def test_prepare_messages_prefers_conversation_system_prompt(self):
    messages = chat_service.prepare_api_messages(
      {"systemPrompt": "全局系统提示词", "maxRounds": 12},
      {
        "messages": [],
        "systemPromptTemplate": {
          "id": "template",
          "title": "会话模板",
          "content": "会话级系统提示词",
        },
      },
      "你好",
    )

    self.assertEqual(
      messages[0],
      {"role": "system", "content": "会话级系统提示词"},
    )
    self.assertEqual(messages[-1], {"role": "user", "content": "你好"})

    fallback = chat_service.prepare_api_messages(
      {"systemPrompt": "全局系统提示词", "maxRounds": 12},
      {"messages": []},
      "继续",
    )
    self.assertEqual(
      fallback[0],
      {"role": "system", "content": "全局系统提示词"},
    )

  def test_prepare_messages_skips_skill_when_system_prompt_is_loaded(self):
    with mock.patch.object(
      chat_service,
      "build_skill_context",
    ) as build_skill_context:
      messages = chat_service.prepare_api_messages(
        {"systemPrompt": "全局系统提示词", "maxRounds": 12},
        {
          "messages": [],
          "skillIds": ["demo"],
          "systemPromptTemplate": {
            "id": "template",
            "title": "会话模板",
            "content": "会话级系统提示词",
          },
        },
        "你好",
        skill_ids=["demo"],
      )

    build_skill_context.assert_not_called()
    self.assertEqual(
      messages[0],
      {"role": "system", "content": "会话级系统提示词"},
    )
    self.assertEqual(messages[-1], {"role": "user", "content": "你好"})

  def test_request_retries_400_without_optional_sampling_fields(self):
    calls = []

    def transport(url, headers, payload, timeout):
      calls.append(
        {
          "url": url,
          "headers": dict(headers),
          "payload": payload,
          "timeout": timeout,
        }
      )
      if len(calls) < 3:
        return 400, {"error": {"message": "unsupported parameter"}}, ""
      return 200, {"choices": [{"message": {"content": "reply"}}]}, ""

    result = chat_service.request_chat_completion(
      {
        "baseUrl": "https://example.com/v1",
        "apiKey": "secret",
        "model": "vision-model",
        "temperature": 0.4,
        "topP": 0.82,
        "maxTokens": 1024,
        "frequencyPenalty": 0.3,
        "presencePenalty": 0.2,
        "seed": 123,
        "stop": ["###", "<END>"],
        "responseFormat": "json_object",
        "reasoningEffort": "high",
      },
      [{"role": "user", "content": "hello"}],
      timeout=7,
      transport=transport,
    )

    self.assertEqual(result, "reply")
    self.assertEqual(len(calls), 3)
    self.assertEqual(calls[0]["payload"]["temperature"], 0.4)
    self.assertEqual(calls[0]["payload"]["top_p"], 0.82)
    self.assertEqual(calls[0]["payload"]["max_tokens"], 1024)
    self.assertEqual(calls[0]["payload"]["frequency_penalty"], 0.3)
    self.assertEqual(calls[0]["payload"]["presence_penalty"], 0.2)
    self.assertEqual(calls[0]["payload"]["seed"], 123)
    self.assertEqual(calls[0]["payload"]["stop"], ["###", "<END>"])
    self.assertEqual(
      calls[0]["payload"]["response_format"],
      {"type": "json_object"},
    )
    self.assertEqual(calls[0]["payload"]["reasoning_effort"], "high")
    self.assertNotIn("temperature", calls[1]["payload"])
    self.assertNotIn("top_p", calls[1]["payload"])
    self.assertNotIn("max_tokens", calls[1]["payload"])
    self.assertNotIn("frequency_penalty", calls[1]["payload"])
    self.assertNotIn("presence_penalty", calls[1]["payload"])
    self.assertNotIn("seed", calls[1]["payload"])
    self.assertNotIn("stop", calls[1]["payload"])
    self.assertNotIn("response_format", calls[1]["payload"])
    self.assertNotIn("reasoning_effort", calls[1]["payload"])
    self.assertEqual(
      calls[0]["headers"]["Authorization"],
      "Bearer secret",
    )
    self.assertEqual(calls[0]["timeout"], 7)

  def test_request_without_key_omits_authorization_and_maps_401(self):
    def unauthorized(url, headers, payload, timeout):
      self.assertNotIn("Authorization", headers)
      return 401, {"error": {"message": "bad key"}}, ""

    with self.assertRaises(chat_service.ChatAPIError) as raised:
      chat_service.request_chat_completion(
        {
          "baseUrl": "https://example.com/v1",
          "model": "text-model",
        },
        [{"role": "user", "content": "hello"}],
        transport=unauthorized,
      )
    self.assertEqual(raised.exception.status, 401)
    self.assertIn("API Key", str(raised.exception))

  def test_image_mode_requests_modalities_then_omits_them_on_final_retry(self):
    calls = []

    def transport(url, headers, payload, timeout):
      calls.append(payload)
      if len(calls) < 3:
        return 400, {"error": {"message": "unsupported parameter"}}, ""
      return 200, {"choices": [{"message": {"content": "image reply"}}]}, ""

    result = chat_service.request_chat_completion(
      {
        "baseUrl": "https://example.com/v1",
        "model": "image-model",
      },
      [{"role": "user", "content": "draw a lighthouse"}],
      image_output=True,
      transport=transport,
    )

    self.assertEqual(result, "image reply")
    self.assertEqual(len(calls), 3)
    self.assertEqual(calls[0]["modalities"], ["image", "text"])
    self.assertEqual(calls[1]["modalities"], ["image", "text"])
    self.assertNotIn("modalities", calls[2])

  def test_extracts_data_url_bare_base64_and_markdown_images(self):
    png_data = self.image_bytes("red", "PNG")
    jpeg_data = self.image_bytes("blue", "JPEG")
    png_base64 = base64.b64encode(png_data).decode("ascii")
    jpeg_base64 = base64.b64encode(jpeg_data).decode("ascii")

    reply = chat_service._response_text(
      {
        "choices": [
          {
            "message": {
              "content": (
                "before "
                f"![cover](data:image/png;base64,{png_base64}) "
                f"between {jpeg_base64} after"
              ),
              "images": [
                {"url": "https://example.com/generated.png"},
              ],
            }
          }
        ]
      }
    )

    self.assertEqual(len(reply.images), 3)
    self.assertIn("before cover", reply)
    self.assertIn("between [Image] after", reply)
    self.assertNotIn(png_base64, reply)
    self.assertNotIn(jpeg_base64, reply)
    self.assertEqual(reply.images[0].data, png_data)
    self.assertEqual(reply.images[1].data, jpeg_data)
    self.assertEqual(
      reply.images[2].url,
      "https://example.com/generated.png",
    )

  def test_image_mode_accepts_image_only_message_and_persists_generated_image(self):
    prompt_library.save_api_config(
      str(self.data_directory),
      {
        "baseUrl": "https://example.com/v1",
        "model": "image-model",
        "apiKey": "secret",
      },
    )
    prompt_library.create_conversation(
      str(self.data_directory),
      {"id": "image-session"},
    )
    reference = self.input_root / "reference.png"
    reference.write_bytes(self.image_bytes("green"))
    generated_data = self.image_bytes("orange", "PNG")
    request_id = "image-request-1"

    with (
      mock.patch.object(
        chat_service,
        "_asset_roots",
        return_value=(str(self.input_root), str(self.output_root)),
      ),
      mock.patch.object(
        chat_service,
        "request_chat_completion",
        return_value=chat_service.ChatCompletionText(
          "",
          (chat_service.ResponseImage(data=generated_data),),
        ),
      ) as request_chat_completion,
    ):
      result = chat_service.run_chat_turn(
        str(self.data_directory),
        "image-session",
        "",
        attachments=[{"root": "input", "path": "reference.png"}],
        task="image",
        request_id=request_id,
      )

    self.assertEqual(result["message"], "")
    self.assertEqual(result["requestId"], request_id)
    self.assertGreaterEqual(result["receivedAt"], result["sentAt"])
    self.assertEqual(len(result["images"]), 1)
    request_chat_completion.assert_called_once()
    self.assertTrue(request_chat_completion.call_args.kwargs["image_output"])
    self.assertEqual(
      request_chat_completion.call_args.kwargs["request_id"],
      request_id,
    )

    conversation = prompt_library.get_conversation(
      str(self.data_directory),
      "image-session",
    )
    user_message, assistant_message = conversation["messages"]
    self.assertEqual(user_message["role"], "user")
    self.assertEqual(user_message["content"], "")
    self.assertEqual(user_message["requestId"], request_id)
    self.assertEqual(user_message["attachments"][0]["path"], "reference.png")
    self.assertEqual(assistant_message["role"], "assistant")
    self.assertEqual(assistant_message["content"], "")
    self.assertEqual(assistant_message["requestId"], request_id)
    self.assertEqual(len(assistant_message["attachments"]), 1)

    attachment = assistant_message["attachments"][0]
    self.assertEqual(attachment["root"], "output")
    self.assertTrue(
      attachment["path"].startswith(
        "assets-astral-chat/image-session/generated-"
      )
    )
    saved_image = self.output_root / attachment["path"]
    self.assertTrue(saved_image.is_file())
    with Image.open(saved_image) as image:
      self.assertEqual(image.format, "PNG")

  def test_cancelled_chat_turn_does_not_persist_messages(self):
    prompt_library.create_conversation(
      str(self.data_directory),
      {"id": "cancel-chat"},
    )
    request_id = "cancel-chat-request"
    chat_service.register_chat_request(request_id)

    def cancel_then_reply(config, messages, **kwargs):
      chat_service.cancel_chat_request(request_id)
      return "late reply"

    try:
      with (
        mock.patch.object(
          chat_service,
          "request_chat_completion",
          side_effect=cancel_then_reply,
        ),
        self.assertRaises(chat_service.ChatCancelled),
      ):
        chat_service.run_chat_turn(
          str(self.data_directory),
          "cancel-chat",
          "stop this request",
          request_id=request_id,
        )
    finally:
      chat_service.finish_chat_request(request_id)

    conversation = prompt_library.get_conversation(
      str(self.data_directory),
      "cancel-chat",
    )
    self.assertEqual(conversation["messages"], [])

  def test_cancellation_arriving_before_registration_stops_the_request(self):
    request_id = "pre-cancel-request"
    self.assertTrue(chat_service.cancel_chat_request(request_id))
    chat_service.register_chat_request(request_id)
    try:
      with self.assertRaises(chat_service.ChatCancelled):
        chat_service._raise_if_cancelled(request_id)
    finally:
      chat_service.finish_chat_request(request_id)

  def test_translation_turn_persists_request_id_and_timestamps(self):
    prompt_library.save_api_config(
      str(self.data_directory),
      {
        "baseUrl": "https://example.com/v1",
        "model": "translation-model",
        "apiKey": "secret",
      },
    )
    prompt_library.create_conversation(
      str(self.data_directory),
      {"id": "translation-metadata"},
    )
    request_id = "translation-request-1"
    chat_service.register_chat_request(request_id)
    try:
      with mock.patch.object(
        chat_service,
        "request_chat_completion",
        return_value="translated text",
      ):
        result = chat_service.run_translation_turn(
          str(self.data_directory),
          "translation-metadata",
          "需要翻译",
          "en",
          request_id=request_id,
        )
    finally:
      chat_service.finish_chat_request(request_id)

    self.assertEqual(result["requestId"], request_id)
    self.assertGreaterEqual(result["receivedAt"], result["sentAt"])
    conversation = prompt_library.get_conversation(
      str(self.data_directory),
      "translation-metadata",
    )
    self.assertEqual(
      [message["requestId"] for message in conversation["messages"]],
      [request_id, request_id],
    )
    self.assertEqual(
      conversation["messages"][0]["timestamp"],
      result["sentAt"],
    )
    self.assertEqual(
      conversation["messages"][1]["timestamp"],
      result["receivedAt"],
    )

  def test_cancelled_generated_image_is_removed_before_persistence(self):
    prompt_library.create_conversation(
      str(self.data_directory),
      {"id": "cancel-image"},
    )
    request_id = "cancel-image-request"
    chat_service.register_chat_request(request_id)
    original_save = chat_service._save_generated_response_images

    def save_then_cancel(*args, **kwargs):
      attachments = original_save(*args, **kwargs)
      chat_service.cancel_chat_request(request_id)
      return attachments

    try:
      with (
        mock.patch.object(
          chat_service,
          "_asset_roots",
          return_value=(str(self.input_root), str(self.output_root)),
        ),
        mock.patch.object(
          chat_service,
          "request_chat_completion",
          return_value=chat_service.ChatCompletionText(
            "",
            (
              chat_service.ResponseImage(
                data=self.image_bytes("purple"),
              ),
            ),
          ),
        ),
        mock.patch.object(
          chat_service,
          "_save_generated_response_images",
          side_effect=save_then_cancel,
        ),
        self.assertRaises(chat_service.ChatCancelled),
      ):
        chat_service.run_chat_turn(
          str(self.data_directory),
          "cancel-image",
          "draw then cancel",
          task="image",
          request_id=request_id,
        )
    finally:
      chat_service.finish_chat_request(request_id)

    generated_root = (
      self.output_root / chat_service.CHAT_IMAGE_DIRECTORY
    )
    self.assertEqual(
      [path for path in generated_root.rglob("*") if path.is_file()],
      [],
    )
    conversation = prompt_library.get_conversation(
      str(self.data_directory),
      "cancel-image",
    )
    self.assertEqual(conversation["messages"], [])

  def test_generated_image_is_removed_when_message_persistence_fails(self):
    prompt_library.create_conversation(
      str(self.data_directory),
      {"id": "persist-failure"},
    )

    with (
      mock.patch.object(
        chat_service,
        "_asset_roots",
        return_value=(str(self.input_root), str(self.output_root)),
      ),
      mock.patch.object(
        chat_service,
        "request_chat_completion",
        return_value=chat_service.ChatCompletionText(
          "",
          (
            chat_service.ResponseImage(
              data=self.image_bytes("cyan"),
            ),
          ),
        ),
      ),
      mock.patch.object(
        chat_service,
        "append_conversation_messages",
        side_effect=OSError("disk full"),
      ),
      self.assertRaisesRegex(OSError, "disk full"),
    ):
      chat_service.run_chat_turn(
        str(self.data_directory),
        "persist-failure",
        "draw this",
        task="image",
      )

    generated_root = (
      self.output_root / chat_service.CHAT_IMAGE_DIRECTORY
    )
    self.assertEqual(
      [path for path in generated_root.rglob("*") if path.is_file()],
      [],
    )

  def test_lists_models_from_normalized_openai_models_endpoint(self):
    calls = []

    def transport(url, headers, timeout):
      calls.append(
        {
          "url": url,
          "headers": dict(headers),
          "timeout": timeout,
        }
      )
      return (
        200,
        {
          "data": [
            {"id": "zeta-model"},
            {"id": "alpha-model"},
            {"id": "zeta-model"},
            {"name": "beta-model"},
            {"id": ""},
          ]
        },
        "",
      )

    models = chat_service.list_api_models(
      {
        "baseUrl": "https://example.com/v1/chat/completions",
        "apiKey": "secret",
      },
      timeout=9,
      transport=transport,
    )

    self.assertEqual(
      models,
      ["alpha-model", "beta-model", "zeta-model"],
    )
    self.assertEqual(calls[0]["url"], "https://example.com/v1/models")
    self.assertEqual(
      calls[0]["headers"]["Authorization"],
      "Bearer secret",
    )
    self.assertEqual(calls[0]["timeout"], 9)

  def test_three_api_modes_route_chat_and_prompt_tasks(self):
    prompt_library.save_api_config(
      str(self.data_directory),
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
            "id": "media-api",
            "name": "媒体 API",
            "baseUrl": "https://media.example.com/v1",
            "model": "media-default",
            "apiKey": "sk-media",
          },
          {
            "id": "vision-api",
            "name": "视觉 API",
            "baseUrl": "https://vision.example.com/v1",
            "model": "vision-default",
            "apiKey": "sk-vision",
          },
        ],
        "tasks": {
          "text": {
            "apiId": "media-api",
            "model": "optimize-model",
          },
          "image": {
            "apiId": "vision-api",
            "model": "invert-model",
          },
          "multimodal": {
            "apiId": "chat-api",
            "model": "chat-model",
          },
        },
      },
    )
    prompt_library.create_conversation(
      str(self.data_directory),
      {"id": "task-routing"},
    )
    calls = []

    def fake_request(config, messages):
      calls.append(
        {
          "task": config["task"],
          "providerId": config["providerId"],
          "model": config["model"],
          "apiKey": config["apiKey"],
          "messages": messages,
        }
      )
      return "reply"

    with (
      mock.patch.object(
        chat_service,
        "request_chat_completion",
        side_effect=fake_request,
      ),
      mock.patch.object(
        chat_service,
        "build_user_content",
        side_effect=lambda text, attachments, **kwargs: text,
      ),
    ):
      chat_service.run_chat_turn(
        str(self.data_directory),
        "task-routing",
        "hello",
        persist=False,
      )
      chat_service.translate_text(
        str(self.data_directory),
        "hello",
        "中文",
      )
      chat_service.optimize_prompt(
        str(self.data_directory),
        "portrait",
      )
      chat_service.invert_prompt(
        str(self.data_directory),
        attachments=[
          {"root": "input", "path": "reference.png"},
        ],
      )
      chat_service.run_chat_turn(
        str(self.data_directory),
        "task-routing",
        "describe this image",
        attachments=[
          {"root": "input", "path": "reference.png"},
        ],
        persist=False,
      )
      chat_service.run_chat_turn(
        str(self.data_directory),
        "task-routing",
        "explicit text route",
        attachments=[
          {"root": "input", "path": "reference.png"},
        ],
        task="text",
        persist=False,
      )

    self.assertEqual(
      [
        (call["task"], call["providerId"], call["model"], call["apiKey"])
        for call in calls
      ],
      [
        ("text", "media-api", "optimize-model", "sk-media"),
        ("text", "media-api", "optimize-model", "sk-media"),
        ("text", "media-api", "optimize-model", "sk-media"),
        ("image", "vision-api", "invert-model", "sk-vision"),
        ("multimodal", "chat-api", "chat-model", "sk-chat"),
        ("text", "media-api", "optimize-model", "sk-media"),
      ],
    )
    self.assertTrue(all(call["messages"] for call in calls))

  def test_prompt_task_accepts_explicit_api_config_and_history(self):
    with (
      mock.patch.object(chat_service, "resolve_api_config") as resolve,
      mock.patch.object(chat_service, "load_local_llm_config") as load_local,
      mock.patch.object(
        chat_service,
        "build_skill_context",
        return_value=("", ""),
      ),
      mock.patch.object(
        chat_service,
        "build_user_content",
        side_effect=lambda text, attachments, **_kwargs: text,
      ),
      mock.patch.object(
        chat_service,
        "request_chat_completion",
        return_value="chat reply",
      ) as request_chat_completion,
    ):
      result = chat_service.run_prompt_task(
        str(self.data_directory),
        "hello",
        task="chat",
        api_config={
          "baseUrl": "https://node.test/v1",
          "apiKey": "node-key",
          "model": "node-model",
        },
        history=[
          {"role": "user", "content": "hi"},
          {"role": "assistant", "content": "hello back"},
        ],
        system_prompt="SYS-PROMPT",
        skill_context="SKILL-TEXT",
      )

    resolve.assert_not_called()
    load_local.assert_not_called()
    config, messages = request_chat_completion.call_args.args[:2]
    self.assertEqual(config["baseUrl"], "https://node.test/v1")
    self.assertEqual(config["model"], "node-model")
    self.assertEqual(
      [message["role"] for message in messages],
      ["system", "user", "assistant", "user"],
    )
    self.assertEqual(messages[-1]["content"], "hello")
    self.assertIn("SYS-PROMPT", messages[0]["content"])
    self.assertIn("SKILL-TEXT", messages[0]["content"])
    self.assertEqual(result["task"], "chat")
    self.assertEqual(result["text"], "chat reply")

  def test_prompt_task_uses_explicit_local_config(self):
    config = {
      "modelPath": "qwen.gguf",
      "maxImageEdge": 1024,
      "imageJpegQuality": 90,
    }
    with (
      mock.patch.object(chat_service, "load_local_llm_config") as load_local,
      mock.patch.object(chat_service, "_validate_local_attachments"),
      mock.patch.object(
        chat_service,
        "build_skill_context",
        return_value=("", ""),
      ),
      mock.patch.object(
        chat_service,
        "_prompt_task_messages",
        return_value=[{"role": "user", "content": "hello"}],
      ) as build_messages,
      mock.patch.object(
        chat_service,
        "generate_local_chat",
        return_value="local reply",
      ) as generate_local_chat,
    ):
      result = chat_service.run_prompt_task(
        str(self.data_directory),
        "hello",
        task="chat",
        mode="local",
        local_config=config,
      )

    load_local.assert_not_called()
    self.assertEqual(build_messages.call_args.args[0]["modelPath"], "qwen.gguf")
    self.assertEqual(generate_local_chat.call_count, 1)
    self.assertEqual(result["text"], "local reply")

  def test_prompt_task_rules_are_limited_to_matching_categories(self):
    expand_rule = self.create_prompt_rule(
      "expand",
      "电影感扩写",
      "EXPAND RULE ONLY",
    )
    invert_rule = self.create_prompt_rule(
      "invert",
      "通用反推",
      "INVERT RULE ONLY",
    )

    def fake_user_content(text, attachments, **_kwargs):
      return text

    with (
      mock.patch.object(
        chat_service,
        "resolve_api_config",
        return_value={"task": "text"},
      ),
      mock.patch.object(
        chat_service,
        "build_skill_context",
        return_value=("", ""),
      ),
      mock.patch.object(
        chat_service,
        "build_user_content",
        side_effect=fake_user_content,
      ),
      mock.patch.object(
        chat_service,
        "request_chat_completion",
        return_value="result",
      ) as request_chat_completion,
    ):
      expanded = chat_service.run_prompt_task(
        str(self.data_directory),
        "portrait",
        task="expand",
        rule_id=expand_rule["id"],
      )
      inverted = chat_service.run_prompt_task(
        str(self.data_directory),
        "",
        task="invert",
        rule_id=invert_rule["id"],
        attachments=[self.image_attachment()],
      )

    self.assertEqual(expanded["ruleId"], expand_rule["id"])
    self.assertEqual(inverted["ruleId"], invert_rule["id"])
    self.assertEqual(request_chat_completion.call_count, 2)
    with self.assertRaisesRegex(
      chat_service.ChatServiceError,
      "Prompt expansion can only use",
    ):
      chat_service.run_prompt_task(
        str(self.data_directory),
        "portrait",
        task="expand",
        rule_id=invert_rule["id"],
      )
    with self.assertRaisesRegex(
      chat_service.ChatServiceError,
      "Image inversion can only use",
    ):
      chat_service.run_prompt_task(
        str(self.data_directory),
        "",
        task="invert",
        rule_id=expand_rule["id"],
        attachments=[self.image_attachment()],
      )
    with self.assertRaisesRegex(
      chat_service.ChatServiceError,
      "Translation tasks do not use",
    ):
      chat_service.run_prompt_task(
        str(self.data_directory),
        "hello",
        task="translate",
        rule_id=expand_rule["id"],
      )

  def test_prompt_task_routes_text_and_image_apis_with_selected_rule(self):
    expand_rule = self.create_prompt_rule(
      "expand",
      "电影感扩写",
      "EXPAND RULE CONTEXT",
    )
    invert_rule = self.create_prompt_rule(
      "invert",
      "通用反推",
      "INVERT RULE CONTEXT",
    )
    resolved_tasks = []
    requests = []

    def fake_resolve(_data_directory, task):
      resolved_tasks.append(task)
      return {
        "task": task,
        "model": f"{task}-model",
        "systemPrompt": "GLOBAL SYSTEM",
      }

    def fake_user_content(text, attachments, **_kwargs):
      return text or f"{len(attachments)} media"

    def fake_request(config, messages, **_kwargs):
      requests.append((config, messages))
      return f"{config['task']} response"

    with (
      mock.patch.object(
        chat_service,
        "resolve_api_config",
        side_effect=fake_resolve,
      ),
      mock.patch.object(
        chat_service,
        "build_skill_context",
        return_value=("", ""),
      ),
      mock.patch.object(
        chat_service,
        "build_user_content",
        side_effect=fake_user_content,
      ),
      mock.patch.object(
        chat_service,
        "request_chat_completion",
        side_effect=fake_request,
      ),
    ):
      expanded = chat_service.run_prompt_task(
        str(self.data_directory),
        "portrait",
        task="expand",
        rule_id=expand_rule["id"],
      )
      translated = chat_service.run_prompt_task(
        str(self.data_directory),
        "电影感少女",
        task="translate",
        target_language="en",
      )
      inverted = chat_service.run_prompt_task(
        str(self.data_directory),
        "",
        task="invert",
        rule_id=invert_rule["id"],
        attachments=[self.image_attachment()],
      )

    self.assertEqual(resolved_tasks, ["text", "text", "image"])
    self.assertEqual(
      [config["task"] for config, _messages in requests],
      ["text", "text", "image"],
    )
    self.assertEqual(expanded["text"], "text response")
    self.assertEqual(translated["text"], "text response")
    self.assertEqual(inverted["text"], "image response")
    self.assertIn(
      "EXPAND RULE CONTEXT",
      requests[0][1][0]["content"],
    )
    self.assertNotIn(
      "INVERT RULE CONTEXT",
      requests[0][1][0]["content"],
    )
    self.assertIn(
      "INVERT RULE CONTEXT",
      requests[2][1][0]["content"],
    )
    self.assertNotIn(
      "EXPAND RULE CONTEXT",
      requests[2][1][0]["content"],
    )
    self.assertIn(
      "目标语言：en",
      requests[1][1][1]["content"],
    )
    for result in (expanded, translated, inverted):
      self.assertGreaterEqual(result["receivedAt"], result["sentAt"])

  def test_prompt_task_rejects_rule_and_skill_together(self):
    expand_rule = self.create_prompt_rule(
      "expand",
      "电影感扩写",
      "EXPAND RULE",
    )

    with (
      mock.patch.object(
        chat_service,
        "build_skill_context",
      ) as build_skill_context,
      mock.patch.object(
        chat_service,
        "request_chat_completion",
      ) as request_chat_completion,
    ):
      with self.assertRaisesRegex(
        chat_service.ChatServiceError,
        "Only one of a system prompt or a Skill can be selected",
      ):
        chat_service.run_prompt_task(
          str(self.data_directory),
          "portrait",
          task="expand",
          rule_id=expand_rule["id"],
          skill_ids=["demo-skill"],
        )

    build_skill_context.assert_not_called()
    request_chat_completion.assert_not_called()

  def test_prompt_task_local_inversion_and_vram_cleanup(self):
    local_config = {
      "modelPath": "chat.gguf",
      "visionModelPath": "mmproj.gguf",
      "maxImageEdge": 1024,
      "imageJpegQuality": 82,
    }
    attachment = self.image_attachment("blue")

    with (
      mock.patch.object(
        chat_service,
        "load_local_llm_config",
        return_value=local_config,
      ) as load_local_llm_config,
      mock.patch.object(
        chat_service,
        "_validate_local_attachments",
      ) as validate_local_attachments,
      mock.patch.object(
        chat_service,
        "build_skill_context",
        return_value=("", ""),
      ),
      mock.patch.object(
        chat_service,
        "build_user_content",
        return_value="local image content",
      ) as build_user_content,
      mock.patch.object(
        chat_service,
        "generate_local_chat",
        return_value="local reverse prompt",
      ) as generate_local_chat,
      mock.patch.object(
        chat_service,
        "_clear_local_model_memory",
        return_value="",
      ) as clear_local_model_memory,
      mock.patch.object(
        chat_service,
        "request_chat_completion",
      ) as request_chat_completion,
    ):
      result = chat_service.run_prompt_task(
        str(self.data_directory),
        "",
        task="invert",
        mode="local",
        attachments=[attachment],
        clear_vram=True,
        seed=321,
      )

    self.assertEqual(result["text"], "local reverse prompt")
    self.assertEqual(result["mode"], "local")
    self.assertEqual(result["task"], "invert")
    self.assertTrue(result["clearedVram"])
    self.assertNotIn("clearVramError", result)
    load_local_llm_config.assert_called_once_with(str(self.data_directory))
    validate_local_attachments.assert_called_once_with(
      local_config,
      [attachment],
    )
    self.assertEqual(build_user_content.call_args.kwargs["max_image_edge"], 1024)
    self.assertEqual(
      build_user_content.call_args.kwargs["image_jpeg_quality"],
      82,
    )
    self.assertTrue(build_user_content.call_args.kwargs["progressive_jpeg"])
    generate_local_chat.assert_called_once_with(
      local_config,
      mock.ANY,
      seed=321,
    )
    clear_local_model_memory.assert_called_once_with()
    request_chat_completion.assert_not_called()

  def test_prompt_task_reports_local_vram_cleanup_failure(self):
    local_config = {
      "modelPath": "chat.gguf",
      "maxImageEdge": 1024,
      "imageJpegQuality": 82,
    }

    with (
      mock.patch.object(
        chat_service,
        "load_local_llm_config",
        return_value=local_config,
      ),
      mock.patch.object(
        chat_service,
        "build_skill_context",
        return_value=("", ""),
      ),
      mock.patch.object(
        chat_service,
        "generate_local_chat",
        return_value="expanded",
      ),
      mock.patch.object(
        chat_service,
        "_clear_local_model_memory",
        return_value="local unload failed",
      ),
    ):
      result = chat_service.run_prompt_task(
        str(self.data_directory),
        "portrait",
        task="expand",
        mode="local",
        clear_vram=True,
      )

    self.assertFalse(result["clearedVram"])
    self.assertEqual(result["clearVramError"], "local unload failed")

  def test_prompt_task_cancellation_discards_late_api_reply(self):
    request_id = "prompt-task-cancel"
    chat_service.register_chat_request(request_id)

    def cancel_then_reply(_config, _messages, **_kwargs):
      chat_service.cancel_chat_request(request_id)
      return "late prompt result"

    try:
      with (
        mock.patch.object(
          chat_service,
          "resolve_api_config",
          return_value={"task": "text"},
        ),
        mock.patch.object(
          chat_service,
          "build_skill_context",
          return_value=("", ""),
        ),
        mock.patch.object(
          chat_service,
          "request_chat_completion",
          side_effect=cancel_then_reply,
        ),
        self.assertRaises(chat_service.ChatCancelled),
      ):
        chat_service.run_prompt_task(
          str(self.data_directory),
          "portrait",
          task="expand",
          request_id=request_id,
        )
    finally:
      chat_service.finish_chat_request(request_id)

  def test_prompt_task_never_reads_or_writes_conversation_history(self):
    with (
      mock.patch.object(
        chat_service,
        "resolve_api_config",
        return_value={"task": "text"},
      ),
      mock.patch.object(
        chat_service,
        "build_skill_context",
        return_value=("", ""),
      ),
      mock.patch.object(
        chat_service,
        "request_chat_completion",
        return_value="stateless result",
      ),
      mock.patch.object(
        chat_service,
        "get_or_create_conversation",
      ) as get_or_create_conversation,
      mock.patch.object(
        chat_service,
        "append_conversation_messages",
      ) as append_conversation_messages,
      mock.patch.object(
        chat_service,
        "update_conversation",
      ) as update_conversation,
    ):
      result = chat_service.run_prompt_task(
        str(self.data_directory),
        "portrait",
        task="expand",
      )

    self.assertEqual(result["text"], "stateless result")
    get_or_create_conversation.assert_not_called()
    append_conversation_messages.assert_not_called()
    update_conversation.assert_not_called()

  def test_builds_image_and_audio_attachment_parts(self):
    image = self.input_root / "reference.png"
    Image.new("RGBA", (640, 480), (255, 0, 0, 128)).save(image)
    audio = self.output_root / "voice.wav"
    audio.write_bytes(b"RIFFmock")

    with mock.patch.object(
      chat_service,
      "_asset_roots",
      return_value=(str(self.input_root), str(self.output_root)),
    ):
      parts = chat_service.build_attachment_parts(
        [
          {
            "root": "input",
            "path": "reference.png",
            "mention": "image3",
          },
          {"root": "output", "path": "voice.wav"},
        ]
      )

    image_part = next(part for part in parts if part["type"] == "image_url")
    audio_part = next(part for part in parts if part["type"] == "input_audio")
    self.assertTrue(
      image_part["image_url"]["url"].startswith("data:image/jpeg;base64,")
    )
    image_payload = base64.b64decode(
      image_part["image_url"]["url"].split(",", 1)[1]
    )
    with Image.open(BytesIO(image_payload)) as compressed:
      self.assertEqual(compressed.mode, "RGB")
      self.assertEqual(compressed.size, (640, 480))
    self.assertEqual(audio_part["input_audio"]["format"], "wav")
    self.assertEqual(
      base64.b64decode(audio_part["input_audio"]["data"]),
      b"RIFFmock",
    )
    text_parts = [part["text"] for part in parts if part["type"] == "text"]
    self.assertIn("[Image asset @image3: reference.png]", text_parts)
    self.assertIn("[Audio asset @audio1: voice.wav]", text_parts)

  def test_builds_inline_audio_attachment_parts(self):
    payload = b"RIFF-inline-audio"
    encoded = base64.b64encode(payload).decode("ascii")

    parts = chat_service.build_attachment_parts(
      [
        {
          "kind": "audio",
          "mimeType": "audio/wav",
          "format": "wav",
          "data": f"data:audio/wav;base64,{encoded}",
          "name": "audio-2.wav",
          "mention": "audio2",
        }
      ]
    )

    audio_part = next(part for part in parts if part["type"] == "input_audio")
    self.assertEqual(audio_part["input_audio"]["format"], "wav")
    self.assertEqual(
      base64.b64decode(audio_part["input_audio"]["data"]),
      payload,
    )
    self.assertIn(
      "[Audio asset @audio2: audio-2.wav]",
      [part["text"] for part in parts if part["type"] == "text"],
    )

  def test_large_image_is_downscaled_before_sending(self):
    image = self.input_root / "large.png"
    Image.effect_noise((2048, 1536), 90).convert("RGBA").save(image)

    with mock.patch.object(
      chat_service,
      "_asset_roots",
      return_value=(str(self.input_root), str(self.output_root)),
    ):
      parts = chat_service.build_attachment_parts(
        [{"root": "input", "path": "large.png", "mention": "image1"}]
      )

    image_part = next(part for part in parts if part["type"] == "image_url")
    encoded = image_part["image_url"]["url"].split(",", 1)[1]
    compressed_payload = base64.b64decode(encoded)
    with Image.open(BytesIO(compressed_payload)) as compressed:
      self.assertEqual(compressed.format, "JPEG")
      self.assertLessEqual(max(compressed.size), chat_service.MAX_IMAGE_EDGE)
      self.assertEqual(compressed.size, (1280, 960))
    self.assertLess(len(compressed_payload), image.stat().st_size)

  def test_large_audio_is_compressed_to_mp3_before_sending(self):
    audio = self.output_root / "long.wav"
    audio.write_bytes(
      b"\0" * (chat_service.AUDIO_COMPRESSION_THRESHOLD_BYTES + 1)
    )
    commands = []

    def fake_ffmpeg(command, **_kwargs):
      commands.append(command)
      Path(command[-1]).write_bytes(b"ID3compressed")
      return mock.Mock(returncode=0)

    with (
      mock.patch.object(
        chat_service,
        "_asset_roots",
        return_value=(str(self.input_root), str(self.output_root)),
      ),
      mock.patch.object(
        chat_service,
        "_find_media_tool",
        return_value="ffmpeg",
      ),
      mock.patch.object(
        chat_service,
        "_media_cache_root",
        return_value=str(self.temp_path),
      ),
      mock.patch.object(
        chat_service.subprocess,
        "run",
        side_effect=fake_ffmpeg,
      ),
    ):
      parts = chat_service.build_attachment_parts(
        [{"root": "output", "path": "long.wav", "mention": "audio1"}]
      )

    audio_part = next(part for part in parts if part["type"] == "input_audio")
    self.assertEqual(audio_part["input_audio"]["format"], "mp3")
    self.assertEqual(
      base64.b64decode(audio_part["input_audio"]["data"]),
      b"ID3compressed",
    )
    self.assertEqual(len(commands), 1)
    self.assertIn("libmp3lame", commands[0])
    self.assertEqual(
      commands[0][commands[0].index("-b:a") + 1],
      chat_service.AUDIO_MP3_BITRATE,
    )

  def test_video_attachment_uses_sampled_frames(self):
    video = self.output_root / "clip.mp4"
    video.write_bytes(b"video")
    frame_buffer = BytesIO()
    Image.effect_noise((2048, 1024), 90).convert("RGBA").save(
      frame_buffer,
      format="PNG",
    )
    sample_frame = frame_buffer.getvalue()

    with (
      mock.patch.object(
        chat_service,
        "_asset_roots",
        return_value=(str(self.input_root), str(self.output_root)),
      ),
      mock.patch.object(
        chat_service,
        "_sample_video_frames",
        return_value=[sample_frame, sample_frame],
      ),
    ):
      parts = chat_service.build_attachment_parts(
        [
          {
            "root": "output",
            "path": "clip.mp4",
            "mention": "video2",
          }
        ]
      )

    self.assertEqual(parts[0]["type"], "text")
    self.assertIn("@video2", parts[0]["text"])
    self.assertIn("2 frames", parts[0]["text"])
    frame_parts = [part for part in parts if part["type"] == "image_url"]
    self.assertEqual(len(frame_parts), 2)
    for part in frame_parts:
      encoded = part["image_url"]["url"].split(",", 1)[1]
      compressed_payload = base64.b64decode(encoded)
      with Image.open(BytesIO(compressed_payload)) as compressed:
        self.assertEqual(compressed.format, "JPEG")
        self.assertEqual(compressed.mode, "RGB")
        self.assertEqual(compressed.size, (1280, 640))
        self.assertLessEqual(
          max(compressed.size),
          chat_service.MAX_IMAGE_EDGE,
        )
      self.assertLess(len(compressed_payload), len(sample_frame))

  def test_chat_turn_persists_user_and_assistant_messages(self):
    prompt_library.save_api_config(
      str(self.data_directory),
      {
        "baseUrl": "https://example.com/v1",
        "model": "text-model",
        "apiKey": "secret",
      },
    )
    prompt_library.create_conversation(
      str(self.data_directory),
      {"id": "canvas"},
    )

    with mock.patch.object(
      chat_service,
      "request_chat_completion",
      return_value="assistant reply",
    ):
      result = chat_service.run_chat_turn(
        str(self.data_directory),
        "canvas",
        "user message",
      )

    self.assertEqual(result["message"], "assistant reply")
    conversation = prompt_library.get_conversation(
      str(self.data_directory),
      "canvas",
    )
    self.assertEqual(
      [(item["role"], item["content"]) for item in conversation["messages"]],
      [
        ("user", "user message"),
        ("assistant", "assistant reply"),
      ],
    )
    self.assertEqual(conversation["title"], "user message")

  def test_local_chat_rejects_image_without_mmproj_before_persistence(self):
    prompt_library.create_conversation(
      str(self.data_directory),
      {"id": "local-canvas"},
    )
    image = self.input_root / "photo.png"
    Image.new("RGB", (32, 32), "red").save(image)
    models_root = self.create_local_model_files()
    local_llm_service.save_local_llm_config(
      str(self.data_directory),
      {"modelPath": "chat.gguf"},
      models_root=str(models_root),
    )
    with mock.patch.object(
      chat_service,
      "_asset_roots",
      return_value=(str(self.input_root), str(self.output_root)),
    ), mock.patch.object(
      chat_service,
      "generate_local_chat",
      return_value="should not run",
    ) as generate:
      with self.assertRaisesRegex(
        chat_service.ChatServiceError,
        "vision projection model",
      ):
        chat_service.run_local_chat_turn(
          str(self.data_directory),
          "local-canvas",
          "describe this",
          attachments=[{"root": "input", "path": "photo.png"}],
          models_root=str(models_root),
        )
    generate.assert_not_called()
    conversation = prompt_library.get_conversation(
      str(self.data_directory),
      "local-canvas",
    )
    self.assertEqual(conversation["messages"], [])

  def test_local_chat_sends_image_with_selected_mmproj(self):
    prompt_library.create_conversation(
      str(self.data_directory),
      {"id": "local-vision"},
    )
    image = self.input_root / "photo.png"
    Image.new("RGB", (48, 32), "blue").save(image)
    models_root = self.create_local_model_files()
    local_llm_service.save_local_llm_config(
      str(self.data_directory),
      {
        "modelPath": "chat.gguf",
        "visionModelPath": "mmproj-model.gguf",
      },
      models_root=str(models_root),
    )

    with mock.patch.object(
      chat_service,
      "_asset_roots",
      return_value=(str(self.input_root), str(self.output_root)),
    ), mock.patch.object(
      chat_service,
      "generate_local_chat",
      return_value="local vision reply",
    ) as generate:
      result = chat_service.run_local_chat_turn(
        str(self.data_directory),
        "local-vision",
        "describe this image",
        attachments=[{"root": "input", "path": "photo.png"}],
        models_root=str(models_root),
      )

    self.assertEqual(result["message"], "local vision reply")
    generate.assert_called_once()
    messages = generate.call_args.args[1]
    user_parts = messages[-1]["content"]
    self.assertIsInstance(user_parts, list)
    self.assertTrue(
      any(part.get("type") == "image_url" for part in user_parts)
    )
    conversation = prompt_library.get_conversation(
      str(self.data_directory),
      "local-vision",
    )
    self.assertEqual(len(conversation["messages"]), 2)
    self.assertEqual(
      conversation["messages"][0]["attachments"],
      [
        {
          "root": "input",
          "path": "photo.png",
          "name": "photo.png",
        }
      ],
    )

  def test_local_chat_rejects_audio_for_non_gemma4_model(self):
    prompt_library.create_conversation(
      str(self.data_directory),
      {"id": "local-audio"},
    )
    audio = self.output_root / "voice.wav"
    audio.write_bytes(b"RIFFmock")
    models_root = self.create_local_model_files()
    local_llm_service.save_local_llm_config(
      str(self.data_directory),
      {
        "modelPath": "chat.gguf",
        "visionModelPath": "mmproj-model.gguf",
      },
      models_root=str(models_root),
    )

    with mock.patch.object(
      chat_service,
      "_asset_roots",
      return_value=(str(self.input_root), str(self.output_root)),
    ), mock.patch.object(
      chat_service,
      "generate_local_chat",
      return_value="should not run",
    ) as generate:
      with self.assertRaisesRegex(
        chat_service.ChatServiceError,
        "Audio chat is supported only by Gemma4",
      ):
        chat_service.run_local_chat_turn(
          str(self.data_directory),
          "local-audio",
          "transcribe this",
          attachments=[{"root": "output", "path": "voice.wav"}],
          models_root=str(models_root),
        )
    generate.assert_not_called()

  def test_local_gemma4_chat_sends_audio_with_mmproj(self):
    prompt_library.create_conversation(
      str(self.data_directory),
      {"id": "local-gemma-audio"},
    )
    audio = self.output_root / "voice.wav"
    audio.write_bytes(b"RIFFmock")
    models_root = self.create_local_model_files("gemma4-chat.gguf")
    local_llm_service.save_local_llm_config(
      str(self.data_directory),
      {
        "modelPath": "gemma4-chat.gguf",
        "visionModelPath": "mmproj-model.gguf",
      },
      models_root=str(models_root),
    )

    with mock.patch.object(
      chat_service,
      "_asset_roots",
      return_value=(str(self.input_root), str(self.output_root)),
    ), mock.patch.object(
      chat_service,
      "generate_local_chat",
      return_value="audio understood",
    ) as generate:
      result = chat_service.run_local_chat_turn(
        str(self.data_directory),
        "local-gemma-audio",
        "describe this audio",
        attachments=[{"root": "output", "path": "voice.wav"}],
        models_root=str(models_root),
      )

    self.assertEqual(result["message"], "audio understood")
    messages = generate.call_args.args[1]
    self.assertTrue(
      any(
        part.get("type") == "input_audio"
        for part in messages[-1]["content"]
      )
    )

  def test_local_chat_uses_configured_image_compression(self):
    prompt_library.create_conversation(
      str(self.data_directory),
      {"id": "local-image-options"},
    )
    Image.new("RGB", (32, 32), "green").save(
      self.input_root / "photo.png"
    )
    models_root = self.create_local_model_files()
    local_llm_service.save_local_llm_config(
      str(self.data_directory),
      {
        "modelPath": "chat.gguf",
        "visionModelPath": "mmproj-model.gguf",
        "maxImageEdge": 768,
        "imageJpegQuality": 75,
      },
      models_root=str(models_root),
    )
    build_options = {}

    def fake_build_user_content(text, attachments, **kwargs):
      build_options.update(kwargs)
      return text

    with mock.patch.object(
      chat_service,
      "_asset_roots",
      return_value=(str(self.input_root), str(self.output_root)),
    ), mock.patch.object(
      chat_service,
      "build_user_content",
      side_effect=fake_build_user_content,
    ), mock.patch.object(
      chat_service,
      "generate_local_chat",
      return_value="ok",
    ):
      chat_service.run_local_chat_turn(
        str(self.data_directory),
        "local-image-options",
        "look",
        attachments=[{"root": "input", "path": "photo.png"}],
        persist=False,
        models_root=str(models_root),
      )

    self.assertEqual(build_options["max_image_edge"], 768)
    self.assertEqual(build_options["image_jpeg_quality"], 75)
    self.assertTrue(build_options["progressive_jpeg"])

  def test_translation_turn_ignores_history_system_skill_and_attachments(self):
    prompt_library.save_api_config(
      str(self.data_directory),
      {
        "baseUrl": "https://example.com/v1",
        "model": "translation-model",
        "apiKey": "secret",
      },
    )
    prompt_library.create_conversation(
      str(self.data_directory),
      {
        "id": "translation-canvas",
        "systemPromptTemplate": {
          "id": "system",
          "title": "不应发送",
          "content": "SYSTEM PROMPT MUST NOT BE SENT",
        },
        "skillIds": ["skill-should-not-send"],
        "attachments": [
          {"root": "input", "path": "material.png"},
        ],
        "messages": [
          {"role": "user", "content": "OLD HISTORY"},
          {"role": "assistant", "content": "OLD ASSISTANT REPLY"},
        ],
      },
    )
    calls = []

    def fake_request(config, messages):
      calls.append({"config": config, "messages": messages})
      return "translated paragraph"

    with mock.patch.object(
      chat_service,
      "request_chat_completion",
      side_effect=fake_request,
    ):
      result = chat_service.run_translation_turn(
        str(self.data_directory),
        "translation-canvas",
        "只翻译这一段",
        "en",
      )

    self.assertEqual(result["message"], "translated paragraph")
    self.assertEqual(len(calls), 1)
    messages = calls[0]["messages"]
    self.assertEqual(
      [message["role"] for message in messages],
      ["system", "user"],
    )
    joined = "\n".join(str(message["content"]) for message in messages)
    self.assertIn("只翻译这一段", joined)
    self.assertIn("目标语言：en", joined)
    self.assertNotIn("OLD HISTORY", joined)
    self.assertNotIn("OLD ASSISTANT REPLY", joined)
    self.assertNotIn("SYSTEM PROMPT MUST NOT BE SENT", joined)
    self.assertNotIn("material.png", joined)
    conversation = prompt_library.get_conversation(
      str(self.data_directory),
      "translation-canvas",
    )
    self.assertEqual(
      [(item["role"], item["content"]) for item in conversation["messages"][-2:]],
      [
        ("user", "只翻译这一段"),
        ("assistant", "translated paragraph"),
      ],
    )


if __name__ == "__main__":
  unittest.main()
