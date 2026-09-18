"""The requirement ledger — the thing that stops "6 of 10 done" reading as done.

The production failures behind this: a blog asked for 5,000 words delivered 2,990
and described itself as "~5,000"; an audit that lost its crawl reported
confidently on what survived. Nothing tracked requirements, nothing aggregated
failures, and nothing checked either before the model wrote its answer.

The invariant under test: the report is computed from RECORDED STATE, so no
model output can talk it out of flagging incomplete work.
"""

from __future__ import annotations

import pytest

from app.runtime.ledger import (
    MAX_REQUIREMENTS,
    Requirement,
    TurnLedger,
    build_ledger,
    extract_requirements,
)

pytestmark = pytest.mark.anyio


TEN_PART = """Please do all of the following:
1. Audit the homepage metadata
2. Check the robots.txt directives
3. Validate the structured data markup
4. Review internal anchor text
5. Measure the mobile viewport handling
6. Compare against the sitemap coverage
7. Identify broken outbound links
8. Summarise the canonical tag usage
9. Evaluate the page title lengths
10. Recommend a prioritised fix order
"""


# --- deterministic extraction: the model is never the only bookkeeper -----


def test_a_numbered_request_yields_every_requirement():
    reqs = extract_requirements(TEN_PART)
    assert len(reqs) == 10
    assert reqs[0].startswith("Audit the homepage metadata")
    assert reqs[9].startswith("Recommend a prioritised fix order")


def test_bulleted_and_prose_imperatives_are_both_recognised():
    assert len(extract_requirements("- draft the intro\n- review the tone\n")) == 2
    prose = "Audit the site for SEO. Then draft a summary of the findings."
    assert len(extract_requirements(prose)) == 2


@pytest.mark.parametrize(
    "text",
    [
        "hi",
        "what is the capital of France",
        "thanks, that was really helpful",
        "can you explain how DNS works",
        "write a blog about zero trust",  # ONE piece of work, not a list
    ],
)
def test_ordinary_requests_build_no_ledger(text: str):
    """The fast path: a request that enumerates nothing is byte-identical."""
    assert build_ledger(text) is None


def test_the_ledger_is_bounded():
    huge = "\n".join(f"{i}. do the thing number {i}" for i in range(1, 60))
    assert len(extract_requirements(huge)) == MAX_REQUIREMENTS


# --- THE case: 10 asked, 6 answered --------------------------------------


def test_six_of_ten_cannot_report_as_complete():
    ledger = build_ledger(TEN_PART)
    assert ledger is not None and len(ledger.requirements) == 10

    # An answer that genuinely covers only the first six.
    answer = (
        "I audited the homepage metadata and the robots.txt directives. "
        "The structured data markup validates. Internal anchor text is "
        "descriptive. The mobile viewport is handled. Sitemap coverage compares "
        "well against what I crawled."
    )
    ledger.assess(answer)

    assert not ledger.complete
    unaddressed = {r.text.split()[1] for r in ledger.unaddressed}
    assert "broken" in unaddressed or len(ledger.unaddressed) >= 3

    report = ledger.render_report()
    assert "Not covered in this answer" in report
    assert "broken outbound links" in report


def test_a_genuinely_complete_answer_gets_no_report():
    """A clean turn must carry no chrome — this is what stops the feature from
    becoming noise on every response."""
    ledger = build_ledger("1. list the colours\n2. name the shapes\n")
    assert ledger is not None
    ledger.assess("The colours are red and blue. The shapes are circles.")
    assert ledger.complete
    assert ledger.render_report() == ""


def test_paraphrase_is_not_flagged():
    """Conservative by construction: any distinctive term counts, so an answer
    that covers a requirement in its own words must not be called missing."""
    ledger = build_ledger("1. audit the metadata\n2. check the sitemap\n")
    assert ledger is not None
    ledger.assess("Reviewed metadata thoroughly. The sitemap looks fine.")
    assert not ledger.unaddressed


