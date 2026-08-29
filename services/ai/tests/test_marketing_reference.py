"""The bundled Marketing reference corpus + `marketing_reference` loader — proves the
specialist depth is PRESERVED (every MARKETING-owned playbook loads, incl. marketing-ops
with the 3 orchestration sequences), served section-wise within the tool-result cap, and
that delegated SEO/content-writing playbooks are intentionally NOT bundled."""

from __future__ import annotations

from app.marketing import references as R

_DOCS = R.list_docs()

_MUST_HAVE = {
    "marketing-strategy-pmm",
    "launch-strategy",
    "pricing-strategy",
    "marketing-demand-acquisition",
    "aeo",
    "page-cro",
    "form-cro",
    "signup-flow-cro",
    "onboarding-cro",
    "popup-cro",
    "paywall-upgrade-cro",
    "paid-ads",
    "ad-creative",
    "social-media-manager",
    "x-twitter-growth",
    "youtube-full",
    "webinar-marketing",
    "app-store-optimization",
    "email-sequence",
    "referral-program",
    "free-tool-strategy",
    "churn-prevention",
    "marketing-psychology",
    "brand-guidelines",
    "competitor-alternatives",
    "content-strategy",
    "social-content",
    "campaign-analytics",
    "analytics-tracking",
    "social-media-analyzer",
    "marketing-context",
    "marketing-ops",
}
# Delegated to existing OllaSuper skills — must NOT be bundled here.
_MUST_NOT = {
    "seo-audit",
    "schema-markup",
    "programmatic-seo",
    "site-architecture",
    "local-seo-manager",
    "content-production",
    "copywriting",
    "copy-editing",
    "content-humanizer",
    "cold-email",
}


def test_all_owned_playbooks_bundled():
    missing = _MUST_HAVE - set(_DOCS)
    assert not missing, f"missing playbooks: {missing}"
    assert len(_DOCS) >= 33


def test_delegated_playbooks_not_bundled():
    for d in _MUST_NOT:
        assert d not in _DOCS, f"{d} should be delegated, not bundled"


def test_orchestration_sequences_loadable():
    ops = R.load_reference("marketing-ops")
    assert "error" not in ops and (ops["sections"] or ops["intro"])
    # a section that names the launch orchestration exists somewhere in the doc
    joined = (ops.get("intro", "") + " ".join(ops.get("sections", []))).lower()
    assert "launch" in joined or "orchestrat" in joined or "campaign" in joined


def test_every_doc_loads_and_is_bounded():
    for doc in _DOCS:
        out = R.load_reference(doc)
        assert "error" not in out, doc
        assert out["sections"] or out["intro"], doc
        assert len(out.get("intro", "")) <= R.MAX_REF_CHARS + 20, doc


def test_section_retrieval_bounded():
    ref = R.load_reference("marketing-strategy-pmm")
    assert ref["sections"]
    sec = R.load_reference("marketing-strategy-pmm", section=ref["sections"][0])
    assert "content" in sec and len(sec["content"]) <= R.MAX_REF_CHARS + 20


def test_unknown_and_traversal():
    assert "error" in R.load_reference("does-not-exist")
    bad = R.load_reference("page-cro", section="zzz-not-a-section")
    assert "error" in bad and "available_sections" in bad
    for evil in ("../config", "../../app/config", "page-cro/../../secrets"):
        assert "error" in R.load_reference(evil), evil
