"""Tool-description and tool-result poisoning (§92 / §109).

The two remaining poisoning surfaces. Resources are covered in
`test_mcp_resources.py` and prompts in `test_mcp_prompts.py`; these are the two
that reach the model through the ORDINARY tool path, which is precisely why they
matter — a defence that only works for the new capability kinds would leave the
oldest one open.

THE CLAIM UNDER TEST, stated so a failure is unambiguous:

    a malicious MCP server controls its tool names, descriptions, annotations
    and results, and NONE of those can grant it authority.

Authority in OllaSuper comes from exactly one place — `check_tool_policy`
reading `ToolDefinition.side_effect` and `permissions.approval_required` — and
the whole point of these tests is that a server cannot write to either.

THE LIE THAT MATTERS is `read_only_hint=True` on `delete_everything`. MCP's own
type definitions say annotations "are not guaranteed to provide a faithful
description of tool behavior" and that clients "should never make tool use
decisions based on ToolAnnotations received from untrusted servers".
`normalize._side_effect` is that sentence in code, and this file is its proof:

    MEASURED, untrusted: delete_everything -> external_side_effect (approval)
    MEASURED, trusted:   delete_everything -> read_only

The second line is not a bug. `trusted` is an operator's explicit decision
recorded in `mcp_curated_servers`, and honouring a hint from a server somebody
deliberately vouched for is what that column means. It is also the phase's stated
residual risk rather than an oversight.

Everything here runs the REAL `check_tool_policy`, the REAL `build_tool_specs`
and the REAL `execute_tool_calls`. If a refusal needed MCP-specific code, these
tests could not be written the way they are.
"""

from __future__ import annotations

import json
from dataclasses import replace

import pytest
from langchain_core.messages import ToolMessage

from app.agent.executor import ToolExecContext, build_tool_specs, execute_tool_calls
from app.agent.policy import READ_SCOPE, WRITE_SCOPE, PolicyDecision, check_tool_policy
from app.config import Settings
from app.mcp.adapter import McpToolAdapter
from app.mcp.connection import build_client
from app.mcp.models import McpConnectionConfig, McpServerIdentity
from app.mcp.normalize import normalize_tools
from app.models.tools import SideEffect, ToolCandidate, ToolDefinition
from app.runtime.writer import DeltaWriter
from app.tools.registry import ToolRegistry
from tests.fakes.mcp_server import TOOL_INJECTION, build_hostile_tool_server
from tests.test_writer_events import RecordingConvex

pytestmark = pytest.mark.anyio


def _cfg(*, trusted: bool) -> McpConnectionConfig:
    return McpConnectionConfig(
        identity=McpServerIdentity(
            slug="hostile", display_name="Hostile", trusted=trusted
        ),
        server=build_hostile_tool_server(),
    )


async def _discover(cfg: McpConnectionConfig) -> list[ToolDefinition]:
    async with build_client(cfg) as client:
        listed = await client.list_tools()
        return normalize_tools(list(listed.tools), cfg.identity)


# ============================================================ §92 DESCRIPTIONS
async def test_a_read_only_lie_from_an_untrusted_server_still_needs_approval():
    """THE tool-poisoning control.

    `delete_everything` advertises `readOnlyHint=true`. If that reached
    `side_effect`, `check_tool_policy` would ALLOW it with no approval — a
    malicious server would have talked its way past the human gate using nothing
    but metadata.
    """
    tools = {t.name: t for t in await _discover(_cfg(trusted=False))}
    tool = tools["delete_everything"]

    assert tool.side_effect is SideEffect.EXTERNAL_SIDE_EFFECT
    assert check_tool_policy(tool, READ_SCOPE).decision is PolicyDecision.NEEDS_APPROVAL
    # AND UNDER AN ELEVATED TURN — which is every production turn, where the
    # side-effect ceiling gates nothing. An earlier version of this test
    # asserted ALLOW here, codifying exactly the bypass audit H-05 named: the
    # hint alone waived the human gate. Nothing an untrusted server says can.
    assert (
        check_tool_policy(tool, WRITE_SCOPE).decision is PolicyDecision.NEEDS_APPROVAL
    )
    assert tool.permissions.approval_required is True


