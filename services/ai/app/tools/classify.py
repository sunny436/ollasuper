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

# Phase 5: READ_ONLY is granted ONLY when positively known safe.
# HTTP methods that are safe by the spec (no side effect by definition).
_SAFE_METHODS = frozenset({"get", "head"})
# The ONLY POST paths treated as read-only: the known analysis families whose
# POST bodies are inputs to a pure computation (scrape/extract/intel/seo/aeo/
# convert/parse/crawl/actors/text/tree/search/similarity ...). Prefix match.
#
# LOAD-BEARING SECURITY DEFAULT: a POST NOT on this allowlist is EXTERNAL_SIDE_
# EFFECT (approval-gated), so an unfamiliar/new mutating POST can never auto-run.
# This list MUST be reconciled against the LIVE Ollagraph spec before deploy
# (run discovery, diff side_effect before/after) so no working read-only tool
# regresses and every genuinely-mutating op flips — that diff is Phase 5's
# acceptance gate for classification.
_READONLY_POST_PREFIXES = (
    "/v1/scrape",
    "/v1/extract",
    "/v1/intel",
    "/v1/actors",
    "/v1/seo",
    "/v1/aeo",
    "/v1/convert",
    "/v1/parse",
    "/v1/crawl",
    "/v1/search",
    "/v1/text",
    "/v1/tree",
    "/v1/similarity",
    "/v1/analyze",
    "/v1/summarize",
    "/v1/classify",
    "/v1/embed",
)


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
    elif m in _SAFE_METHODS:
        # GET/HEAD are safe by the HTTP spec.
        side = SideEffect.READ_ONLY
    elif m == "post" and any(p.startswith(pre) for pre in _READONLY_POST_PREFIXES):
        # A POST on the known read-only analysis allowlist: the body is an input
        # to a pure computation (scrape/extract/intel/seo/...), not a mutation.
        side = SideEffect.READ_ONLY
    else:
        # Phase 5 SAFE DEFAULT: an unfamiliar POST, any PUT/PATCH/DELETE, or an
        # unknown/absent method is EXTERNAL_SIDE_EFFECT (approval-gated, never
        # auto-run) until positively known safe. A POST must never become
        # read-only simply because its path is unfamiliar.
        side = SideEffect.EXTERNAL_SIDE_EFFECT

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
