"""Harmony tool-call leak recovery — tested against the EXACT strings gpt-5.6-luna
leaked into prod SEO reports (see app/agent/harmony.py)."""

from __future__ import annotations

from app.agent.harmony import (
    HarmonyStreamFilter,
    parse_harmony_calls,
    recover_into_message,
)


class _Msg:
    """Minimal AIMessage stand-in (content + tool_calls attrs)."""

    def __init__(self, content: str, tool_calls=None):
        self.content = content
        self.tool_calls = tool_calls or []


# --- no marker => exact no-op ------------------------------------------------
def test_plain_text_is_untouched():
    text = "Here is a normal answer with a canonical tag <link rel=\"canonical\">."
    calls, cleaned = parse_harmony_calls(text)
    assert calls == []
    assert cleaned == text


def test_recover_is_noop_without_marker():
    m = _Msg("A perfectly normal reply.")
    assert recover_into_message(m) is False
    assert m.content == "A perfectly normal reply." and m.tool_calls == []


# --- clean `code:` variant (this is what broke the full audit) ---------------
CODE_LEAK = (
    "I'm proceeding with the foundation checks while the crawl is prepared. "
    "to=functions.find_capabilities code:\n"
    '{"query":"robots sitemap metadata"}\n'
    "to=functions.scrape_endpoint_v1_scrape_post code:\n"
    '{"url":"https://www.networkershome.com/","format":"html","timeout":30}\n'
    "to=functions.batch_scrape_endpoint_v1_scrape_batch_post code:\n"
    '{"urls":["https://www.networkershome.com/robots.txt"],"format":"html"}\n\n'
    "SEO Audit — networkershome.com\n\nVerdict: strong fundamentals."
)


def test_code_variant_recovers_all_calls_and_keeps_report():
    calls, cleaned = parse_harmony_calls(CODE_LEAK)
    names = [c["name"] for c in calls]
    assert names == [
        "find_capabilities",
        "scrape_endpoint_v1_scrape_post",
        "batch_scrape_endpoint_v1_scrape_batch_post",
    ]
    assert calls[0]["args"] == {"query": "robots sitemap metadata"}
    assert calls[1]["args"]["url"] == "https://www.networkershome.com/"
    assert calls[2]["args"]["urls"] == ["https://www.networkershome.com/robots.txt"]
    # The narration and the real report survive; the leak spans are gone.
    assert cleaned.startswith("I'm proceeding with the foundation checks")
    assert "SEO Audit — networkershome.com" in cleaned
    assert "Verdict: strong fundamentals." in cleaned
    assert "to=functions." not in cleaned
    assert "code:" not in cleaned


# --- messy `(json` + garbage + triple-repeat (from the technical-only run) ---
MESSY_LEAK = (
    "I'm checking the HTTP→HTTPS path as well. "
    "to=functions.seo_redirect_chain_endpoint_v1_seo_redirect_chain_map_post (json天天中奖 "  # noqa: E501
    "to=functions.seo_redirect_chain_endpoint_v1_seo_redirect_chain_map_post (json Timbhoni geschniegelt\n"  # noqa: E501
    '{"url":"http://www.networkershome.com/"}\n'
    "to=functions.seo_redirect_chain_endpoint_v1_seo_redirect_chain_map_post (json"
    "# Technical SEO Audit — networkershome.com\n\n"
    "⚠️ Potential crawl blocker: the robots check reported the homepage as disallowed."
)


def test_messy_variant_recovers_once_and_never_eats_the_report():
    calls, cleaned = parse_harmony_calls(MESSY_LEAK)
    # Exactly one real call recovered (the two arg-less fragments are dropped).
    assert len(calls) == 1
    assert calls[0]["name"] == (
        "seo_redirect_chain_endpoint_v1_seo_redirect_chain_map_post"
    )
    assert calls[0]["args"] == {"url": "http://www.networkershome.com/"}
    # The report heading glued onto `(json#` MUST survive intact.
    assert "# Technical SEO Audit — networkershome.com" in cleaned
    assert "⚠️ Potential crawl blocker" in cleaned
    assert cleaned.startswith("I'm checking the HTTP→HTTPS path as well.")
    # The leak markers and the CJK/garbage tokens are gone.
    assert "to=functions." not in cleaned
    assert "天天中奖" not in cleaned
    assert "Timbhoni" not in cleaned


# --- multi_tool_use.parallel wrapper -----------------------------------------
PARALLEL_LEAK = (
    "Running independent checks in parallel. "
    "multi_tool_use.parallel (json {\"tool_uses\":["
    '{"recipient_name":"functions.intel_robots_endpoint","parameters":{"url":"https://x.com"}},'
    '{"recipient_name":"functions.intel_headers_endpoint","parameters":{"url":"https://x.com"}}'
    "]})\n\nDone."
)


def test_parallel_wrapper_expands_to_each_call():
    calls, cleaned = parse_harmony_calls(PARALLEL_LEAK)
    assert [c["name"] for c in calls] == [
        "intel_robots_endpoint",
        "intel_headers_endpoint",
    ]
    assert all(c["args"] == {"url": "https://x.com"} for c in calls)
    assert "multi_tool_use.parallel" not in cleaned
    assert cleaned.startswith("Running independent checks in parallel.")
    assert "Done." in cleaned


# --- recover_into_message wiring + dedup -------------------------------------
def test_recover_into_message_sets_tool_calls_and_cleans_content():
    m = _Msg(CODE_LEAK)
    assert recover_into_message(m) is True
    assert len(m.tool_calls) == 3
    assert "to=functions." not in m.content
    assert "SEO Audit — networkershome.com" in m.content


def test_recover_dedups_against_a_real_call():
    # The model made find_capabilities properly AND leaked the same call as text.
    real = {
        "name": "find_capabilities",
        "args": {"query": "robots sitemap metadata"},
        "id": "real1",
        "type": "tool_call",
    }
    m = _Msg(CODE_LEAK, tool_calls=[real])
    recover_into_message(m)
    fc = [c for c in m.tool_calls if c["name"] == "find_capabilities"]
    assert len(fc) == 1  # not run twice


# --- truncated/unbalanced JSON is stripped, not half-emitted ------------------
def test_truncated_json_is_dropped_cleanly():
    text = 'Working. to=functions.scrape_endpoint code:\n{"url":"https://x.com","for'
    calls, cleaned = parse_harmony_calls(text)
    assert calls == []  # never closed → not recovered
    assert "to=functions." not in cleaned
    assert cleaned.startswith("Working.")


# --- stream filter: same result whether whole or char-by-char ----------------
def _drive(chunks):
    f = HarmonyStreamFilter()
    out = "".join(f.feed(c) for c in chunks)
    return out + f.flush()


def test_stream_filter_whole_chunk_matches_parser():
    assert _drive([MESSY_LEAK]) == parse_harmony_calls(MESSY_LEAK)[1]


def test_stream_filter_is_split_robust():
    whole = _drive([CODE_LEAK])
    per_char = _drive(list(CODE_LEAK))
    assert whole == per_char == parse_harmony_calls(CODE_LEAK)[1]
    assert "to=functions." not in per_char


def test_stream_filter_passes_clean_text_through_promptly():
    f = HarmonyStreamFilter()
    # No marker → emitted immediately (minus at most a partial-marker tail).
    s = "The canonical tag tells Google "
    assert f.feed(s) == s
    assert f.flush() == ""
