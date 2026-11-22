import asyncio
import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from aiohttp import web


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
TEST_PACKAGE = "assets_astral_route_tests"


class FakeRequest:
  def __init__(self, payload):
    self.payload = payload

  async def json(self):
    return self.payload


class PromptTaskRouteTests(unittest.TestCase):
  @classmethod
  def setUpClass(cls):
    fake_folder_paths = types.ModuleType("folder_paths")
    fake_server = types.ModuleType("server")

    class FakePromptServer:
      instance = SimpleNamespace(routes=web.RouteTableDef())

    fake_server.PromptServer = FakePromptServer

    package = types.ModuleType(TEST_PACKAGE)
    package.__path__ = [str(PACKAGE_ROOT)]
    sys.modules[TEST_PACKAGE] = package
    qualified_name = f"{TEST_PACKAGE}.routes"
    with mock.patch.dict(
      sys.modules,
      {
        "folder_paths": fake_folder_paths,
        "server": fake_server,
      },
    ):
      spec = importlib.util.spec_from_file_location(
        qualified_name,
        PACKAGE_ROOT / "routes.py",
      )
      module = importlib.util.module_from_spec(spec)
      sys.modules[qualified_name] = module
      spec.loader.exec_module(module)
    cls.routes = module

  def test_prompt_task_route_passes_options_and_finishes_request(self):
    payload = {
      "requestId": "prompt-tool-test",
      "text": "portrait",
      "task": "expand",
      "mode": "local",
      "ruleId": "expand-rule",
      "skillIds": [],
      "attachments": [{"kind": "image"}],
      "clearVram": True,
      "targetLanguage": "en",
      "sourceLanguage": "auto",
    }
    expected = {"text": "expanded", "task": "expand"}
    with (
      mock.patch.object(
        self.routes,
        "register_chat_request",
        return_value="registered-request",
      ) as register,
      mock.patch.object(
        self.routes,
        "finish_chat_request",
      ) as finish,
      mock.patch.object(
        self.routes,
        "default_data_directory",
        return_value="data-directory",
      ),
      mock.patch.object(
        self.routes,
        "run_prompt_task_async",
        new=mock.AsyncMock(return_value=expected),
      ) as run_task,
    ):
      response = asyncio.run(
        self.routes.post_prompt_task(FakeRequest(payload))
      )

    self.assertEqual(response.status, 200)
    self.assertEqual(json.loads(response.text), expected)
    register.assert_called_once_with("prompt-tool-test")
    run_task.assert_awaited_once_with(
      "data-directory",
      "portrait",
      task="expand",
      mode="local",
      rule_id="expand-rule",
      skill_ids=[],
      attachments=[{"kind": "image"}],
      clear_vram=True,
      request_id="registered-request",
      target_language="en",
      source_language="auto",
    )
    finish.assert_called_once_with("registered-request")

  def test_prompt_task_route_finishes_request_after_failure(self):
    with (
      mock.patch.object(
        self.routes,
        "register_chat_request",
        return_value="registered-request",
      ),
      mock.patch.object(
        self.routes,
        "finish_chat_request",
      ) as finish,
      mock.patch.object(
        self.routes,
        "run_prompt_task_async",
        new=mock.AsyncMock(
          side_effect=self.routes.ChatServiceError("invalid task")
        ),
      ),
    ):
      response = asyncio.run(
        self.routes.post_prompt_task(
          FakeRequest(
            {
              "requestId": "prompt-tool-test",
              "text": "portrait",
              "task": "expand",
            }
          )
        )
      )

    self.assertEqual(response.status, 400)
    self.assertEqual(
      json.loads(response.text),
      {"error": "invalid task"},
    )
    finish.assert_called_once_with("registered-request")


if __name__ == "__main__":
  unittest.main()
