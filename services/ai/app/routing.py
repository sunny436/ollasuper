"""Master Model Router — the proactive half of model selection.

WHY THIS EXISTS. The user used to pick the model from a dropdown, so the product
read as several different bots and the person typing had to understand a roster
to use it. Selection is an implementation detail; this module makes it one.

WHAT IT IS NOT. Not a classifier, not a scoring framework, not a service. It is
one pure function over a list the caller already has. That is a hard requirement,
not a style preference: it runs on the pre-first-token path of every chat turn,
so anything that blocks — a database read, an HTTP call, a model call, a lock —
is a latency regression the user feels directly as "OllaSuper is thinking about
thinking". Budget: P99 < 1ms. See `select()`'s timing note.

WHAT IT DELIBERATELY DOES NOT MODEL, and why (absence here is evidence-based,
not an oversight):

  * TOOLS. The router runs at the `build_llm` site in runner.py, which is BEFORE
    skill selection and tool-spec assembly. Whether this turn needs tools is
    genuinely unknown here, and moving `build_llm` to find out would mean
    restructuring the agentic core for a gate that buys nothing: a model whose
    tool-call deltas break is ALREADY handled at execution time by
    agent/health.streams_tool_calls_cleanly -> non-streaming client.
  * VISION. The catalogue reports `vision: true` for every entry as a cosmetic
    default. Routing on a constant is not routing.
  * COST. Ollima's /v1/models carries no pricing, so every price field is "".

Adding a dimension here requires DATA for that dimension. Inventing a number to
fill a slot would make the policy confidently wrong, which is worse than narrow.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from app.agent import health as model_health
from app.logging import get_logger

log = get_logger(__name__)

# Rough chars-per-token. Only ever used to decide SIMPLE vs HEAVY and to compare
# against a KNOWN context window, never to bill or trim anything — the real
# budgeting lives in agent/budget.py against the model's measured window.
_CHARS_PER_TOKEN = 4


@dataclass(frozen=True)
class ModelProfile:
    """Measured behaviour for one model. Seeded from benchmarks, config-driven.

    The benchmark that seeds these was n=1 per model, one prompt shape, one host,
    one moment. That is enough to order models; it is NOT ground truth. Hence
    config (`ai_router_profiles`) rather than a constant: re-measuring must not
    require a deploy.
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
class Decision:
    model: str
    # Structured, not prose: this is an observability record, not a message.
    reason: str


@dataclass(frozen=True)
class RouterConfig:
    enabled: bool = False
    profiles: dict[str, ModelProfile] = field(default_factory=dict)
    # Above this many estimated prompt+history tokens the turn is HEAVY.
    heavy_token_threshold: int = 1200

    @staticmethod
    def from_settings(enabled: bool, profiles_json: str) -> RouterConfig:
        """Parse once, at Settings load — never on the request path.

        A malformed profile blob disables the router rather than failing a turn:
        the fallback is the behaviour that shipped before this module existed, so
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


def select(
    *,
    cfg: RouterConfig,
    candidates: list[Candidate],
    fallback: str,
    prompt_chars: int,
    history_chars: int,
) -> Decision:
    """Choose the model for this turn. Pure, in-process, no I/O.

    Timing: a filter plus a min() over <=8 items. The only non-trivial cost is
    `model_health.is_exhausted`, an in-process dict lookup with a monotonic
    compare. There is no path through this function that touches a socket, a
    file, or a database.

    EVERY failure returns `fallback`, which is the model the caller would have
    used anyway. Routing can degrade the choice; it can never fail the turn.
    """
    if not cfg.enabled or not candidates:
        return Decision(fallback, "disabled" if not cfg.enabled else "no_candidates")

    est = estimate_tokens(prompt_chars, history_chars)

    # --- hard filters: capability before speed, always -------------------
    healthy: list[Candidate] = []
    for c in candidates:
        if model_health.is_exhausted(c.id):
            continue
        # A KNOWN window that cannot hold the turn disqualifies the model.
        # An UNKNOWN window (0) never does: treating "not measured" as "too
        # small" would silently exclude 7 of 8 models on invented evidence.
        if c.context_window > 0 and est > c.context_window:
            continue
        healthy.append(c)

    if not healthy:
        return Decision(fallback, "all_filtered")

    # --- class: two, deliberately ----------------------------------------
    # More classes would be finer-grained guessing, not finer-grained truth:
    # nothing here reads meaning, only size. Where it is ambiguous the SIMPLE
    # branch wins, and SIMPLE picks a general fast model rather than an
    # aggressive specialist — the safe direction to be wrong in.
    heavy = est >= cfg.heavy_token_threshold

    def profile(c: Candidate) -> ModelProfile:
        return cfg.profiles.get(c.id, ModelProfile())

    if heavy:
        # Deepest reasoner, TTFT as tie-break: a hard question is worth waiting
        # for, a coin-flip between equals is not.
        best = max(
            healthy,
            key=lambda c: (profile(c).reasoning_tier, -profile(c).ttft_s),
        )
        return Decision(best.id, f"heavy:{est}t")

    best = min(healthy, key=lambda c: profile(c).ttft_s)
    return Decision(best.id, f"simple:{est}t")
