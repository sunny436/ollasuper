"""Derive side-effect + permission metadata from an operation's shape.

The Ollagraph spec carries no `x-` side-effect hints, so classification is by
HTTP method + path prefix + required auth scheme (verified against the live
spec's prefix distribution). This is METADATA for a future policy engine — it
enforces nothing in Phase 1.
"""

from __future__ import annotations

from app.models.tools import SideEffect, ToolPermissions

# Account / credential / billing / org surfaces — highest blast radius.
_HIGH_IMPACT_PREFIXES = ("/v1/keys", "/v1/me", "/v1/billing", "/v1/auth", "/v1/orgs")
# Browser sessions hold external state (create/hold/teardown).
_SESSION_PREFIXES = ("/v1/session", "/v1/stagehand")
_MUTATING_METHODS = frozenset({"delete", "patch", "put"})


def classify(
    method: str,
    path: str,
    required_auth: str = "BearerAuth",
) -> tuple[SideEffect, ToolPermissions, bool]:
    """Return (side_effect, permissions, enabled_by_default)."""
    m = (method or "").lower()
    p = path or ""

    if required_auth == "AdminToken":
        side = SideEffect.HIGH_IMPACT
    elif any(p.startswith(pre) for pre in _HIGH_IMPACT_PREFIXES):
        side = SideEffect.HIGH_IMPACT
    elif any(p.startswith(pre) for pre in _SESSION_PREFIXES):
        side = SideEffect.EXTERNAL_SIDE_EFFECT
    elif "/async" in p:
        # Async scrape/batch jobs fire a webhook — an external side effect.
        side = SideEffect.EXTERNAL_SIDE_EFFECT
    elif m in _MUTATING_METHODS:
        # A resource mutation not caught above; classify conservatively.
        side = SideEffect.EXTERNAL_SIDE_EFFECT
    else:
        # POST here is overwhelmingly read-only analysis (scrape/extract/intel/
        # actors/seo/aeo/convert/parse/crawl/...), plus all GETs.
        side = SideEffect.READ_ONLY

    if side is SideEffect.READ_ONLY:
        perms = ToolPermissions(
            required_permissions=["ollagraph:read"],
            workspace_scope=True,
            approval_required=False,
        )
        enabled = True
    elif side is SideEffect.EXTERNAL_SIDE_EFFECT:
        perms = ToolPermissions(
            required_permissions=["ollagraph:write"],
            workspace_scope=True,
            approval_required=True,
        )
        # Registered as ENABLED so the approval round-trip can surface it — it is
        # still never auto-run: the default READ scope denies it (missing the
        # write grant + read-only ceiling), so it is only reachable when
        # ai_agent_side_effect_enabled raises the runner's scope, and even then
        # only via NEEDS_APPROVAL. HIGH_IMPACT below stays disabled outright.
        enabled = True
    else:  # HIGH_IMPACT
        perms = ToolPermissions(
            required_permissions=["ollagraph:admin"],
            user_scope=True,
            approval_required=True,
        )
        enabled = False

    return side, perms, enabled
