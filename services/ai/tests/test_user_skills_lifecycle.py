"""Phase 7 — lifecycle properties that can only be broken in the RUNTIME.

The Convex half of the contract (what a later dispatch sees after an edit,
disable, delete, retry, resume, scheduled run or account deletion) is asserted
in `userSkills.lifecycle.test.ts`. Two things cannot be asserted there:

  1. THAT A RUNNING GENERATION IS IMMUTABLE. This is the reason no durable
     version snapshot exists: `run_generation` reads `req.customSkills` once
     and never re-reads it, so an edit during a generation cannot reach it.
     That is a property of this code, and this is where a future change would
     silently take it away.

  2. THAT AN APPROVED TOOL SURVIVES A SKILL CHANGE. Consent was given for a
     specific call; an unrelated settings edit must not discard it.
"""

from __future__ import annotations

import httpx
from langchain_core.messages import AIMessage

from app.models.chat import (
    ApprovedPending,
    CustomSkill,
    GenerateRequest,
    HistoryMessage,
)
from app.models.tools import (
    Availability,
    SideEffect,
    ToolDefinition,
    ToolPermissions,
)
from app.orchestrator.intents import register_intents
from app.runtime.runner import run_generation
from app.tools.registry import ToolRegistry
from app.tools.selection import ToolSelector
from tests.conftest import make_settings
from tests.test_agent_runner import RecordingConvex

_READABILITY = "seo_readability_endpoint_v1_seo_readability_post"
_READABILITY_QUERY = "measure content readability score of text editorial quality"
# A request about something else entirely, so lexical discovery cannot surface
# the tool and it is not one of the seeded core capabilities. Anything that
# binds it did so for a reason the test is naming.
_UNRELATED = "Tell me about the history of the Hanseatic League."


def _tool(tool_id: str, description: str) -> ToolDefinition:
    return ToolDefinition(
        tool_id=tool_id,
        name=tool_id,
        description=description,
        path=f"/v1/{tool_id}",
        method="post",
        category="content",
        side_effect=SideEffect.READ_ONLY,
        enabled=True,
        availability=Availability.AVAILABLE,
        permissions=ToolPermissions(required_permissions=["ollagraph:read"]),
        input_schema={"type": "object", "properties": {"text": {"type": "string"}}},
    )


def _registry() -> ToolRegistry:
    reg = ToolRegistry()
    reg.register(_tool(_READABILITY, _READABILITY_QUERY))
    reg.register(_tool("unrelated_currency_tool", "convert currency amounts"))
    return reg


def _skill(instructions="ORIGINAL: quote the clause number.", caps=None):
    return CustomSkill(
        id="k1",
        ownerId="u1",
        revision=1,
        name="Reviewer",
        description="Reviewing contracts.",
        instructions=instructions,
        capabilities=caps or [],
    )


def _req(skills, *, text=_UNRELATED, approved=None, **kw):
    return GenerateRequest(
        streamId="s1",
        threadId="t1",
        messageId="m1",
        userId="u1",
        workspaceId="w1",
        model="gpt-5.6-luna",
        history=[HistoryMessage(role="user", content=text, seq=1)],
        customSkills=skills,
        approvedPending=approved or [],
        **kw,
    )


def _settings(**over):
    return make_settings(
        "http://x",
        ai_agent_enabled=True,
        ai_orchestrated_runtime_enabled=True,
        ollagraph_base_url="https://api.ollagraph.test",
        ollagraph_api_key="osk_test_key_123456",
        ai_user_skills_enabled=True,
        ai_user_skill_min_score=0.0,
        **over,
    )


