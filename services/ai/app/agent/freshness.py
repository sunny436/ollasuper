"""Freshness — the temporal requirement in a request, and the age of what was read.

WHY THIS EXISTS. The 18.09.2026 skill audit found a "last 30 days" question answered
from a two-year-old source and a "this week" question with no idea what day it was.
Inspection of the code explained both: nothing in the pipeline knew today's date,
nothing parsed "last 30 days" out of the request, and nothing looked at how old a
source was before the model cited it. Freshness was a paragraph of prompt guidance
and an optional tool the model could call. This module is the deterministic half.

THREE JOBS, all pure functions so every rule is unit-testable:
  1. `detect_requirement` — what the request asks for, as a WINDOW. `strict` has a
     cutoff date ("last 30 days"); `live` needs retrieval but no cutoff
     ("latest price").
     A request about the past, or about the user's own files, has no requirement.
  2. `snippet_date` / `content_date` — when a source is from. Search results carry NO
     date field; the engine puts one at the START of the snippet. A scraped page carries
     its dateline inside the markdown. Each date is RANKED by how it was found, because
     "Updated 2026-09-12" and "a date somewhere in the first screen" are not the same
     evidence. Unknown is unknown — it never satisfies a strict window.
  3. `annotate_search` / `annotate_read` / `render_freshness` — what the model is shown
     (stale results are moved out of `results`, with the reason) and what the user is
     told at the end of the turn, computed from recorded state so the answer text cannot
     talk its way past it. The same rule `claims.py` follows.

SEMANTICS (fixed, tested): `today` is the UTC date. A window is `[cutoff, today+1]`,
lower bound inclusive, with ONE day of grace on the lower bound for time zones. A source
satisfies a strict window only when an EXPLICIT date (published / updated / snippet)
lands inside it. Bare "now" and "currently" are conversation, not requirements.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta

from app.agent.search_guard import canonical_url

# --------------------------------------------------------------------------- dates

_MONTHS = {
    m: i
    for i, names in enumerate(
        (
            ("jan", "january"),
            ("feb", "february"),
            ("mar", "march"),
            ("apr", "april"),
            ("may",),
            ("jun", "june"),
            ("jul", "july"),
            ("aug", "august"),
            ("sep", "sept", "september"),
            ("oct", "october"),
            ("nov", "november"),
            ("dec", "december"),
        ),
        start=1,
    )
    for m in names
}
_MONTH = (
    r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?"
    r"|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
)
# Only UNAMBIGUOUS forms: ISO, "12 Sep 2026", "Sep 12, 2026", "September 2026".
# "12/09/2026" is day-first in India and month-first in the US; it is not parsed.
_ISO = re.compile(r"\b(20\d\d)-(\d{2})-(\d{2})(?!\d)")
_DMY = re.compile(
    rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\s+({_MONTH})\.?,?\s+(20\d\d)(?!\d)", re.I
)
_MDY = re.compile(
    rf"\b({_MONTH})\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?,?\s+(20\d\d)(?!\d)", re.I
)
_MY = re.compile(rf"\b({_MONTH})\.?,?\s+(20\d\d)(?!\d)", re.I)
_RELATIVE = re.compile(r"\b(\d{1,3})\s+(hours?|days?|weeks?|months?)\s+ago\b", re.I)


def today_utc() -> date:
    return datetime.now(UTC).date()


def _mk(y: int, m: int, d: int) -> date | None:
    try:
        return date(y, m, d)
    except ValueError:
        return None


def _match_date(m: re.Match, kind: str) -> date | None:
    if kind == "iso":
        return _mk(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    if kind == "dmy":
        return _mk(
            int(m.group(3)), _MONTHS[m.group(2).lower().rstrip(".")], int(m.group(1))
        )
    if kind == "mdy":
        return _mk(
            int(m.group(3)), _MONTHS[m.group(1).lower().rstrip(".")], int(m.group(2))
        )
    if kind == "my":
        return _mk(int(m.group(2)), _MONTHS[m.group(1).lower().rstrip(".")], 1)
    return None


def _first_date(text: str, today: date) -> tuple[date, int, int] | None:
    """The earliest-positioned unambiguous date in `text`, as (date, start, end).
    Relative forms ("3 days ago") resolve against `today`."""
    best: tuple[date, int, int] | None = None
    # A day+month+year form that is INVALID ("31 Feb 2026") is not re-read as a
    # month+year — that would be a guess.
    claimed: list[tuple[int, int]] = []
    for kind, rx in (("iso", _ISO), ("dmy", _DMY), ("mdy", _MDY), ("my", _MY)):
        m = rx.search(text)
        if not m:
            continue
        if kind == "my" and any(a <= m.start() < b for a, b in claimed):
            continue
        if kind in ("dmy", "mdy"):
            claimed.append((m.start(), m.end()))
        d = _match_date(m, kind)
        if d is not None and (best is None or m.start() < best[1]):
            best = (d, m.start(), m.end())
    m = _RELATIVE.search(text)
    if m and (best is None or m.start() < best[1]):
        n = int(m.group(1))
        unit = m.group(2).lower()
        days = (
            n
            if unit.startswith("day")
            else n * 7
            if unit.startswith("week")
            else n * 30
            if unit.startswith("month")
            else 0
        )
        best = (today - timedelta(days=days), m.start(), m.end())
    return best


def parse_date(text: str, today: date | None = None) -> date | None:
    hit = _first_date(text or "", today or today_utc())
    return hit[0] if hit else None


# ------------------------------------------------------------- the requirement


@dataclass(frozen=True, slots=True)
class TemporalRequirement:
    kind: str  # "strict" | "live"
    phrase: str  # the user's own words that set it, e.g. "last 30 days"
    cutoff: date | None  # inclusive lower bound; strict only
    sentence: str  # the sentence the phrase sits in (bounded) — the retrieval query

    @property
    def strict(self) -> bool:
        return self.kind == "strict"

    def describe(self) -> str:
        if self.cutoff is not None:
            return (
                f"{self.phrase} (sources dated on or after {self.cutoff.isoformat()})"
            )
        return f"{self.phrase} (current information)"


_FENCE = re.compile(r"```.*?```", re.S)
_QUOTE = re.compile(r"^\s*>.*$", re.M)
_SENTENCE_SPLIT = re.compile(r"(?<=[.?!])\s+|\n+")

# strict phrases → a cutoff builder. Order matters: the most specific first.
_STRICT: tuple[tuple[re.Pattern, str], ...] = (
    (
        re.compile(
            r"\b(?:last|past|previous)\s+(\d{1,3})\s+(days?|weeks?|months?)\b", re.I
        ),
        "n_units",
    ),
    (re.compile(r"\b(?:in\s+the\s+)?(?:this|past|last)\s+week\b", re.I), "week"),
    (re.compile(r"\bthis\s+month\b", re.I), "this_month"),
    (re.compile(r"\b(?:last|past|previous)\s+month\b", re.I), "last_month"),
    (re.compile(r"\bthis\s+quarter\b", re.I), "quarter"),
    (re.compile(r"\b(?:this\s+year|year[- ]to[- ]date|ytd)\b", re.I), "year"),
    (re.compile(r"\byesterday\b", re.I), "yesterday"),
    (re.compile(r"\btoday\b", re.I), "today"),
)
_SINCE = re.compile(
    r"\b(since|after|from)\s+(?=\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)",
    re.I,
)

# live phrases: retrieval is required; there is no cutoff to enforce.
_LIVE = re.compile(
    r"\b(?:"
    r"what(?:'s| is| are) the latest"
    r"|latest\s+(?:news|headlines|version|release|update|updates|price|prices|rate|rates|"
    r"result|results|data|figures|numbers|developments|announcement|announcements|"
    r"status|standings|score|scores|report)"
    r"|current\s+(?:price|prices|rate|rates|status|weather|score|scores|standings|value|"
    r"exchange\s+rate|market|situation|state|version|ceo|leader|holder|holders|level|levels)"
    r"|today'?s"
    r"|right\s+now|at\s+the\s+moment"
    r"|as\s+of\s+(?:today|now|this\s+morning|tonight)"
    r"|breaking\s+news|live\s+(?:price|prices|score|scores|rate|rates|data)"
    r"|what(?:'s| has| is)?\s+changed|what'?s\s+new"
    r"|recent\s+(?:news|developments|changes|updates|events|announcements)"
    r"|happened\s+recently|recently\s+(?:announced|released|changed|launched|published)"
    r"|news\s+(?:on|about|from|for|regarding|around)\b|headlines\s+(?:on|about|from|for)\b"
    r")",
    re.I,
)
# A strict phrase is a REQUIREMENT only inside a sentence that asks for information
# about the world: "what happened this week?" — not "I've been sick for the last
# 3 days, draft an email". Interrogatives and request verbs, never topic words.
_INFO = re.compile(
    r"\b(?:what|which|who|whose|how|where|when|why|tell\s+me|give\s+me|find|show|list|"
    r"summari[sz]e|search|look\s+up|check|research|compare|report\s+on|update\s+me|"
    r"happened|changed|announced|released|trending)\b",
    re.I,
)
# An auxiliary that OPENS the sentence is a question even without the "?":
# "did the RBI change rates this week". Mid-sentence it is prose ("I have a meeting").
_INFO_START = re.compile(
    r"^\s*(?:did|does|do|has|have|had|is|are|was|were|can|could|will|would|should)\b",
    re.I,
)
# The sentence is about THIS conversation or the user's own material, not the world.
_OWN = re.compile(
    r"\b(?:this\s+(?:conversation|chat|thread|file|document|csv|sheet|spreadsheet|dataset|"
    r"table|pdf|report|data)|our\s+(?:chat|conversation)|the\s+(?:attached|uploaded)|"
    r"attached|uploaded|my\s+(?:data|file|files|notes|document|documents))\b",
    re.I,
)
_AS_OF_DATE = re.compile(
    r"\bas\s+of\s+(?=\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)", re.I
)

# Historical anchors cancel a LIVE reading (never a strict window).
_HISTORY = re.compile(
    r"\b(?:history\s+of|when\s+(?:was|were|did)\b.{0,60}\b(?:founded|launched|born|invented|"
    r"established|created|started|released|introduced)|origin\s+of|timeline\s+of)\b",
    re.I,
)
_YEAR = re.compile(r"\b(19\d\d|20\d\d)\b")


def _sentence_of(text: str, pos: int) -> str:
    start = 0
    for m in _SENTENCE_SPLIT.finditer(text):
        if m.start() >= pos:
            return text[start : m.start()].strip()
        start = m.end()
    return text[start:].strip()


def _strict_cutoff(rule: str, m: re.Match, today: date) -> date:
    if rule == "n_units":
        n = int(m.group(1))
        unit = m.group(2).lower()
        days = (
            n
            if unit.startswith("day")
            else n * 7
            if unit.startswith("week")
            else n * 30
        )
        return today - timedelta(days=max(1, days))
    if rule == "week":
        return today - timedelta(days=7)
    if rule == "this_month":
        return today.replace(day=1)
    if rule == "last_month":
        first = today.replace(day=1)
        return (first - timedelta(days=1)).replace(day=1)
    if rule == "quarter":
        q_month = 3 * ((today.month - 1) // 3) + 1
        return today.replace(month=q_month, day=1)
    if rule == "year":
        return today.replace(month=1, day=1)
    if rule == "yesterday":
        return today - timedelta(days=2)
    return today - timedelta(days=1)  # today


def detect_requirement(
    text: str, today: date | None = None
) -> TemporalRequirement | None:
    """The temporal requirement a request carries, or None.

    Reads the user's own words only (fenced code and quoted lines are stripped: a
    pasted article that says "this week" is content, not a request). The caller
    decides whether the turn is about the user's own files — that is context this
    function does not have — and suppresses the requirement in that case.
    """
    if not text:
        return None
    today = today or today_utc()
    body = _QUOTE.sub("", _FENCE.sub(" ", text))
    if not body.strip():
        return None

    # "as of <date>" — retrieval required, anchored to that date; no cutoff.
    m = _AS_OF_DATE.search(body)
    if m:
        d = parse_date(body[m.end() : m.end() + 40], today)
        if d is not None:
            return TemporalRequirement(
                "live",
                body[m.start() : m.end()].strip() + " " + d.isoformat(),
                None,
                _sentence_of(body, m.start())[:300],
            )

    # "since/after/from <date>" — a strict window from that date.
    m = _SINCE.search(body)
    if m:
        hit = _first_date(body[m.end() : m.end() + 40], today)
        if hit is not None and hit[1] == 0:
            d = hit[0]
            if m.group(1).lower() == "after":
                d = d + timedelta(days=1)
            if d <= today + timedelta(days=1):
                return TemporalRequirement(
                    "strict",
                    body[m.start() : m.end() + hit[2]].strip(),
                    d,
                    _sentence_of(body, m.start())[:300],
                )

    for rx, rule in _STRICT:
        m = rx.search(body)
        if m:
            sentence = _sentence_of(body, m.start())
            if _OWN.search(sentence):
                return None
            if (
                "?" not in sentence
                and not _INFO.search(sentence)
                and not _INFO_START.match(sentence)
            ):
                continue  # a time word in a sentence that asks for nothing
            return TemporalRequirement(
                "strict",
                m.group(0).strip(),
                _strict_cutoff(rule, m, today),
                sentence[:300],
            )

    m = _LIVE.search(body)
    if not m:
        return None
    if _HISTORY.search(body) or _OWN.search(_sentence_of(body, m.start())):
        return None
    years = [int(y) for y in _YEAR.findall(body)]
    if years and max(years) < today.year - 1:
        return None  # "the current price in 2019" is a question about the past
    return TemporalRequirement(
        "live", m.group(0).strip(), None, _sentence_of(body, m.start())[:300]
    )


def satisfies_window(
    d: date | None, req: TemporalRequirement, today: date | None = None
) -> bool | None:
    """True/False for a dated source under a strict window; None when there is
    nothing to judge (no date, or no strict window)."""
    if d is None or req.cutoff is None:
        return None
    today = today or today_utc()
    if d > today + timedelta(days=1):
        return None  # a future date is not a date we trust
    return d >= req.cutoff - timedelta(days=1)  # one day of grace for time zones


# ------------------------------------------------------- where a source is from


#: Ranked: how a date was found decides how much it is worth.
DATE_RANK = {"published": 0, "updated": 1, "snippet": 2, "inferred": 3, "reported": 4}
#: The kinds that can SATISFY a strict window. `inferred` (an unlabelled date on the
#: first screen) and `reported` (the model's own source_date) can flag a source as
#: stale, but cannot vouch for it being fresh.
EXPLICIT_KINDS = frozenset({"published", "updated", "snippet"})


@dataclass(frozen=True, slots=True)
class SourceDate:
    value: date
    kind: str

    @property
    def explicit(self) -> bool:
        return self.kind in EXPLICIT_KINDS

    def as_dict(self) -> dict:
        return {"date": self.value.isoformat(), "date_kind": self.kind}


_SNIPPET_LEAD = re.compile(r"^\s*[·•\-–—\s]*", re.M)
_LABEL_PUBLISHED = re.compile(
    r"\b(?:published|posted|date\s+published|publication\s+date|published\s+on|posted\s+on)\b\s*[:\-–—]?\s*(?:on\s+)?",
    re.I,
)
_LABEL_UPDATED = re.compile(
    r"\b(?:updated|last\s+updated|last\s+modified|modified|revised)\b\s*[:\-–—]?\s*(?:on\s+)?",
    re.I,
)
_HEAD_CHARS = 2500
_MIN_READ = re.compile(r"\s*[\u2014\u2013\-\u00b7|]\s*\d+\s*min", re.I)


def snippet_date(snippet: str, today: date | None = None) -> SourceDate | None:
    """The engine's date annotation: a date AT THE START of the snippet ("Jul 15,
    2026Postmortem as…", "3 days ago · …"). A date further in is content."""
    if not snippet:
        return None
    today = today or today_utc()
    text = _SNIPPET_LEAD.sub("", snippet, count=1)[:40]
    hit = _first_date(text, today)
    if hit is None or hit[1] > 2:
        return None
    if hit[0] > today + timedelta(days=1):
        return None
    return SourceDate(hit[0], "snippet")


