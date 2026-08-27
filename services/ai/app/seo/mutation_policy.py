"""Phase 7 — the WRITE side of SEO, kept deliberately tiny and separate from the
read-only `capabilities.py`.

A SEO mutation is NEVER auto-run: every write tool is `approval_required=True` +
`EXTERNAL_SIDE_EFFECT` + gated on the `seo:write` permission, so `check_tool_policy`
returns NEEDS_APPROVAL under the interactive `WRITE_SEO_SCOPE` and hard-DENIES under
the default `READ_SCOPE` (missing `seo:write`) — which is why the background audit
agent and the monitoring worker (both read-only scopes) can never reach a write.

No credential / DNS / delete capability exists here: irreversible actions are simply
absent from the allowlist (they would classify HIGH_IMPACT → DENY). Provider-specific
policy (`precheck_mutation`) refuses an off-allowlist target/provider or a
non-reversible action BEFORE any approval is even requested.
"""

from __future__ import annotations

from app.agent.policy import PolicyScope
from app.models.tools import SideEffect

# The ONLY SEO write tool ids that may ever run. Anything else is out of scope.
ALLOWED_WRITE_TOOL_IDS: frozenset[str] = frozenset(
    {
        "seo_update_metadata",
        "seo_update_structured_data",
        "seo_propose_redirect",
        "seo_update_content",
    }
)

# The write permission a mutation turn must be granted. Distinct from `ollagraph:write`
# on purpose — enabling SEO mutations must NOT silently enable every Ollagraph write.
SEO_WRITE_PERMISSION = "seo:write"

# Interactive mutation scope: read (for preview/verify) + seo:write, EXTERNAL ceiling.
# A write tool -> NEEDS_APPROVAL here; an Ollagraph write tool (needs ollagraph:write,
# not granted) still DENIES; HIGH_IMPACT still DENIES. Used ONLY on an interactive chat
# turn behind `ai_seo_mutations_enabled`; NEVER for the audit/monitoring workers.
WRITE_SEO_SCOPE = PolicyScope(
    granted_permissions=frozenset({"ollagraph:read", SEO_WRITE_PERMISSION}),
    max_side_effect=SideEffect.EXTERNAL_SIDE_EFFECT,
)

# Providers we will actually write to. The real site-write provider is a later seam;
# the stub is the only one wired today. An off-list provider is refused pre-approval.
ALLOWED_WRITE_PROVIDERS: frozenset[str] = frozenset({"seo_write"})


def precheck_mutation(
    *, tool_id: str, provider: str, reversibility: str
) -> str | None:
    """Provider-specific policy, enforced BEFORE an approval is requested. Returns a
    refusal reason string, or None if the mutation may proceed to the approval flow.
    A non-reversible action is refused outright (never do the irreversible)."""
    if tool_id not in ALLOWED_WRITE_TOOL_IDS:
        return "tool is not an allowlisted SEO write capability"
    if provider not in ALLOWED_WRITE_PROVIDERS:
        return f"provider '{provider}' is not an allowlisted write provider"
    if reversibility != "reversible":
        return "irreversible actions are not supported"
    return None
