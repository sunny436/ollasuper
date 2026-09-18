"""Web search — the half of it OllaSuper controls.

Every expectation here was taken from the LIVE provider on 17-09-2026, not from
the tester's prose:

  * `/v1/search` accepts `lang`/`region` and this codebase never set either; an
    English query came back with a Spanish result.
  * `"zqzqxqxqzq asdfghjk"` returned 11 unrelated results (YouTube, TikTok,
    Instagram) and no zero-result signal of any kind.
  * results carry opaque `https://www.google.com/goto?url=CAESYgHr…` wrappers; a
    HEAD on one returns 200 with no Location, so the canonical URL is NOT
    recoverable — it may be marked, never rewritten into a guess.
  * `engines_failed` is populated on nearly every call (duckduckgo http_503)
    while the merged results are fine, so a partial engine failure must NOT be
    escalated — that would warn on almost every answer.
"""

from __future__ import annotations

from app.agent.search_guard import (
    canonical_url,
    empty_query,
    is_search_tool,
    prepare_args,
    process_result,
)

SEARCH_ID = "search_endpoint_v1_search_post"


def payload(*results, **extra):
    return {
        "status": "success",
        "count": len(results),
        "results": list(results),
        **extra,
    }


def hit(url="https://en.wikipedia.org/wiki/Nvidia", title="Nvidia", snippet=""):
    return {"title": title, "url": url, "snippet": snippet, "rank": 1}


# --------------------------------------------------------------- tool gating
def test_only_the_search_tool_is_touched():
    assert is_search_tool(SEARCH_ID)
    assert not is_search_tool("seo_broken_links_endpoint_v1_seo_broken_links_post")
    assert not is_search_tool("scrape_endpoint_v1_scrape_post")


# ------------------------------------------------------------ request fields
def test_lang_is_filled_when_the_model_omits_it():
    args, changed = prepare_args(
        {"query": "who founded Nvidia"}, response_language="EN"
    )
    assert args["lang"] == "EN"
    assert changed == {"lang": "EN"}


def test_an_explicit_lang_is_never_overridden():
    args, changed = prepare_args(
        {"query": "quién fundó Nvidia", "lang": "ES"}, response_language="EN"
    )
    assert args["lang"] == "ES"
    assert changed == {}


def test_auto_means_leave_it_to_the_provider():
    args, changed = prepare_args({"query": "hello"}, response_language="auto")
    assert "lang" not in args and changed == {}


def test_region_is_never_invented():
    """Nothing in the request carries a country. Guessing one is the same class
    of failure this whole change exists to stop."""
    args, _ = prepare_args({"query": "plumbers near me"}, response_language="EN")
    assert "region" not in args


def test_the_original_args_are_not_mutated():
    original = {"query": "x"}
    prepare_args(original, response_language="EN")
    assert original == {"query": "x"}


# ------------------------------------------------------------- empty queries
def test_a_punctuation_only_query_is_refused_before_the_provider():
    assert empty_query({"query": "! @ # $ % ^ & * ( )"})
    assert empty_query({"query": "   "})


def test_a_real_query_is_never_refused():
    assert not empty_query({"query": "who founded Nvidia"})
    assert not empty_query({"query": "C++17"})
    assert not empty_query({"query": "北京 天気"})  # non-latin is searchable


# ------------------------------------------------------------------- the URLs
def test_tracking_params_are_stripped():
    url, redirect = canonical_url(
        "https://example.com/post?utm_source=x&utm_medium=y&id=7&fbclid=z"
    )
    assert url == "https://example.com/post?id=7"
    assert redirect is False


def test_a_clean_url_is_untouched():
    assert canonical_url("https://en.wikipedia.org/wiki/Nvidia") == (
        "https://en.wikipedia.org/wiki/Nvidia",
        False,
    )


def test_an_opaque_redirect_is_marked_not_rewritten():
    src = "https://www.google.com/goto?url=CAESYgHrOzAViTFB6aYVHtulnLiImSrIBZAV"
    url, redirect = canonical_url(src)
    assert redirect is True
    assert url == src  # NOT guessed at — the target is not in the URL