class _Rec:
    """Records every system prompt, and can run a callback between model turns."""

    def __init__(self, tool_turns: list[AIMessage], between=None) -> None:
        self.prompts: list[str] = []
        self.bound: list[list] = []
        outer = self

        class _T:
            calls = 0

            async def ainvoke(self, messages, *a, **k):
                outer.prompts.append(
                    "".join(
                        str(m.content)
                        for m in messages
                        if isinstance(getattr(m, "content", None), str)
                    )
                )
                # The race: mutate the request AFTER the first model turn but
                # BEFORE the runtime would have a chance to re-read anything.
                if between is not None and self.calls == 0:
                    between()
                self.calls += 1
                return tool_turns[min(self.calls - 1, len(tool_turns) - 1)]

        self._t = _T()

    def bind_tools(self, specs):
        self.bound.append(list(specs))
        return self._t

    async def ainvoke(self, messages, *a, **k):
        self.prompts.append(
            "".join(
                str(m.content)
                for m in messages
                if isinstance(getattr(m, "content", None), str)
            )
        )
        return AIMessage(content="plain")


async def _run(monkeypatch, req, reg, *, tool_turns=None, between=None, settings=None):
    llms: list[_Rec] = []

    def _build(*a, **k):
        lm = _Rec(tool_turns or [AIMessage(content="answer")], between)
        llms.append(lm)
        return lm

    monkeypatch.setattr("app.runtime.runner.build_llm", _build)
    http = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json={}))
    )
    try:
        await run_generation(
            req,
            settings or _settings(),
            RecordingConvex(),
            tool_registry=reg,
            tool_selector=ToolSelector(reg),
            ollagraph_http=http,
        )
    finally:
        await http.aclose()
    prompts = [p for lm in llms for p in lm.prompts]
    names = sorted(
        {s["function"]["name"] for lm in llms for specs in lm.bound for s in specs}
    )
    return prompts, names


# ---------------------------------------------------------------------------
# 1. A RUNNING GENERATION IS IMMUTABLE
# ---------------------------------------------------------------------------
async def test_editing_a_skill_mid_run_cannot_change_the_running_turn(monkeypatch):
    """The property the whole no-versioning answer rests on.

    If this ever fails, a durable snapshot becomes necessary — which is exactly
    why the assertion is here rather than in a comment.
    """
    req = _req([_skill()])

    def edit_mid_run():
        # The most aggressive form of the race: rewrite the request object
        # itself, in place, while the generation is running. Even this must not
        # reach the prompt, because the prompt was assembled once.
        req.customSkills[0].instructions = "EDITED: do the opposite."

    prompts, _ = await _run(monkeypatch, req, _registry(), between=edit_mid_run)
    joined = "".join(prompts)
    assert "ORIGINAL: quote the clause number." in joined
    assert "EDITED: do the opposite." not in joined


async def test_a_second_executor_pass_does_not_re_read_the_skills(monkeypatch):
    """A tool-calling turn runs the model more than once. The later passes must
    reuse the prompt built at the start, not rebuild it from a mutated request."""
    reg = _registry()
    call = AIMessage(
        content="",
        tool_calls=[{"name": _READABILITY, "args": {"text": "x"}, "id": "c1"}],
    )
    req = _req([_skill(caps=["phase7.readability"])], text="score this text")
    register_intents({"phase7.readability": {"query": _READABILITY_QUERY}})

    def wipe_mid_run():
        req.customSkills.clear()

    prompts, _ = await _run(
        monkeypatch,
        req,
        reg,
        tool_turns=[call, AIMessage(content="done")],
        between=wipe_mid_run,
    )
    # Every model turn in this generation saw the same guidance.
    assert prompts, "the model was never invoked"
    assert all("ORIGINAL: quote the clause number." in p for p in prompts if p)


async def test_disabling_is_ignore_not_erase_within_a_run(monkeypatch):
    # `enabled=False` arriving in a payload is refused at the boundary, so a
    # disable can only ever take effect on the NEXT dispatch — never halfway
    # through one. Asserted from both sides in the same test.
    on = _req([_skill()])
    off = _req([_skill().model_copy(update={"enabled": False})])
    prompts_on, _ = await _run(monkeypatch, on, _registry())
    prompts_off, _ = await _run(monkeypatch, off, _registry())
    assert "ORIGINAL: quote the clause number." in "".join(prompts_on)
    assert "ORIGINAL: quote the clause number." not in "".join(prompts_off)


