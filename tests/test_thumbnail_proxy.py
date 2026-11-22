import importlib
import io
import shutil
import sys
import types
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from PIL import Image


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_NAME = "_assets_astral_thumbnail_test"
if PACKAGE_NAME not in sys.modules:
  package = types.ModuleType(PACKAGE_NAME)
  package.__path__ = [str(PACKAGE_ROOT)]
  sys.modules[PACKAGE_NAME] = package
thumbnail_proxy = importlib.import_module(f"{PACKAGE_NAME}.thumbnail_proxy")


class ThumbnailProxyTests(unittest.TestCase):
  def setUp(self):
    self.temp_path = (
      PACKAGE_ROOT
      / ".asset-library-tests"
      / f"thumbnails-{uuid.uuid4().hex}"
    )
    self.temp_path.mkdir(parents=True)

  def tearDown(self):
    shutil.rmtree(self.temp_path, ignore_errors=True)

  @staticmethod
  def png_bytes():
    output = io.BytesIO()
    Image.new("RGB", (8, 8), "#336699").save(output, "PNG")
    return output.getvalue()

  def test_accepts_trusted_https_hosts(self):
    for url in (
      "https://image.civitai.com/preview.jpeg",
      "https://huggingface.co/thumb.png",
      "https://www.modelscope.cn/thumb.webp",
    ):
      with self.subTest(url=url):
        self.assertEqual(thumbnail_proxy.validate_thumbnail_url(url), url)

  def test_rejects_insecure_credentials_and_untrusted_hosts(self):
    for url in (
      "http://image.civitai.com/preview.jpeg",
      "https://user:pass@civitai.com/preview.jpeg",
      "https://example.com/preview.jpeg",
    ):
      with self.subTest(url=url):
        with self.assertRaises(thumbnail_proxy.ThumbnailError):
          thumbnail_proxy.validate_thumbnail_url(url)

  def test_detects_image_extension_and_rejects_non_image_content_type(self):
    data = self.png_bytes()
    self.assertEqual(
      thumbnail_proxy._image_extension("image/png", data),
      ".png",
    )
    with self.assertRaises(thumbnail_proxy.ThumbnailError):
      thumbnail_proxy._image_extension("text/plain", data)

  def test_cache_writes_once_then_reuses_existing_image(self):
    url = "https://image.civitai.com/preview.png"
    calls = 0

    def fake_download(_url):
      nonlocal calls
      calls += 1
      return self.png_bytes(), ".png", "image/png"

    with patch.object(thumbnail_proxy, "_download_image", side_effect=fake_download):
      first = thumbnail_proxy.cache_thumbnail(url, str(self.temp_path))
      second = thumbnail_proxy.cache_thumbnail(url, str(self.temp_path))

    self.assertEqual(first, second)
    self.assertTrue(Path(first).is_file())
    self.assertEqual(calls, 1)


if __name__ == "__main__":
  unittest.main()
