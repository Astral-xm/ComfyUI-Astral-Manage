import importlib
import json
import shutil
import sys
import types
import unittest
import uuid
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_NAME = "_assets_astral_cache_test"
if PACKAGE_NAME not in sys.modules:
  package = types.ModuleType(PACKAGE_NAME)
  package.__path__ = [str(PACKAGE_ROOT)]
  sys.modules[PACKAGE_NAME] = package
source_cache = importlib.import_module(f"{PACKAGE_NAME}.lora_source_cache")


class LoraSourceCacheTests(unittest.TestCase):
  def setUp(self):
    self.temp_path = (
      PACKAGE_ROOT
      / ".asset-library-tests"
      / f"lora-source-cache-{uuid.uuid4().hex}"
    )
    self.temp_path.mkdir(parents=True)
    self.lora_path = self.temp_path / "hero.safetensors"
    self.lora_path.write_bytes(b"test-lora")
    self.file = "characters/hero.safetensors"

  def tearDown(self):
    shutil.rmtree(self.temp_path, ignore_errors=True)

  def sample_result(self):
    return {
      "file": self.file,
      "sha256": "abc123",
      "metadata": {"aliases": ["hero"]},
      "searchQueries": ["hero"],
      "refreshedAt": 1770000000,
      "recommendedStrength": {
        "text": "0.6 - 0.9",
        "value": 0.75,
        "min": 0.6,
        "max": 0.9,
        "source": "C站描述",
      },
      "recommendedStrengthSource": "C站描述",
      "triggers": ["hero", "cinematic"],
      "triggersSource": "C站",
      "thumbnailUrl": "https://image.civitai.com/example.jpeg",
      "thumbnailSource": "C站示例图",
      "sources": {
        "civitai": {
          "ok": True,
          "match": "sha256",
          "url": "https://civitai.com/models/1?modelVersionId=2",
          "name": "Hero - v1",
          "versionName": "v1",
          "baseModel": "Illustrious",
          "modelId": 1,
          "modelVersionId": 2,
          "description": "<p>Recommended strength 0.6 - 0.9</p>",
        },
        "huggingface": {
          "ok": True,
          "url": "https://huggingface.co/owner/hero",
          "candidates": [],
        },
        "modelscope": {
          "ok": False,
          "error": "未找到模型",
        },
      },
    }

  def test_persists_nb_compatible_json_and_restores_full_result(self):
    result = self.sample_result()
    downloader_calls = []

    def downloader(url):
      downloader_calls.append(url)
      return b"fake-png", ".png"

    persisted = source_cache.persist_lora_source_result(
      self.file,
      str(self.lora_path),
      result,
      downloader=downloader,
    )

    sidecar = self.temp_path / "hero.json"
    preview = self.temp_path / "hero.preview.png"
    self.assertTrue(sidecar.is_file())
    self.assertEqual(preview.read_bytes(), b"fake-png")
    self.assertEqual(downloader_calls, [result["thumbnailUrl"]])
    self.assertIn("/assets-astral/loras/thumbnail?", persisted["thumbnailLocalUrl"])

    data = json.loads(sidecar.read_text(encoding="utf-8"))
    self.assertEqual(data["name"], "hero.safetensors")
    self.assertEqual(data["triggerWords"], "hero, cinematic")
    self.assertEqual(data["recommendedWeight"], "0.6 - 0.9")
    self.assertEqual(data["previewImage"], str(preview))
    self.assertEqual(data["civitaiUrl"], result["sources"]["civitai"]["url"])
    self.assertEqual(data["sourceUrls"]["huggingface"], result["sources"]["huggingface"]["url"])
    self.assertNotIn("cache", data["assetsAstral"])
    self.assertNotIn("thumbnailLocalUrl", data["assetsAstral"])

    restored = source_cache.load_lora_source_cache(
      self.file,
      str(self.lora_path),
    )
    self.assertEqual(restored["recommendedStrength"]["text"], "0.6 - 0.9")
    self.assertEqual(restored["triggers"], ["hero", "cinematic"])
    self.assertEqual(
      restored["sources"]["civitai"]["url"],
      result["sources"]["civitai"]["url"],
    )
    self.assertEqual(restored["thumbnailLocalFile"], "hero.preview.png")
    self.assertEqual(restored["cache"]["sidecar"], "hero.json")

  def test_reads_existing_nb_sidecar_without_overwriting_it(self):
    sidecar = self.temp_path / "hero.json"
    sidecar.write_text(
      json.dumps(
        {
          "name": "hero.safetensors",
          "triggerWords": "hero, portrait",
          "recommendedWeight": "0.8",
          "civitaiUrl": "https://civitai.com/models/123",
          "civitaiStatus": "matched",
          "civitaiModelId": 123,
          "civitaiVersionId": 456,
          "updatedAt": "2026-01-02T03:04:05.000Z",
        },
        ensure_ascii=False,
      ),
      encoding="utf-8",
    )
    (self.temp_path / "hero.preview.jpg").write_bytes(b"existing-preview")

    restored = source_cache.load_lora_source_cache(
      self.file,
      str(self.lora_path),
    )

    self.assertEqual(restored["triggers"], ["hero", "portrait"])
    self.assertEqual(restored["recommendedStrength"]["text"], "0.8")
    self.assertEqual(restored["sources"]["civitai"]["modelId"], 123)
    self.assertEqual(restored["thumbnailLocalFile"], "hero.preview.jpg")
    self.assertIn("/assets-astral/loras/thumbnail?", restored["thumbnailLocalUrl"])

  def test_uses_astral_sidecar_when_standard_json_is_unrelated(self):
    unrelated = self.temp_path / "hero.json"
    original = {"rgthree": {"custom": True}}
    unrelated.write_text(json.dumps(original), encoding="utf-8")

    source_cache.persist_lora_source_result(
      self.file,
      str(self.lora_path),
      self.sample_result(),
      downloader=lambda _url: (b"preview", ".webp"),
    )

    self.assertEqual(
      json.loads(unrelated.read_text(encoding="utf-8")),
      original,
    )
    self.assertTrue((self.temp_path / "hero.astral.json").is_file())
    self.assertTrue((self.temp_path / "hero.preview.webp").is_file())
    restored = source_cache.load_lora_source_cache(
      self.file,
      str(self.lora_path),
    )
    self.assertEqual(restored["cache"]["sidecar"], "hero.astral.json")

  def test_failed_refresh_preserves_previous_successful_sources_in_sidecar(self):
    source_cache.persist_lora_source_result(
      self.file,
      str(self.lora_path),
      self.sample_result(),
      downloader=lambda _url: (b"preview", ".png"),
    )
    failed = self.sample_result()
    failed["refreshedAt"] += 60
    failed["recommendedStrength"] = None
    failed["triggers"] = []
    failed["thumbnailUrl"] = ""
    failed["sources"] = {
      "civitai": {"ok": False, "error": "C站请求过于频繁"},
      "huggingface": {"ok": False, "error": "Hugging Face 超时"},
      "modelscope": {"ok": False, "error": "魔搭超时"},
    }

    current = source_cache.persist_lora_source_result(
      self.file,
      str(self.lora_path),
      failed,
      downloader=lambda _url: (b"unused", ".png"),
    )

    self.assertEqual(
      current["preservedCachedSources"],
      ["civitai", "huggingface"],
    )
    self.assertFalse(current["sources"]["civitai"]["ok"])
    restored = source_cache.load_lora_source_cache(
      self.file,
      str(self.lora_path),
    )
    self.assertTrue(restored["sources"]["civitai"]["ok"])
    self.assertTrue(restored["sources"]["huggingface"]["ok"])
    self.assertFalse(restored["sources"]["modelscope"]["ok"])
    self.assertEqual(
      restored["sources"]["civitai"]["url"],
      self.sample_result()["sources"]["civitai"]["url"],
    )
    self.assertEqual(
      restored["lastRefreshAttempt"]["sources"]["civitai"]["error"],
      "C站请求过于频繁",
    )

  def test_ignores_corrupt_or_unrelated_json(self):
    (self.temp_path / "hero.json").write_text("{not json", encoding="utf-8")

    self.assertIsNone(
      source_cache.load_lora_source_cache(self.file, str(self.lora_path))
    )

  def test_name_alone_does_not_claim_a_standard_json_sidecar(self):
    unrelated = self.temp_path / "hero.json"
    original = {"name": "hero", "note": "unrelated metadata"}
    unrelated.write_text(json.dumps(original), encoding="utf-8")

    source_cache.persist_lora_source_result(
      self.file,
      str(self.lora_path),
      self.sample_result(),
      downloader=lambda _url: (b"preview", ".png"),
    )

    self.assertEqual(
      json.loads(unrelated.read_text(encoding="utf-8")),
      original,
    )
    self.assertTrue((self.temp_path / "hero.astral.json").is_file())


if __name__ == "__main__":
  unittest.main()