def content_date(markdown: str, today: date | None = None) -> SourceDate | None:
    """A page's dateline, from the first screen of its markdown. A labelled date
    ("Published …", "Updated …") outranks an unlabelled one; nothing is guessed
    from deeper in the page, where dates are the content."""
    if not markdown:
        return None
    today = today or today_utc()
    head = markdown[:_HEAD_CHARS]
    for label_rx, kind in (
        (_LABEL_PUBLISHED, "published"),
        (_LABEL_UPDATED, "updated"),
    ):
        for m in label_rx.finditer(head):
            hit = _first_date(head[m.end() : m.end() + 40], today)
            if hit is not None and hit[1] <= 2 and hit[0] <= today + timedelta(days=1):
                return SourceDate(hit[0], kind)
    hit = _first_date(head, today)
    if hit is not None and hit[0] <= today + timedelta(days=1):
        # "April 16, 2026 — 22 min read" is a byline dateline, not a date in prose.
        if _MIN_READ.match(head[hit[2] : hit[2] + 30]):
            return SourceDate(hit[0], "published")
        return SourceDate(hit[0], "inferred")
    return None


def url_key(url: str) -> str:
    u, _redirect = canonical_url(str(url or "").strip())
    u = u.split("#", 1)[0]
    # scheme + host are case-insensitive; the path is not; a trailing slash on
    # the path is not a different page.
    m = re.match(r"^(https?://[^/]+)([^?]*)(\?.*)?$", u, re.I)
    if not m:
        return u.lower().rstrip("/")
    path = (m.group(2) or "").rstrip("/")
    return m.group(1).lower() + path + (m.group(3) or "")


