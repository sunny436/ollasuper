"""Human-readable tool labels for the execution-status pill (app/agent/tool_labels.py).
Curated phrase → verb derivation → cleaned fallback. Never raw, never raises."""

from __future__ import annotations

from app.agent.tool_labels import action_label


def test_curated_covers_current_tools_via_short_name():
    assert action_label("search_endpoint") == "Searching the web"
    assert action_label("crawl_endpoint") == "Crawling the website"
    assert action_label("seo_meta_audit_endpoint") == "Auditing page metadata"
    assert action_label("seo_schema_validate_endpoint") == "Validating structured data"
    assert action_label("intel_robots_endpoint") == "Checking robots.txt"
    assert action_label("seo_keyword_extract_endpoint") == "Extracting keywords"
    assert action_label("seo_broken_links_endpoint") == "Checking for broken links"


def test_curated_matches_the_long_operation_id_too():
    # The real op_id carries a version/method tail; it must normalize to the same key.
    long_id = "seo_redirect_chain_endpoint_v1_seo_redirect_chain_map_post"
    assert action_label(long_id, long_id) == "Mapping redirects"
    assert (
        action_label("Seo Redirect Chain Endpoint", long_id) == "Mapping redirects"
    )


def test_reserved_builtins_have_friendly_labels():
    assert (
        action_label("search_knowledge", "search_knowledge")
        == "Reading your documents"
    )
    assert action_label("generate_file", "generate_file") == "Generating a file"
    assert action_label("find_capabilities") == "Finding the right tools"


def test_unknown_tool_derives_a_verb_phrase_never_raw():
    # No curated entry → verb-family derivation, endpoint/provider noise stripped.
    lbl = action_label("acme_price_lookup_endpoint")
    assert "endpoint" not in lbl.lower()
    assert lbl.lower().startswith("searching")  # 'lookup' → Searching
    # A verb-less unknown → cleaned "Running <Nice Name>", still never raw.
    lbl2 = action_label("quantum_flux_endpoint")
    assert lbl2 == "Running Quantum Flux"
    assert "endpoint" not in lbl2.lower()


def test_never_raises_and_never_empty():
    for bad in ("", None):
        out = action_label(bad or "", bad)  # type: ignore[arg-type]
        assert isinstance(out, str) and out
