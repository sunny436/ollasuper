"""Phase 4 — tool-execution policy, enforced OUTSIDE the model.

Each test isolates ONE gate by constructing a ToolDefinition with exactly the
field under test set, so the ordered gate is verified dimension by dimension.
"""

from __future__ import annotations

from app.agent.policy import READ_SCOPE, PolicyScope, check_tool_policy
from app.models.tools import (
    Availability,
    SideEffect,
    ToolDefinition,
    ToolPermissions,
)


def _tool(**over) -> ToolDefinition:
    base = dict(
        tool_id="scrape_url",
        name="Scrape URL",
        side_effect=SideEffect.READ_ONLY,
        enabled=True,
        availability=Availability.AVAILABLE,
        required_auth="BearerAuth",
        permissions=ToolPermissions(required_permissions=["ollagraph:read"]),
    )
    base.update(over)
    return ToolDefinition(**base)


def test_read_only_authorized_is_allowed():
    r = check_tool_policy(_tool(), READ_SCOPE)
    assert r.allowed and r.decision == "allow"


def test_high_impact_needs_approval():
    # Isolate the side-effect gate: enabled, available, no perm requirement.
    r = check_tool_policy(
        _tool(side_effect=SideEffect.HIGH_IMPACT, permissions=ToolPermissions()),
        READ_SCOPE,
    )
    assert r.needs_approval


def test_external_side_effect_needs_approval():
    r = check_tool_policy(
        _tool(
            side_effect=SideEffect.EXTERNAL_SIDE_EFFECT, permissions=ToolPermissions()
        ),
        READ_SCOPE,
    )
    assert r.needs_approval


def test_approval_required_flag_needs_approval():
    r = check_tool_policy(
        _tool(
            permissions=ToolPermissions(
                required_permissions=["ollagraph:read"], approval_required=True
            )
        ),
        READ_SCOPE,
    )
    assert r.needs_approval


def test_disabled_is_denied():
    assert check_tool_policy(_tool(enabled=False), READ_SCOPE).denied


def test_unavailable_is_denied():
    assert check_tool_policy(
        _tool(availability=Availability.UNAVAILABLE), READ_SCOPE
    ).denied


def test_admin_token_is_denied():
    # Denied even though it is high-impact+approval: we hold no admin token, so
    # approval could never be fulfilled. Deny beats the approval escape hatch.
    r = check_tool_policy(
        _tool(
            required_auth="AdminToken",
            side_effect=SideEffect.HIGH_IMPACT,
            permissions=ToolPermissions(approval_required=True),
        ),
        READ_SCOPE,
    )
    assert r.denied


def test_missing_permission_is_denied():
    r = check_tool_policy(
        _tool(permissions=ToolPermissions(required_permissions=["ollagraph:write"])),
        READ_SCOPE,
    )
    assert r.denied


def test_scope_without_read_denies_everything():
    empty = PolicyScope(granted_permissions=frozenset())
    assert check_tool_policy(_tool(), empty).denied
