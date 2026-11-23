import http.server
import importlib.util
import shutil
import socket
import sys
import tempfile
import threading
import types
import unittest
import uuid
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
TEST_PACKAGE = "assets_astral_security_tests"

package = types.ModuleType(TEST_PACKAGE)
package.__path__ = [str(PACKAGE_ROOT)]
sys.modules[TEST_PACKAGE] = package

for module_name in ("asset_library", "prompt_library", "local_llm_service", "chat_service"):
  qualified_name = f"{TEST_PACKAGE}.{module_name}"
  spec = importlib.util.spec_from_file_location(
    qualified_name,
    PACKAGE_ROOT / f"{module_name}.py",
  )
  module = importlib.util.module_from_spec(spec)
  sys.modules[qualified_name] = module
  spec.loader.exec_module(module)

chat_service = sys.modules[f"{TEST_PACKAGE}.chat_service"]
local_llm_service = sys.modules[f"{TEST_PACKAGE}.local_llm_service"]
prompt_library = sys.modules[f"{TEST_PACKAGE}.prompt_library"]


class SecurityRegressionTests(unittest.TestCase):
  def setUp(self):
    self.temp_path = (
      PACKAGE_ROOT
      / ".asset-library-tests"
      / f"security-{uuid.uuid4().hex}"
    )
    self.temp_path.mkdir(parents=True)
    self.data_directory = self.temp_path / "data"
    self.data_directory.mkdir()

  def tearDown(self):
    shutil.rmtree(self.temp_path, ignore_errors=True)

  def test_changing_the_base_url_drops_the_stored_key(self):
    prompt_library.save_api_config(
      str(self.data_directory),
      {
        "baseUrl": "https://api.example.com/v1",
        "model": "example-model",
        "apiKey": "sk-secret",
      },
    )
    self.assertEqual(
      prompt_library.resolve_api_config(str(self.data_directory), "text")["apiKey"],
      "sk-secret",
    )

    prompt_library.save_api_config(
      str(self.data_directory),
      {"baseUrl": "https://other.example.net/v1"},
    )
    resolved = prompt_library.resolve_api_config(str(self.data_directory), "text")
    self.assertEqual(resolved["baseUrl"], "https://other.example.net/v1")
    self.assertEqual(resolved["apiKey"], "")

  def test_a_new_key_is_accepted_with_the_new_base_url(self):
    prompt_library.save_api_config(
      str(self.data_directory),
      {"baseUrl": "https://api.example.com/v1", "apiKey": "sk-old"},
    )
    prompt_library.save_api_config(
      str(self.data_directory),
      {"baseUrl": "https://other.example.net/v1", "apiKey": "sk-new"},
    )
    self.assertEqual(
      prompt_library.resolve_api_config(str(self.data_directory), "text")["apiKey"],
      "sk-new",
    )

  def test_model_list_uses_the_saved_provider_not_the_request_body(self):
    prompt_library.save_api_config(
      str(self.data_directory),
      {
        "baseUrl": "https://api.example.com/v1",
        "model": "example-model",
        "apiKey": "sk-secret",
      },
    )
    saved = prompt_library.load_api_configuration(str(self.data_directory))
    provider = prompt_library.resolve_api_provider(
      str(self.data_directory),
      {
        "id": saved["providers"][0]["id"],
        "baseUrl": "http://169.254.169.254/latest",
        "apiKey": "attacker-supplied",
      },
    )
    self.assertEqual(provider["baseUrl"], "https://api.example.com/v1")
    self.assertEqual(provider["apiKey"], "sk-secret")

  def test_api_errors_do_not_echo_the_upstream_body(self):
    message = chat_service._api_error_message(
      500,
      {"error": {"message": "internal-secret"}},
      '{"error": {"message": "internal-secret"}}',
    )
    self.assertNotIn("internal-secret", message)
    self.assertIn("500", message)

  def test_absolute_and_unc_model_paths_are_rejected_before_file_access(self):
    original = local_llm_service.os.path.realpath
    calls = []

    def tracking_realpath(path, *args, **kwargs):
      calls.append(path)
      return original(path, *args, **kwargs)

    local_llm_service.os.path.realpath = tracking_realpath
    try:
      for value in (
        r"\\server\share\model.gguf",
        "//server/share/model.gguf",
        r"C:\models\model.gguf",
        "C:model.gguf",
        "../outside.gguf",
      ):
        with self.assertRaises(local_llm_service.LocalLLMError):
          local_llm_service._model_relative_path(
            value,
            str(self.temp_path),
            require_file=False,
          )
      self.assertEqual(calls, [])
    finally:
      local_llm_service.os.path.realpath = original

  def test_model_list_requests_do_not_follow_redirects(self):
    hits = []
    with socket.socket() as probe:
      probe.bind(("127.0.0.1", 0))
      port = probe.getsockname()[1]

    class Handler(http.server.BaseHTTPRequestHandler):
      def do_GET(self):
        hits.append(self.path)
        if self.path == "/models":
          self.send_response(302)
          self.send_header("Location", f"http://127.0.0.1:{port}/target")
          self.end_headers()
          return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"data": []}')

      def log_message(self, *args):
        pass

    server = http.server.HTTPServer(("127.0.0.1", port), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
      status, _payload, _raw = chat_service._http_get_json(
        f"http://127.0.0.1:{port}/models",
        {"Authorization": "Bearer secret"},
        5,
      )
    finally:
      server.shutdown()
      server.server_close()
    self.assertEqual(status, 302)
    self.assertEqual(hits, ["/models"])


if __name__ == "__main__":
  unittest.main()