def test_the_redirect_marking_reaches_the_result():
    out, _ = process_result(
        payload(hit(url="https://www.google.com/goto?url=CAESYgHr", title="Nvidia")),
        {"query": "nvidia"},
    )
    assert out["results"][0]["redirect"] is True
    assert "canonical URL unknown" in out["results"][0]["url_note"]


# ------------------------------------------------------------------ relevance
def test_gibberish_with_unrelated_results_is_reported_as_nothing_found():
    out, nothing = process_result(
        payload(
            hit(url="https://www.youtube.com/watch?v=x", title="Funny cat video"),
            hit(url="https://www.tiktok.com/@a/video/1", title="Dance trend"),
        ),
        {"query": "zqzqxqxqzq asdfghjk"},
    )
    assert nothing is True
    assert out["relevance"] == "none"
    assert len(out["results"]) == 2  # annotated, never dropped


def test_a_matching_result_is_not_flagged():
    out, nothing = process_result(
        payload(hit(title="Nvidia - Wikipedia", snippet="Nvidia was founded in 1993")),
        {"query": "who founded Nvidia"},
    )
    assert nothing is False
    assert "relevance" not in out
    assert out["results"][0]["matches_query"] is True


def test_zero_results_is_reported_as_nothing_found():
    out, nothing = process_result(payload(), {"query": "anything"})
    assert nothing is True and out["relevance"] == "none"


def test_partial_engine_failure_alone_is_not_escalated():
    """duckduckgo 503s on nearly every live call while the merged results are
    fine; escalating that would put a warning on almost every answer."""
    out, nothing = process_result(
        payload(
            hit(title="Nvidia - Wikipedia", snippet="founded 1993"),
            engines_used=["bing", "google"],
            engines_failed=[{"engine": "duckduckgo", "error": "http_503"}],
        ),
        {"query": "who founded Nvidia"},
    )
    assert nothing is False
    assert "relevance" not in out
    assert out["engines_failed"] == [{"engine": "duckduckgo", "error": "http_503"}]


def test_results_keep_their_order_and_fields():
    first = hit(title="Nvidia one", snippet="nvidia")
    second = hit(url="https://nvidia.com", title="Nvidia two", snippet="nvidia")
    out, _ = process_result(payload(first, second), {"query": "nvidia"})
    assert [r["title"] for r in out["results"]] == ["Nvidia one", "Nvidia two"]
    assert out["results"][0]["rank"] == 1


def test_a_non_search_payload_is_passed_through():
    assert process_result({"data": "something else"}, {"query": "x"}) == (
        {"data": "something else"},
        False,
    )


# --------------------------------------------------- language without a stated one
# responseLanguage defaults to "auto", so filling `lang` only from the stated
# preference would leave the measured failure (an English query answered with
# Spanish results) unfixed for almost every user.


def test_an_english_query_sets_lang_even_with_no_preference():
    args, changed = prepare_args(
        {"query": "who founded Nvidia"}, response_language=None
    )
    assert args["lang"] == "EN" and changed == {"lang": "EN"}


def test_the_stated_preference_still_wins_over_detection():
    args, _ = prepare_args({"query": "who founded Nvidia"}, response_language="DE")
    assert args["lang"] == "DE"


def test_a_non_english_query_is_left_to_the_provider():
    for q in ["quién fundó Nvidia", "北京 天気 予報", "meilleur hôtel à Paris"]:
        args, changed = prepare_args({"query": q}, response_language=None)
        assert "lang" not in args, q
        assert changed == {}


def test_a_query_with_no_grammatical_evidence_is_left_alone():
    """"nvidia stock price" is not evidence of a language — three nouns."""
    args, _ = prepare_args({"query": "nvidia stock price"}, response_language=None)
    assert "lang" not in args


def test_a_single_token_is_never_labelled():
    args, _ = prepare_args({"query": "nvidia"}, response_language=None)
    assert "lang" not in args
