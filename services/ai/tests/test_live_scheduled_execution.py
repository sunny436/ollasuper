"""Phase 2 LIVE verification — the real model and the real Ollagraph API.

Opt-in and skipped by default (`LIVE_AI_TESTS=1`), following the same pattern as
the `db` marker: `uv run pytest` stays hermetic and offline. These tests spend
real tokens and real Ollagraph credits, so they are few and short-prompted.

WHAT THIS PROVES, precisely:
  * the AI half is REAL — real model, real Ollagraph discovery, real tool
    execution, real skill composition, all reached through
    `run_generation`, the same entry point Convex's dispatch action POSTs to;
  * the UNATTENDED policy holds against the real 147-tool Ollagraph catalogue.

WHAT IT DOES NOT PROVE: the Convex server. There is no Docker/Postgres on this
machine, so no self-hosted Convex can run; the Convex ingress is a recording
stand-in here. Convex's own functions are covered separately by
convex/scheduled.execution.test.ts, which executes the REAL function code under
convex-test. That split is stated in the Phase 2 report rather than papered over.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import httpx
import pytest

from app.agent.policy import READ_SCOPE, check_tool_policy
from app.clients.ollagraph import OllagraphAdapter
from app.models.chat import GenerateRequest, HistoryMessage
from app.models.tools import SideEffect
from app.runtime.runner import run_generation
from app.tools.registry import ToolRegistry
from app.tools.selection import ToolSelector
from tests.conftest import make_settings
from tests.test_agent_runner import RecordingConvex

pytestmark = [
    pytest.mark.anyio,
    pytest.mark.live,
    pytest.mark.skipif(
        os.environ.get("LIVE_AI_TESTS") != "1",
        reason="live AI tests are opt-in: set LIVE_AI_TESTS=1",
    ),
]

REPO_ROOT = Path(__file__).resolve().parents[3]
OLLAGRAPH_BASE = "https://api.ollagraph.com"
MODEL = "gpt-5.6-luna"


def _creds() -> dict[str, str]:
    """Load the operator credentials. Never logged, never echoed.

    Missing or unparseable credentials SKIP rather than silently degrading to a
    fake — a live suite that quietly stops being live is worse than no suite.
    """
    try:
        og = re.search(
            r"^api_key=(\S+)",
            (REPO_ROOT / "ollagraph_details.txt").read_text(errors="ignore"),
            re.M,
        )
        openrouter = (REPO_ROOT / "open_router_key.txt").read_text().strip()
        ollima = re.search(
            r"\bsk-[A-Za-z0-9_-]{16,}",
            (REPO_ROOT / "ollima.txt").read_text(errors="ignore"),
        )
    except OSError as e:
        pytest.skip(f"credential file unreadable: {type(e).__name__}")
    if not (og and openrouter and ollima):
        pytest.skip("credentials present but not parseable")
    return {
        "ollagraph": og.group(1),
        "openrouter": openrouter,
        "ollima": ollima.group(0),
    }


def _settings(**over):
    c = _creds()
    base = dict(
        openrouter_api_key=c["openrouter"],
        ollima_api_key=c["ollima"],
        ollagraph_base_url=OLLAGRAPH_BASE,
        ollagraph_api_key=c["ollagraph"],
        ai_default_model=MODEL,
    )
    base.update(over)
    # The Convex URL is unused: the ingress is the recording stand-in below.
    return make_settings("http://127.0.0.1:1", **base)


def _scheduled_request(prompt: str, message_id: str) -> GenerateRequest:
    """Exactly the payload Convex's dispatchPayload builds for a scheduled turn:
    no history, no summary, unattended."""
    return GenerateRequest(
        streamId=f"live-{message_id}",
        threadId="live-thread",
        messageId=message_id,
        userId="live-user",
        workspaceId="live-ws",
        model=MODEL,
        history=[HistoryMessage(role="user", content=prompt, seq=1)],
        summary=None,
        titleNeeded=False,
        unattended=True,
    )


def _event_types(convex: RecordingConvex) -> set[str]:
    out: set[str] = set()
    for call in convex.calls:
        if call.get("op") == "event":
            for e in call["events"]:
                out.add(e["type"])
    return out


def _finalize(convex: RecordingConvex) -> dict:
    finals = [c for c in convex.calls if c.get("op") == "finalize"]
    assert len(finals) == 1, f"expected exactly one finalize, got {len(finals)}"
    return finals[0]


async def _discovered() -> tuple[ToolRegistry, httpx.AsyncClient]:
    s = _settings(ai_agent_enabled=True)
    client = OllagraphAdapter.build_http_client()
    result = await OllagraphAdapter(s, client).discover()
    reg = ToolRegistry()
    reg.replace_all(result.definitions, result.components, result.report)
    return reg, client


# ── 1. a real answer, with no user online ───────────────────────────────────


async def test_a_scheduled_turn_gets_a_real_model_answer():
    convex = RecordingConvex()
    await run_generation(
        _scheduled_request(
            "Reply with exactly this and nothing else: SCHEDULED-OK",
            "live-plain",
        ),
        _settings(),
        convex,
    )
    final = _finalize(convex)
    assert final["status"] == "done", final
    assert "SCHEDULED-OK" in final["text"]


# ── 2. the unattended scope against the REAL catalogue ──────────────────────


async def test_the_unattended_scope_refuses_real_side_effecting_tools():
    reg, client = await _discovered()
    try:
        tools = reg.list()
        assert len(tools) > 50, f"discovery returned only {len(tools)} tools"

        allowed = [t for t in tools if check_tool_policy(t, READ_SCOPE).allowed]
        blocked = [t for t in tools if not check_tool_policy(t, READ_SCOPE).allowed]
        # A real, non-trivial split: unattended runs reach the read-only half of
        # the live catalogue and are refused the rest.
        assert allowed and blocked
        assert all(t.side_effect is SideEffect.READ_ONLY for t in allowed)
        # Nothing that mutates the outside world is reachable without approval,
        # and unattended execution can never obtain approval.
        assert any(t.side_effect is SideEffect.HIGH_IMPACT for t in blocked)
    finally:
        await client.aclose()


# ── 3. a real Ollagraph tool, executed by a scheduled turn ──────────────────


async def test_a_scheduled_turn_executes_a_real_ollagraph_tool():
    reg, client = await _discovered()
    convex = RecordingConvex()
    try:
        await run_generation(
            _scheduled_request(
                "Use the scrape tool on https://example.com and tell me the "
                "page's H1 heading text.",
                "live-tool",
            ),
            _settings(ai_agent_enabled=True),
            convex,
            tool_registry=reg,
            tool_selector=ToolSelector(reg),
            ollagraph_http=client,
        )
    finally:
        await client.aclose()

    types = _event_types(convex)
    assert "TOOL_CALL" in types, types
    assert "TOOL_RESULT" in types, types
    final = _finalize(convex)
    assert final["status"] == "done", final
    # The real page's heading made it into the real answer.
    assert "example domain" in final["text"].lower(), final["text"]


# ── 4. a real Skill, activating on a scheduled turn ─────────────────────────


async def test_a_real_skill_composes_into_a_scheduled_turn(monkeypatch):
    """The scheduled path is the normal path, so skills need no special wiring.

    Asserted by capturing the composed skills block rather than by inspecting
    the answer, which a model could produce either way.
    """
    import app.runtime.runner as runner_mod

    real = runner_mod.render_skills_block
    seen: list[str] = []

    def spy(*args, **kwargs):
        block = real(*args, **kwargs)
        if block:
            seen.append(block)
        return block

    monkeypatch.setattr(runner_mod, "render_skills_block", spy)

    reg, client = await _discovered()
    convex = RecordingConvex()
    try:
        await run_generation(
            _scheduled_request(
                "Perform an SEO analysis of example.com meta tags and "
                "headings, then summarise in two sentences.",
                "live-skill",
            ),
            _settings(
                ai_agent_enabled=True,
                ai_seo_enabled=True,
                # Skills compose only under the orchestrated runtime — the same
                # flag interactive chat needs. Scheduled turns require no
                # special wiring, but they DO inherit this gate.
                ai_orchestrated_runtime_enabled=True,
                # Relevance tuning is NOT what this test is about. The live
                # roster's tag scoring is context-sensitive and pre-existing;
                # pinning the threshold low makes activation deterministic, so
                # the assertion is about the scheduled turn REACHING the skill
                # composition path — not about how one prompt happens to score.
                ai_skill_min_score=0.05,
            ),
            convex,
            tool_registry=reg,
            tool_selector=ToolSelector(reg),
            ollagraph_http=client,
        )
    finally:
        await client.aclose()

    assert seen, "no skill guidance was composed into the scheduled turn"
    composed = "\n".join(seen).lower()
    assert "seo" in composed, composed[:400]
    assert _finalize(convex)["status"] == "done"


# ── 5. a real Ollagraph failure, classified rather than hung ────────────────


async def test_a_real_ollagraph_failure_still_finalizes_the_turn():
    """A failing tool must degrade into an observation, never a hang.

    The occurrence-level classification of that outcome is covered
    hermetically in test_scheduler_chat_executor.py; what matters here is that
    a REAL upstream failure reaches a terminal state at all.
    """
    reg, client = await _discovered()
    convex = RecordingConvex()
    try:
        await run_generation(
            _scheduled_request(
                "Use the scrape tool on "
                "https://this-domain-does-not-exist-ollasuper-test.invalid and "
                "report what happened in one sentence.",
                "live-fail",
            ),
            _settings(ai_agent_enabled=True),
            convex,
            tool_registry=reg,
            tool_selector=ToolSelector(reg),
            ollagraph_http=client,
        )
    finally:
        await client.aclose()

    final = _finalize(convex)
    # Terminal either way — the run is never left hanging on a failed tool.
    assert final["status"] in ("done", "error"), final
