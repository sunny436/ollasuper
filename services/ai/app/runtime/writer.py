"""DeltaWriter — batches generated tokens and pushes them into Convex.

This is the crux of the streaming design, and the flush policy is the whole
game. Convex re-sends the *entire* result of a subscribed query on every
change, with no document-level diffing, so a reply of L characters flushed in
n batches costs roughly n x L/2 bytes downstream per viewer. Batching is
therefore quadratically cheaper, and the floor on batch size matters far more
than the interval.

An 8,000-character reply:

    40-char batches  -> n=200 -> ~800 KB downstream
    96-char batches  -> n=84  -> ~336 KB
    512-char batches -> n=16  -> ~64 KB

96 is the knee: every extra 56 characters is ~0.3s of reading at LLM output
speed, i.e. invisible, while the bandwidth saving is large. The growth term
(total // 25) stops a 40,000-character answer degenerating into ~8 MB.

The interval is a LATENCY CEILING, not the primary trigger — this was measured,
not assumed. A real model streams ~70 tok/s (~280 chars/s); with the 100ms
floor originally chosen, the timer always beat the size target and produced
~32-char batches: 236 flushes on an 8k answer, ~944KB downstream per viewer,
i.e. the batching did nothing. The floor is 300ms so the size branch wins in
the common case, while a trickling response still repaints ~3x/sec.

The adaptive term (1.5 x EWMA round-trip, capped at 700ms) is the backpressure
mechanism: if Convex slows down the writer batches harder on its own, with no
coordination and no queue depth to tune.
"""

from __future__ import annotations

import asyncio
import random
import time
from collections import deque
from dataclasses import dataclass, field

from app.clients.convex import ConvexClient, ConvexRejected, ConvexUnavailable
from app.config import Settings
from app.logging import get_logger
from app.models.events import EventType, make_event

log = get_logger(__name__)


def _clamp(lo: float, x: float, hi: float) -> float:
    return max(lo, min(x, hi))


@dataclass
class _Pending:
    seq: int
    text: str


@dataclass
class WriterStats:
    flushes: int = 0
    chars: int = 0
    dropped: int = 0
    first_flush_ms: float | None = None
    ewma_rtt: float = 0.05
    started_at: float = field(default_factory=time.monotonic)


