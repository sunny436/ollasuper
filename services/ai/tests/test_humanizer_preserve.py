"""The final validation: a rewrite may change voice, never substance.

This is the test that makes "ZERO fabrication" mean something. Each case takes a
draft, applies one realistic rewrite, and asserts the verifier names exactly what
went wrong — because "something was lost" is not actionable and "the 34% is gone"
is.
"""

from __future__ import annotations

from app.humanizer.preserve import verify

DRAFT = (
    "# How we cut p95 latency by 41%\n\n"
    "In today's digital landscape, the robust platform is not just a cache but a "
    "testament to careful work. We measured 41% lower p95 latency across 1,200 "
    "requests in March 2026, and the team shipped it on 2026-03-14.\n\n"
    "## What the data showed\n\n"
    "Additionally, experts argue that connection reuse matters most. See the "
    "[benchmark writeup](https://example.test/bench) and the raw numbers at "
    "https://example.test/raw.csv for the full picture.[1]\n\n"
    "Run `redis-cli --latency` to reproduce it.\n\n"
    "```python\n"
    "pool = ConnectionPool(max_connections=32)\n"
    "```\n"
)

CLEAN_REWRITE = (
    "# How we cut p95 latency by 41%\n\n"
    "We cut p95 latency by 41% across 1,200 requests in March 2026. The change "
    "shipped on 2026-03-14 and it was mostly connection reuse.\n\n"
    "## What the data showed\n\n"
    "Connection reuse did the work. The [benchmark writeup]"
    "(https://example.test/bench) has the method, and the raw numbers are at "
    "https://example.test/raw.csv.[1]\n\n"
    "Run `redis-cli --latency` to reproduce it.\n\n"
    "```python\n"
    "pool = ConnectionPool(max_connections=32)\n"
    "```\n"
)


def test_a_faithful_rewrite_passes_and_reads_better():
    r = verify(DRAFT, CLEAN_REWRITE, keywords=("p95 latency",))
    assert r["ok"] is True, r["lost"]
    assert r["lost"] == {}
    assert r["added_claims"] == [] and r["added_urls"] == []
    assert r["score_after"] > r["score_before"]
    assert r["improved"] is True


def test_a_dropped_number_is_named():
    r = verify(DRAFT, CLEAN_REWRITE.replace("1,200 requests", "many requests"))
    assert r["ok"] is False
    assert "1200" in r["lost"]["numbers"]


def test_a_dropped_date_is_named():
    r = verify(DRAFT, CLEAN_REWRITE.replace("2026-03-14", "the spring"))
    assert r["ok"] is False
    assert "2026-03-14" in r["lost"]["dates"]


def test_a_reformatted_date_is_not_a_loss():
    """A date is ONE fact. Rendering 2026-03-14 as "14 March 2026" changes the
    voice, not the day — and reporting it as a loss would send the model off to
    "restore" something that never left."""
    r = verify(DRAFT, CLEAN_REWRITE.replace("2026-03-14", "14 March 2026"))
    assert "dates" not in r["lost"]
    assert r["added_claims"] == []


def test_a_dropped_url_is_named():
    r = verify(DRAFT, CLEAN_REWRITE.replace("https://example.test/raw.csv", "the CSV"))
    assert r["ok"] is False
    assert "https://example.test/raw.csv" in r["lost"]["urls"]


def test_an_edited_link_target_is_a_lost_url():
    """Upstream: never alter a link. A changed target is a lost source."""
    r = verify(DRAFT, CLEAN_REWRITE.replace("example.test/bench", "example.test/other"))
    assert r["ok"] is False
    assert any("bench" in u for u in r["lost"]["urls"])


def test_a_dropped_citation_marker_is_named():
    r = verify(DRAFT, CLEAN_REWRITE.replace(".[1]", "."))
    assert r["ok"] is False
    assert "[1]" in r["lost"]["citation_markers"]


def test_an_edited_code_block_is_named():
    r = verify(DRAFT, CLEAN_REWRITE.replace("max_connections=32", "max_connections=64"))
    assert r["ok"] is False
    assert r["lost"]["code"]


