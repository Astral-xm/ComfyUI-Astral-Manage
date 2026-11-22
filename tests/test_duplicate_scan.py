import sys
import threading
import time
import unittest
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
  sys.path.insert(0, str(PACKAGE_ROOT))

import duplicate_scan


class DuplicateScanManagerTests(unittest.TestCase):
  def wait_for_status(self, manager, task_id, statuses, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
      task = manager.snapshot(task_id)
      if task is not None and task["status"] in statuses:
        return task
      time.sleep(0.01)
    self.fail(f"Task {task_id} did not reach {sorted(statuses)}")

  def test_reuses_active_task_and_cancels_background_scan(self):
    scanner_started = threading.Event()

    def scanner(
      _categories,
      *,
      category_filter,
      progress_callback,
      cancel_callback,
    ):
      progress_callback(
        {
          "phase": "hashing",
          "totalFilesToHash": 2,
          "hashedFiles": 0,
          "hashedBytes": 0,
          "totalBytesToHash": 200,
        }
      )
      scanner_started.set()
      while not cancel_callback():
        time.sleep(0.01)
      raise RuntimeError("scan stopped")

    manager = duplicate_scan.DuplicateScanManager(scanner)
    self.addCleanup(manager.shutdown)
    first, started = manager.start([], category_filter="loras")
    second, started_again = manager.start([], category_filter="checkpoints")

    self.assertTrue(started)
    self.assertFalse(started_again)
    self.assertEqual(first["taskId"], second["taskId"])
    self.assertTrue(scanner_started.wait(1), "scanner thread did not start")

    manager.cancel(first["taskId"])
    completed = self.wait_for_status(
      manager,
      first["taskId"],
      {"cancelled"},
    )

    self.assertEqual(completed["category"], "loras")
    self.assertIsNone(completed["result"])
    self.assertEqual(completed["error"], "扫描已取消")

  def test_completes_with_result_and_progress(self):
    def scanner(
      _categories,
      *,
      category_filter,
      progress_callback,
      cancel_callback,
    ):
      self.assertEqual(category_filter, "loras")
      self.assertFalse(cancel_callback())
      progress_callback(
        {
          "phase": "hashing",
          "totalFilesToHash": 4,
          "hashedFiles": 2,
          "hashedBytes": 50,
          "totalBytesToHash": 100,
          "currentFile": {
            "category": "loras",
            "relativePath": "example.safetensors",
          },
        }
      )
      return {
        "groups": [],
        "groupCount": 0,
        "fileCount": 0,
        "reclaimableBytes": 0,
        "scannedFiles": 6,
        "hashedFiles": 4,
      }

    manager = duplicate_scan.DuplicateScanManager(scanner)
    self.addCleanup(manager.shutdown)
    task, started = manager.start([], category_filter="loras")
    self.assertTrue(started)

    completed = self.wait_for_status(
      manager,
      task["taskId"],
      {"succeeded"},
    )

    self.assertEqual(completed["progress"], 1.0)
    self.assertEqual(completed["result"]["scannedFiles"], 6)
    self.assertIsNone(completed["currentFile"])


if __name__ == "__main__":
  unittest.main()