# ---------------------------------------------------------------- the ledger


@dataclass(slots=True)
class FreshnessLedger:
    """Per-turn recorded state: what was asked, what was retrieved, how old it was."""

    requirement: TemporalRequirement | None = None
    web_available: bool = False
    search_calls: int = 0
    search_ok: int = 0  # searches that returned at least one usable result
    search_failed: int = 0
    search_compliant: int = 0  # strict: results explicitly dated inside the window
    prefetched: bool = False
    dates: dict[str, SourceDate] = field(default_factory=dict)
    retrieved_urls: set[str] = field(default_factory=set)
    read_urls: list[str] = field(default_factory=list)

    def note_url(self, url: str, sd: SourceDate | None = None) -> None:
        key = url_key(url)
        if not key:
            return
        self.retrieved_urls.add(key)
        if sd is not None:
            cur = self.dates.get(key)
            if cur is None or DATE_RANK[sd.kind] < DATE_RANK[cur.kind]:
                self.dates[key] = sd

    def note_read(self, url: str, sd: SourceDate | None = None) -> None:
        self.note_url(url, sd)
        key = url_key(url)
        if key and key not in self.read_urls:
            self.read_urls.append(key)

    @property
    def active(self) -> bool:
        return self.requirement is not None


# ------------------------------------------------ what the model is shown


