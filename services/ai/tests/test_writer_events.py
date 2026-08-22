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
        return self._resp


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