# --- failures and truncation are recorded, not inferred ------------------


def test_failed_tools_downgrade_addressed_to_unverified():
    """55% of tool calls fail in production. An answer built on missing evidence
    is not a completed requirement."""
    ledger = build_ledger("1. audit the metadata\n2. check the sitemap\n")
    assert ledger is not None
    for _ in range(6):
        ledger.note_tool(ok=True)
    for _ in range(4):
        ledger.note_tool(ok=False)

    ledger.assess("Metadata audited. Sitemap checked.")

    assert not ledger.complete
    assert len(ledger.unverified) == 2
    report = ledger.render_report()
    assert "incomplete evidence" in report
    assert "4 tool call(s) failed" in report


def test_truncated_tool_results_are_counted():
    ledger = build_ledger("1. audit the metadata\n2. check the sitemap\n")
    assert ledger is not None
    ledger.note_tool(ok=True, truncated=True)
    ledger.assess("Metadata audited. Sitemap checked.")
    assert ledger.tools_truncated == 1
    assert not ledger.complete


def test_a_truncated_answer_is_reported():
    ledger = build_ledger("1. audit the metadata\n2. check the sitemap\n")
    assert ledger is not None
    ledger.note_output_truncated("length")
    ledger.assess("Metadata audited. Sitemap checked.")
    assert not ledger.complete
    assert "length limit" in ledger.render_report()


def test_a_normal_finish_is_not_treated_as_truncation():
    ledger = build_ledger("1. audit the metadata\n2. check the sitemap\n")
    assert ledger is not None
    ledger.note_output_truncated("stop")
    ledger.assess("Metadata audited. Sitemap checked.")
    assert ledger.complete


# --- the pre-synthesis injection -----------------------------------------


def test_the_model_is_shown_the_real_state_before_it_answers():
    """The answer streams token by token, so a gate after it cannot retract a
    claim. Putting state in front of the model is what makes an honest answer
    possible; the report is the backstop for when it is not."""
    ledger = build_ledger(TEN_PART)
    assert ledger is not None
    ledger.note_tool(ok=False)
    status = ledger.render_status()

    assert "Recommend a prioritised fix order" in status
    assert "1 failed" in status
    assert "state plainly which ones you could not fully support" in status


def test_the_report_cannot_be_overridden_by_the_answer_text():
    """The whole point: the model claiming completion changes nothing."""
    ledger = build_ledger(TEN_PART)
    assert ledger is not None
    ledger.assess(
        "All ten items are complete. Everything has been fully audited and "
        "verified. Done."
    )
    assert not ledger.complete
    assert "Not covered in this answer" in ledger.render_report()


def test_requirement_terms_ignore_filler():
    r = Requirement(id="r1", text="Please review the internal anchor text for me")
    assert "review" in r.terms and "internal" in r.terms
    assert "the" not in r.terms and "for" not in r.terms


def test_an_empty_ledger_is_complete_and_silent():
    assert TurnLedger().complete
    assert TurnLedger().render_report() == ""


# --- integration: the ledger is fed by REAL tool execution ----------------
# The counting seam is writer.record_execution — the one place every tool
# outcome already passes through. These drive it through the real executor
# rather than calling note_tool() by hand, so the wiring itself is under test.

import httpx  # noqa: E402

from app.agent.executor import ToolExecContext, execute_tool_calls  # noqa: E402
from app.agent.policy import READ_SCOPE  # noqa: E402
from app.clients.ollagraph import OllagraphAdapter  # noqa: E402
from app.runtime.writer import DeltaWriter  # noqa: E402
from app.tools.registry import ToolRegistry  # noqa: E402
from tests.test_agent_executor import _read_tool, _settings, _tc  # noqa: E402
from tests.test_writer_events import RecordingConvex  # noqa: E402