def annotate_search(
    payload: dict, req: TemporalRequirement, today: date | None = None
) -> tuple[dict, dict]:
    """Date every result from its snippet. Under a STRICT window, explicitly-dated
    results older than the cutoff are moved out of `results` into `excluded_stale`
    with the reason; undated ones stay, marked as not satisfying the window. Returns
    (payload, facts) where facts carry the per-URL dates for the ledger."""
    if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
        return payload, {"dates": {}, "compliant": 0, "undated": 0, "excluded": 0}
    today = today or today_utc()
    kept: list = []
    excluded: list[dict] = []
    dates: dict[str, SourceDate] = {}
    compliant = undated = 0
    for r in payload["results"]:
        if not isinstance(r, dict):
            kept.append(r)
            continue
        out = dict(r)
        sd = snippet_date(str(out.get("snippet") or ""), today)
        url = str(out.get("url") or "")
        if sd is not None:
            out.update(sd.as_dict())
            if url:
                dates[url] = sd
        else:
            out["date"] = None
            out["date_kind"] = "unknown"
        if req.strict:
            ok = satisfies_window(sd.value if sd else None, req, today)
            if sd is not None and sd.explicit and ok is False:
                excluded.append(
                    {
                        "url": url,
                        "title": out.get("title"),
                        "date": sd.value.isoformat(),
                    }
                )
                continue
            if sd is not None and sd.explicit and ok:
                compliant += 1
            elif sd is None:
                undated += 1
                out["date_note"] = (
                    "date unknown — does not satisfy the requested window; "
                    "verify the date on the page before citing"
                )
        kept.append(out)
    out_payload = dict(payload)
    out_payload["results"] = kept
    out_payload["count"] = len(kept)
    block: dict = {"required": req.phrase}
    if req.strict:
        block.update(
            cutoff=req.cutoff.isoformat() if req.cutoff else None,
            compliant=compliant,
            undated=undated,
            excluded_stale=len(excluded),
        )
        if excluded:
            out_payload["excluded_stale"] = excluded
        if compliant == 0:
            block["note"] = (
                "No result is explicitly dated inside the requested window. "
                f"Search again with the month and year (e.g. '{_month_year(today)}') "
                "or a narrower query; if no current source exists, say so — do not "
                "cite an older source as current."
            )
        else:
            block["note"] = (
                "Cite only sources dated inside the window; include each source's date."
            )
    else:
        block["note"] = (
            "Current information was requested: cite sources with their "
            "publication dates."
        )
    out_payload["freshness"] = block
    return out_payload, {
        "dates": dates,
        "compliant": compliant,
        "undated": undated,
        "excluded": len(excluded),
    }