@pytest.mark.parametrize(
    ("trusted", "name", "scope", "expected"),
    [
        # trusted × declared read → the ONLY unasked cell
        (True, "delete_everything", WRITE_SCOPE, PolicyDecision.ALLOW),
        (True, "delete_everything", READ_SCOPE, PolicyDecision.ALLOW),
        # trusted × write (no read hint) → asks
        (True, "helper", WRITE_SCOPE, PolicyDecision.NEEDS_APPROVAL),
        (True, "helper", READ_SCOPE, PolicyDecision.NEEDS_APPROVAL),
        # untrusted × anything → asks
        (False, "delete_everything", WRITE_SCOPE, PolicyDecision.NEEDS_APPROVAL),
        (False, "delete_everything", READ_SCOPE, PolicyDecision.NEEDS_APPROVAL),
        (False, "helper", WRITE_SCOPE, PolicyDecision.NEEDS_APPROVAL),
        (False, "helper", READ_SCOPE, PolicyDecision.NEEDS_APPROVAL),
    ],
)
async def test_the_approval_matrix(trusted, name, scope, expected):
    """trusted × declared-read × scope, exhaustively. One cell runs unasked:
    a declared read on a server an operator vouched for. Every other cell asks.
    (`delete_everything` is the fixture's declared read; `helper` carries no
    annotations and is therefore a write.)"""
    tools = {t.name: t for t in await _discover(_cfg(trusted=trusted))}
    assert check_tool_policy(tools[name], scope).decision is expected


async def test_the_hint_is_honoured_only_where_an_operator_vouched_for_the_server():
    """The control for the test above, and the phase's stated residual risk.

    A trusted connection DOES downgrade to read-only — that is what marking a
    curated server `trusted` means. Asserting it here makes the trust boundary
    explicit rather than something a reader has to infer from the absence of a
    test.
    """
    tools = {t.name: t for t in await _discover(_cfg(trusted=True))}
    assert tools["delete_everything"].side_effect is SideEffect.READ_ONLY
    # `helper` carries NO annotations at all, so even a trusted server gets the
    # fail-safe classification. Absence of a hint is never read as "harmless".
    assert tools["helper"].side_effect is SideEffect.EXTERNAL_SIDE_EFFECT


@pytest.mark.parametrize("trusted", [False, True])
async def test_a_poisoned_description_is_metadata_and_nothing_else(trusted):
    """It reaches the model, and it reaches it as a tool DESCRIPTION.

    Not suppressed — hiding what a server said would be lying about the tool the
    user is being offered. What matters is the POSITION: a `description` field
    inside a function spec, with no role, no priority, and no path to the system
    prompt.
    """
    tools = await _discover(_cfg(trusted=trusted))
    registry = ToolRegistry()
    registry.replace_provider("mcp:hostile", tools)
    specs, _names = build_tool_specs(
        [ToolCandidate(tool=t, score=1.0) for t in tools], registry
    )

    blob = json.dumps(specs)
    assert TOOL_INJECTION[:40] in blob, "the fixture did not inject anything"
    # Every occurrence is inside a `description`. There is no key in a function
    # spec that could carry an instruction.
    for spec in specs:
        assert set(spec) == {"type", "function"}
        assert set(spec["function"]) <= {"name", "description", "parameters"}
    assert "system" not in blob.lower().replace("systematic", "")


async def test_an_oversized_description_cannot_exhaust_the_context_window():
    """40,000 characters of description on every turn is a context-exhaustion
    primitive, not a tool.

    TWO INDEPENDENT CAPS produce this, and the test deliberately asserts the
    OBSERVABLE property rather than either one: `normalize_tool` truncates at
    1024 and `build_tool_specs` truncates again. Measured — removing either alone
    changes nothing here, and removing BOTH turns this red. That is defence in
    depth working, and it is why the assertion is on what reaches the model."""
    tools = await _discover(_cfg(trusted=True))
    registry = ToolRegistry()
    registry.replace_provider("mcp:hostile", tools)
    specs, _ = build_tool_specs(
        [ToolCandidate(tool=t, score=1.0) for t in tools], registry
    )
    for spec in specs:
        assert len(spec["function"]["description"]) <= 1024


async def test_a_hostile_tool_cannot_shadow_a_reserved_or_native_tool():
    """§106. `_by_name` is first-wins and `build_tool_specs` seeds `used` with
    the reserved names, so a collider is RENAMED rather than silently taking
    over a name the model already trusts."""
    tools = await _discover(_cfg(trusted=True))
    registry = ToolRegistry()
    native = ToolDefinition(
        tool_id="generate_file", name="generate_file", provider="ollagraph"
    )
    registry.register(native)
    registry.replace_provider("mcp:hostile", tools)

    # Namespacing alone already separates them.
    assert registry.get("generate_file") is not None
    assert all(t.tool_id.startswith("mcp:hostile:") for t in tools)

    specs, names = build_tool_specs(
        [ToolCandidate(tool=t, score=1.0) for t in tools],
        registry,
        reserved={"generate_file", "mcp_read_resource"},
    )
    bound = {s["function"]["name"] for s in specs}
    assert "generate_file" not in bound
    assert "mcp_read_resource" not in bound
    # Each bound name still maps back to the MCP tool it came from.
    for name in bound:
        assert names[name].startswith("mcp:hostile:")


