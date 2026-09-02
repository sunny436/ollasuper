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
import contextlib
import json
import random
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field

from app.agent.tool_labels import action_label
from app.clients.convex import ConvexClient, ConvexRejected, ConvexUnavailable
from app.config import Settings
from app.logging import get_logger, redact_obj, redact_text
from app.models.events import EventType, make_event

# A TOOL event means the turn is actively doing tool work — the signal that rolls
# the total-execution deadline forward (see DeltaWriter.on_tool_activity).
_TOOL_EVENT_TYPES = frozenset(
    {EventType.TOOL_CALL, EventType.TOOL_RESULT, EventType.TOOL_PROGRESS}
)

# Convex `appendEvent` hard-caps ONE ingress body at MAX_EVENTS_PER_BATCH and
# SILENTLY `.slice()`s the excess away (chat/ingest.ts). Events are the resume
# checkpoint's fallback authority, so a dropped TOOL_RESULT is not cosmetic —
# chunk client-side at exactly that number and never send more in one body.
_EVENT_BATCH_MAX = 64

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
        # Phase 8: set when a tool parked awaiting approval. The runner sees it
        # after the graph routes to END and SKIPS finalize (the durable park is
        # already recorded; finalizing would drive waiting_approval -> done).
        self.suspended = False
        # Set by the runner to roll the total-execution deadline forward whenever a
        # TOOL event is emitted — so a skill/agent turn that legitimately runs many
        # tools (e.g. a deep SEO audit) is NOT killed by the fixed deadline that
        # bounds a plain no-tool reply. Fires for the parent AND every delegated
        # sub-agent, since they share this one writer. A no-tool turn emits no tool
        # events, so its deadline is untouched.
        self.on_tool_activity: Callable[[], None] | None = None
        # Rolls the total-execution deadline on ANY forward progress, not just tool
        # work. A turn streaming a long final answer emits no tool events, so
        # `on_tool_activity` alone leaves the slowest, most valuable phase of a
        # tool-heavy turn under a FROZEN deadline. Bound to the same callback.
        self.on_progress: Callable[[], None] | None = None
        # Typed events are COALESCED (like deltas) instead of costing one ingress
        # round-trip each: at the measured ~126ms loopback floor, 2 events per tool
        # call is ~252ms of serialized bookkeeping per call, which dominates a wide
        # fan-out. Drained by flush()/heartbeat()/finalize(), on a size or age
        # trigger, and synchronously whenever a caller needs the durable landed bool.
        self._events: list[dict] = []
        # True while a drain is mid-POST. Coalescing NEVER delays an event: the
        # first one goes out immediately, and only what piles up BEHIND an in-flight
        # POST is batched. A low-rate turn stays byte-identical to one-POST-per-event
        # while a wide fan-out collapses hundreds of round-trips into a handful.
        self._event_draining = False
        # Held ONLY to swap the buffer, never across the network round-trip.
        self._event_lock = asyncio.Lock()
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

    def set_event_seq(self, seq: int) -> None:
        """Phase 7 resume: continue the typed-event seq space from the durable
        baseline so a resumed run's new events don't collide with the surviving
        ones on Convex's (messageId, seq) idempotency probe (which would silently
        drop them). Text/delta seq restarts at 0 — the reaper cleared the
        committed text + resident chunks — so only the event seq needs seeding."""
        self._event_seq = max(0, int(seq))

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
        # Piggyback the event drain on the text path so a turn that is streaming
        # keeps its activity timeline live without its own timer.
        await self.flush_events()
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
            # Deltas ARE forward progress. Rolling the deadline here is what keeps a
            # long final answer — which by definition emits no tool events — from
            # being killed mid-generation by a deadline frozen at the last tool call.
            if self.on_progress is not None:
                with contextlib.suppress(Exception):  # never fatal
                    self.on_progress()
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
        # A wide tool fan-out produces events but no text, so this beat is the
        # drain that keeps the activity pill live between model steps.
        await self.flush_events()
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
        # Terminal folds `chatStreamEvents` into the message, so anything still
        # buffered here would be lost from the fold (and from resume's fallback
        # authority). Drain first; a failure is swallowed exactly like a lost delta.
        with contextlib.suppress(Exception):
            await self.flush_events()
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

    async def forget(self, *, memory_ids: list[str]) -> dict:
        """Phase 6: DISABLE (reversible) the user's OWN matching memories through
        Convex (`op:"forget"`). Ownership is derived from the streamId capability
        — Convex only ever disables rows belonging to the stream's user, and it
        disables (not deletes), so the user can restore them in Settings. Returns
        `{disabled: int}` (0 when nothing matched or memory is off) so the agent
        reports the true outcome instead of claiming it forgot."""
        body = {
            "op": "forget",
            "streamId": self._stream_id,
            "memoryIds": memory_ids,
        }
        try:
            resp = await self._convex.ingress(body)
        except ConvexUnavailable:
            return {"disabled": 0, "reason": "unavailable"}
        except ConvexRejected:
            return {"disabled": 0, "reason": "rejected"}
        if resp.get("cancel"):
            self._cancel_requested = True
        if resp.get("unknown") or resp.get("dropped"):
            return {"disabled": 0, "reason": "stream_closed"}
        return {"disabled": int(resp.get("disabled") or 0)}

    async def research_checkpoint(
        self, *, run_id: str, kind: str, payload: dict
    ) -> dict:
        """Deep Research: persist the model's research state through Convex
        (`op:"research-checkpoint"`). Convex derives ownership from the streamId
        capability and UPSERTS the run idempotently by `researchRunId` (in-place on
        resume — never a duplicate row). Returns `{saved}`; a lost/dropped/rejected
        write is reported honestly so the agent never claims it persisted."""
        body = {
            "op": "research-checkpoint",
            "streamId": self._stream_id,
            "researchRunId": run_id,
            "kind": kind,
            "payload": payload,
        }
        try:
            resp = await self._convex.ingress(body)
        except ConvexUnavailable:
            return {"saved": False, "reason": "unavailable"}
        except ConvexRejected:
            log.error(
                "research_checkpoint_rejected", extra={"stream_id": self._stream_id}
            )
            return {"saved": False, "reason": "rejected"}
        if resp.get("cancel"):
            self._cancel_requested = True
        if resp.get("unknown") or resp.get("dropped"):
            return {"saved": False, "reason": "stream_closed"}
        if resp.get("rejected"):
            return {"saved": False, "reason": str(resp.get("rejected"))}
        return {"saved": bool(resp.get("saved"))}

    async def store_artifact(
        self,
        blob: bytes,
        *,
        filename: str,
        fmt: str,
        mime: str,
        sha256: str | None = None,
        artifact_key: str | None = None,
        parent_artifact_id: str | None = None,
        role: str | None = None,
        page: int | None = None,
    ) -> dict:
        """File Generation System: persist a generated file blob through Convex
        (streamId-scoped, owner derived server-side). Returns `{artifactId, size}`
        or raises (the tool then reports the failure honestly).

        Phase 3 (optional, additive): `sha256` declares the content hash — Convex
        recomputes + rejects a mismatch (integrity verification). `artifact_key`
        makes the store IDEMPOTENT: a re-store with the same (stream, key) returns
        the existing artifactId instead of a duplicate blob (safe on crash-resume).
        Filegen passes neither, so its behavior is byte-identical."""
        return await self._convex.store_artifact(
            blob,
            stream_id=self._stream_id,
            filename=filename,
            fmt=fmt,
            mime=mime,
            sha256=sha256,
            artifact_key=artifact_key,
            parent_artifact_id=parent_artifact_id,
            role=role,
            page=page,
        )

    async def record_execution(
        self,
        execution,
        *,
        side_effect: str,
        args: object = None,
        result_content: str | None = None,
        error: dict | None = None,
        approval_ref: str | None = None,
    ) -> bool:
        """Phase 3: durably UPSERT the tool-execution record (`op:"execution"`) — the
        crash-recovery AUTHORITY. Called at RUNNING (write-ahead, before a side
        effect), at the terminal state (with result/error), and at WAITING_APPROVAL
        (with the durable args, so an approved resume executes it directly). Returns
        whether the record durably LANDED (the write-ahead signal). An OLD Convex
        without this op 400s → ConvexRejected → False, and the executor's DUAL gate
        falls back to the TOOL_CALL event's persisted-bool (deploy Python first)."""
        body: dict = {
            "op": "execution",
            "streamId": self._stream_id,
            "executionId": execution.execution_id,
            "stepId": execution.step_id,
            "toolCallId": execution.tool_call_id,
            "toolId": execution.tool_id,
            "attemptId": execution.attempt_id,
            "attempt": execution.attempt,
            "actionType": "tool",
            "sideEffect": side_effect,
            "state": str(execution.state),
            "inputHash": execution.args_hash,
            "createdAt": execution.created_at,
        }
        if args is not None:
            body["args"] = args
        if result_content is not None:
            body["resultContent"] = result_content[:16000]
        if error is not None:
            body["error"] = json.dumps(error, default=str)[:2000]
        if approval_ref is not None:
            body["approvalRef"] = approval_ref
        if execution.started_at is not None:
            body["startedAt"] = execution.started_at
        if execution.ended_at is not None:
            body["endedAt"] = execution.ended_at
        try:
            resp = await self._convex.ingress(body)
        except ConvexUnavailable:
            return False
        except ConvexRejected:
            return False  # old Convex without op:"execution" → dual gate falls back
        if resp.get("cancel"):
            self._cancel_requested = True
        return bool(resp.get("persisted")) and not resp.get("unknown")

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

    async def emit_event(self, type: EventType, **body: object) -> bool:
        """Emit ONE structured typed event. Best-effort like a delta: a lost
        structured event is cosmetic (the terminal FINAL/ERROR is folded
        server-side at finalize). `textOffset` = current text length, so a future
        phase can interleave the event with the text deterministically.

        Phase 2: RETURNS whether the event durably LANDED (persisted and the
        stream is live) — the executor uses this on a side-effecting TOOL_CALL as
        a write-ahead: it only calls the provider if the intent was recorded. The
        ingress client already retries transient failures 4x; `appendEvent`
        reports `persisted` only when it actually inserted (NOT on a terminal /
        waiting_approval / unknown stream). Existing callers ignore the bool.

        Phase 8: redact secret SHAPES from tool arguments/results at the emit edge
        so the durable ledger never persists a leaked token. Shape-based, so real
        args (query/url/id) are inert; the transient toolExecutions record (resume
        authority) is untouched, so replay/recovery stay exact."""
        # A tool event proves the turn is actively doing tool work — roll the
        # total-execution deadline forward so a long, legitimately-tool-heavy turn
        # (a deep audit) is not cut off. Best-effort: a hook error never breaks the
        # turn, and the hook is unset for a plain no-tool reply.
        if type in _TOOL_EVENT_TYPES and self.on_tool_activity is not None:
            with contextlib.suppress(Exception):  # bookkeeping is never fatal
                self.on_tool_activity()
        if "arguments" in body:
            body["arguments"] = redact_obj(body["arguments"])
        if "result" in body:
            body["result"] = redact_obj(body["result"])
        if isinstance(body.get("content"), str):
            body["content"] = redact_text(body["content"])
        # The ONE chokepoint every TOOL_CALL passes through (generic + reserved
        # tools) — stamp a human-readable action label for the execution-status UI
        # so it never renders a raw endpoint name. Guarded: a label never blocks a
        # tool call.
        if type is EventType.TOOL_CALL and "label" not in body:
            body["label"] = action_label(
                str(body.get("tool_name") or ""), body.get("tool_id")
            )
        envelope = make_event(
            type,
            self._event_seq,
            generation_id=self._stream_id,
            text_offset=self._total,
            **body,
        )
        self._event_seq += 1
        wire = envelope.to_wire()
        # A side-effecting TOOL_CALL is the executor's WRITE-AHEAD: it may not touch
        # the provider until the intent is durably recorded, so it needs the REAL
        # landed bool. Drain anything queued first (to keep wire order tidy), then
        # POST this one event alone so the returned bool unambiguously describes IT.
        if (
            type is EventType.TOOL_CALL
            and str(body.get("side_effect") or "read_only") != "read_only"
        ):
            await self.flush_events()
            return await self._post_events([wire])
        async with self._event_lock:
            self._events.append(wire)
            start_drain = not self._event_draining
        # Only the first event of a burst pays a round-trip; the rest ride its wake.
        if start_drain:
            await self.flush_events()
        return True

    async def _post_events(self, batch: list[dict]) -> bool:
        """POST one chunk. Returns whether Convex durably persisted it AND the
        stream is live — the write-ahead signal. Best-effort on transport failure,
        exactly like a delta: `toolExecutions` is the recovery AUTHORITY, and the
        terminal state is folded server-side at finalize."""
        try:
            resp = await self._convex.ingress(
                {"op": "event", "streamId": self._stream_id, "events": batch}
            )
        except ConvexUnavailable:
            return False  # transient; the answer text is unaffected
        except ConvexRejected:
            log.error("event_rejected", extra={"stream_id": self._stream_id})
            return False
        if resp.get("cancel"):
            self._cancel_requested = True
        return bool(resp.get("persisted")) and not resp.get("unknown")

    async def flush_events(self) -> bool:
        """Drain buffered typed events, re-looping so anything that arrives behind
        an in-flight POST rides the next chunk instead of costing its own round-trip.

        Chunks are swapped under a short lock and POSTed OUTSIDE it. Ordering
        correctness does not depend on wire order (Convex keys events by seq, so a
        reordered POST self-heals — see the note on `_lock`); holding a mutex across
        the round-trip only serialized the fan-out, at ~126ms of measured loopback
        latency per event.
        """
        landed = False
        try:
            while True:
                async with self._event_lock:
                    if not self._events:
                        return landed
                    batch = self._events[:_EVENT_BATCH_MAX]
                    del self._events[:_EVENT_BATCH_MAX]
                    self._event_draining = True
                landed = await self._post_events(batch)
        finally:
            # ALWAYS clear the in-flight marker, including on the CancelledError
            # the deadline watchdog raises mid-POST. Leaving it set would make
            # every later emit buffer without ever starting a drain of its own.
            self._event_draining = False

    async def request_approval(
        self,
        *,
        approval_id: str,
        tool_id: str,
        tool_name: str,
        args_key: str,
        reason: str,
        ttl_ms: int,
        preview: dict | None = None,
    ) -> dict:
        """Phase 8: park a tool approval + suspend the stream (`op:"approval"`).

        Embeds the APPROVAL_REQUEST event (so the chip/dialog renders) and parks
        the durable `chatApprovals` row atomically. Returns the ingress response:
        `{decision: "pending"|"approved"|"rejected"|"expired", token?}`. A
        "pending" reply means the turn is now suspended; a resolved reply means a
        prior decision exists and the live run can act on it inline.

        Phase 7: `preview` is the rich SEO ActionPreview, embedded in the event payload
        STRING (no Convex schema change) so the user sees the diff before approving."""
        envelope = make_event(
            EventType.APPROVAL_REQUEST,
            self._event_seq,
            generation_id=self._stream_id,
            text_offset=self._total,
            approval_id=approval_id,
            tool_name=tool_name,
            reason=reason,
            status="pending",
            preview=preview,
        )
        self._event_seq += 1
        body = {
            "op": "approval",
            "streamId": self._stream_id,
            "approvalId": approval_id,
            "toolId": tool_id,
            "toolName": tool_name,
            "argsKey": args_key,
            "reason": reason,
            "ttlMs": ttl_ms,
            "event": envelope.to_wire(),
        }
        async with self._lock:
            try:
                resp = await self._convex.ingress(body)
            except ConvexUnavailable:
                return {"decision": "unavailable"}
            except ConvexRejected:
                log.error("approval_rejected", extra={"stream_id": self._stream_id})
                return {"decision": "unavailable"}
        if resp.get("cancel"):
            self._cancel_requested = True
        return resp

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