def _month_year(d: date) -> str:
    return d.strftime("%B %Y")


def annotate_read(
    payload: dict, req: TemporalRequirement, today: date | None = None
) -> tuple[dict, dict]:
    """Date a scraped page (or each page of a batch) from its dateline. Under a strict
    window an older page is returned WITH its content and a `stale_for_request` flag —
    the model may need it for context; it may not cite it as current."""
    today = today or today_utc()
    dates: dict[str, SourceDate] = {}

    def one(page: dict) -> dict:
        out = dict(page)
        content = out.get("content")
        sd = content_date(content if isinstance(content, str) else "", today)
        url = str(out.get("url") or "")
        if sd is not None:
            out.update(sd.as_dict())
            if url:
                dates[url] = sd
            if (
                req.strict
                and satisfies_window(sd.value, req, today) is False
                and sd.kind != "inferred"
            ):
                out["stale_for_request"] = True
                out["freshness_note"] = (
                    f"dated {sd.value.isoformat()} ({sd.kind}) — older than the "
                    "requested window (on or after "
                    f"{req.cutoff.isoformat() if req.cutoff else '?'}); "
                    "do not cite as current"
                )
        else:
            out["date"] = None
            out["date_kind"] = "unknown"
        return out

    if not isinstance(payload, dict):
        return payload, {"dates": dates}
    if isinstance(payload.get("results"), list):
        out_payload = dict(payload)
        out_payload["results"] = [
            one(p) if isinstance(p, dict) else p for p in payload["results"]
        ]
        return out_payload, {"dates": dates}
    if isinstance(payload.get("content"), str) or payload.get("url"):
        return one(payload), {"dates": dates}
    return payload, {"dates": dates}