# ---------------------------------------------------------------------------
# 2. AN APPROVED TOOL SURVIVES A SKILL CHANGE
# ---------------------------------------------------------------------------
async def test_an_approved_tool_stays_bound_after_its_skill_is_deleted(monkeypatch):
    """The race Phase 6 widened.

    A skill declares a capability, the tool binds ONLY because of that
    declaration, the model calls it, it parks for approval. The user approves —
    then deletes the skill. On resume the declaration is gone and discovery
    never surfaced this tool, so without re-seeding it the approved action fails
    as "unknown tool" and the user's consent is silently discarded.
    """
    register_intents({"phase7.appr": {"query": _READABILITY_QUERY}})
    reg = _registry()
    approved = [ApprovedPending(
            approvalId="ap1", toolId=_READABILITY, args={"text": "x"}, token="tok"
        )]

    # The skill is GONE from the payload (deleted while the approval waited).
    _, bound = await _run(
        monkeypatch, _req([], approved=approved, attempt=1), reg
    )
    assert any("readability" in n for n in bound), bound


async def test_without_the_approval_that_tool_is_not_bound(monkeypatch):
    # The control. Proves the test above passes because of the approval and not
    # because discovery would have surfaced the tool anyway.
    _, bound = await _run(monkeypatch, _req([]), _registry())
    assert not any("readability" in n for n in bound), bound


async def test_an_approval_cannot_resurrect_a_tool_that_is_now_disabled(monkeypatch):
    """Re-seeding restores BINDABILITY, never authorization.

    If the tool was disabled while the approval waited, the approval must not
    bring it back — `_passes` still gates, so it stays unbound.
    """
    reg = ToolRegistry()
    disabled = _tool(_READABILITY, _READABILITY_QUERY)
    disabled.enabled = False
    reg.register(disabled)
    approved = [ApprovedPending(
            approvalId="ap1", toolId=_READABILITY, args={"text": "x"}, token="tok"
        )]
    _, bound = await _run(
        monkeypatch, _req([], approved=approved, attempt=1), reg
    )
    assert not any("readability" in n for n in bound), bound


async def test_a_skill_edit_during_the_approval_wait_changes_only_the_guidance(
    monkeypatch,
):
    # The approval is about a TOOL and its ARGS, both pinned durably in
    # `approvedPending`. Editing the skill changes what the model is told, not
    # what was consented to — so the approved call is still exactly the approved
    # call.
    register_intents({"phase7.appr2": {"query": _READABILITY_QUERY}})
    approved = [ApprovedPending(
            approvalId="ap1", toolId=_READABILITY, args={"text": "x"}, token="tok"
        )]
    req = _req(
        [_skill(instructions="EDITED WHILE WAITING: be terse.")],
        approved=approved,
        attempt=1,
    )
    prompts, bound = await _run(monkeypatch, req, _registry())
    assert "EDITED WHILE WAITING: be terse." in "".join(prompts)
    assert any("readability" in n for n in bound), bound
    assert req.approvedPending[0].args == {"text": "x"}
    assert req.approvedPending[0].token == "tok"


# ---------------------------------------------------------------------------
# 3. LATEST-WINS ACROSS ATTEMPTS, ASSERTED IN THE RUNTIME
# ---------------------------------------------------------------------------
async def test_a_resumed_attempt_uses_whatever_the_payload_now_carries(monkeypatch):
    # Convex decides WHAT a resumed attempt is given (asserted in the Convex
    # lifecycle test); the runtime must simply use it, with no memory of a
    # previous attempt. There is no cache here, so there is nothing to be stale.
    first, _ = await _run(monkeypatch, _req([_skill()]), _registry())
    second, _ = await _run(
        monkeypatch,
        _req([_skill(instructions="EDITED: the new rule.")], attempt=2),
        _registry(),
    )
    assert "ORIGINAL: quote the clause number." in "".join(first)
    assert "EDITED: the new rule." in "".join(second)
    assert "ORIGINAL: quote the clause number." not in "".join(second)


async def test_a_scheduled_unattended_turn_still_applies_the_owners_skill(monkeypatch):
    prompts, _ = await _run(
        monkeypatch, _req([_skill()], unattended=True), _registry()
    )
    assert "ORIGINAL: quote the clause number." in "".join(prompts)
