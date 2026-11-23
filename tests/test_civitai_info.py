import importlib.util
import unittest
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
  "asset_civitai_info",
  PACKAGE_ROOT / "civitai_info.py",
)
civitai_info = importlib.util.module_from_spec(spec)
spec.loader.exec_module(civitai_info)


class CivitaiInfoTests(unittest.TestCase):
  def test_normalizes_chinese_recommendation_and_trigger_words(self):
    data = {
      "id": 3313358,
      "modelId": 2927894,
      "name": "v1.0",
      "model": {
        "name": "Celestial Dynasty",
        "description": "<p>推荐强度为 0.60～0.80，适合人像。</p>",
      },
      "trainedWords": ["DCC3LDYN@S.", "extra, trigger"],
    }

    result = civitai_info.normalize_civitai_model_version(
      data,
      "Krea2/example.safetensors",
      "abc123",
    )

    self.assertEqual(result["name"], "Celestial Dynasty - v1.0")
    self.assertEqual(
      result["url"],
      "https://civitai.com/models/2927894?modelVersionId=3313358",
    )
    self.assertEqual(result["recommendedStrength"]["text"], "0.6 - 0.8")
    self.assertEqual(result["recommendedStrength"]["value"], 0.7)
    self.assertEqual(
      result["recommendedStrength"]["source"],
      "Civitai description",
    )
    self.assertEqual(result["triggers"], ["DCC3LDYN@S.", "extra", "trigger"])

  def test_reads_english_recommendation(self):
    data = {
      "model": {
        "description": "Recommended LoRA weight range of 0.75 to 1.00.",
      },
    }

    recommendation = civitai_info.extract_recommended_strength(data)

    self.assertEqual(recommendation["text"], "0.75 - 1")
    self.assertEqual(recommendation["value"], 0.88)
  def test_uses_only_weights_for_the_matching_model_version(self):
    data = {
      "id": 222,
      "images": [
        {
          "meta": {
            "resources": [
              {"type": "lora", "modelVersionId": 111, "weight": 0.2},
              {"type": "lora", "modelVersionId": 222, "weight": 0.65},
            ],
          },
        },
        {
          "meta": {
            "civitaiResources": [
              {"type": "lora", "modelVersionId": 222, "weight": 0.85},
            ],
          },
        },
      ],
    }

    recommendation = civitai_info.extract_recommended_strength(data)

    self.assertEqual(recommendation["text"], "0.65 - 0.85")
    self.assertEqual(recommendation["value"], 0.75)
    self.assertEqual(recommendation["source"], "Civitai preview weight")

  def test_does_not_invent_a_strength(self):
    data = {
      "description": "A LoRA for character details.",
      "trainedWords": ["character"],
    }

    self.assertIsNone(civitai_info.extract_recommended_strength(data))

  def test_maps_common_http_failures_to_readable_reasons(self):
    self.assertIn("did not find", civitai_info.error_message_for_status(404))
    self.assertIn(
      "too many requests",
      civitai_info.error_message_for_status(429),
    )
    self.assertIn("HTTP 503", civitai_info.error_message_for_status(503))


if __name__ == "__main__":
  unittest.main()
