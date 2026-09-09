"""Phase 6 — turning a DECLARED capability into a BOUND tool, safely.

A skill says what it prefers to work with. This module decides what that
actually means at runtime, and the whole design is one sentence:

    A declaration widens what is RELEVANT. It never widens what is ALLOWED.

Nothing here registers a tool, defines a schema, imports a module, or reaches a
network endpoint. Every path is a LOOKUP against a catalogue the platform owns,
followed by the same authorization predicate discovery already applies.

---------------------------------------------------------------------------
THE BUG THIS FIXES
---------------------------------------------------------------------------

`reserve_skill_tools` (runner.py) exists because "the blog skill declares 34
blog.* capabilities and the real blog turn bound NONE of them". It resolves a
declaration with `registry.get(name)` — a literal tool-id lookup.

But skills do not declare tool ids. They declare INTENTS, which is the whole
point of `orchestrator/intents.py`: "a thin, stable naming layer OVER the
existing tool metadata, so a skill references `page.fetch` rather than an
unstable provider tool_id". The real ids are provider operation ids:

    intent  blog.serp_research  ->  tool  search_endpoint_v1_search_post

Measured against the shipped catalogue: of everything the blog and SEO skills
declare, 100% are intents and 0% are registered tool ids. So every
`registry.get(...)` returned None, every declaration was skipped, and the fix
for "bound NONE of them" bound none of them. The telemetry said so all along —
`agent.skill_tools_reserved` logs `declared: N, added: 0`.

Resolving through the intent map is what makes a declaration mean anything, for
built-in and user skills alike.

---------------------------------------------------------------------------
WHY A USER MAY DECLARE INTENTS AND NOT TOOL IDS
---------------------------------------------------------------------------

Provider tool ids are operation ids from an OpenAPI document. They change when
the provider changes, they differ between deployments, and
`search_endpoint_v1_search_post` is not something a person should ever type.
Intents are ours: stable, few, human-meaningful, and enumerable — which is what
makes an authoritative catalogue possible at all, and what a picker can list.

So a user declaration is checked against `INTENT_MAP` and nothing else. A raw
tool id from a user is refused, not because it would escalate (it could not —
every gate below still runs) but because accepting it would put an unstable,
provider-shaped, unbounded namespace in front of people, and would silently
break their skills whenever the provider redeployed.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.agent.policy import PolicyScope, check_tool_policy
from app.logging import get_logger
from app.models.tools import ToolFilters
from app.orchestrator.intents import intent_spec
from app.tools.registry import ToolRegistry
from app.tools.selection import ToolSelector, _passes

log = get_logger(__name__)

# How many tools one intent may contribute. An intent is a small idea ("fetch a
# page"), so a handful of matches covers it; without a cap, one declaration
# could flood the candidate list and crowd out everything discovery found.
DEFAULT_TOOLS_PER_INTENT = 3


@dataclass(frozen=True, slots=True)
class BoundCapabilities:
    """What each declaration actually became — including the failures.

    The failure lists are the point. `reserve_skill_tools` skips silently, which
    is how a declaration could be broken for every skill in the product without
    anyone noticing. A user who declares a capability and does not get it is
    owed a reason, and an operator is owed a log line that names it.
    """

    tool_ids: list[str] = field(default_factory=list)
    unknown: list[str] = field(default_factory=list)
    unresolved: list[str] = field(default_factory=list)
    unauthorized: list[str] = field(default_factory=list)
    unavailable: list[str] = field(default_factory=list)

    @property
    def any_failures(self) -> bool:
        return bool(self.unknown or self.unresolved or self.unauthorized)


EMPTY_CAPABILITIES = BoundCapabilities()


def resolve_capabilities(
    names,
    *,
    registry: ToolRegistry,
    selector: ToolSelector,
    filters: ToolFilters,
    scope: PolicyScope | None = None,
    intents_only: bool = False,
    limit_per: int = DEFAULT_TOOLS_PER_INTENT,
) -> BoundCapabilities:
    """Declared names -> the tool ids they may actually contribute.

    THE CHAIN, in order, with nothing skipped:

      1. EXISTENCE      the name is in the authoritative catalogue (INTENT_MAP),
                        or — for a built-in, which may still use the documented
                        literal-tool-id form — a registered tool.
      2. RESOLUTION     the intent's canonical query runs through the SAME
                        deterministic selector everything else uses. No new
                        ranking, no per-intent special case.
      3. AVAILABILITY   a disabled or unavailable tool is reported, not bound.
      4. AUTHORIZATION  `_passes` against the CALLER's filters — the caller's
                        granted permissions and side-effect ceiling, both
                        derived from the authenticated request's scope.

    And then, outside this function and unchanged: `check_tool_policy` re-decides
    per call at the execution choke point, approval is required where the tool
    demands it, and the executor's own gates run. This function only decides
    what the model is OFFERED.

    `intents_only=True` for user-authored declarations — see the module
    docstring for why a raw tool id is refused there.
    """
    out_ids: list[str] = []
    unknown: list[str] = []
    unresolved: list[str] = []
    unauthorized: list[str] = []
    unavailable: list[str] = []
    seen: set[str] = set()

    for name in sorted({n for n in names if isinstance(n, str) and n.strip()}):
        spec = intent_spec(name)
        if spec is None:
            # Not an intent. A built-in may still name a tool directly (the
            # backward-compatible form `is_intent` documents); a user may not.
            direct = None if intents_only else registry.get(name)
            if direct is None:
                unknown.append(name)
                continue
            if not _passes(direct, filters):
                (unavailable if not direct.enabled else unauthorized).append(name)
                continue
            if direct.tool_id not in seen:
                seen.add(direct.tool_id)
                out_ids.append(direct.tool_id)
            continue

        query = spec.get("query")
        if not isinstance(query, str) or not query.strip():
            unresolved.append(name)
            continue

        # Rank with availability-only filters so the outcome can be REPORTED
        # precisely: selecting with the caller's filters would hide a denied
        # tool as if it did not exist, and "you may not use this" and "this
        # deployment does not have this" are different answers to the user.
        matches = selector.select(
            query,
            top_k=limit_per,
            filters=ToolFilters(include_disabled=True, include_unavailable=True),
            min_score=None,
        ).candidates
        if not matches:
            unresolved.append(name)
            continue

        kept = 0
        blocked_reason = ""
        for c in matches:
            tool = c.tool
            if _passes(tool, filters):
                if tool.tool_id not in seen:
                    seen.add(tool.tool_id)
                    out_ids.append(tool.tool_id)
                kept += 1
                continue
            if not tool.enabled or blocked_reason == "":
                blocked_reason = "unavailable" if not tool.enabled else "unauthorized"
        if kept == 0:
            # Matched real tools, but none this caller may be offered. An admin
            # tool, a write tool under a read-only ceiling, a disabled provider.
            (unavailable if blocked_reason == "unavailable" else unauthorized).append(
                name
            )

    if scope is not None and out_ids:
        # The admin-token rule lives ONLY in `check_tool_policy` — `_passes` has
        # no concept of it — so a tool requiring an AdminToken passes every
        # filter above and is then hard-denied at execution. Binding it would
        # offer the model a capability that can only ever fail, and would make
        # this function's "reserved" list a lie. Drop it here instead.
        keep, denied = [], []
        for tid in out_ids:
            tool = registry.get(tid)
            if tool is not None and check_tool_policy(tool, scope).denied:
                denied.append(tid)
            else:
                keep.append(tid)
        out_ids, unauthorized = keep, [*unauthorized, *denied]

    return BoundCapabilities(
        tool_ids=out_ids,
        unknown=unknown,
        unresolved=unresolved,
        unauthorized=unauthorized,
        unavailable=unavailable,
    )


def user_capability_catalog(settings) -> list[dict]:
    """What a user may put in their skill's `capabilities`, for the picker.

    Deliberately NOT read from the global `INTENT_MAP`. That map is populated as
    a side effect of `build_live_runtime`, which runs per generation, so a fresh
    process would serve an empty catalogue until somebody happened to chat
    first. `effective_intent_maps` composes the same set deterministically from
    the flags, with no startup order to get wrong.

    Ids only, grouped by their prefix. The id IS the label: intents are named
    for humans (`page.fetch`, `blog.serp_research`) precisely so this layer can
    be shown to one. No descriptions yet — they live on the per-domain
    capability objects and the intent map drops them, and inventing a second
    place to write them is how the two would drift.

    Reflects THIS deployment: a capability whose flag is off is not offered,
    because declaring it would resolve to nothing and the user would have no way
    to find out why.
    """
    from app.orchestrator.intents import INTENT_MAP
    from app.runtime.roster import effective_intent_maps

    # Core intents are always present; flag-gated ones only when enabled.
    names = sorted({*INTENT_MAP, *effective_intent_maps(settings)})
    out: list[dict] = []
    for name in names:
        group = name.split(".", 1)[0] if "." in name else "general"
        out.append({"id": name, "group": group})
    return out
