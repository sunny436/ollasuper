"""The bundled Finance reference corpus + `finance_reference` loader — proves the
stock-analysis depth is PRESERVED (all 27 sector playbooks +
forensic/IPO/report-template/
scoring references load), served section-wise within the tool-result cap. So 'covered'
is
proven, not assumed."""

from __future__ import annotations

from app.finance import references as R

_DOCS = R.list_docs()

# The 27 source sector playbooks (verbatim stems).
_SECTORS = {
    "auto",
    "aviation-hotels",
    "banks",
    "biotech-clinical",
    "chemicals-cement",
    "exchanges-payments",
    "fmcg-consumer",
    "holdco-assetmgr",
    "infra-capitalgoods",
    "insurance",
    "insurance-brokers-services",
    "it-saas",
    "metals-mining",
    "mortgage-reit-specialty-finance",
    "nbfc",
    "oil-gas",
    "people-businesses",
    "pharma-healthcare",
    "rail-freight",
    "realestate-reit",
    "retail-ecommerce",
    "semiconductors",
    "shipping-logistics",
    "telecom-media",
    "utilities-power",
    "waste-environmental",
    "_index",
}
# The mode / methodology references the Equity skill routes to by name.
_KEY_REFS = {
    "equity/06-valuation",
    "equity/11-scoring-rubric",
    "equity/12-report-template",
    "equity/18-forensic-mode",
    "equity/19-ipo-mode",
    "equity/03-earnings-quality",
    "equity/07-forensic-red-flags",
    "equity/13-situations",
}


def test_all_27_sector_playbooks_are_bundled():
    stems = {d.split("/")[-1] for d in _DOCS if d.startswith("equity/sectors/")}
    assert stems == _SECTORS, _SECTORS ^ stems
    assert len([d for d in _DOCS if d.startswith("equity/sectors/")]) == 27


def test_key_methodology_references_present():
    for ref in _KEY_REFS:
        assert ref in _DOCS, ref


def test_corpus_size_and_fpa_saas_refs():
    assert len(_DOCS) >= 50  # 21 equity + 27 sectors + fpa + saas
    assert any(d.startswith("fpa/") for d in _DOCS)
    assert any(d.startswith("saas/") for d in _DOCS)
    assert "references/notice" not in [d.lower() for d in _DOCS]  # NOTICE excluded


def test_every_doc_loads_nonempty_and_bounded():
    for doc in _DOCS:
        out = R.load_reference(doc)
        assert "error" not in out, doc
        assert out["sections"] or out["intro"], doc
        assert len(out.get("intro", "")) <= R.MAX_REF_CHARS + 20, doc


def test_section_retrieval_is_bounded():
    ref = R.load_reference("equity/06-valuation")
    assert ref["sections"]
    sec = R.load_reference("equity/06-valuation", section=ref["sections"][0])
    assert "content" in sec and sec["content"]
    assert len(sec["content"]) <= R.MAX_REF_CHARS + 20


def test_unknown_doc_and_section_error():
    assert "error" in R.load_reference("does/not/exist")
    bad = R.load_reference("equity/sectors/banks", section="zzz-not-a-section-zzz")
    assert "error" in bad and "available_sections" in bad


def test_path_traversal_is_blocked():
    for evil in ("../config", "../../app/config", "equity/../../secrets"):
        assert "error" in R.load_reference(evil), evil
