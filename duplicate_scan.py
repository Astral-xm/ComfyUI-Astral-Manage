from __future__ import annotations

import copy
import threading
import time
import uuid
from collections.abc import Callable
from typing import Any


TERMINAL_STATUSES = {"succeeded", "failed", "cancelled"}
ACTIVE_STATUSES = {"queued", "running", "cancelling"}


class DuplicateScanManager:
  def __init__(
    self,
    scanner: Callable[..., dict[str, Any]],
    *,
    max_history: int = 8,
  ) -> None:
    self._scanner = scanner
    self._max_history = max(2, int(max_history))
    self._lock = threading.RLock()
    self._jobs: dict[str, dict[str, Any]] = {}
    self._job_order: list[str] = []
    self._cancel_events: dict[str, threading.Event] = {}
    self._active_job_id: str | None = None

  def start(
    self,
    categories: list[dict[str, Any]],
    *,
    category_filter: str = "",
  ) -> tuple[dict[str, Any], bool]:
    with self._lock:
      active = self._get_active_locked()
      if active is not None:
        return self._snapshot_locked(active), False

      task_id = uuid.uuid4().hex
      now = time.time()
      task = {
        "taskId": task_id,
        "status": "queued",
        "phase": "queued",
        "category": category_filter,
        "createdAt": now,
        "startedAt": None,
        "finishedAt": None,
        "updatedAt": now,
        "scannedFiles": 0,
        "totalFilesToHash": 0,
        "hashedFiles": 0,
        "failedFiles": 0,
        "hashedBytes": 0,
        "totalBytesToHash": 0,
        "currentFile": None,
        "result": None,
        "error": None,
      }
      cancel_event = threading.Event()
      self._jobs[task_id] = task
      self._job_order.append(task_id)
      self._cancel_events[task_id] = cancel_event
      self._active_job_id = task_id
      self._trim_history_locked()
      snapshot = self._snapshot_locked(task)
      categories_copy = copy.deepcopy(categories)

    thread = threading.Thread(
      target=self._run,
      args=(task_id, categories_copy, category_filter, cancel_event),
      name=f"assets-astral-duplicate-scan-{task_id[:8]}",
      daemon=True,
    )
    try:
      thread.start()
    except Exception as error:
      with self._lock:
        task = self._jobs.get(task_id)
        if task is not None:
          task["status"] = "failed"
          task["phase"] = "failed"
          task["error"] = f"无法启动后台扫描线程：{error}"
          task["finishedAt"] = time.time()
          task["updatedAt"] = task["finishedAt"]
          self._finish_locked(task_id)
      raise
    return snapshot, True

  def snapshot(self, task_id: str | None = None) -> dict[str, Any] | None:
    with self._lock:
      task = self._resolve_task_locked(task_id)
      return self._snapshot_locked(task) if task is not None else None

  def cancel(self, task_id: str | None = None) -> dict[str, Any] | None:
    with self._lock:
      task = self._resolve_task_locked(task_id)
      if task is None:
        return None
      status = str(task["status"])
      if status in TERMINAL_STATUSES:
        return self._snapshot_locked(task)
      cancel_event = self._cancel_events.get(str(task["taskId"]))
      if cancel_event is not None:
        cancel_event.set()
      task["status"] = "cancelling"
      task["updatedAt"] = time.time()
      return self._snapshot_locked(task)

  def shutdown(self) -> None:
    with self._lock:
      for task in self._jobs.values():
        if task["status"] in ACTIVE_STATUSES:
          event = self._cancel_events.get(str(task["taskId"]))
          if event is not None:
            event.set()
          task["status"] = "cancelling"
          task["updatedAt"] = time.time()

  def _run(
    self,
    task_id: str,
    categories: list[dict[str, Any]],
    category_filter: str,
    cancel_event: threading.Event,
  ) -> None:
    with self._lock:
      task = self._jobs.get(task_id)
      if task is None:
        return
      task["status"] = "running"
      task["phase"] = "starting"
      task["startedAt"] = time.time()
      task["updatedAt"] = task["startedAt"]

    def report(update: dict[str, Any]) -> None:
      with self._lock:
        current = self._jobs.get(task_id)
        if current is None or current["status"] in TERMINAL_STATUSES:
          return
        current.update(copy.deepcopy(update))
        current["updatedAt"] = time.time()
        if current.get("phase") == "hashing" and not current.get("hashingStartedAt"):
          current["hashingStartedAt"] = current["updatedAt"]

    try:
      result = self._scanner(
        categories,
        category_filter=category_filter,
        progress_callback=report,
        cancel_callback=cancel_event.is_set,
      )
    except Exception as error:
      with self._lock:
        task = self._jobs.get(task_id)
        if task is None:
          return
        task["finishedAt"] = time.time()
        task["updatedAt"] = task["finishedAt"]
        task["currentFile"] = None
        if cancel_event.is_set():
          task["status"] = "cancelled"
          task["phase"] = "cancelled"
          task["error"] = "扫描已取消"
        else:
          task["status"] = "failed"
          task["phase"] = "failed"
          task["error"] = str(error) or error.__class__.__name__
        self._finish_locked(task_id)
      if not cancel_event.is_set():
        print(f"[ComfyUI-Astral-Manage] Duplicate model scan failed: {error}")
      return

    with self._lock:
      task = self._jobs.get(task_id)
      if task is None:
        return
      task["finishedAt"] = time.time()
      task["updatedAt"] = task["finishedAt"]
      task["currentFile"] = None
      if cancel_event.is_set():
        task["status"] = "cancelled"
        task["phase"] = "cancelled"
        task["error"] = "扫描已取消"
      else:
        task["status"] = "succeeded"
        task["phase"] = "completed"
        task["result"] = result
        task["error"] = None
      self._finish_locked(task_id)

  def _finish_locked(self, task_id: str) -> None:
    if self._active_job_id == task_id:
      self._active_job_id = None
    self._trim_history_locked()

  def _get_active_locked(self) -> dict[str, Any] | None:
    if self._active_job_id is None:
      return None
    task = self._jobs.get(self._active_job_id)
    if task is None or task["status"] not in ACTIVE_STATUSES:
      self._active_job_id = None
      return None
    return task

  def _resolve_task_locked(self, task_id: str | None) -> dict[str, Any] | None:
    if task_id:
      return self._jobs.get(str(task_id))
    active = self._get_active_locked()
    if active is not None:
      return active
    for known_id in reversed(self._job_order):
      task = self._jobs.get(known_id)
      if task is not None:
        return task
    return None

  def _trim_history_locked(self) -> None:
    while len(self._job_order) > self._max_history:
      removable = next(
        (
          task_id
          for task_id in self._job_order
          if task_id != self._active_job_id
          and self._jobs.get(task_id, {}).get("status") in TERMINAL_STATUSES
        ),
        None,
      )
      if removable is None:
        break
      self._job_order.remove(removable)
      self._jobs.pop(removable, None)
      self._cancel_events.pop(removable, None)

  def _snapshot_locked(self, task: dict[str, Any]) -> dict[str, Any]:
    snapshot = copy.deepcopy(
      {key: value for key, value in task.items() if not key.startswith("_")}
    )
    now = time.time()
    started_at = task.get("startedAt")
    finished_at = task.get("finishedAt")
    elapsed_end = float(finished_at or now)
    snapshot["elapsedSeconds"] = (
      max(0.0, elapsed_end - float(started_at))
      if started_at is not None
      else 0.0
    )

    total_bytes = max(0, int(task.get("totalBytesToHash") or 0))
    hashed_bytes = max(0, int(task.get("hashedBytes") or 0))
    total_files = max(0, int(task.get("totalFilesToHash") or 0))
    hashed_files = max(0, int(task.get("hashedFiles") or 0))
    if task["status"] == "succeeded":
      progress = 1.0
    elif total_bytes > 0:
      progress = min(1.0, hashed_bytes / total_bytes)
    elif total_files > 0:
      progress = min(1.0, hashed_files / total_files)
    else:
      progress = 0.0
    snapshot["progress"] = progress

    hashing_started_at = task.get("hashingStartedAt")
    hashing_elapsed = (
      max(0.001, elapsed_end - float(hashing_started_at))
      if hashing_started_at is not None
      else 0.0
    )
    bytes_per_second = (
      hashed_bytes / hashing_elapsed
      if hashing_elapsed > 0 and hashed_bytes > 0
      else 0.0
    )
    snapshot["bytesPerSecond"] = bytes_per_second
    snapshot["etaSeconds"] = (
      max(0.0, (total_bytes - hashed_bytes) / bytes_per_second)
      if total_bytes > hashed_bytes and bytes_per_second > 0
      else 0.0
    )
    return snapshot
