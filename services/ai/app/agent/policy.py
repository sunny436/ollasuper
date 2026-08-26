"""Tool-execution policy (Phase 4) — enforced OUTSIDE the model.

The LLM is NOT a security authority. Discovery already filters the tools bound
to the model to the READ_ONLY, enabled, available subset; this module re-decides
per call, from the `ToolDefinition` metadata alone, whether an execution is
permitted. It runs on the value the model returns (a tool name + args), never on
the model's reasoning, so a hallucinated or misconfigured tool cannot slip
through: an unknown tool never reaches here (the executor's `registry.get`
returns None first), and a tool whose metadata says write/high-impact/admin is
denied or held for approval regardless of what the model asked for.

Three outcomes:
  * ALLOW           — execute via the Phase-1 adapter.
  * NEEDS_APPROVAL  — do NOT execute; emit a Phase-3 APPROVAL_REQUEST. Phase 4
                      does not implement the approval resume round-trip, so this
                      terminates the call with a "requires approval" observation.
  * DENY            — do NOT execute; return a safe error observation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum

from app.models.tools import Availability, SideEffect, ToolDefinition

# Blast-radius ordering, mirroring app/tools/selection.py so the ceiling here and
# the discovery filter agree on what "read-only" means.
_SIDE_EFFECT_RANK = {
    SideEffect.READ_ONLY: 0,
    SideEffect.EXTERNAL_SIDE_EFFECT: 1,
    SideEffect.HIGH_IMPACT: 2,
}


class PolicyDecision(StrEnum):
    ALLOW = "allow"
    NEEDS_APPROVAL = "needs_approval"
    DENY = "deny"


@dataclass(frozen=True, slots=True)
class PolicyScope:
    """What the CALLER may do. There is no per-user permission engine in the
    Python plane, so an authenticated chat user is granted the read capability
    only — write/admin tools require the (deferred) approval round-trip and are
    never silently run. Kept as a value object so a real scope can be threaded
    from Convex later without touching call sites."""

    granted_permissions: frozenset[str] = field(
        default_factory=lambda: frozenset({"ollagraph:read"})
    )
    # Ceiling on blast radius the caller may execute WITHOUT approval.
    max_side_effect: SideEffect = SideEffect.READ_ONLY
    # Phase 5: AUTHORITATIVE caller identity, threaded from the Convex-
    # authenticated request (never the model). Defaulted empty so READ_SCOPE/
    # WRITE_SCOPE stay valid permission TEMPLATES and every existing call site +
    # test constructs unchanged; the runner builds the per-turn scope via
    # dataclasses.replace(...). user/workspace/tenant feed the outbound Ollagraph
    # scope headers (the tenant/user isolation boundary the provider enforces);
    # agent_id/capabilities are placeholders for a future agent/capability
    # identity and are NOT yet enforced.
    user_id: str = ""
    workspace_id: str = ""
    tenant_id: str = ""
    agent_id: str | None = None
    capabilities: frozenset[str] = frozenset()
    # Phase 2: generic agent capability scoping. When EITHER is non-None, a tool is
    # in scope iff `tool.category in allowed_categories` OR `tool.tool_id in
    # allowed_tool_ids`; anything else is hard-DENIED here — the single execution
    # choke point — so a scoped agent can never run an out-of-scope tool even after
    # discovering it via find_capabilities. Both None (the default, and every
    # existing scope) => unrestricted, byte-identical.
    allowed_categories: frozenset[str] | None = None
    allowed_tool_ids: frozenset[str] | None = None


# The default scope for an ordinary authenticated chat turn.
READ_SCOPE = PolicyScope()

# Elevated scope used only when ai_agent_side_effect_enabled is on: grants the
# write capability and an EXTERNAL_SIDE_EFFECT ceiling, so a scrape/analyze tool
# resolves to NEEDS_APPROVAL (its approval_required is honoured) rather than DENY.
# HIGH_IMPACT tools still fail — they need ollagraph:admin, which is never
# granted, and are disabled at classify time.
WRITE_SCOPE = PolicyScope(
    granted_permissions=frozenset({"ollagraph:read", "ollagraph:write"}),
    max_side_effect=SideEffect.EXTERNAL_SIDE_EFFECT,
)


@dataclass(frozen=True, slots=True)
class PolicyResult:
    decision: PolicyDecision
    reason: str = ""

    @property
    def allowed(self) -> bool:
        return self.decision is PolicyDecision.ALLOW

    @property
    def needs_approval(self) -> bool:
        return self.decision is PolicyDecision.NEEDS_APPROVAL

    @property
    def denied(self) -> bool:
        return self.decision is PolicyDecision.DENY


def check_tool_policy(tool: ToolDefinition, scope: PolicyScope) -> PolicyResult:
    """Ordered gate over tool metadata. First match wins; hard failures (deny)
    are checked before the soft escape hatch (approval) so an admin-scoped or
    disabled tool can never be reached by asking for approval."""
    if not tool.enabled:
        return PolicyResult(PolicyDecision.DENY, "tool is disabled")
    if tool.availability is not Availability.AVAILABLE:
        return PolicyResult(PolicyDecision.DENY, "tool is unavailable")
    # We hold no admin token; the adapter refuses these too. Approval cannot
    # help — deny rather than dangle an unfulfillable approval.
    if tool.required_auth == "AdminToken":
        return PolicyResult(PolicyDecision.DENY, "admin-scoped tool is not callable")
    required = set(tool.permissions.required_permissions)
    if required and not required <= scope.granted_permissions:
        return PolicyResult(PolicyDecision.DENY, "missing required permission")
    # Phase 2: agent capability scope — hard DENY an out-of-scope tool BEFORE the
    # side-effect ceiling, so a scoped agent (e.g. SEO) can never reach an
    # out-of-category tool even if it discovered one via find_capabilities.
    if scope.allowed_categories is not None or scope.allowed_tool_ids is not None:
        in_scope = tool.category in (scope.allowed_categories or frozenset()) or (
            tool.tool_id in (scope.allowed_tool_ids or frozenset())
        )
        if not in_scope:
            return PolicyResult(
                PolicyDecision.DENY, "tool outside the agent's capability scope"
            )
    ceiling = _SIDE_EFFECT_RANK.get(scope.max_side_effect, 0)
    if _SIDE_EFFECT_RANK.get(tool.side_effect, 2) > ceiling:
        return PolicyResult(
            PolicyDecision.NEEDS_APPROVAL, "side effect exceeds read-only ceiling"
        )
    if tool.permissions.approval_required:
        return PolicyResult(PolicyDecision.NEEDS_APPROVAL, "tool requires approval")
    return PolicyResult(PolicyDecision.ALLOW, "read-only and authorized")
