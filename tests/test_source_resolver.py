import io
import importlib
import json
import struct
import sys
import types
import unittest
from unittest.mock import patch
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_NAME = "_assets_astral_source_test"
if PACKAGE_NAME not in sys.modules:
  package = types.ModuleType(PACKAGE_NAME)
  package.__path__ = [str(PACKAGE_ROOT)]
  sys.modules[PACKAGE_NAME] = package
source_resolver = importlib.import_module(f"{PACKAGE_NAME}.source_resolver")


class FakeResponse:
  def __init__(self, payload, status_code=200):
    self._payload = payload
    self.status_code = status_code
    self.headers = {}

  def json(self):
    return self._payload


class SourceResolverTests(unittest.TestCase):
  def test_parses_shared_windows_proxy(self):
    self.assertEqual(
      source_resolver._parse_windows_proxy_server("127.0.0.1:7890"),
      {
        "http": "http://127.0.0.1:7890",
        "https": "http://127.0.0.1:7890",
      },
    )

  def test_parses_per_protocol_windows_proxy(self):
    self.assertEqual(
      source_resolver._parse_windows_proxy_server(
        "http=127.0.0.1:7890;https=127.0.0.1:7891"
      ),
      {
        "http": "http://127.0.0.1:7890",
        "https": "http://127.0.0.1:7891",
      },
    )

  def test_search_queries_include_human_readable_name(self):
    queries = source_resolver.search_queries("Char_style-v2.safetensors")

    self.assertEqual(queries[0], "Char_style-v2")
    self.assertIn("Char style v2", queries)

  def test_search_queries_add_leading_metadata_alias_for_renamed_file(self):
    queries = source_resolver.search_queries(
      "local-random-name.safetensors",
      aliases=["girlslike_by_XTER"],
    )

    self.assertIn("girlslike", queries)

  def test_search_queries_strip_cjk_suffix_for_ascii_model_search(self):
    queries = source_resolver.search_queries(
      "krea2-Cc-MJ-影视柔光.safetensors",
    )

    self.assertIn("krea2 Cc MJ", queries)

  def test_search_queries_drop_generic_version_fragments(self):
    queries = source_resolver.search_queries(
      "DC Celestial Dynasty v1.safetensors",
      canonical_name="DC Celestial Dynasty - v1.0 [Krea 2 Raw]",
    )

    self.assertNotIn("v1", queries)
    self.assertFalse(any(query.casefold().startswith("v1.") for query in queries))

  def test_safetensors_metadata_aliases_survive_local_file_rename(self):
    header = {
      "__metadata__": {
        "modelspec.title": "Renamed Hero Style",
        "ss_base_model_version": "sdxl_base_v1-0",
      }
    }
    encoded = json.dumps(header, ensure_ascii=False).encode("utf-8")
    payload = struct.pack("<Q", len(encoded)) + encoded
    with patch("builtins.open", return_value=io.BytesIO(payload)):
      metadata = source_resolver._read_safetensors_metadata(
        "random_local_name.safetensors"
      )

    summary = source_resolver.summarize_safetensors_metadata(metadata)
    queries = source_resolver.search_queries(
      "random_local_name.safetensors",
      aliases=summary["aliases"],
    )
    self.assertEqual(summary["details"]["ss_base_model_version"], "sdxl_base_v1-0")
    self.assertEqual(queries[0], "Renamed Hero Style")
    self.assertIn("random_local_name", queries)

  @patch.object(source_resolver.requests, "request")
  def test_huggingface_uses_name_search_and_keeps_model_path(self, request):
    request.return_value = FakeResponse(
      [
        {
          "id": "owner/style-lora",
          "downloads": 123,
          "likes": 4,
          "pipeline_tag": "text-to-image",
        }
      ]
    )

    result = source_resolver.find_huggingface_sources("style_lora.safetensors")

    self.assertTrue(result["ok"])
    self.assertEqual(result["match"], "name-candidate")
    self.assertEqual(
      result["candidates"][0]["url"],
      "https://huggingface.co/owner/style-lora",
    )
    self.assertEqual(request.call_args.kwargs["params"]["search"], "style_lora")

  @patch.object(source_resolver.requests, "request")
  def test_modelscope_uses_put_search_endpoint(self, request):
    request.return_value = FakeResponse(
      {
        "Code": 200,
        "Data": {
          "Model": {
            "Models": [
              {
                "Path": "owner",
                "Name": "style-lora",
                "ChineseName": "风格 LoRA",
                "Downloads": 42,
                "Stars": 5,
              }
            ]
          }
        },
      }
    )

    result = source_resolver.find_modelscope_sources("style_lora.safetensors")

    self.assertEqual(request.call_args.args[0], "PUT")
    self.assertEqual(
      request.call_args.args[1],
      "https://www.modelscope.cn/api/v1/dolphin/models",
    )
    self.assertEqual(
      result["candidates"][0]["url"],
      "https://www.modelscope.cn/models/owner/style-lora",
    )
    self.assertEqual(result["candidates"][0]["name"], "风格 LoRA")

  def test_huggingface_candidate_is_promoted_when_lfs_sha256_matches(self):
    expected_hash = "a" * 64

    def fake_request(method, url, **kwargs):
      del method, kwargs
      if url.endswith("/paths-info/main"):
        return [
          {
            "type": "file",
            "path": "renamed/repository-file.safetensors",
            "lfs": {"oid": expected_hash, "size": 123},
          }
        ]
      return [
        {
          "id": "owner/renamed-repository",
          "downloads": 100,
          "likes": 2,
          "siblings": [
            {"rfilename": "renamed/repository-file.safetensors"},
          ],
        }
      ]

    with patch.object(source_resolver.requests, "request", side_effect=lambda *args, **kwargs: FakeResponse(fake_request(*args, **kwargs))):
      result = source_resolver.find_huggingface_sources(
        "local-renamed.safetensors",
        sha256=expected_hash,
      )

    candidate = result["candidates"][0]
    self.assertEqual(result["match"], "sha256")
    self.assertEqual(candidate["matchLabel"], "SHA256 精确匹配")
    self.assertEqual(
      candidate["matchedFile"],
      "renamed/repository-file.safetensors",
    )

  def test_huggingface_hash_uses_batched_paths_info(self):
    expected_hash = "c" * 64
    calls = []

    def fake_request(method, url, **kwargs):
      calls.append((method, url, kwargs.get("json")))
      if url.endswith("/paths-info/main"):
        return [
          {
            "type": "file",
            "path": "weights/local-file.safetensors",
            "lfs": {"oid": expected_hash, "size": 123},
          }
        ]
      return [
        {
          "id": "owner/repository",
          "siblings": [
            {"rfilename": "README.md"},
            {"rfilename": "weights/local-file.safetensors"},
          ],
        }
      ]

    with patch.object(source_resolver.requests, "request", side_effect=lambda *args, **kwargs: FakeResponse(fake_request(*args, **kwargs))):
      result = source_resolver.find_huggingface_sources(
        "repository.safetensors",
        sha256=expected_hash,
      )

    self.assertEqual(result["match"], "sha256")
    self.assertTrue(
      any(
        method == "POST" and url.endswith("/paths-info/main")
        for method, url, _body in calls
      )
    )

  def test_modelscope_candidate_is_promoted_when_file_sha256_matches(self):
    expected_hash = "b" * 64

    def fake_request(source, method, url, **kwargs):
      del source, method, kwargs
      if "/repo/files" in url:
        return {
          "Code": 200,
          "Data": {
            "Files": [
              {
                "Path": "weights/renamed-file.safetensors",
                "Sha256": expected_hash,
              }
            ]
          },
        }
      return {
        "Code": 200,
        "Data": {
          "Model": {
            "Models": [
              {
                "Path": "owner",
                "Name": "renamed-repository",
                "ChineseName": "改名仓库",
              }
            ]
          }
        },
      }

    with patch.object(source_resolver, "_json_request", side_effect=fake_request):
      result = source_resolver.find_modelscope_sources(
        "local-renamed.safetensors",
        sha256=expected_hash,
      )

    candidate = result["candidates"][0]
    self.assertEqual(result["match"], "sha256")
    self.assertEqual(candidate["matchType"], "sha256")
    self.assertEqual(candidate["matchedFile"], "weights/renamed-file.safetensors")

  def test_model_card_reads_only_explicit_trigger_fields(self):
    text = """
    # Style LoRA

    Trigger words: soft focus, cinematic light

    No other trigger is needed for the gallery example.
    """

    self.assertEqual(
      source_resolver.extract_trigger_words_from_model_card(text),
      ["soft focus", "cinematic light"],
    )
    self.assertEqual(
      source_resolver.extract_trigger_words_from_model_card(
        "No trigger word is needed, just use an image reference.",
      ),
      [],
    )
    self.assertEqual(
      source_resolver.extract_trigger_words_from_model_card(
        "---\ntrigger_words:\n  - soft light\n  - portrait, film\n---",
      ),
      ["soft light", "portrait", "film"],
    )

  def test_huggingface_model_card_supplies_strength_and_triggers(self):
    source = {
      "ok": True,
      "candidates": [
        {
          "id": "owner/style-lora",
          "matchType": "sha256",
        }
      ],
    }

    def fake_json(source_name, method, url, **kwargs):
      del source_name, method, url, kwargs
      return {"cardData": {"instance_prompt": "photo style"}}

    def fake_text(source_name, method, url, **kwargs):
      del source_name, method, url, kwargs
      return """
      # Style LoRA
      Trigger words: soft focus, cinematic
      Recommended weight range is 0.8-1.2.
      """

    with (
      patch.object(source_resolver, "_json_request", side_effect=fake_json),
      patch.object(source_resolver, "_text_request", side_effect=fake_text),
    ):
      source_resolver._enrich_huggingface_source(source)

    self.assertEqual(
      source["recommendedStrength"]["text"],
      "0.8 - 1.2",
    )
    self.assertEqual(
      source["recommendedStrength"]["source"],
      "Hugging Face 模型卡",
    )
    self.assertEqual(source["triggers"], ["photo style", "soft focus", "cinematic"])
    self.assertEqual(source["triggersSource"], "Hugging Face 模型卡")

  def test_modelscope_model_card_supplies_strength_and_triggers(self):
    source = {
      "ok": True,
      "candidates": [
        {
          "id": "owner/style-lora",
          "matchType": "sha256",
        }
      ],
    }
    payload = {
      "Code": 200,
      "Data": {
        "Description": "人物柔光滤镜，建议权重0.8-1.2",
        "ReadMeContent": "",
        "TriggerWords": '["soft light", "portrait"]',
        "MuseInfo": {"versions": []},
      },
    }

    with patch.object(
      source_resolver,
      "_json_request",
      return_value=payload,
    ):
      source_resolver._enrich_modelscope_source(source)

    self.assertEqual(source["recommendedStrength"]["text"], "0.8 - 1.2")
    self.assertEqual(source["recommendedStrength"]["source"], "魔搭模型卡")
    self.assertEqual(source["triggers"], ["soft light", "portrait"])
    self.assertEqual(source["triggersSource"], "魔搭模型卡")

  def test_aggregate_prefers_civitai_then_huggingface_then_modelscope(self):
    sources = {
      "civitai": {
        "ok": True,
        "recommendedStrength": None,
        "triggers": [],
      },
      "huggingface": {
        "ok": True,
        "recommendedStrength": {
          "text": "0.7 - 0.9",
          "value": 0.8,
          "source": "Hugging Face 模型卡",
        },
        "triggers": ["hf trigger"],
        "triggersSource": "Hugging Face 模型卡",
      },
      "modelscope": {
        "ok": True,
        "recommendedStrength": {
          "text": "0.6 - 0.8",
          "value": 0.7,
          "source": "魔搭模型卡",
        },
        "triggers": ["ms trigger"],
        "triggersSource": "魔搭模型卡",
      },
    }

    result = source_resolver._aggregate_model_info(sources)

    self.assertEqual(result["recommendedStrength"]["text"], "0.7 - 0.9")
    self.assertEqual(result["recommendedStrengthSource"], "Hugging Face")
    self.assertEqual(result["triggers"], ["hf trigger"])
    self.assertEqual(result["triggersSource"], "Hugging Face 模型卡")

    sources["civitai"]["recommendedStrength"] = {
      "text": "0.5",
      "value": 0.5,
      "source": "C站描述",
    }
    sources["civitai"]["triggers"] = ["civitai trigger"]
    result = source_resolver._aggregate_model_info(sources)

    self.assertEqual(result["recommendedStrength"]["text"], "0.5")
    self.assertEqual(result["triggers"], ["civitai trigger"])
    self.assertEqual(result["triggersSource"], "C站模型")

  @patch.object(source_resolver.requests, "request")
  def test_reports_readable_source_http_failure(self, request):
    request.return_value = FakeResponse({}, status_code=429)

    with self.assertRaises(source_resolver.SourceRequestError) as context:
      source_resolver.find_huggingface_sources("style.safetensors")

    self.assertIn("请求过于频繁", str(context.exception))


if __name__ == "__main__":
  unittest.main()
