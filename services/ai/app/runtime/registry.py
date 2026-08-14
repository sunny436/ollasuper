"""In-process registry of running generations.

This is the FAST cancel path (sub-millisecond task.cancel()). It is correct
only with a single worker, which is why the systemd unit pins
`uvicorn --workers 1`. That is not a compromise: this workload is ~100%
IO-bound — waiting on OpenRouter's SSE and on Convex POSTs — so the GIL is not
the constraint, and one uvloop process carries hundreds of concurrent streams.

Correctness never depends on hitting the right worker, because the authoritative
cancel signal is the flag Convex returns on every ingress response (see
DeltaWriter.cancel_requested). If this service is ever scaled out, the fast path
degrades to a <=600ms cancel and nothing breaks.
"""

from __future__ import annotations

import asyncio

from app.logging import get_logger

log = get_logger(__name__)


class Conflict(RuntimeError):
    """This messageId is already generating."""


class TooMany(RuntimeError):
    """Per-user or global concurrency cap reached."""

    def __init__(self, retry_after: int = 5) -> None:
        super().__init__("too many concurrent generations")
        self.retry_after = retry_after


class Registry:
    def __init__(self, max_per_user: int, max_global: int) -> None:
        self._tasks: dict[str, asyncio.Task] = {}
        self._owner: dict[str, str] = {}
        self._per_user: dict[str, int] = {}
        self._max_per_user = max_per_user
        self._max_global = max_global

    def acquire(self, message_id: str, user_id: str) -> None:
        if message_id in self._tasks:
            raise Conflict(message_id)
        if len(self._tasks) >= self._max_global:
            raise TooMany(retry_after=10)
        if self._per_user.get(user_id, 0) >= self._max_per_user:
            raise TooMany(retry_after=5)
        self._owner[message_id] = user_id
        self._per_user[user_id] = self._per_user.get(user_id, 0) + 1

    def attach(self, message_id: str, task: asyncio.Task) -> None:
        self._tasks[message_id] = task

    def cancel(self, message_id: str) -> bool:
        task = self._tasks.get(message_id)
        if task is None or task.done():
            return False
        task.cancel()
        return True

    def release(self, message_id: str) -> None:
        self._tasks.pop(message_id, None)
        user_id = self._owner.pop(message_id, None)
        if user_id is not None:
            left = self._per_user.get(user_id, 1) - 1
            if left <= 0:
                self._per_user.pop(user_id, None)
            else:
                self._per_user[user_id] = left

    def has(self, message_id: str) -> bool:
        return message_id in self._tasks

    @property
    def active(self) -> int:
        return len(self._tasks)

    async def shutdown(self) -> None:
        """Cancel everything on SIGINT so each generation's `finally:` runs and
        finalizes as cancelled, rather than leaving messages spinning until the
        Convex reaper fires."""
        tasks = list(self._tasks.values())
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
