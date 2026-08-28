"""Deep Research — the executor's `record_research` checkpoint branch + resume
seeding. Real DeltaWriter over RecordingConvex (records the `research-checkpoint`
op); ResearchContext supplies the run id + the H4 ceilings. Proves durable capture
of the plan/finding provenance, the code-enforced source budget (graceful stop),
honest reporting, dedup, and that resume does not re-research completed work."""

from __future__ import annotations

import json

from app.agent.executor import ToolExecContext, execute_tool_calls
from app.agent.policy import READ_SCOPE
from app.models.chat import ActiveResearchRun, ResearchFindingSeed
from app.research.run_state import build_research_context, render_research_seed
from app.research.tool import RECORD_RESEARCH_TOOL_NAME, ResearchContext
from app.runtime.writer import DeltaWriter
from tests.conftest import make_settings
from tests.test_writer_events import RecordingConvex

_OK = {"ok": True, "saved": True}


def _ctx(*, resp=_OK, run_id="r1", settings=None, seen=None):
    s = settings or make_settings("http://x")
    convex = RecordingConvex(resp)
    writer = DeltaWriter(convex, "s1", s)
    rc = ResearchContext(settings=s, run_id=run_id, seen_sources=set(seen or ()))
    ctx = ToolExecContext(
        registry=None,
        adapter=None,
        writer=writer,
        scope=READ_SCOPE,
        name_to_tool_id={},
        result_max_chars=8000,
        default_timeout_s=30.0,
        research=rc,
    )
    return ctx, convex, rc


def _ops(convex, op):
    return [c for c in convex.calls if c.get("op") == op]


def _call(cid="c1", **args):
    return {"name": RECORD_RESEARCH_TOOL_NAME, "args": args, "id": cid}


# --- plan: durable capture of objective + safe reason ----------------------
async def test_plan_records_objective_reason_and_subquestions():
    ctx, convex, rc = _ctx()
    msgs = await execute_tool_calls(
        [
            _call(
                kind="plan",
                objective="compare CRMs for a 20-person startup",
                research_reason="multi-source comparison needing current pricing",
                subquestions=["pricing", "reviews", "integrations"],
                time_sensitive=True,
            )
        ],
        ctx,
    )
    ops = _ops(convex, "research-checkpoint")
    assert len(ops) == 1 and ops[0]["kind"] == "plan"
    assert ops[0]["researchRunId"] == "r1" and ops[0]["streamId"] == "s1"
    p = ops[0]["payload"]
    assert p["reason"] == "multi-source comparison needing current pricing"
    assert p["objective"].startswith("compare CRMs") and p["timeSensitive"] is True
    assert p["subquestions"] == ["pricing", "reviews", "integrations"]
    assert rc.plan_recorded and rc.objective.startswith("compare CRMs")
    assert msgs[0].status == "success"


async def test_plan_without_objective_is_error_and_not_written():
    ctx, convex, _ = _ctx()
    msgs = await execute_tool_calls([_call(kind="plan", research_reason="x")], ctx)
    assert msgs[0].status == "error"
    assert _ops(convex, "research-checkpoint") == []


async def test_plan_branch_fanout_is_capped():
    s = make_settings("http://x", ai_research_max_branches=2)
    ctx, convex, rc = _ctx(settings=s)
    await execute_tool_calls(
        [_call(kind="plan", objective="o", subquestions=["a", "b", "c", "d"])],
        ctx,
    )
    p = _ops(convex, "research-checkpoint")[0]["payload"]
    assert p["subquestions"] == ["a", "b"]  # trimmed to the ceiling
    assert rc.branch_count == 2


# --- finding: provenance + CITATION ----------------------------------------
async def test_finding_records_full_provenance_and_citation():
    ctx, convex, rc = _ctx()
    msgs = await execute_tool_calls(
        [
            _call(
                kind="finding",
                subquestion="pricing",
                claim="Vendor X starts at $25/user/mo",
                source_url="https://vendorx.com/pricing",
                source_title="Vendor X Pricing",
                source_type="official",
                source_date="2026-08",
                confidence="high",
                supports=True,
            )
        ],
        ctx,
    )
    op = _ops(convex, "research-checkpoint")[0]
    assert op["kind"] == "finding"
    f = op["payload"]
    assert f["claim"].startswith("Vendor X") and f["sourceUrl"].endswith("/pricing")
    assert f["sourceType"] == "official" and f["confidence"] == "high"
    # a CITATION event was emitted for the source
    cites = [
        json.loads(e["payload"])
        for c in convex.calls
        if c.get("op") == "event"
        for e in c["events"]
        if e["type"] == "CITATION"
    ]
    assert cites and cites[0]["source_id"] == "https://vendorx.com/pricing"
    assert "https://vendorx.com/pricing" in rc.seen_sources
    assert msgs[0].status == "success"


