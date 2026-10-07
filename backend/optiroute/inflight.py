"""Track cancellable chat requests within this backend process."""

import asyncio
import time
from typing import Any


_active: dict[tuple[str, str], asyncio.Task] = {}
_progress: dict[tuple[str, str], dict[str, Any]] = {}
_early_cancellations: dict[tuple[str, str], float] = {}
_completed: dict[tuple[str, str], float] = {}
_cancelled: dict[tuple[str, str], float] = {}
_results: dict[tuple[str, str], tuple[float, dict]] = {}


def register(client_id: str, request_id: str, task: asyncio.Task | None = None) -> None:
    key = (client_id, request_id)
    now = time.monotonic()
    for expired_key, expiry in list(_early_cancellations.items()):
        if expiry <= now:
            _early_cancellations.pop(expired_key, None)
    for expired_key, expiry in list(_completed.items()):
        if expiry <= now:
            _completed.pop(expired_key, None)
    for expired_key, expiry in list(_cancelled.items()):
        if expiry <= now:
            _cancelled.pop(expired_key, None)
    for expired_key, (expiry, _) in list(_results.items()):
        if expiry <= now:
            _results.pop(expired_key, None)
    if key in _early_cancellations:
        _early_cancellations.pop(key, None)
        raise asyncio.CancelledError()
    if key in _active:
        raise ValueError("This request ID is already in use.")
    _active[key] = task or asyncio.current_task()
    _progress[key] = {"status": "running", "message": "Preparing your prompt...", "errors": []}


def unregister(client_id: str, request_id: str) -> None:
    key = (client_id, request_id)
    _active.pop(key, None)
    _progress.pop(key, None)
    _completed[key] = time.monotonic() + 90


def finish(client_id: str, request_id: str, result: dict) -> None:
    key = (client_id, request_id)
    if key not in _cancelled:
        _results[key] = (time.monotonic() + 600, {"status": "completed", "result": result})


def fail(client_id: str, request_id: str, error: str) -> None:
    key = (client_id, request_id)
    if key not in _cancelled:
        _results[key] = (time.monotonic() + 600, {"status": "failed", "error": error})


def update(client_id: str, request_id: str | None, message: str) -> None:
    if request_id:
        key = (client_id, request_id)
        if key in _progress:
            _progress[key]["message"] = message


def note_error(client_id: str, request_id: str | None, message: str) -> None:
    """Keep a short, user-readable history of provider failures in this job."""
    if request_id:
        key = (client_id, request_id)
        if key in _progress:
            errors = _progress[key].setdefault("errors", [])
            if not errors or errors[-1] != message:
                errors.append(message)
                del errors[:-6]


def status(client_id: str, request_id: str) -> dict:
    key = (client_id, request_id)
    if key in _cancelled:
        return {"status": "cancelled", "message": ""}
    if key in _progress:
        return _progress[key]
    result = _results.get(key)
    if result and result[0] > time.monotonic():
        return result[1]
    return {"status": "finished", "message": ""}


def is_cancelled(client_id: str, request_id: str | None) -> bool:
    return bool(request_id and (client_id, request_id) in _cancelled)


def cancel(client_id: str, request_id: str) -> str:
    key = (client_id, request_id)
    _cancelled[key] = time.monotonic() + 90
    _results.pop(key, None)
    task = _active.get(key)
    if task and not task.done():
        task.cancel()
        return "running"
    if key in _completed:
        return "completed"
    # The cancel message can arrive before authentication of the chat request.
    _early_cancellations[key] = time.monotonic() + 90
    return "pending"


def active_task(client_id: str, request_id: str) -> asyncio.Task | None:
    return _active.get((client_id, request_id))