# --------------------------------------------------- what the user is told


_URL = re.compile(r"https?://[^\s<>()\[\]\"']+", re.I)
_MD_LINK = re.compile(r"\]\((https?://[^)\s]+)\)", re.I)
#: The answer already says it could not verify — no correction is owed.
_DISCLAIMED = re.compile(
    r"\b(?:knowledge\s+cutoff|training\s+(?:data|cutoff)|could\s+not\s+(?:verify|retrieve|access|fetch)|"
    r"couldn't\s+(?:verify|retrieve|access|fetch)|unable\s+to\s+(?:verify|retrieve|access)|"
    r"may\s+be\s+out\s+of\s+date|may\s+be\s+outdated|not\s+(?:been\s+)?verified|"
    r"search\s+(?:failed|was\s+unavailable|returned\s+no)|no\s+current\s+sources?)\b",
    re.I,
)


def cited_urls(answer: str) -> list[str]:
    text = _FENCE.sub(" ", answer or "")
    seen: list[str] = []
    for m in list(_MD_LINK.finditer(text)) + list(_URL.finditer(text)):
        u = m.group(1) if m.re is _MD_LINK else m.group(0)
        u = u.rstrip(".,;:!?)")
        k = url_key(u)
        if k and k not in seen:
            seen.append(k)
    return seen