class DeltaWriter:
    """Buffers tokens and flushes batches to Convex's /ai/ingress."""

    def __init__(
        self,
        convex: ConvexClient,
        stream_id: str,
        settings: Settings,
    ) -> None:
        self._convex = convex
        self._stream_id = stream_id
        self._s = settings
        self._buf: list[str] = []
        self._buf_len = 0
        self._seq = 0
        # Typed-event ordering key (Phase 3), independent of the text `_seq`.
        self._event_seq = 0
        self._total = 0
        self._full: list[str] = []
        # Batches that failed to land ride along with the next flush; the
        # ingress body is a list precisely so a catch-up is a single request.
        self._pending: deque[_Pending] = deque()
        self._pending_bytes = 0
        self._last_flush = time.monotonic()
        # Flushes are strictly serialized so wire order matches seq order.
        # Ordering correctness does not *depend* on this — Convex reads by seq,
        # so a reordered POST self-heals — but it keeps the common case simple.
        self._lock = asyncio.Lock()
        self._cancel_requested = False
        self._first_failure_at: float | None = None
        self.stats = WriterStats()

    # -- properties ---------------------------------------------------------

    @property
    def cancel_requested(self) -> bool:
        """Set from the ingress response. Worker-agnostic: the authority is a
        Convex field, not this process's memory, so it works even if the
        service is ever scaled past one worker."""
        return self._cancel_requested

    @property
    def text(self) -> str:
        return "".join(self._full)

    # -- policy -------------------------------------------------------------

    def _chunk_target(self) -> int:
        return int(
            _clamp(
                self._s.ai_flush_min_chars,
                self._total // 25,
                self._s.ai_flush_max_chars,
            )
        )

    def _interval(self) -> float:
        """Latency CEILING, not the primary trigger.

        Measured: a real model streams ~70 tok/s, about 280 chars/s. With a
        100ms floor the timer always fired first and produced ~32-char batches
        — 236 flushes on an 8k answer, which is ~944KB downstream per viewer
        and defeats the whole point of batching. The char target has to be what
        normally fires; the timer exists only so a *slow* stream still updates.

        At 280 chars/s the 96-char target is reached in ~340ms, so a 300ms
        floor lets the size branch win in the common case while a trickling
        response still repaints ~3x/sec.
        """
        lo = self._s.ai_flush_min_interval_ms / 1000
        hi = self._s.ai_flush_max_interval_ms / 1000
        return _clamp(lo, max(lo, 1.5 * self.stats.ewma_rtt), hi)

    def _should_flush(self) -> bool:
        if not self._buf:
            return False
        # Time-to-first-token is the single most-noticed latency in a chat UI,
        # and it costs exactly one extra write per message.
        if self.stats.flushes == 0:
            return True
        if self._buf_len >= self._chunk_target():
            return True
        return (time.monotonic() - self._last_flush) >= self._interval()

    # -- api ----------------------------------------------------------------

    async def push(self, text: str) -> None:
        if not text:
            return
        self._buf.append(text)
        self._buf_len += len(text)
        self._full.append(text)
        self._total += len(text)
        if self._should_flush():
            await self.flush()

    async def flush(self, force: bool = False) -> None:
        async with self._lock:
            if not self._buf and not self._pending:
                return
            if self._buf:
                batch = _Pending(seq=self._seq, text="".join(self._buf))
                self._seq += 1
                self._buf.clear()
                self._buf_len = 0
                self._pending.append(batch)
                self._pending_bytes += len(batch.text)
                self._evict_if_needed()
            if not self._pending:
                return

            deltas = [{"seq": p.seq, "text": p.text} for p in self._pending]
            t0 = time.monotonic()
            try:
                resp = await self._convex.ingress(
                    {"op": "delta", "streamId": self._stream_id, "deltas": deltas}
                )
            except ConvexUnavailable:
                # Keep the batches; the next flush carries the backlog.
                if self._first_failure_at is None:
                    self._first_failure_at = time.monotonic()
                elif (
                    time.monotonic() - self._first_failure_at
                    > self._s.ai_ingress_fail_deadline_s
                ):
                    raise
                return

            rtt = time.monotonic() - t0
            self.stats.ewma_rtt = 0.7 * self.stats.ewma_rtt + 0.3 * rtt
            self._first_failure_at = None
            self._pending.clear()
            self._pending_bytes = 0
            self._last_flush = time.monotonic()
            self.stats.flushes += 1
            self.stats.chars = self._total
            if self.stats.first_flush_ms is None:
                self.stats.first_flush_ms = (
                    self._last_flush - self.stats.started_at
                ) * 1000
            if resp.get("cancel"):
                self._cancel_requested = True
        _ = force

    def _evict_if_needed(self) -> None:
        """Bound the backlog. Dropping a delta only leaves a visual gap that
        the authoritative finalize text repairs — losing the whole generation
        to unbounded memory growth would be worse."""
        while self._pending_bytes > self._s.ai_pending_cap_bytes and self._pending:
            gone = self._pending.popleft()
            self._pending_bytes -= len(gone.text)
            self.stats.dropped += 1
            # seq keeps advancing, so Convex still orders what does arrive.

    async def heartbeat(self) -> None:
        """Keep the stall reaper at bay while the model thinks or a tool runs,
        and pick up a cancellation during a no-token gap."""
        try:
            resp = await self._convex.ingress(
                {"op": "heartbeat", "streamId": self._stream_id}
            )
        except ConvexUnavailable:
            return
        if resp.get("cancel"):
            self._cancel_requested = True

    async def finalize(
        self,
        status: str,
        *,
        text: str | None = None,
        usage: dict | None = None,
        finish_reason: str | None = None,
        error: dict | None = None,
    ) -> None:
        """Terminal write.

        Gets a much longer retry budget than a delta: a lost delta is cosmetic,
        but a lost finalize leaves the message spinning in the UI until the
        Convex reaper fires 90s later.
        """
        body: dict = {
            "op": "finalize",
            "streamId": self._stream_id,
            "status": status,
            "text": text if text is not None else self.text,
        }
        if usage:
            body["usage"] = usage
        if finish_reason:
            body["finishReason"] = finish_reason
        if error:
            body["error"] = error
        if self.stats.first_flush_ms is not None:
            body["firstTokenMs"] = round(self.stats.first_flush_ms)
        body["latencyMs"] = round((time.monotonic() - self.stats.started_at) * 1000)

        for attempt in range(8):
            try:
                await self._convex.ingress(body)
                return
            except ConvexRejected:
                log.error(
                    "finalize_rejected",
                    extra={"stream_id": self._stream_id, "status": status},
                )
                return
            except ConvexUnavailable:
                if attempt == 7:
                    log.error(
                        "finalize_lost",
                        extra={"stream_id": self._stream_id, "status": status},
                    )
                    return
                delay = min(8.0, 0.2 * (2**attempt))
                await asyncio.sleep(delay * (0.75 + random.random() * 0.5))  # noqa: S311

    async def set_title(self, title: str) -> None:
        try:
            await self._convex.ingress(
                {"op": "title", "streamId": self._stream_id, "title": title}
            )
        except (ConvexUnavailable, ConvexRejected):
            pass  # A missing auto-title is cosmetic; never fail a turn for it.

    async def remember(self, *, content: str, kind: str) -> dict:
        """Phase 6: persist a memory CANDIDATE through Convex (`op:"remember"`).

        Convex derives ownership from the `streamId` capability and VALIDATES
        (secret-scan / scope / dedup / terminal guard) before storing — this
        never writes a record directly. Returns `{saved, id?, reason?}`; a lost,
        dropped, or rejected write is reported honestly so the agent does not
        claim it saved."""
        body = {
            "op": "remember",
            "streamId": self._stream_id,
            "content": content,
            "kind": kind,
        }
        try:
            resp = await self._convex.ingress(body)
        except ConvexUnavailable:
            return {"saved": False, "reason": "unavailable"}
        except ConvexRejected:
            log.error("remember_rejected", extra={"stream_id": self._stream_id})
            return {"saved": False, "reason": "rejected"}
        if resp.get("cancel"):
            self._cancel_requested = True
        if resp.get("unknown") or resp.get("dropped"):
            return {"saved": False, "reason": "stream_closed"}
        if resp.get("disabled"):
            return {"saved": False, "reason": "disabled"}
        if resp.get("rejected"):
            return {"saved": False, "reason": str(resp.get("rejected"))}
        if resp.get("id"):
            return {"saved": True, "id": resp.get("id")}
        return {"saved": False, "reason": "not_saved"}

    # -- typed event protocol (Phase 3) -------------------------------------
    #
    # These make the writer CAPABLE of emitting typed events. Nothing in the
    # production generation path calls emit_event yet (runner.py still emits
    # text + finalize only); the future Agent Core (Phase 4) will call it at the
    # tool seam. They reuse the same ingress client + cancel propagation as
    # deltas and never touch the text buffer, so the high-volume path is intact.

    async def emit_text_delta(self, text: str) -> None:
        """Protocol alias — text rides the existing high-volume delta channel."""
        await self.push(text)

    async def emit_event(self, type: EventType, **body: object) -> None:
        """Emit ONE structured typed event. Best-effort like a delta: a lost
        structured event is cosmetic (the terminal FINAL/ERROR is folded
        server-side at finalize). `textOffset` = current text length, so a future
        phase can interleave the event with the text deterministically."""
        envelope = make_event(
            type,
            self._event_seq,
            generation_id=self._stream_id,
            text_offset=self._total,
            **body,
        )
        self._event_seq += 1
        async with self._lock:
            try:
                resp = await self._convex.ingress(
                    {
                        "op": "event",
                        "streamId": self._stream_id,
                        "events": [envelope.to_wire()],
                    }
                )
            except ConvexUnavailable:
                return  # transient; the answer text is unaffected
            except ConvexRejected:
                log.error("event_rejected", extra={"stream_id": self._stream_id})
                return
            if resp.get("cancel"):
                self._cancel_requested = True

    async def emit_final(
        self,
        *,
        text: str | None = None,
        usage: dict | None = None,
        finish_reason: str | None = None,
    ) -> None:
        """Protocol alias for a successful terminal write (single shielded POST)."""
        await self.finalize(
            "done", text=text, usage=usage, finish_reason=finish_reason
        )

    async def emit_error(self, error: dict, *, text: str | None = None) -> None:
        """Protocol alias for a terminal error write."""
        await self.finalize("error", text=text, error=error)
