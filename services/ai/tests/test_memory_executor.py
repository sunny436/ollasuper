"""Phase 6 — the executor's `search_memory` + `remember` branches.

Real DeltaWriter over RecordingConvex (records the ingress ops, incl. the new
`remember` op); the memory pool is injected via MemoryContext. Proves events,
pairing, that identity is never taken from args, and honest save/reject reporting.
"""

from __future__ import annotations

import json

from langchain_core.messages import ToolMessage

from app.agent.executor import MemoryContext, ToolExecContext, execute_tool_calls
from app.agent.memory import (
    FORGET_TOOL_NAME,
    MEMORY_SEARCH_TOOL_NAME,
    REMEMBER_TOOL_NAME,
)
from app.agent.policy import READ_SCOPE
from app.models.chat import MemoryItem
from app.runtime.writer import DeltaWriter
from tests.conftest import make_settings
from tests.test_writer_events import RecordingConvex


def _m(id, content, kind="preference", source="explicit"):
    return MemoryItem(id=id, kind=kind, content=content, source=source)


def _ctx(memories, *, resp=None):
    s = make_settings("http://x")
    convex = RecordingConvex(resp)
    writer = DeltaWriter(convex, "s1", s)
    ctx = ToolExecContext(
        registry=None,
        adapter=None,
        writer=writer,
        scope=READ_SCOPE,
        name_to_tool_id={},
        result_max_chars=8000,
        default_timeout_s=30.0,
        memory=MemoryContext(memories=memories, settings=s),
    )
    return ctx, convex


def _events(convex, etype):
    out = []
    for c in convex.calls:
        if c.get("op") == "event":
            for e in c["events"]:
                if e["type"] == etype:
                    out.append(json.loads(e["payload"]))
    return out


def _ops(convex, op):
    return [c for c in convex.calls if c.get("op") == op]


def _sc(query, cid="c1", **extra):
    return {
        "name": MEMORY_SEARCH_TOOL_NAME,
        "args": {"query": query, **extra},
        "id": cid,
    }


def _rem(content, kind="fact", cid="c1", **extra):
    return {
        "name": REMEMBER_TOOL_NAME,
        "args": {"content": content, "kind": kind, **extra},
        "id": cid,
    }


# --- search_memory --------------------------------------------------------
async def test_search_emits_events_and_verbatim_block():
    ctx, convex = _ctx([_m("1", "Prefers concise answers")])
    msgs = await execute_tool_calls([_sc("response style preference")], ctx)
    assert len(msgs) == 1 and isinstance(msgs[0], ToolMessage)
    assert msgs[0].status == "success" and msgs[0].tool_call_id == "c1"
    assert msgs[0].content.startswith("<user_memory>")
    assert _events(convex, "TOOL_CALL") and _events(convex, "TOOL_RESULT")
    cites = _events(convex, "CITATION")
    assert len(cites) == 1 and cites[0]["source_id"] == "memory:1"


async def test_search_no_results_success_no_citation():
    ctx, convex = _ctx([])  # empty pool
    msgs = await execute_tool_calls([_sc("anything at all")], ctx)
    assert msgs[0].status == "success"
    assert json.loads(msgs[0].content)["status"] == "no_results"
    assert _events(convex, "CITATION") == []


async def test_search_ignores_malicious_identity_args():
    # search only ranks the ctx pool + the `query`; user_id/workspace in args
    # cannot widen scope (there is no scope arg to widen).
    ctx, convex = _ctx([_m("1", "Uses Python")])
    msgs = await execute_tool_calls(
        [_sc("python", user_id="attacker", workspaceId="other")], ctx
    )
    assert msgs[0].status == "success" and "Uses Python" in msgs[0].content


async def test_search_missing_query_is_error():
    ctx, convex = _ctx([_m("1", "x")])
    msgs = await execute_tool_calls(
        [{"name": MEMORY_SEARCH_TOOL_NAME, "args": {}, "id": "c1"}], ctx
    )
    assert msgs[0].status == "error" and msgs[0].tool_call_id == "c1"


# --- remember (write) -----------------------------------------------------
async def test_remember_saves_and_emits_artifact():
    ctx, convex = _ctx([], resp={"ok": True, "id": "mem1"})
    msgs = await execute_tool_calls([_rem("I use Rust", "fact")], ctx)
    # The write went out as a `remember` ingress op carrying content + kind.
    rem_ops = _ops(convex, "remember")
    assert len(rem_ops) == 1 and rem_ops[0]["content"] == "I use Rust"
    assert rem_ops[0]["kind"] == "fact" and rem_ops[0]["streamId"] == "s1"
    assert _events(convex, "ARTIFACT")  # a "remembered" chip
    assert msgs[0].status == "success"
    assert json.loads(msgs[0].content)["status"] == "saved"


