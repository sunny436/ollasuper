from __future__ import annotations

import json

from app.models.events import EventType
from app.runtime.writer import DeltaWriter
from tests.conftest import make_settings


class RecordingConvex:
    """Records every ingress() body so we can assert the wire shape without a
    server. Duck-typed in place of ConvexClient (Python)."""

    def __init__(self, resp: dict | None = None) -> None:
        self.calls: list[dict] = []
        self._resp = resp or {"ok": True}

    async def ingress(self, body: dict) -> dict:
        self.calls.append(body)
        resp = dict(self._resp)
        # Phase 2/3: a live event / execution write is durable — report `persisted`
        # so the executor's write-ahead lands (a test can override via `_resp`).
        if body.get("op") in ("event", "execution") and "persisted" not in resp:
            resp["persisted"] = True
        return resp


def _writer(resp: dict | None = None) -> tuple[DeltaWriter, RecordingConvex]:
    convex = RecordingConvex(resp)
    return DeltaWriter(convex, "s1", make_settings("http://x")), convex  # type: ignore[arg-type]


def _ops(convex: RecordingConvex, op: str) -> list[dict]:
    return [c for c in convex.calls if c.get("op") == op]


async def test_emit_event_posts_event_op_with_wire_shape():
    w, convex = _writer()
    await w.emit_event(
        EventType.TOOL_CALL, tool_name="web_search", call_id="c1", arguments={"q": "x"}
    )
    events = _ops(convex, "event")
    assert len(events) == 1
    body = events[0]
    assert body["streamId"] == "s1"
    ev = body["events"][0]
    assert ev["type"] == "TOOL_CALL"
    assert ev["seq"] == 0
    assert json.loads(ev["payload"])["tool_name"] == "web_search"


async def test_event_seq_increments_independently_of_text():
    w, convex = _writer()
    await w.push("hello world")  # text path (TTFT forces a delta flush)
    await w.emit_event(EventType.CITATION, source_id="s1")
    await w.emit_event(EventType.CITATION, source_id="s2")
    seqs = [e["events"][0]["seq"] for e in _ops(convex, "event")]
    assert seqs == [0, 1]  # unaffected by the interleaved text delta


async def test_text_path_still_works_after_emit_event():
    w, convex = _writer()
    await w.emit_event(EventType.TOOL_PROGRESS, call_id="c1", progress=0.5)
    await w.emit_text_delta("hi there")
    deltas = _ops(convex, "delta")
    assert deltas and deltas[0]["deltas"][0]["text"] == "hi there"


async def test_emit_event_propagates_cancel():
    w, _ = _writer(resp={"ok": True, "cancel": True})
    await w.emit_event(EventType.TOOL_PROGRESS, call_id="c1", progress=0.5)
    assert w.cancel_requested is True


async def test_emit_final_and_error_use_the_finalize_op():
    w, convex = _writer()
    await w.emit_final(text="done", finish_reason="stop")
    await w.emit_error({"code": "x", "message": "y"}, text="partial")
    finals = _ops(convex, "finalize")
    assert [f["status"] for f in finals] == ["done", "error"]


# ---- event coalescing --------------------------------------------------------
#
# One ingress round-trip per event cost ~126ms of MEASURED loopback latency, and
# the executor emits two per tool call — ~252ms of serialization per call, which
# dominated any wide fan-out. Events are coalesced now, but coalescing must never
# ADD latency: the first event of a burst still goes out immediately.


class SlowConvex(RecordingConvex):
    """Lets a burst pile up behind an in-flight POST, like the real ingress."""

    def __init__(self, delay: float = 0.02) -> None:
        super().__init__()
        self._delay = delay

    async def ingress(self, body: dict) -> dict:
        import asyncio

        await asyncio.sleep(self._delay)
        return await super().ingress(body)


async def test_a_lone_event_is_not_delayed_by_coalescing():
    w, convex = _writer()
    await w.emit_event(EventType.TOOL_CALL, tool_name="t", call_id="c1", arguments={})
    # Posted during the await, with no drain/flush needed.
    assert len(_ops(convex, "event")) == 1


async def test_a_burst_coalesces_into_far_fewer_round_trips():
    import asyncio

    convex = SlowConvex()
    w = DeltaWriter(convex, "s1", make_settings("http://x"))  # type: ignore[arg-type]
    await asyncio.gather(
        *(
            w.emit_event(
                EventType.TOOL_RESULT, call_id=f"c{i}", status="success", result={}
            )
            for i in range(200)
        )
    )
    await w.flush_events()
    posts = _ops(convex, "event")
    sent = sum(len(p["events"]) for p in posts)
    assert sent == 200, "every event must still reach Convex"
    # 200 events used to cost 200 round-trips; now it is a small handful.
    assert len(posts) < 20, f"expected coalescing, got {len(posts)} round-trips"


async def test_no_batch_exceeds_the_convex_slice_cap():
    """chat/ingest.ts does `events.slice(0, MAX_EVENTS_PER_BATCH)` and SILENTLY
    drops the excess. Events are the resume checkpoint's fallback authority, so an
    oversized body would lose TOOL_RESULTs and cause duplicate execution."""
    import asyncio

    from app.runtime.writer import _EVENT_BATCH_MAX

    convex = SlowConvex()
    w = DeltaWriter(convex, "s1", make_settings("http://x"))  # type: ignore[arg-type]
    await asyncio.gather(
        *(
            w.emit_event(EventType.TOOL_RESULT, call_id=f"c{i}", status="success")
            for i in range(300)
        )
    )
    await w.flush_events()
    posts = _ops(convex, "event")
    assert posts and all(len(p["events"]) <= _EVENT_BATCH_MAX for p in posts)
    assert sum(len(p["events"]) for p in posts) == 300


async def test_side_effecting_tool_call_still_posts_synchronously():
    """The executor's WRITE-AHEAD: a side-effecting call may not touch the provider
    until its intent is durably recorded, so this one event cannot be buffered and
    its returned bool must describe ITSELF."""
    w, convex = _writer()
    landed = await w.emit_event(
        EventType.TOOL_CALL,
        tool_name="t",
        call_id="c1",
        arguments={},
        side_effect="external_side_effect",
    )
    assert landed is True
    posts = _ops(convex, "event")
    assert len(posts) == 1 and len(posts[0]["events"]) == 1


async def test_buffered_events_are_drained_before_finalize():
    """finalize folds chatStreamEvents into the message server-side, so anything
    still buffered would vanish from the fold and from resume's fallback."""
    convex = SlowConvex()
    w = DeltaWriter(convex, "s1", make_settings("http://x"))  # type: ignore[arg-type]
    await w.emit_event(EventType.TOOL_RESULT, call_id="c1", status="success")
    await w.emit_event(EventType.TOOL_RESULT, call_id="c2", status="success")
    await w.finalize("done")
    sent = sum(len(p["events"]) for p in _ops(convex, "event"))
    assert sent == 2
    assert _ops(convex, "finalize")