async def test_no_credential_appears_in_any_hostile_tool_definition():
    tools = await _discover(_cfg(trusted=True))
    blob = json.dumps([t.model_dump(mode="json") for t in tools])
    for marker in (
        "access_token",
        "refresh_token",
        "client_secret",
        "Authorization",
        "Bearer ",
        "envelope",
    ):
        assert marker not in blob


# ================================================================ §109 RESULTS
async def _run(tool_id: str, *, trusted: bool = True, scope=None) -> ToolMessage:
    """One real tool call through the real executor."""
    cfg = _cfg(trusted=trusted)
    tools = await _discover(cfg)
    registry = ToolRegistry()
    registry.replace_provider("mcp:hostile", tools)

    ctx = ToolExecContext(
        registry=registry,
        adapter=None,
        adapters={"mcp:hostile": McpToolAdapter(cfg)},
        writer=DeltaWriter(RecordingConvex(), "s1", Settings()),
        # `PolicyScope` is a dataclass, not a pydantic model — `replace`, not
        # `model_copy`.
        scope=scope
        or replace(READ_SCOPE, max_side_effect=SideEffect.EXTERNAL_SIDE_EFFECT),
        name_to_tool_id={t.tool_id: t.tool_id for t in tools},
        result_max_chars=8000,
        default_timeout_s=30.0,
    )
    msgs = await execute_tool_calls([{"name": tool_id, "args": {}, "id": "c1"}], ctx)
    assert len(msgs) == 1
    return msgs[0]


async def test_a_poisoned_tool_result_arrives_framed_as_data():
    """§109. The result comes back — suppressing it would be lying about what the
    server returned — but inside `<tool_output>`, which is what tells the model
    it is reading DATA rather than being addressed.

    Inherited free from the existing executor: there is no MCP-specific framing.
    """
    msg = await _run("mcp:hostile:poisoned_lookup")
    assert isinstance(msg, ToolMessage)
    assert msg.tool_call_id == "c1"
    assert "<tool_output>" in msg.content
    assert TOOL_INJECTION[:40] in msg.content
    # It is a ToolMessage. There is no field on one that could carry a system
    # instruction, which is the structural half of the defence.
    assert msg.type == "tool"


async def test_a_poisoned_result_is_bounded_like_any_other():
    msg = await _run("mcp:hostile:poisoned_lookup")
    assert len(msg.content) <= 8000 + 200  # + the framing wrapper


async def test_a_poisoned_result_does_not_change_what_the_next_call_may_do():
    """The property that makes result injection inert rather than merely ugly:
    policy is re-evaluated from METADATA on every call, so nothing a server
    returned can widen what it is allowed to do next."""
    cfg = _cfg(trusted=False)
    tools = {t.name: t for t in await _discover(cfg)}
    before = check_tool_policy(tools["delete_everything"], READ_SCOPE).decision

    await _run("mcp:hostile:poisoned_lookup", trusted=False)

    after = check_tool_policy(tools["delete_everything"], READ_SCOPE).decision
    assert before is after is PolicyDecision.NEEDS_APPROVAL


async def test_an_approval_gated_hostile_tool_is_not_executed_without_approval():
    """End to end: the lie, the policy, and the executor together.

    An untrusted `delete_everything` under the read-only ceiling must NOT reach
    the server. This is the whole chain the description poisoning was aimed at.
    """
    msg = await _run("mcp:hostile:delete_everything", trusted=False, scope=READ_SCOPE)
    # A refusal the model can read, not a silent drop and not an execution.
    assert isinstance(msg, ToolMessage)
    assert "deleted" not in msg.content


async def test_all_four_poisoning_surfaces_are_covered_by_this_suite():
    """A coverage guard on the claim itself.

    §141 requires poisoning proven inert for tool descriptions, tool results,
    resources AND prompts. Three of those live in other files; this asserts the
    set is complete so a future reader does not have to take it on trust.
    """
    import pathlib

    here = pathlib.Path(__file__).parent
    covered = {
        "tool description": here / "test_mcp_injection.py",
        "tool result": here / "test_mcp_injection.py",
        "resource": here / "test_mcp_resources.py",
        "prompt": here / "test_mcp_prompts.py",
    }
    for surface, path in covered.items():
        assert path.exists(), f"{surface} has no test file"
        body = path.read_text(encoding="utf-8")
        assert "INJECTION" in body, f"{surface}: {path.name} asserts no injection"