def test_dropped_inline_code_is_named():
    r = verify(DRAFT, CLEAN_REWRITE.replace("`redis-cli --latency`", "the CLI"))
    assert r["ok"] is False
    assert any("redis-cli" in c for c in r["lost"]["code"])


def test_a_removed_heading_is_named():
    r = verify(DRAFT, CLEAN_REWRITE.replace("## What the data showed\n\n", ""))
    assert r["ok"] is False
    assert r["lost"]["headings"]


def test_a_recased_heading_is_fine_but_a_repurposed_one_is_not():
    """Upstream §20 allows fixing decorative title case; it does not allow
    changing what the heading is about."""
    ok = verify(
        DRAFT,
        CLEAN_REWRITE.replace("## What the data showed", "## What The Data Showed"),
    )
    assert "headings" not in ok["lost"]
    bad = verify(DRAFT, CLEAN_REWRITE.replace("## What the data showed", "## Pricing"))
    assert bad["lost"]["headings"]


def test_a_lost_keyword_is_named():
    r = verify(
        DRAFT,
        CLEAN_REWRITE.replace("p95 latency", "response time"),
        keywords=("p95 latency",),
    )
    assert r["ok"] is False
    assert "p95 latency" in r["lost"]["keywords"]


def test_a_keyword_absent_from_the_draft_is_not_a_loss():
    """The check is 'the rewrite did not lose it', not 'the writer forgot it'."""
    r = verify(DRAFT, CLEAN_REWRITE, keywords=("kubernetes",))
    assert r["ok"] is True


def test_an_invented_number_is_fabrication():
    r = verify(DRAFT, CLEAN_REWRITE.replace("mostly connection reuse", "a 63% win"))
    assert r["ok"] is False
    assert "63%" in r["added_claims"]  # 63% is not 63


def test_an_invented_source_is_fabrication():
    r = verify(
        DRAFT, CLEAN_REWRITE + "\nAlso see https://invented.test/study for more.\n"
    )
    assert r["ok"] is False
    assert "https://invented.test/study" in r["added_urls"]


def test_the_blog_output_contract_cannot_be_humanized_away():
    before = (
        "# Post\n\nBody text with a claim of 12% growth.\n\n"
        "## OllaSuper Blog Quality Score\n96/100 — Exceptional\n"
        "Quality of this draft — NOT a Google-ranking prediction.\n\n"
        "## Sources & evidence\n- https://example.test/a\n"
    )
    after = "# Post\n\nBody text with a claim of 12% growth.\n"
    r = verify(before, after)
    assert r["ok"] is False
    assert set(r["lost"]["required_blocks"]) == {
        "blog_quality_score",
        "ranking_caption",
        "sources_section",
    }


def test_junk_inputs_are_refused_not_crashed():
    assert "error" in verify("", "x")
    assert "error" in verify("x", "")
    assert "error" in verify(None, "x")  # type: ignore[arg-type]
    assert "error" in verify("x", 3)  # type: ignore[arg-type]


# ===========================================================================
# The second deep pass. Each case below was a MEASURED failure of the shipped
# code before it was fixed — not a hypothetical.
# ===========================================================================
SEO_DRAFT = (
    "# Incident retrospectives that change something\n\n"
    "Incident retrospectives fail when the action items are nobody's job. We "
    "reviewed 40 teams in 2026.\n\n"
    "## What worked\n\n"
    'As one SRE lead said, "we stopped writing action items nobody owns."\n\n'
    "[internal-link: action item tracking -> the ownership guide]\n\n"
    "![alt: a retrospective board with owners](image-placeholder)\n"
)


def test_a_keyword_moved_out_of_the_title_is_a_seo_loss():
    """Present elsewhere is not preserved: SEO weight sits in the title."""
    moved = SEO_DRAFT.replace(
        "# Incident retrospectives that change something",
        "# Meetings that change something",
    ).replace("We reviewed", "Incident retrospectives matter. We reviewed")
    r = verify(SEO_DRAFT, moved, keywords=("incident retrospectives",))
    assert r["ok"] is False
    assert "incident retrospectives (first heading)" in r["lost"]["keyword_placement"]


