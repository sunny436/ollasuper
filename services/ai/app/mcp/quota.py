"""Hard ceilings on MCP tool calls: per turn, per connection, per tool, per user.

WHY (audit H-09). Before this module a hostile server — or an injected
instruction the model kept obeying — could drive an unbounded number of calls:
nothing counted calls per turn, per connection or per tool; nothing bounded
how many ran at once for one user; and the only per-user rate limits lived in
Convex for CONNECT/AUTH/CAPABILITY operations, never for tool execution. The
loop-detection in `graph.py` did not help either, because a server answering
`is_error` forever looked like progress (fixed in `executor.py` alongside).

WHAT. Two scopes, because they have different lifetimes:

  * `TurnQuota` — one per chat turn, created by `mcp_for_turn`, consulted by
    every `McpToolAdapter.call_tool` on that turn. Counts calls per turn, per
    connection and per tool, refuses a third identical `(tool, args)`, and
    keeps a result-byte budget. Dies with the turn.
  * `UserGate` — one per PROCESS on the session pool, keyed by user: bounds
    calls in flight at once. `--workers 1` makes it authoritative; a restart
    resets it, which is stated rather than hidden.

The DURABLE hourly cap is not here: it lives in Convex (`mcp/limits.ts`, kind
`mcpToolCall`, the same `consumeWindow` primitive that bounds chat), charged
from `McpToolAdapter.call_tool` through the ingress op `mcp-quota-consume`
before the wire is touched, and FAIL CLOSED — a window that cannot be charged
is a call that does not run.

EVERY REFUSAL IS A `ToolError(RATE_LIMITED, retryable=False)`. Not retryable:
the executor's retry loop would otherwise spend its budget on a refusal that
cannot change within the turn, and the model sees the reason in the result.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

import anyio

from app.logging import get_logger
from app.tools.errors import ToolError, ToolErrorKind

log = get_logger(__name__)

__all__ = ["QuotaLimits", "TurnQuota", "UserGate", "refused"]


@dataclass(frozen=True)
class QuotaLimits:
    """Defaults match `Settings`; a test passes small ones."""

    max_calls_per_turn: int = 64
    max_calls_per_connection_turn: int = 24
    max_calls_per_tool_turn: int = 8
    max_identical_calls_turn: int = 2
    max_result_bytes_per_turn: int = 2 * 1024 * 1024
    max_concurrent_calls_per_user: int = 4


def refused(reason: str) -> ToolError:
    return ToolError(ToolErrorKind.RATE_LIMITED, reason, retryable=False)


def _signature(tool_id: str, payload: Any) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(f"{tool_id}\n{canonical}".encode()).hexdigest()


@dataclass
class TurnQuota:
    """Per-turn counters. Plain data; the adapter calls `admit` then `charge`."""

    limits: QuotaLimits = field(default_factory=QuotaLimits)
    calls: int = 0
    per_connection: dict[str, int] = field(default_factory=dict)
    per_tool: dict[str, int] = field(default_factory=dict)
    identical: dict[str, int] = field(default_factory=dict)
    result_bytes: int = 0

    def admit(self, *, connection_id: str, tool_id: str, payload: Any) -> None:
        """Count the call, or refuse it. Counting happens on admission — a
        refused call is not counted, a refused server is not charged."""
        lim = self.limits
        if self.calls >= lim.max_calls_per_turn:
            raise refused(
                f"this turn already made {lim.max_calls_per_turn} connector "
                "calls; answer with what you have"
            )
        if (
            self.per_connection.get(connection_id, 0)
            >= lim.max_calls_per_connection_turn
        ):
            raise refused(
                f"this turn already made {lim.max_calls_per_connection_turn} "
                "calls to this connector; answer with what you have"
            )
        if self.per_tool.get(tool_id, 0) >= lim.max_calls_per_tool_turn:
            raise refused(
                f"this turn already called this tool "
                f"{lim.max_calls_per_tool_turn} times; do not call it again"
            )
        sig = _signature(tool_id, payload)
        if self.identical.get(sig, 0) >= lim.max_identical_calls_turn:
            raise refused(
                "this exact call was already made with these arguments; "
                "the result will not change"
            )
        if self.result_bytes >= lim.max_result_bytes_per_turn:
            raise refused(
                "this turn's connector results already reached the size budget; "
                "answer with what you have"
            )
        self.calls += 1
        self.per_connection[connection_id] = (
            self.per_connection.get(connection_id, 0) + 1
        )
        self.per_tool[tool_id] = self.per_tool.get(tool_id, 0) + 1
        self.identical[sig] = self.identical.get(sig, 0) + 1

    def charge(self, result_bytes: int) -> None:
        self.result_bytes += max(0, int(result_bytes))

    def as_log_fields(self) -> dict[str, Any]:
        return {
            "mcp_calls": self.calls,
            "mcp_result_bytes": self.result_bytes,
            "mcp_connections_called": len(self.per_connection),
        }


class UserGate:
    """Per-user concurrency for MCP calls, process-wide.

    A semaphore per user, created on first use and never removed: the map is
    bounded by the number of distinct users a process serves between restarts,
    each entry a few hundred bytes.
    """

    def __init__(self, max_concurrent: int = 4) -> None:
        self._max = max(1, max_concurrent)
        self._gates: dict[str, anyio.Semaphore] = {}

    def for_user(self, user_id: str) -> anyio.Semaphore:
        gate = self._gates.get(user_id)
        if gate is None:
            gate = anyio.Semaphore(self._max)
            self._gates[user_id] = gate
        return gate
