"""Pending authorizations, routed by `state`.

THE PROBLEM THIS SOLVES. The SDK's authorization flow is CLI-shaped: it
generates `state` and PKCE into a coroutine's stack frame, calls
`redirect_handler(url)`, and then AWAITS `callback_handler()` in that same
coroutine. A browser callback arrives in a different HTTP request entirely.

So the flow coroutine stays alive, parked on an event, and this registry is how
the callback request finds it. The `state` is parsed out of the authorization URL
the SDK hands `redirect_handler` — we never generate it, and we never validate it
as a security control. The SDK re-validates it with `secrets.compare_digest`
immediately after `callback_handler` returns, and also checks the RFC 9207
issuer. This registry is ROUTING; that is the GATE. Two independent mechanisms,
deliberately.

WHY IN-PROCESS IS DEFENSIBLE HERE. `services/ai/systemd/myos-ai.service`
documents `--workers 1` as REQUIRED — the existing fast-cancel path is already an
in-process task registry — and Phase 3's session pool is already in-process
memory. A pending authorization is shorter-lived than either.

THE LIMIT, STATED: a service restart mid-authorization loses pending attempts.
Nothing is left inconsistent, because no credential has been written yet; the
user authorizes again. That is a real cost, not an argued-away one.

WHAT IS NEVER STORED HERE: the authorization code, the PKCE verifier, or a
token. The verifier never leaves the SDK's stack frame, which is the strongest
possible statement about where it lives.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs, urlparse

import anyio

from app.logging import get_logger

log = get_logger(__name__)

__all__ = ["AuthorizationAttempt", "AttemptRegistry", "state_from_url"]

#: An authorization is a human clicking through a consent screen — with a
#: password, a second factor on a phone, Google's "unverified app" interstitial
#: and a scope checklist in the way. Two minutes was not enough for that on
#: production (the callback arrived to "no pending authorization"). Ten minutes
#: matches how long the providers' own authorization codes stay valid, and a
#: leaked `state` is still worth nothing without the PKCE verifier held here.
DEFAULT_TTL_S = 600.0

#: A hard ceiling on concurrent pending authorizations, so a caller that starts
#: flows in a loop cannot grow this map without bound.
MAX_PENDING = 256


@dataclass
class AuthorizationAttempt:
    """One in-flight authorization. Holds identity and plumbing — no secrets."""

    attempt_id: str
    user_id: str
    workspace_id: str
    connection_id: str
    server_name: str
    #: Parsed out of the SDK's authorization URL. Used ONLY to route the
    #: callback back to this attempt; the SDK re-validates it.
    state: str = ""
    authorization_url: str = ""
    requested_scope: str | None = None
    created_at: float = 0.0
    expires_at: float = 0.0
    #: Set once the URL is known, so `start` can return without polling.
    url_ready: anyio.Event = field(default_factory=anyio.Event)
    #: Set by the callback, so the parked SDK coroutine can proceed.
    callback_ready: anyio.Event = field(default_factory=anyio.Event)
    #: Set when the background flow has finished, successfully or not, so a
    #: waiter does not have to poll. A busy-wait here would burn the event loop
    #: for the length of a human consent screen.
    finished: anyio.Event = field(default_factory=anyio.Event)
    #: The `AuthorizationCodeResult` the SDK's callback_handler returns.
    result: Any = None
    error: str | None = None
    completed: bool = False

    @property
    def pool_key(self) -> tuple[str, str, str]:
        return (self.user_id, self.workspace_id, self.connection_id)

    def __repr__(self) -> str:  # pragma: no cover - trivial
        # The state is a routing token, not a secret — but it is also not
        # something a log line needs, and an attempt appearing in a traceback
        # should not hand it over.
        return (
            f"AuthorizationAttempt(id={self.attempt_id!r}, "
            f"user={self.user_id!r}, server={self.server_name!r}, "
            f"completed={self.completed})"
        )


def state_from_url(authorization_url: str) -> str:
    """Read `state` out of the authorization URL the SDK built.

    Parsing rather than generating is what lets us reuse the SDK's own `state`
    (and its `compare_digest` validation) instead of inventing a parallel one
    that would then have to be kept consistent with it.
    """
    try:
        values = parse_qs(urlparse(authorization_url).query).get("state") or []
    except ValueError:
        return ""
    return values[0] if values else ""


class AttemptRegistry:
    """In-process pending authorizations, keyed by `state`.

    Single-use and TTL-bounded: an entry is POPPED before it is completed, so a
    replayed callback finds nothing.
    """

    def __init__(
        self, *, ttl_s: float = DEFAULT_TTL_S, max_pending: int = MAX_PENDING
    ) -> None:
        self._ttl = ttl_s
        self._max = max_pending
        self._by_state: dict[str, AuthorizationAttempt] = {}
        self._by_id: dict[str, AuthorizationAttempt] = {}
        self._lock = anyio.Lock()

    async def create(
        self,
        *,
        attempt_id: str,
        user_id: str,
        workspace_id: str,
        connection_id: str,
        server_name: str,
    ) -> AuthorizationAttempt:
        now = anyio.current_time()
        attempt = AuthorizationAttempt(
            attempt_id=attempt_id,
            user_id=user_id,
            workspace_id=workspace_id,
            connection_id=connection_id,
            server_name=server_name,
            created_at=now,
            expires_at=now + self._ttl,
        )
        async with self._lock:
            self._sweep_locked(now)
            if len(self._by_id) >= self._max:
                raise RuntimeError(
                    "too many pending MCP authorizations; try again shortly"
                )
            self._by_id[attempt_id] = attempt
        return attempt

    async def bind_state(self, attempt: AuthorizationAttempt, state: str) -> None:
        """Register the routing key once the SDK has produced the URL."""
        if not state:
            # Without a state we cannot route the callback. Fail the attempt
            # rather than registering something unreachable.
            attempt.error = "the authorization URL carried no state parameter"
            attempt.url_ready.set()
            return
        async with self._lock:
            attempt.state = state
            self._by_state[state] = attempt

    async def claim(self, state: str) -> AuthorizationAttempt | None:
        """Take the attempt for `state`, removing it. SINGLE USE.

        Popping before completion is what makes a replayed callback a no-op: the
        second delivery of the same code finds nothing to complete.
        """
        async with self._lock:
            now = anyio.current_time()
            self._sweep_locked(now)
            attempt = self._by_state.pop(state, None)
            if attempt is None:
                return None
            self._by_id.pop(attempt.attempt_id, None)
            if now > attempt.expires_at:
                log.info(
                    "mcp.oauth_attempt_expired",
                    extra={"attempt_id": attempt.attempt_id},
                )
                return None
            return attempt

    async def get(self, attempt_id: str) -> AuthorizationAttempt | None:
        async with self._lock:
            return self._by_id.get(attempt_id)

    async def discard(self, attempt: AuthorizationAttempt) -> None:
        async with self._lock:
            self._by_state.pop(attempt.state, None)
            self._by_id.pop(attempt.attempt_id, None)

    @property
    def pending(self) -> int:
        return len(self._by_id)

    def _sweep_locked(self, now: float) -> None:
        expired = [
            state
            for state, attempt in self._by_state.items()
            if now > attempt.expires_at
        ]
        for state in expired:
            attempt = self._by_state.pop(state, None)
            if attempt is not None:
                self._by_id.pop(attempt.attempt_id, None)
                # Wake anything parked on it so a coroutine cannot leak.
                attempt.error = "authorization timed out"
                attempt.callback_ready.set()
                attempt.url_ready.set()
                attempt.finished.set()
        # An attempt that never reached `bind_state` has no routing key, so the
        # sweep above cannot see it. Catch those too.
        stale = [
            attempt_id
            for attempt_id, attempt in self._by_id.items()
            if now > attempt.expires_at
        ]
        for attempt_id in stale:
            attempt = self._by_id.pop(attempt_id, None)
            if attempt is not None:
                attempt.error = "authorization timed out"
                attempt.callback_ready.set()
                attempt.url_ready.set()