async def test_remember_rejected_is_not_saved():
    ctx, convex = _ctx([], resp={"ok": True, "rejected": "secret"})
    msgs = await execute_tool_calls([_rem("sk-abc123", "fact")], ctx)
    assert msgs[0].status == "error"
    body = json.loads(msgs[0].content)
    assert body["status"] == "not_saved" and body["reason"] == "secret"
    assert _events(convex, "ARTIFACT") == []  # nothing was saved


async def test_remember_terminal_drop_is_not_saved():
    ctx, convex = _ctx([], resp={"ok": True, "dropped": "terminal"})
    msgs = await execute_tool_calls([_rem("late write", "fact")], ctx)
    assert msgs[0].status == "error"
    assert json.loads(msgs[0].content)["reason"] == "stream_closed"


async def test_remember_disabled_is_not_saved():
    ctx, convex = _ctx([], resp={"ok": True, "disabled": True})
    msgs = await execute_tool_calls([_rem("x", "fact")], ctx)
    assert json.loads(msgs[0].content)["reason"] == "disabled"


async def test_remember_missing_content_is_error():
    ctx, convex = _ctx([], resp={"ok": True, "id": "m"})
    msgs = await execute_tool_calls(
        [{"name": REMEMBER_TOOL_NAME, "args": {"kind": "fact"}, "id": "c1"}], ctx
    )
    assert msgs[0].status == "error"
    assert _ops(convex, "remember") == []  # no write attempted


async def test_duplicate_remember_not_re_sent():
    ctx, convex = _ctx([], resp={"ok": True, "id": "m"})
    msgs = await execute_tool_calls(
        [_rem("same fact", "fact", "c1"), _rem("same fact", "fact", "c2")], ctx
    )
    assert len(_ops(convex, "remember")) == 1  # written once
    assert [m.tool_call_id for m in msgs] == ["c1", "c2"]  # both paired


async def test_cancel_skips_but_pairs():
    ctx, convex = _ctx([_m("1", "x")], resp={"ok": True, "id": "m"})
    ctx.writer._cancel_requested = True
    msgs = await execute_tool_calls([_rem("y", "fact")], ctx)
    assert msgs[0].tool_call_id == "c1"
    assert json.loads(msgs[0].content)["status"] == "cancelled"
    assert _ops(convex, "remember") == []  # not written after cancel


# --- forget_memory (Phase 6) ----------------------------------------------
def _forget(query, cid="c1"):
    return {"name": FORGET_TOOL_NAME, "args": {"query": query}, "id": cid}


async def test_forget_disables_matched_and_reports_true_count():
    ctx, convex = _ctx(
        [_m("m1", "my favorite color is teal", kind="preference")],
        resp={"ok": True, "disabled": 1},
    )
    msgs = await execute_tool_calls([_forget("favorite color")], ctx)
    ops = _ops(convex, "forget")
    assert len(ops) == 1
    assert ops[0]["memoryIds"] == ["m1"]  # matched memory's id, from the pool
    body = json.loads(msgs[0].content)
    assert body["status"] == "forgotten" and body["disabled"] == 1
    results = _events(convex, "TOOL_RESULT")
    assert results[-1]["result"] == {"disabled": 1}


async def test_forget_no_keyword_match_disables_nothing():
    # fallback_to_recent is OFF for forget: an unrelated query must NOT disable a
    # recency-picked memory the user never named.
    ctx, convex = _ctx(
        [_m("m1", "my favorite color is teal", kind="preference")],
        resp={"ok": True, "disabled": 1},
    )
    msgs = await execute_tool_calls([_forget("quantum chromodynamics")], ctx)
    assert _ops(convex, "forget") == []  # nothing sent to Convex
    body = json.loads(msgs[0].content)
    assert body["status"] == "no_match"
    assert msgs[0].status == "success"  # honest, not an error


async def test_forget_missing_query_is_error():
    ctx, convex = _ctx([_m("m1", "x")])
    msgs = await execute_tool_calls(
        [{"name": FORGET_TOOL_NAME, "args": {}, "id": "c1"}], ctx
    )
    assert msgs[0].status == "error"
    assert _ops(convex, "forget") == []


async def test_forget_zero_disabled_is_reported_honestly():
    # Convex disabled nothing (e.g. rows already inactive) -> agent must not claim
    # it forgot.
    ctx, convex = _ctx(
        [_m("m1", "my favorite color is teal", kind="preference")],
        resp={"ok": True, "disabled": 0},
    )
    msgs = await execute_tool_calls([_forget("favorite color")], ctx)
    assert msgs[0].status == "error"
    assert json.loads(msgs[0].content)["status"] == "not_forgotten"


async def test_duplicate_forget_not_re_sent():
    ctx, convex = _ctx(
        [_m("m1", "favorite color teal", kind="preference")],
        resp={"ok": True, "disabled": 1},
    )
    await execute_tool_calls(
        [_forget("favorite color", "c1"), _forget("favorite color", "c2")], ctx
    )
    assert len(_ops(convex, "forget")) == 1
