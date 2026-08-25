"""Deterministic, provider-agnostic tool discovery / selection (Phase 2).

Answers ONE question — "which available tools are most relevant to this
request?" — and returns metadata only. It NEVER executes a tool, never calls a
provider for a user request, and is not connected to the LLM/LangGraph.

Two layers:
  * Layer 1 — metadata filter (availability/enabled/category/provider/side_effect).
  * Layer 2 — deterministic lexical ranking (weighted token overlap over the
    tool name/path/category/description), normalized to [0,1].

Ranking is a single function so a future semantic `EmbeddingScorer` can be added
as one more signal without restructuring (Layer 3, documented, not implemented).
No new dependencies; scoring 223 cached token-sets is sub-millisecond.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from time import perf_counter

from app.logging import get_logger
from app.models.tools import (
    Availability,
    SideEffect,
    ToolCandidate,
    ToolDefinition,
    ToolFilters,
    ToolSelectionResult,
)
from app.tools.registry import ToolRegistry

log = get_logger(__name__)

DEFAULT_TOP_K = 5
MAX_TOP_K = 25
DEFAULT_MIN_SCORE = 0.2

# Field weights sum to 1 so the base score is normalized to [0,1]. Name and
# path carry the most signal (Ollagraph paths are semantic: /v1/seo/broken-links-audit).
_W_NAME, _W_PATH, _W_CAT, _W_DESC = 0.35, 0.35, 0.15, 0.15
_NAME_EXACT_BONUS = 0.15

# Generic words that carry no tool-selection signal. Deliberately EXCLUDES tool
# verbs (search/scrape/extract/crawl/convert/...) which are highly selective.
_STOPWORDS = frozenset(
    """a an the this that these those of to in on for and or with without within
    is are was were be been being do does did doing please i we you it me us them
    my your our their its what which who whom how can could would should will
    now today from at by as into about over under between out up down want need
    give show tell find get list all any some more most new latest current""".split()
)
# Tokens common to every path/spec; never selective.
_NOISE = frozenset({"v1", "v2", "api", "http", "https", "www", "com"})

_SIDE_EFFECT_RANK = {
    SideEffect.READ_ONLY: 0,
    SideEffect.EXTERNAL_SIDE_EFFECT: 1,
    SideEffect.HIGH_IMPACT: 2,
}


def _tokenize(text: str) -> set[str]:
    """Lowercase, split on all non-alphanumerics, drop stopwords/noise/short
    tokens, and singularize a trailing 's'. Deterministic and cheap."""
    out: set[str] = set()
    for w in re.findall(r"[a-z0-9]+", (text or "").lower()):
        if len(w) <= 1 or w in _STOPWORDS or w in _NOISE:
            continue
        if len(w) > 3 and w.endswith("s"):
            w = w[:-1]
        out.add(w)
    return out


# QUERY-SIDE ONLY alias map: user vocabulary -> the canonical verb that actually
# appears in Ollagraph tool metadata. The deterministic ranker is exact-lexical
# (Layer 2), and the Ollagraph spec is sparse (the scrape tool's only token is
# "scrape"), so a request that avoids the exact keyword — "fetch the page",
# "grab the text" — matched nothing. This bridges the common synonyms without a
# semantic model. Keys are already post-_tokenize (lowercased, singularized).
# It NEVER touches the tool index and only ADDS query tokens, so it cannot
# surface a disabled/unauthorized tool (those are filtered before scoring) and
# cannot lower an exact query's score (the name-exact bonus keys off the
# ORIGINAL tokens — see _score_entry). Typos are deliberately out of scope.
_SYNONYMS = {
    # -> scrape (fetch web content)
    "fetch": "scrape", "grab": "scrape", "pull": "scrape", "download": "scrape",
    "retrieve": "scrape", "scraping": "scrape",
    # -> crawl
    "spider": "crawl", "crawling": "crawl",
    # -> extract
    "parse": "extract", "parsing": "extract", "extraction": "extract",
    # -> search
    "lookup": "search", "google": "search",
    # -> convert
    "transform": "convert", "conversion": "convert",
    # -> audit (SEO/AEO page analysis)
    "analyze": "audit", "analyse": "audit", "inspect": "audit", "examine": "audit",
}


def _expand_synonyms(q: set[str]) -> set[str]:
    """Add canonical aliases for any query token that has one. Additive only."""
    extra = {_SYNONYMS[w] for w in q if w in _SYNONYMS}
    return q | extra if extra else q


@dataclass(slots=True)
class _Entry:
    tool: ToolDefinition
    name_toks: set[str]
    path_toks: set[str]
    cat_toks: set[str]
    desc_toks: set[str]


class ToolSearchIndex:
    """Per-tool tokenized fields, built ONCE from a registry snapshot. Cached by
    the caller and rebuilt only when `registry.version` changes."""

    def __init__(self, tools: list[ToolDefinition]) -> None:
        self.entries: list[_Entry] = [
            _Entry(
                tool=t,
                name_toks=_tokenize(t.name) | _tokenize(t.tool_id),
                path_toks=_tokenize(t.path),
                cat_toks=_tokenize(t.category),
                desc_toks=_tokenize(t.description),
            )
            for t in tools
        ]


def _overlap(q: set[str], field: set[str]) -> float:
    # Overlap coefficient (÷ the SMALLER set), not recall (÷|q|). Tool name/path/
    # category fields are short; dividing by the verbose query length structurally
    # capped every score below min_score for real multi-word requests — "scrape
    # this url and extract the page content" scored the scrape tool ~0.12 on
    # name+path, under the 0.2 floor, so a 111-tool pool yielded n_scored:0 and the
    # agent saw no tools at all. Normalizing by the smaller set scores a tool by how
    # well its own fields are covered, independent of how many extra words the user
    # typed, so a fully-matched short field (path {scrape}) reads as a strong signal.
    return len(q & field) / min(len(q), len(field)) if q and field else 0.0


def _score_entry(
    q: set[str], e: _Entry, q_exact: set[str] | None = None
) -> tuple[float, list[str], str]:
    n = _overlap(q, e.name_toks)
    p = _overlap(q, e.path_toks)
    c = _overlap(q, e.cat_toks)
    d = _overlap(q, e.desc_toks)
    score = _W_NAME * n + _W_PATH * p + _W_CAT * c + _W_DESC * d

    signals: list[str] = []
    if n:
        signals.append("name")
    if p:
        signals.append("path")
    if c:
        signals.append("category")
    if d:
        signals.append("description")
    # Every query term present in the tool name/id is a strong, precise match.
    # Keyed off the ORIGINAL (un-expanded) tokens so synonym expansion can only
    # add candidates, never demote an exact query by widening its token set.
    exact = q_exact if q_exact is not None else q
    if exact and exact <= e.name_toks:
        score += _NAME_EXACT_BONUS
        signals.append("name_exact")

    score = min(1.0, score)
    reason = "matched " + ", ".join(signals) if signals else "no field match"
    return score, signals, reason


def _passes(tool: ToolDefinition, f: ToolFilters) -> bool:
    if not f.include_unavailable and tool.availability != Availability.AVAILABLE:
        return False
    if not f.include_disabled and not tool.enabled:
        return False
    if f.categories and tool.category not in f.categories:
        return False
    if f.providers and tool.provider not in f.providers:
        return False
    if f.max_side_effect is not None and _SIDE_EFFECT_RANK.get(
        tool.side_effect, 0
    ) > _SIDE_EFFECT_RANK.get(f.max_side_effect, 2):
        return False
    # Phase 5: a tool the caller lacks the permission to run is never ranked/bound
    # (execution still re-checks via check_tool_policy — this only avoids offering
    # it). A tool with no required_permissions is unaffected.
    if f.granted_permissions is not None:
        required = set(tool.permissions.required_permissions)
        if required and not required <= f.granted_permissions:
            return False
    return True


class ToolSelector:
    """Holds a registry + a cached search index. Provider-agnostic: depends only
    on ToolRegistry/ToolDefinition."""

    def __init__(self, registry: ToolRegistry) -> None:
        self._registry = registry
        self._index: ToolSearchIndex | None = None
        self._index_version = -1

    def _index_now(self) -> ToolSearchIndex:
        # Single event loop (uvicorn --workers 1) → no lock needed; a rare
        # duplicate rebuild is idempotent.
        v = self._registry.version
        if self._index is None or self._index_version != v:
            self._index = ToolSearchIndex(self._registry.list())
            self._index_version = v
        return self._index

    def select(
        self,
        query: str,
        *,
        top_k: int | None = None,
        filters: ToolFilters | None = None,
        min_score: float | None = None,
    ) -> ToolSelectionResult:
        t0 = perf_counter()
        filters = filters or ToolFilters()
        k = max(1, min(top_k or DEFAULT_TOP_K, MAX_TOP_K))
        threshold = DEFAULT_MIN_SCORE if min_score is None else min_score

        index = self._index_now()
        pool = [e for e in index.entries if _passes(e.tool, filters)]
        t_filter = perf_counter()

        q_exact = _tokenize(query)
        q = _expand_synonyms(q_exact)
        scored: list[ToolCandidate] = []
        for e in pool:
            score, signals, reason = _score_entry(q, e, q_exact)
            if score >= threshold:
                scored.append(
                    ToolCandidate(
                        tool=e.tool,
                        score=round(score, 4),
                        matched_signals=signals,
                        reason=reason,
                    )
                )
        # Deterministic: score desc, then tool_id asc for stable ordering.
        scored.sort(key=lambda c: (-c.score, c.tool.tool_id))
        top = scored[:k]
        t_rank = perf_counter()

        no_match = len(top) == 0
        stats = {
            "n_total": len(index.entries),
            "n_filtered": len(pool),
            "n_scored": len(scored),
            "returned": len(top),
            "top_k": k,
            "min_score": threshold,
            "filter_ms": round((t_filter - t0) * 1000, 3),
            "rank_ms": round((t_rank - t_filter) * 1000, 3),
        }
        log.info(
            "tool.discovery.request",
            extra={
                "top_k": k,
                "n_filtered": len(pool),
                "n_candidates": len(scored),
                "returned": len(top),
                "no_match": no_match,
                "filter_ms": stats["filter_ms"],
                "rank_ms": stats["rank_ms"],
            },
        )
        log.debug("tool.discovery.query", extra={"query": query})
        return ToolSelectionResult(
            query=query, candidates=top, no_match=no_match, stats=stats
        )


def discover_tools(
    registry: ToolRegistry,
    query: str,
    *,
    top_k: int | None = None,
    filters: ToolFilters | None = None,
    min_score: float | None = None,
) -> ToolSelectionResult:
    """Convenience wrapper matching the requested interface. Builds a one-shot
    selector (no cross-call index cache) — for tests/scripts. The route uses a
    cached `ToolSelector` on app.state."""
    return ToolSelector(registry).select(
        query, top_k=top_k, filters=filters, min_score=min_score
    )