def _ctx_with_ledger(handler, ledger):
    reg = ToolRegistry()
    tool = _read_tool()
    reg.register(tool)
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    writer = DeltaWriter(RecordingConvex(), "s1", _settings())
    writer.ledger = ledger
    ctx = ToolExecContext(
        registry=reg,
        adapter=OllagraphAdapter(_settings(), client),
        writer=writer,
        scope=READ_SCOPE,
        name_to_tool_id={tool.tool_id: tool.tool_id},
        result_max_chars=8000,
        default_timeout_s=30.0,
        run_id="run_1",
        max_concurrent_tools=4,
    )
    return ctx, client


async def test_a_real_failing_tool_is_counted_by_the_ledger():
    ledger = build_ledger("1. audit the metadata\n2. check the sitemap\n")
    assert ledger is not None

    ctx, client = _ctx_with_ledger(
        lambda req: httpx.Response(500, json={"error": "boom"}), ledger
    )
    try:
        await execute_tool_calls([_tc("search_web", {}, "c1")], ctx)
    finally:
        await client.aclose()

    assert ledger.tools_attempted == 1
    assert ledger.tools_failed == 1

    ledger.assess("Metadata audited. Sitemap checked.")
    assert not ledger.complete
    assert "incomplete evidence" in ledger.render_report()


async def test_a_real_succeeding_tool_leaves_the_turn_clean():
    ledger = build_ledger("1. audit the metadata\n2. check the sitemap\n")
    assert ledger is not None

    ctx, client = _ctx_with_ledger(
        lambda req: httpx.Response(200, json={"data": {"ok": True}}), ledger
    )
    try:
        await execute_tool_calls([_tc("search_web", {}, "c1")], ctx)
    finally:
        await client.aclose()

    assert ledger.tools_attempted == 1
    assert ledger.tools_failed == 0

    ledger.assess("Metadata audited. Sitemap checked.")
    assert ledger.complete
    assert ledger.render_report() == ""


async def test_a_real_truncated_result_marks_requirements_unverified():
    """8,000-char cap; 442 results hit it in 14 days. An answer built on a
    clipped result is not a satisfied requirement."""
    ledger = build_ledger("1. audit the metadata\n2. check the sitemap\n")
    assert ledger is not None

    big = {"data": {"blob": "x" * 40_000}}
    ctx, client = _ctx_with_ledger(lambda req: httpx.Response(200, json=big), ledger)
    try:
        await execute_tool_calls([_tc("search_web", {}, "c1")], ctx)
    finally:
        await client.aclose()

    assert ledger.tools_truncated == 1
    assert ledger.tools_attempted == 1  # counted ONCE, not twice

    ledger.assess("Metadata audited. Sitemap checked.")
    assert len(ledger.unverified) == 2
    assert "truncated" in ledger.render_report()


async def test_no_ledger_means_the_executor_is_unchanged():
    """The fast path: writer.ledger is None for ordinary chat and nothing here
    may touch it."""
    ctx, client = _ctx_with_ledger(
        lambda req: httpx.Response(200, json={"data": {"ok": True}}), None
    )
    try:
        msgs = await execute_tool_calls([_tc("search_web", {}, "c1")], ctx)
    finally:
        await client.aclose()
    assert msgs and ctx.writer.ledger is None


# --- deadline becomes a checkpoint, not a dead end ------------------------


def test_a_deadline_reports_what_was_covered_and_what_remains():
    """`deadline_exceeded` is already in Convex's RESUMABLE_ERROR_CODES, so the
    completed executions survive and a retry continues rather than restarting.
    The user was told only "took too long"; the outstanding work is what makes
    that a checkpoint."""
    ledger = build_ledger(TEN_PART)
    assert ledger is not None
    ledger.stopped_early = True
    ledger.assess(
        "I audited the homepage metadata and checked the robots.txt directives. "
        "The structured data markup validates."
    )

    assert not ledger.complete
    report = ledger.render_report()
    assert "stopped at its time limit" in report
    assert "of 10 requirements" in report
    assert "not repeated" in report  # side-effect safety is stated, not implied
    assert "Recommend a prioritised fix order" in report  # what still remains


