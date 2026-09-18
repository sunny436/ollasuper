"""What OllaSuper can fix about web search — which is the request and the results,
not the engines.

MEASURED against the live provider (`api.ollagraph.com/v1/search`, 17-09-2026),
because the tester report and the code disagreed in both directions:

  * `engines_failed` comes back populated on nearly every call — duckduckgo
    `http_503` almost always, google `http_502` intermittently — and the provider
    still returns merged results from whatever is healthy. Engine health is NOT
    ours to fix, and flagging every partial failure would put a warning on almost
    every answer. So partial failure is left alone; only an EMPTY result set is
    reported upward.
  * The request accepts `lang` and `region`, and nothing in this codebase ever set
    them. An English query returned a Spanish result. `lang` is set here.
    `region` is NOT: nothing in the request carries a country, and inventing one
    is the same class of failure being fixed.
  * Results carry google `…/goto?url=CAESYgHr…` wrappers whose payload is opaque;
    a HEAD returns 200 with no Location, so the canonical URL cannot be recovered
    without fetching each one. They are MARKED, never rewritten into a guess.
  * A gibberish query ("zqzqxqxqzq asdfghjk") returned 11 unrelated results with
    no zero-result signal, which is what made the model narrate rank #1.

Every transform here is ADDITIVE and reversible: results are annotated, never
dropped or reordered, so a ranking the provider got right is untouched.
"""

from __future__ import annotations

import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

#: The provider's web-search operation. Gated on this id so no other tool is
#: touched by any of the logic in this module.
SEARCH_TOOL_IDS = frozenset({"search_endpoint_v1_search_post"})

#: Params that identify a campaign/click, never a document.
_TRACKING = re.compile(
    r"^(utm_[a-z_]+|fbclid|gclid|gbraid|wbraid|mc_[a-z]+|igshid|ref_src|ref_url)$",
    re.I,
)
#: Redirect wrappers whose target is not recoverable from the URL itself.
_OPAQUE_REDIRECT = re.compile(r"^https?://[^/]*\bgoogle\.[a-z.]+/(goto|url)\b", re.I)

_WORD = re.compile(r"[a-z0-9][a-z0-9'-]*")
#: Terms carrying no discriminating power when judging whether a result is about
#: the query. Mirrors the ledger's stop list — same job, same reasoning.
_STOP = frozenset(
    """a an and are as at be but by for from has have in into is it its of on or
    that the their there these this to was were will with your you we our us all
    can could should would may might must do does did not no than then them they
    what which who whom whose how why where when while about over under more most
    each every any some per via using use used latest current best top new news
    """.split()
)


def is_search_tool(tool_id: str, tool_name: str = "") -> bool:
    return tool_id in SEARCH_TOOL_IDS or tool_name in SEARCH_TOOL_IDS


def distinctive_terms(text: str) -> set[str]:
    return {w for w in _WORD.findall(text.lower()) if w not in _STOP and len(w) > 2}


def prepare_args(args: dict, *, response_language: str | None) -> tuple[dict, dict]:
    """Args to send, plus what was changed (for the tool-call event / logs).

    The model's own values always win — this only fills what it left out.
    """
    if not isinstance(args, dict):
        return args, {}
    out = dict(args)
    changed: dict[str, str] = {}
    lang = (response_language or "").strip()
    if not out.get("lang") and lang and lang.lower() not in {"auto", "default"}:
        out["lang"] = lang
        changed["lang"] = lang
    return out, changed


def empty_query(args: dict) -> bool:
    """A query with nothing searchable in it.

    DEFENSIVE, and labelled as such: the tester saw a provider exception on a
    punctuation-only query, but the same input returns HTTP 200 today, so this is
    not a reproduction — it is a cheap refusal to spend a call (and a possible
    60 s retry) on a query that cannot match anything.
    """
    if not isinstance(args, dict):
        return False
    q = str(args.get("query") or "")
    return not any(ch.isalnum() for ch in q)


def canonical_url(url: str) -> tuple[str, bool]:
    """(url without tracking params, whether it is an opaque redirect wrapper)."""
    if not url:
        return url, False
    if _OPAQUE_REDIRECT.match(url):
        return url, True
    try:
        parts = urlsplit(url)
        kept = [
            (k, v)
            for k, v in parse_qsl(parts.query, keep_blank_values=True)
            if not _TRACKING.match(k)
        ]
        return urlunsplit(parts._replace(query=urlencode(kept))), False
    except ValueError:
        return url, False


def annotate_result(result: dict, query_terms: set[str]) -> dict:
    """One result, cleaned and annotated. Never dropped, never reordered."""
    if not isinstance(result, dict):
        return result
    out = dict(result)
    url, redirect = canonical_url(str(out.get("url") or ""))
    out["url"] = url
    if redirect:
        # Said plainly so the model neither presents nor stores it as the source's
        # own address. The target is NOT guessed — it is not in the URL.
        out["redirect"] = True
        out["url_note"] = "search-engine redirect; canonical URL unknown"
    if query_terms:
        text = f"{out.get('title') or ''} {out.get('snippet') or ''}".lower()
        out["matches_query"] = bool(query_terms & set(_WORD.findall(text)))
    return out


def process_result(payload: dict, args: dict) -> tuple[dict, bool]:
    """(annotated payload, whether the search found nothing usable).

    "Nothing usable" means zero results, or results none of which share a
    distinctive term with the query — the gibberish case. The results are still
    returned; what changes is that the model is told, instead of being left to
    narrate the top hit as though it answered the question.
    """
    if not isinstance(payload, dict):
        return payload, False
    results = payload.get("results")
    if not isinstance(results, list):
        return payload, False
    terms = distinctive_terms(str((args or {}).get("query") or ""))
    out = dict(payload)
    out["results"] = [annotate_result(r, terms) for r in results]
    relevant = [
        r for r in out["results"] if isinstance(r, dict) and r.get("matches_query")
    ]
    nothing = not results or (bool(terms) and not relevant)
    if nothing:
        out["relevance"] = "none"
        out["note"] = (
            "No result matches the query terms. Report that nothing was found "
            "rather than summarising unrelated results."
        )
    return out, nothing