def test_a_keyword_moved_out_of_the_opening_paragraph_is_a_seo_loss():
    moved = SEO_DRAFT.replace(
        "Incident retrospectives fail when the action items are nobody's job.",
        "Follow-ups fail when nobody owns them.",
    ).replace("## What worked\n\n", "## What worked\n\nIncident retrospectives. ")
    r = verify(SEO_DRAFT, moved, keywords=("incident retrospectives",))
    assert (
        "incident retrospectives (opening paragraph)" in r["lost"]["keyword_placement"]
    )


def test_a_dropped_internal_link_marker_is_named():
    r = verify(
        SEO_DRAFT,
        SEO_DRAFT.replace(
            "[internal-link: action item tracking -> the ownership guide]", ""
        ),
    )
    assert r["ok"] is False and r["lost"]["internal_links"]


def test_a_dropped_image_placeholder_is_named():
    r = verify(
        SEO_DRAFT,
        SEO_DRAFT.replace(
            "![alt: a retrospective board with owners](image-placeholder)", ""
        ),
    )
    assert r["ok"] is False and r["lost"]["image_placeholders"]


def test_a_paraphrased_quotation_is_a_fabricated_quote():
    r = verify(
        SEO_DRAFT,
        SEO_DRAFT.replace(
            "we stopped writing action items nobody owns.",
            "we no longer write unowned action items.",
        ),
    )
    assert r["ok"] is False and r["lost"]["quotations"]


def test_straightening_curly_quotes_is_not_a_lost_quotation():
    """The humanizer's own §21 converts curly quotes. A verbatim check that did
    not normalise would reject exactly the edit the stage recommends."""
    curly = SEO_DRAFT.replace(
        '"we stopped writing action items nobody owns."',
        "“we stopped writing action items nobody’s owns.”",
    )
    straight = curly.replace("“", '"').replace("”", '"').replace("’", "'")
    r = verify(curly, straight)
    assert "quotations" not in r["lost"], r["lost"]


def test_the_seo_draft_rewritten_faithfully_passes_every_new_check():
    faithful = SEO_DRAFT.replace(
        "We reviewed 40 teams in 2026.", "We looked at 40 teams in 2026."
    )
    r = verify(SEO_DRAFT, faithful, keywords=("incident retrospectives",))
    assert r["ok"] is True, r["lost"]


# ------------------------------------------ Marketing's evidence contract
MARKETING = (
    "## \U0001f7e2 What the data shows\n\n"
    "**FACT:** Churn fell to 3.1% in Q3 \U0001f7e2 verified (Stripe export).\n\n"
    "**INFERENCE:** The drop likely follows the onboarding change "
    "\U0001f7e1 estimate.\n\n"
    "**ASSUMPTION:** Seasonality is flat \U0001f534 assumed.\n\n"
    "**RECOMMENDATION:** Extend the onboarding flow to the enterprise tier.\n"
)


def test_stripping_the_evidence_labels_is_refused():
    stripped = MARKETING
    for label in (
        "**FACT:** ",
        "**INFERENCE:** ",
        "**ASSUMPTION:** ",
        "**RECOMMENDATION:** ",
    ):
        stripped = stripped.replace(label, "")
    r = verify(MARKETING, stripped)
    assert r["ok"] is False
    assert len(r["lost"]["evidence_labels"]) == 4


def test_upgrading_an_assumption_to_verified_is_fabrication():
    """Measured before the fix: this passed with ok=true, lost={}. Promoting
    "assumed" to "verified" invents evidence."""
    upgraded = MARKETING.replace("\U0001f534 assumed", "\U0001f7e2 verified")
    r = verify(MARKETING, upgraded)
    assert r["ok"] is False
    assert r["lost"]["evidence_tags"] == ["\U0001f534 x1"]
    assert any("verified" in c for c in r["added_claims"])


def test_an_honest_marketing_rewrite_keeps_labels_and_tags_and_passes():
    honest = MARKETING.replace(
        "The drop likely follows the onboarding change",
        "The onboarding change probably drove it",
    )
    r = verify(MARKETING, honest)
    assert r["ok"] is True, (r["lost"], r["added_claims"])