def test_a_turn_that_finishes_normally_is_never_marked_stopped_early():
    ledger = build_ledger("1. list the colours\n2. name the shapes\n")
    assert ledger is not None
    ledger.assess("The colours are red and blue. The shapes are circles.")
    assert ledger.complete
    assert "time limit" not in ledger.render_report()


# --- the dependency chain is recorded, not guessed ------------------------


def test_the_first_step_has_no_parent_and_later_steps_chain():
    """Tools inside one step are siblings that already run concurrently; a step
    always follows the results of the one before it. That IS the dependency
    chain, so recording it needs no cooperation from the model — which is the
    point, since a weak model declaring its own DAG is what cannot be relied on.
    """
    from app.agent.executor import _parent_step_id, _step_id

    ctx, client = _ctx_with_ledger(
        lambda req: httpx.Response(200, json={"data": {}}), None
    )
    # execute_tool_calls bumps the counter on ENTRY, so the first pass is s1
    # and there is never an s0.
    ctx.step_counter = 1
    assert _parent_step_id(ctx) is None  # responds to the user, not to a tool
    step1 = _step_id(ctx)

    ctx.step_counter = 2
    assert _parent_step_id(ctx) == step1  # step 2's parent IS step 1

    ctx.step_counter = 4
    assert _parent_step_id(ctx).endswith(":s3")


async def test_a_real_execution_records_its_parent_step():
    """`toolExecutions.parentStep` was reserved for the step graph and never
    populated. It is now filled from the real execution order."""
    ctx, client = _ctx_with_ledger(
        lambda req: httpx.Response(200, json={"data": {"ok": True}}), None
    )
    try:
        ctx.step_counter = 1  # bumped to 2 on entry: it responds to step 1
        await execute_tool_calls([_tc("search_web", {}, "c1")], ctx)
    finally:
        await client.aclose()

    executions = ctx.ledger.all()
    assert executions, "no execution was recorded"
    assert executions[0].parent_step is not None
    assert executions[0].parent_step.endswith(":s1")


async def test_a_first_step_execution_has_no_parent():
    ctx, client = _ctx_with_ledger(
        lambda req: httpx.Response(200, json={"data": {"ok": True}}), None
    )
    try:
        ctx.step_counter = 0
        await execute_tool_calls([_tc("search_web", {}, "c1")], ctx)
    finally:
        await client.aclose()

    assert ctx.ledger.all()[0].parent_step is None


# ------------------------------------------------- notices without a ledger
# "Write a 2,000-word article" is ONE requirement, so it builds no ledger — and
# that is exactly the shape the tester saw stop mid-sentence with nothing said
# about it. These notices therefore cannot live behind the ledger.


def test_a_single_requirement_request_builds_no_ledger():
    assert build_ledger("Write a 2,000-word article about AI in software") is None


def test_truncation_is_reported_without_a_ledger():
    from app.runtime.ledger import render_standalone_notices

    out = render_standalone_notices(output_truncated=True, no_evidence=False)
    assert "length limit" in out


def test_empty_search_is_reported_without_a_ledger():
    from app.runtime.ledger import render_standalone_notices

    out = render_standalone_notices(output_truncated=False, no_evidence=True)
    assert "no usable results" in out


def test_a_clean_turn_renders_nothing():
    from app.runtime.ledger import render_standalone_notices

    assert render_standalone_notices(output_truncated=False, no_evidence=False) == ""


def test_both_notices_can_appear_together():
    from app.runtime.ledger import render_standalone_notices

    out = render_standalone_notices(output_truncated=True, no_evidence=True)
    assert "length limit" in out and "no usable results" in out
