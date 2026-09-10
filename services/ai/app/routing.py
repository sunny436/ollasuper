"""Master Model Router — the proactive half of model selection.

WHY THIS EXISTS. The user used to pick the model from a dropdown, so the product
read as several different bots and the person typing had to understand a roster
to use it. Selection is an implementation detail; this module makes it one.

WHAT IT IS NOT. Not a classifier, not a scoring framework, not a service. It is
one pure function over data the caller already has. That is a hard requirement,
not a style preference: it runs on the pre-first-token path of every chat turn,
so anything that blocks — a database read, an HTTP call, a model call, a lock —
is a latency regression the user feels directly. Budget: P99 < 1ms.

TWO INDEPENDENT AXES, and keeping them apart is the whole design.

  REASONING  how hard is the thinking          -> a tier FLOOR (0/1/2)
  GROUNDED   does this turn need external data -> which capable model wins

They are not the same question and they have opposite costs. Measured on
production, time-to-first-visible-token scales with the number of agentic steps:

    steps 0 -> 1.6s      steps 2 -> 10.9s      steps 5 -> 46.4s

TTFT is paid ONCE PER STEP. So a grounded, tool-heavy turn on a high-TTFT
reasoner multiplies that model's worst property, while a self-contained hard
question pays it once and can afford the deepest model on offer. Collapsing
"needs tools" into "is complex" therefore picks exactly the wrong model for
agentic work — which is most of what this product is asked to do.

WHY NOT LENGTH. The first version of this router classified on prompt+history
size. Measured against the real conversations users actually ran, all five of the
heaviest requests ("deep audit this website", "do a ultra deep audit", ...) were
21-82 characters and routed to the FASTEST, WEAKEST model. Length is a proxy for
input size, and input size is the one thing that genuinely does not imply hard
reasoning: "rewrite this paragraph: [5000 words]" is trivial work on a large
input. This product's heaviest capabilities are invoked with short imperatives
because the work lives in the tools and the corpus, not in the prompt.

WHAT IT DELIBERATELY DOES NOT MODEL, and why (absence here is evidence-based):

  * WHICH TOOLS will run. The router executes before skill selection and tool
    binding, so that is genuinely unknown here. It estimates whether the turn
    NEEDS grounding, which is a different and answerable question.
  * VISION. The catalogue reports `vision: true` for every entry as a cosmetic
    default. Routing on a constant is not routing.
  * COST. Ollima's /v1/models carries no pricing, so every price field is "".

HONEST LIMIT. At sub-millisecond with no model, any reading of text is
ultimately lexical. What keeps this a WORK-TYPE decision rather than keyword
matching is that the action set is small and closed, it is matched at the request
HEAD where the imperative lives, a single token never decides on its own, and the
structural signals (attachments, corpus, URLs, open loops) are independent of
vocabulary and can promote or demote by themselves.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field, replace

from app.agent import health as model_health
from app.logging import get_logger

log = get_logger(__name__)

# Rough chars-per-token, used only for coarse context comparisons — never to
# bill or trim anything. The real budgeting is agent/budget.py.
_CHARS_PER_TOKEN = 4

# How much text each pass reads. The router must cost the same on a 48k-char
# turn (the ai_max_turn_chars ceiling) as on a 200-char one, and these bounds are
# what make that true. _EDGE_CHARS is taken from BOTH ends of the request.
#
# The window is tight on purpose. On a pasted document the body alternation
# finds NOTHING, so it retries every branch at every position — the worst case
# is a 48k paste with no signal in it, and the window is what bounds that. A
# real request states its intent well inside this window of either end.
#
# 72 was chosen by MEASUREMENT, not taste: at 96 the 48k worst case ran at
# P99 ~1.4ms, and at 72 it is ~0.35ms — three times inside the budget with no
# change in classification quality on either the real prompts or the held-out
# paraphrases. Tight enough to be provably fast, wide enough to catch the
# trailing constraints people actually write ("...and don't guess").
_HEAD_CHARS = 160
_EDGE_CHARS = 72

# --- reasoning classes -----------------------------------------------------
SIMPLE, MODERATE, HEAVY = 0, 1, 2

# --- Tier B: the work-type taxonomy ---------------------------------------
#
# A CLOSED set of request ACTIONS, matched at the head of the request. Ordered
# most-specific first: ANALYZE/DECIDE are checked before the generic producers so
# "design a migration plan" does not read as PRODUCE.
#
# Every pattern is folded into ONE compiled alternation per class. That is not a
# style choice: a per-character Python predicate in skills/user_skills.py cost a
# measured 309ms event-loop stall and became 11.4ms as a compiled regex.

_ANALYZE = (
    r"audit|analy[sz]|investigat|diagnos|debug|troubleshoot|critique|review|"
    r"assess|evaluat|examin|inspect|compar|benchmark|profil|"
    r"root\s*cause|(?<!\bor\s)\bwhy\b(?!\s+not\b)|"
    r"what(?:'?s| is| are)?\s+(?:wrong|broken|failing|slow|causing|happening)|"
    # Predicted-failure questions are analysis about the future, whatever the
    # phrasing: a modal or likelihood marker within a few words of a failure
    # verb. Generalises past any single wording ("what will break", "what is
    # likely to fall over", "could this crash").
    r"(?:will|would|could|might|likely|risk\w*|chance)\s[a-z\s]{0,20}?"
    r"(?:break|fail|go\s+wrong|blow\s+up|fall\s+over|crash|regress)|"
    r"go\s+through|walk\s+(?:me\s+)?through|dig\s+into|look\s+into|"
    r"(?:have|take)\s+a\s+\w*\s*look\s+at|get\s+to\s+the\s+bottom|"
    r"find\s+(?:out\s+)?(?:the\s+)?(?:issue|issues|problem|problems|bug|bugs|"
    r"gap|gaps|flaw|flaws|risk|risks|gotcha|anything|every)|"
    r"figure\s+out|work\s+out\s+why|make\s+sense\s+of|"
    r"hurting|holding\s+(?:us|it|this)\s+back|"
    r"anything\s+(?:that|which|we)|is\s+there\s+anything"
)

_DECIDE = (
    r"strateg|roadmap|architect|design\b|plan\b|blueprint|"
    r"recommend|advis|propos|"
    r"which\s+(?:one|of|approach|option|way|is)|"
    r"should\s+(?:we|i|it)|"
    r"safe(?:r|st)?\s+(?:long|option|choice|way|approach|bet)|"
    r"best\s+(?:way|approach|option|practice|choice)|"
    r"trade[\s-]?offs?|pros\s+and\s+cons|"
    r"decide|choose\s+between|help\s+(?:me\s+)?(?:pick|choose|decide)|what\s+would\s+you\b|what\s+(?:should|would)\s+(?:we|i)\b"
)

_TRANSFORM = (
    r"translat|rewrit|re-?word|re-?phras|paraphras|summar[iy]|"
    r"tl;?dr|shorten|condens|expand\s+this|"
    r"re-?format|reformat|format\s+this|convert\s+(?:this|it|the)|"
    r"proof-?read|spell-?check|fix\s+(?:the\s+)?(?:grammar|spelling|typos)|"
    r"make\s+(?:this|it)\s+(?:short|long|simpl|clear|plain|formal|casual)"
)

_RETRIEVE = (
    r"what\s+(?:is|are|was|were|does|do)\s|what'?s\s|"
    r"who(?:'?s| is| was| are)\s|when\s+(?:is|was|did|does)|where\s+(?:is|was)|"
    r"define\b|definition\s+of|meaning\s+of|"
    r"how\s+(?:much|many|old|far|long\s+is)|"
    r"look\s+up|tell\s+me\s+the\b"
)

_PRODUCE = (
    r"writ(?:e|ing)|draft|generat|creat|build|implement|"
    r"make\s+(?:me\s+)?a\b|produce|compose|code\s+(?:me\s+)?a\b|add\s+a\b"
)

# --- Tier C: corroborating intensity --------------------------------------
# NEVER promotes on its own. It raises a request that already classified as
# analytic/deciding work, and breaks ties. "deep" in "deep dish pizza" must not
# route anyone to a reasoner.
_INTENSITY = (
    r"deep(?:ly|er)?\b|thorough|comprehensive|exhaustive|ultra\b|in[\s-]depth|"
    r"rigorous|end[\s-]to[\s-]end|full(?:y)?\s+(?:audit|review|analy)|"
    r"every\s+(?:issue|risk|gap|flaw|detail|angle)|"
    r"edge\s*cases?|corner\s*cases?|"
    r"production[\s-]?ready|production\s+risk|"
    r"do\s*n[o']?t\s+guess|don'?t\s+assume|verify\s+every|be\s+(?:accurate|precise|certain)|"
    r"step[\s-]by[\s-]step|carefully|be\s+brutal|no\s+hand[\s-]?wav"
)

# --- grounding: does this turn need data it does not already have? --------
_URL = r"https?://|www\.[a-z0-9-]+\.[a-z]{2,}|\b[a-z0-9-]+\.(?:com|org|net|io|ai|dev|co)\b"
_RETRIEVAL_INTENT = (
    r"search\b|google\b|look\s+up|find\s+(?:me\s+)?(?:the\s+)?(?:latest|current|recent)|"
    r"latest\b|current(?:ly)?\b|today|this\s+(?:week|month|year)|right\s+now|"
    r"news\b|browse|fetch|crawl|scrape|"
    r"this\s+(?:website|site|page|url|domain|repo)"
)

_C = re.IGNORECASE

# ONE pass over the body, not three. Three unanchored alternations across a
# 1200-char window measured ~1000us P50 on a 48k-char turn — each one retries
# every branch at every position. A single alternation with named groups pays
# that walk once, and `finditer` can stop as soon as all three flags are set.
_RE_BODY = re.compile(
    f"(?P<url>{_URL})|(?P<retrieval>{_RETRIEVAL_INTENT})|(?P<intensity>{_INTENSITY})",
    _C,
)
# ONE pass for the work type too. Five separate alternations over a 160-char
# head measured ~240us — the cost is the number of BRANCHES, not the length of
# the text, so five walks is five times the price of one. A single alternation
# also expresses the rule directly: re.search returns the leftmost match, which
# IS "the earliest action in the request wins", and `lastgroup` names it. Group
# order is the tie-break at equal position, so analytic work precedes the
# generic producer ("design a migration plan" is a plan, not a production job).
_RE_WORK = re.compile(
    f"(?P<analyze>{_ANALYZE})|(?P<decide>{_DECIDE})|(?P<transform>{_TRANSFORM})"
    f"|(?P<retrieve>{_RETRIEVE})|(?P<produce>{_PRODUCE})",
    _C,
)
_WORK_LEVEL = {
    "analyze": HEAVY,
    "decide": HEAVY,
    "transform": SIMPLE,
    "retrieve": SIMPLE,
    "produce": MODERATE,
}
_RE_INTENSITY = re.compile(_INTENSITY, _C)
_RE_URL = re.compile(_URL, _C)
_RE_RETRIEVAL = re.compile(_RETRIEVAL_INTENT, _C)

# A definitional opener is a strong DEMOTER: "what does audit mean" contains an
# analytic word but is a lookup.
_RE_DEFINITIONAL = re.compile(
    r"^\s*(?:what\s+(?:does|do|is|are)\b|what'?s\b|who\b|define\b|meaning\s+of)",
    _C,
)


@dataclass(frozen=True)
class ModelProfile:
    """Measured behaviour for one model. Seeded from benchmarks, config-driven.

    The seeding benchmark was n=1 per model, one prompt shape, one host, one
    moment. Enough to ORDER models; not ground truth. Hence config rather than a
    constant: re-measuring must never require a deploy.
    """

    ttft_s: float = 99.0
    tok_per_s: float = 0.0
    # 0 = no hidden reasoning, 1 = moderate, 2 = heavy. Ordering only.
    reasoning_tier: int = 0


@dataclass(frozen=True)
class Candidate:
    """One routable model, as supplied by Convex from the live catalogue."""

    id: str
    # The model's real context window, or 0 when it has never been MEASURED.
    # 0 means unknown, and unknown must never be treated as small — see select().
    context_window: int = 0


@dataclass(frozen=True)
class Signals:
    """Everything the router reads about one turn.

    Deliberately plain data: the caller gathers it from values already in scope,
    so the router itself touches nothing.
    """

    text: str = ""
    history_chars: int = 0
    history_turns: int = 0
    # Tier A — structural, and independent of how the request is worded.
    has_document: bool = False
    has_image: bool = False
    rag_files: int = 0
    open_loops: int = 0
    artifacts: int = 0
    # "fast" | "balanced" | "thorough" — an existing user preference.
    response_speed: str = "balanced"


@dataclass(frozen=True)
class Decision:
    model: str
    # Structured, not prose: this is an observability record, not a message.
    reason: str


@dataclass(frozen=True)
class RouterConfig:
    enabled: bool = False
    profiles: dict[str, ModelProfile] = field(default_factory=dict)
    # A turn whose CONTEXT alone is this large is at least moderate work.
    heavy_token_threshold: int = 1200

    @staticmethod
    def from_settings(enabled: bool, profiles_json: str) -> RouterConfig:
        """Parse once, at Settings load — never on the request path.

        Malformed profiles disable the router rather than failing a turn: the
        fallback is the behaviour that shipped before this module existed, so
        degrading to it is always safe.
        """
        if not enabled:
            return RouterConfig(enabled=False)
        profiles: dict[str, ModelProfile] = {}
        if profiles_json.strip():
            try:
                raw = json.loads(profiles_json)
                for mid, p in (raw or {}).items():
                    profiles[mid] = ModelProfile(
                        ttft_s=float(p.get("ttft_s", 99.0)),
                        tok_per_s=float(p.get("tok_per_s", 0.0)),
                        reasoning_tier=int(p.get("reasoning_tier", 0)),
                    )
            except (ValueError, TypeError, AttributeError) as e:
                log.warning("router.profiles_invalid", extra={"error": str(e)[:200]})
                return RouterConfig(enabled=False)
        if not profiles:
            log.warning("router.no_profiles")
            return RouterConfig(enabled=False)
        return RouterConfig(enabled=True, profiles=profiles)


def estimate_tokens(prompt_chars: int, history_chars: int) -> int:
    return (prompt_chars + history_chars) // _CHARS_PER_TOKEN


@dataclass(frozen=True)
class Classification:
    reasoning: int
    grounded: bool
    work: str


def classify(sig: Signals, heavy_token_threshold: int = 1200) -> Classification:
    """Work type and grounding for one turn. Pure, bounded, no I/O.

    Order matters. Structural evidence is applied first because it cannot be
    paraphrased away; the taxonomy then sets the floor; intensity may only raise
    something already analytic.
    """
    head = sig.text[:_HEAD_CHARS]
    # Edges only: a request states its intent at the start and its constraints
    # at the end; the middle of a long turn is pasted material, not instruction.
    body = (
        sig.text[:_EDGE_CHARS] + " " + sig.text[-_EDGE_CHARS:]
        if len(sig.text) > 2 * _EDGE_CHARS
        else sig.text
    )

    # --- grounding: does the turn need data it does not already hold? ------
    # One pass, exiting as soon as both flags are known.
    saw_url = saw_retrieval = saw_intensity = False
    for m in _RE_BODY.finditer(body):
        if m.lastgroup == "url":
            saw_url = True
        elif m.lastgroup == "retrieval":
            saw_retrieval = True
        else:
            saw_intensity = True
        if saw_url and saw_retrieval and saw_intensity:
            break
    # A standing corpus is AVAILABILITY, not need — `rag_files` deliberately does
    # not appear here. On prod it made every turn on an account with uploaded
    # files "grounded", which pushed even "hi" off the fast path. Grounding means
    # THIS turn asks for data it does not hold: a URL, an explicit retrieval, or
    # a document attached to this message.
    grounded = bool(saw_url or saw_retrieval or sig.has_document)

    # --- Tier B: the work type, decided by the EARLIEST action in the head -
    #
    # Position is the whole trick. "translate this audit report to French" is a
    # translation whose OBJECT happens to be an audit; "audit this translated
    # doc" is the reverse. Taking the earliest match makes the request's own head
    # verb decide, which is what a reader does, instead of letting any analytic
    # noun anywhere in the sentence win.
    first = _RE_WORK.search(head)
    if first:
        work = first.lastgroup or "unknown"
        reasoning = _WORK_LEVEL.get(work, MODERATE)
        # An interrogative opener WRAPS a request; an imperative verb GOVERNS
        # one. "what's likely to break when we ship this" is a question ABOUT
        # analysis that merely starts with "what's", so a leading RETRIEVE yields
        # to an analytic action later in the same clause. TRANSFORM and PRODUCE
        # keep their positional precedence, because there the leading verb really
        # is the action ("translate this audit report to French").
        if work == "retrieve":
            for m in _RE_WORK.finditer(head):
                if m.lastgroup in ("analyze", "decide"):
                    work = m.lastgroup
                    reasoning = _WORK_LEVEL[work]
                    break
    else:
        # Unrecognised phrasing. A short, signal-free request is almost always
        # small talk or a one-liner; anything longer is genuinely unclear, and
        # unclear is where a deterministic router should NOT gamble on "fast".
        if len(sig.text) < 40 and not (grounded or sig.has_image):
            work, reasoning = "unknown", SIMPLE
        else:
            work, reasoning = "unknown", MODERATE

    # A definitional opener demotes ONLY when the request is actually shaped like
    # a lookup: short, single clause. "what does audit mean" is a lookup;
    # "what's likely to break when we ship this" is not, and demoting it on the
    # leading two words is how a real question gets sent to the weakest model.
    if (
        _RE_DEFINITIONAL.match(head)
        and len(sig.text) < 60
        and not saw_intensity
    ):
        work, reasoning = "retrieve", SIMPLE

    # --- Tier C: intensity RAISES, and the bias is DELIBERATELY asymmetric -
    #
    # A first cut demanded corroboration (a URL, an attachment, an intensity
    # word) before analytic work could reach HEAVY. Measured against held-out
    # paraphrases it dropped recall from 70% to 10%: real analytic questions
    # ("figure out why the job keeps dying", "walk me through the risks") carry
    # none of those, and every one was demoted to MODERATE.
    #
    # The two errors are not equally expensive. A trivial request on a reasoner
    # costs the user ~4s once. A genuinely deep request on the weakest model
    # costs a shallow answer EVERY time, and that is the failure this router
    # exists to remove. So analytic and deciding work stays HEAVY, and the known
    # false positives ("compare these two words") are accepted and documented
    # rather than engineered away by guessing at objects.
    if reasoning == MODERATE and saw_intensity:
        reasoning = HEAVY
    elif reasoning == SIMPLE and _RE_INTENSITY.search(head):
        # Explicit rigor demands are about HOW the answer is produced, so they
        # lift a transform/retrieve request off the floor without pretending it
        # became analysis.
        reasoning = MODERATE

    # --- Tier A: structural signals, independent of wording ----------------
    if sig.open_loops >= 2 or sig.artifacts >= 2:
        reasoning = max(reasoning, MODERATE)
    if sig.has_image or sig.has_document:
        reasoning = max(reasoning, MODERATE)
    if estimate_tokens(0, sig.history_chars) >= heavy_token_threshold:
        # Kept from the original policy, but demoted to what it actually is: a
        # signal about CONTEXT SIZE, not about how hard the thinking is.
        reasoning = max(reasoning, MODERATE)

    # --- explicit user preference: a nudge, never an override --------------
    # responseSpeed is documented as controlling answer LENGTH, so it may lean
    # the decision but must not redefine capability.
    if sig.response_speed == "thorough":
        reasoning = min(HEAVY, reasoning + 1)
    elif sig.response_speed == "fast":
        reasoning = max(MODERATE if reasoning >= HEAVY else SIMPLE, reasoning - 1)

    return Classification(reasoning=reasoning, grounded=grounded, work=work)


def select(
    *,
    cfg: RouterConfig,
    candidates: list[Candidate],
    fallback: str,
    signals: Signals | None = None,
    prompt_chars: int = 0,
    history_chars: int = 0,
) -> Decision:
    """Choose the model for this turn. Pure, in-process, no I/O.

    The only non-trivial cost is `model_health.is_exhausted`, an in-process dict
    lookup with a monotonic compare. There is no path through this function that
    touches a socket, a file or a database.

    EVERY failure returns `fallback`, which is the model the caller would have
    used anyway. Routing can change WHICH model answers; it can never stop one
    from answering.
    """
    if not cfg.enabled or not candidates:
        return Decision(fallback, "disabled" if not cfg.enabled else "no_candidates")

    sig = signals or Signals(text="", history_chars=history_chars)
    est = estimate_tokens(prompt_chars or len(sig.text), sig.history_chars)

    # --- hard filters: capability before speed, always --------------------
    healthy: list[Candidate] = []
    for c in candidates:
        if model_health.is_exhausted(c.id):
            continue
        # A KNOWN window that cannot hold the turn disqualifies. An UNKNOWN
        # window (0) never does: treating "not measured" as "too small" would
        # exclude 7 of 8 real models on invented evidence.
        if c.context_window > 0 and est > c.context_window:
            continue
        healthy.append(c)

    if not healthy:
        return Decision(fallback, "all_filtered")

    cls = classify(sig, cfg.heavy_token_threshold)

    def profile(c: Candidate) -> ModelProfile:
        return cfg.profiles.get(c.id, ModelProfile())

    # --- capability floor --------------------------------------------------
    capable = [c for c in healthy if profile(c).reasoning_tier >= cls.reasoning]
    if not capable:
        # Nothing meets the floor: take the best on offer rather than silently
        # dropping to the fastest, which is what "capability before speed" means
        # when capability is unavailable.
        best_tier = max(profile(c).reasoning_tier for c in healthy)
        capable = [c for c in healthy if profile(c).reasoning_tier == best_tier]

    # --- which capable model wins: always the cheapest that MEETS the floor -
    #
    # An earlier cut tried to be clever here — "a self-contained turn pays TTFT
    # once, so it can afford the deepest model" — and it routed EVERY trivial
    # query to the reasoner, because a floor of 0 makes every model capable and
    # "deepest" then wins. 0 of 10 trivial prompts stayed on the fast path.
    #
    # The honest conclusion is that grounding does not belong in this tie-break
    # at all. The floor already encodes capability; within it, lower TTFT is
    # always better, and it is better by MORE on a grounded turn because TTFT is
    # paid per step. Grounding earns its keep in classify() — where it is real
    # evidence that analytic work is substantial — and in the reason string for
    # observability. Trading capability for latency here would invert the one
    # rule this router is built on.
    best = min(capable, key=lambda c: profile(c).ttft_s)

    tag = "g" if cls.grounded else "s"
    return Decision(best.id, f"{cls.work}:{cls.reasoning}{tag}:{est}t")


__all__ = [
    "Candidate",
    "Classification",
    "Decision",
    "ModelProfile",
    "RouterConfig",
    "Signals",
    "classify",
    "estimate_tokens",
    "replace",
    "select",
    "HEAVY",
    "MODERATE",
    "SIMPLE",
]