async def test_finding_without_source_is_error():
    ctx, convex, _ = _ctx()
    msgs = await execute_tool_calls(
        [_call(kind="finding", claim="a claim with no source")], ctx
    )
    assert msgs[0].status == "error"
    assert _ops(convex, "research-checkpoint") == []


# --- H4: source ceiling enforced in code (graceful stop) -------------------
async def test_source_budget_ceiling_refuses_and_instructs_stop():
    s = make_settings("http://x", ai_research_max_sources=2)
    ctx, convex, rc = _ctx(settings=s)
    for i, url in enumerate(("https://a.com", "https://b.com")):
        m = await execute_tool_calls(
            [_call(kind="finding", cid=f"c{i}", claim=f"claim {i}", source_url=url)],
            ctx,
        )
        assert m[0].status == "success"
    # third DISTINCT source exceeds the ceiling → refused with a stop instruction
    msgs = await execute_tool_calls(
        [_call(kind="finding", cid="c3", claim="c3", source_url="https://c.com")],
        ctx,
    )
    body = json.loads(msgs[0].content)
    assert msgs[0].status == "error" and body["status"] == "budget_reached"
    assert "stop" in body["instruction"].lower()
    assert len(_ops(convex, "research-checkpoint")) == 2  # the 3rd was NOT written
    # re-recording an ALREADY-seen source is still allowed (not a new source)
    ok = await execute_tool_calls(
        [_call(kind="finding", cid="c4", claim="again", source_url="https://a.com")],
        ctx,
    )
    assert ok[0].status == "success"


# --- complete + dedup + honest failure -------------------------------------
async def test_complete_is_recorded():
    ctx, convex, _ = _ctx()
    msgs = await execute_tool_calls([_call(kind="complete")], ctx)
    assert msgs[0].status == "success"
    assert _ops(convex, "research-checkpoint")[0]["kind"] == "complete"


async def test_duplicate_plan_not_re_sent():
    ctx, convex, _ = _ctx()
    await execute_tool_calls(
        [
            _call(kind="plan", cid="c1", objective="same", subquestions=["a"]),
            _call(kind="plan", cid="c2", objective="same", subquestions=["a"]),
        ],
        ctx,
    )
    assert len(_ops(convex, "research-checkpoint")) == 1  # written once


async def test_lost_checkpoint_reported_honestly():
    ctx, convex, _ = _ctx(resp={"ok": True, "saved": False})
    msgs = await execute_tool_calls(
        [_call(kind="finding", claim="c", source_url="https://x.com")], ctx
    )
    assert msgs[0].status == "error"
    assert json.loads(msgs[0].content)["status"] == "not_recorded"


async def test_bad_kind_is_error():
    ctx, convex, _ = _ctx()
    msgs = await execute_tool_calls([_call(kind="bogus")], ctx)
    assert msgs[0].status == "error"
    assert _ops(convex, "research-checkpoint") == []


# --- resume: continue the run without re-researching completed work --------
def _active():
    return ActiveResearchRun(
        runId="run-42",
        objective="compare CRMs",
        status="researching",
        timeSensitive=True,
        subquestions=["pricing", "reviews", "integrations"],
        completed=["pricing", "reviews"],
        findings=[
            ResearchFindingSeed(
                subquestion="pricing",
                claim="Vendor X starts at $25/user/mo",
                sourceUrl="https://vendorx.com/pricing",
                sourceTitle="Vendor X Pricing",
                sourceDate="2026-08",
                confidence="high",
            ),
            ResearchFindingSeed(
                subquestion="reviews",
                claim="Vendor X rated 4.5/5 on G2",
                sourceUrl="https://g2.com/vendorx",
            ),
        ],
        sourceCount=2,
    )


def test_build_research_context_continues_run_and_seeds_budget():
    s = make_settings("http://x")
    rc = build_research_context(s, _active())
    assert rc.run_id == "run-42"  # SAME row on resume (idempotent upsert)
    # the source counter carries prior findings so the budget spans the whole run
    assert rc.seen_sources == {"https://vendorx.com/pricing", "https://g2.com/vendorx"}
    assert rc.plan_recorded is True


def test_build_research_context_fresh_when_no_active_run():
    s = make_settings("http://x")
    rc = build_research_context(s, None)
    assert rc.run_id and not rc.seen_sources and not rc.plan_recorded


def test_render_seed_lists_completed_open_and_findings():
    block = render_research_seed(_active())
    low = block.lower()
    assert "<prior_research>" in low and "do not repeat" in low
    assert "still open: integrations" in low  # the only un-completed sub-question
    assert "vendor x starts at $25" in low  # a prior finding is replayed
    assert "vendor x pricing" in low  # with its source


def test_render_seed_empty_when_no_run():
    assert render_research_seed(None) == ""
    assert render_research_seed(ActiveResearchRun()) == ""  # no runId