def render_freshness(
    answer: str, ledger: FreshnessLedger, today: date | None = None
) -> str:
    """The end-of-turn statement, system-authored from recorded state. Empty when the
    turn was compliant. Never rewrites the answer — it appends the truth."""
    req = ledger.requirement
    if req is None:
        return ""
    today = today or today_utc()
    disclosed = bool(_DISCLAIMED.search(answer or ""))
    parts: list[str] = []

    if not ledger.web_available:
        if not disclosed:
            parts.append(
                f"**Recency not verified.** This asks for {req.describe()}, but web "
                "retrieval was not available in this turn, so the answer comes from "
                "prior knowledge and may be out of date."
            )
        return _join(parts)
    if ledger.search_calls == 0:
        if not disclosed:
            parts.append(
                f"**Live data was required but no search was run.** This asks for "
                f"{req.describe()}; the answer was not checked against current "
                "sources — "
                "treat it as unverified for recency."
            )
        return _join(parts)
    if ledger.search_failed > 0 and ledger.search_ok == 0:
        parts.append(
            "**The web search failed (provider error), so no current sources were "
            f"retrieved.** This asks for {req.describe()}; nothing in the answer is "
            "grounded in current evidence."
        )
        return _join(parts)

    if req.strict and req.cutoff is not None:
        cited = cited_urls(answer)
        stale: list[str] = []
        unknown: list[str] = []
        fresh = 0
        for k in cited:
            sd = ledger.dates.get(k)
            if sd is None:
                if k in ledger.retrieved_urls:
                    unknown.append(k)
                continue
            ok = satisfies_window(sd.value, req, today)
            if ok is False:
                stale.append(f"- {k} ({sd.value.isoformat()}, {sd.kind})")
            elif ok and sd.explicit:
                fresh += 1
        head = (
            f"**Recency check — {req.phrase}: sources must be dated on or after "
            f"{req.cutoff.isoformat()}.**"
        )
        if stale:
            parts.append(
                head
                + f" {len(stale)} cited source(s) are older than that; claims taken "
                "from them do not satisfy the request:\n" + "\n".join(stale[:8])
            )
        if fresh == 0:
            if unknown and not stale:
                parts.append(head)
            reason = (
                f"{len(unknown)} cited source(s) carry no verifiable date"
                if unknown
                else (
                    "no source dated inside the window was cited"
                    if cited
                    else "the answer cites no sources"
                )
            )
            if ledger.search_compliant == 0:
                reason += (
                    "; the search found no result explicitly dated inside the window"
                )
            parts.append(
                "No cited source could be verified as within the requested window "
                f"({reason})."
            )
    return _join(parts)


def _join(parts: list[str]) -> str:
    return "\n\n".join(p for p in parts if p)


# ----------------------------------------------- the per-turn directive + query


def render_directive(req: TemporalRequirement) -> str:
    """The system-prompt line for a turn with a temporal requirement. Names the
    window and the cutoff; never a blanket 'always search'."""
    if req.strict and req.cutoff is not None:
        window = f"only sources dated on or after {req.cutoff.isoformat()} satisfy it"
    else:
        window = "current sources with visible publication dates are required"
    return (
        "TEMPORAL REQUIREMENT (detected from the request): the user asks for "
        f"{req.phrase} — {window}. A web search has been run for you; read the "
        "compliant sources before answering, search again with a narrower or dated "
        "query if they are insufficient, cite each source with its date, and if no "
        "compliant source exists say so plainly instead of presenting older material "
        "as current. Never answer this from memory alone."
    )


def prefetch_query(req: TemporalRequirement, today: date | None = None) -> str:
    """The query for the system-initiated search: the user's own sentence, plus the
    month/year for a short strict window (engines have no recency filter; the date
    in the query is the only lever). Bounded to the provider's 500 chars."""
    today = today or today_utc()
    q = " ".join((req.sentence or req.phrase).split())[:280].rstrip("?.!")
    if req.strict and req.cutoff is not None:
        span = (today - req.cutoff).days
        q += " " + (_month_year(today) if span <= 45 else str(today.year))
    return q[:500]
