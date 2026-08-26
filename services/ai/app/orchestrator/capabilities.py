"""Phase 10 — capability resolution (the DISCOVERY layer).

Answers "what capabilities MIGHT help?" over the FULL registry — NOT a top-K
reachability slice. It reuses the deterministic `ToolSelector` (Phase 2) and adds
nothing to ranking; its job is to keep DISCOVERY separate from AUTHORIZATION and
EXECUTION:

  * DISCOVERY (here)      — search the whole registry; NO permission prefilter.
  * AUTHORIZATION (annot) — each match is stamped with its check_tool_policy
                            status so the model + orchestrator know what is usable,
                            without discovery deciding it.
  * EXECUTION (executor)  — the Phase 1-8 gates still enforce authorization per
                            call; discovery never runs anything.

The Top-K ceiling is removed by CONSTRUCTION: `limit` bounds only how many matches
are surfaced per query, and the model reaches any capability by refining the query
(there is no global cap on what is reachable).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from app.agent.policy import PolicyScope, check_tool_policy
from app.models.tools import ToolCandidate, ToolDefinition, ToolFilters
from app.orchestrator.intents import intent_spec

if TYPE_CHECKING:
    from app.tools.registry import ToolRegistry
    from app.tools.selection import ToolSelector


@dataclass(frozen=True, slots=True)
class ResolvedCapability:
    """One discovered capability + its authorization annotation (discovery does
    NOT authorize — this only records what the policy WOULD decide)."""

    candidate: ToolCandidate
    score: float
    auth_status: str  # "allow" | "needs_approval" | "deny"

    @property
    def tool(self) -> ToolDefinition:
        return self.candidate.tool


class CapabilityResolver:
    """DISCOVERY over the full registry. Reuses the ToolSelector; annotates
    authorization; never executes."""

    def __init__(
        self, registry: ToolRegistry, selector: ToolSelector, *, default_limit: int = 10
    ) -> None:
        self._registry = registry
        self._selector = selector
        self._default_limit = default_limit

    def resolve(
        self,
        query: str,
        *,
        limit: int | None = None,
        scope: PolicyScope | None = None,
        min_score: float | None = None,
    ) -> list[ResolvedCapability]:
        """Rank the FULL registry for `query` and annotate each match with its
        authorization status. NO `granted_permissions` prefilter — discovery
        surfaces what might help; authorization is annotated + enforced separately.
        `limit` bounds surfacing per query, not reachability."""
        if not isinstance(query, str) or not query.strip():
            return []
        k = limit or self._default_limit
        result = self._selector.select(
            query,
            top_k=k,
            filters=ToolFilters(),  # availability/enabled only — no permission gate
            min_score=min_score,
        )
        return [
            ResolvedCapability(
                candidate=c,
                score=c.score,
                auth_status=self._auth(c.tool, scope),
            )
            for c in result.candidates
        ]

    def by_ids(
        self, ids, *, scope: PolicyScope | None = None
    ) -> list[ResolvedCapability]:
        """Resolve explicit tool_id hints (e.g. a skill's `preferred_capabilities`)
        to annotated candidates. DISCOVERY only — score 1.0 (skill-recommended);
        execution still enforces authorization per call. Unknown ids are skipped."""
        out: list[ResolvedCapability] = []
        for tid in ids:
            tool = self._registry.get(tid)
            if tool is None:
                continue
            cand = ToolCandidate(tool=tool, score=1.0, reason="skill-recommended")
            out.append(
                ResolvedCapability(
                    candidate=cand, score=1.0, auth_status=self._auth(tool, scope)
                )
            )
        return out

    def by_intents(
        self, intents, *, scope: PolicyScope | None = None, limit_per: int = 3
    ) -> tuple[list[ResolvedCapability], list[str]]:
        """Resolve capability INTENTS (e.g. `page.fetch`) to annotated candidates
        via the intent map + the deterministic selector. Returns
        `(resolved, unresolved_intents)` so the caller can report capability gaps.
        Unknown intents / intents that match no tool go to `unresolved`."""
        out: list[ResolvedCapability] = []
        unresolved: list[str] = []
        seen: set[str] = set()
        for name in intents:
            spec = intent_spec(name)
            if spec is None:
                unresolved.append(name)
                continue
            mse = spec.get("max_side_effect")
            filters = (
                ToolFilters(max_side_effect=mse)
                if mse is not None
                else ToolFilters()
            )
            result = self._selector.select(
                spec["query"], top_k=limit_per, filters=filters, min_score=None
            )
            hit = False
            for c in result.candidates:
                if c.tool.tool_id in seen:
                    continue
                seen.add(c.tool.tool_id)
                out.append(
                    ResolvedCapability(
                        candidate=c,
                        score=c.score,
                        auth_status=self._auth(c.tool, scope),
                    )
                )
                hit = True
            if not hit:
                unresolved.append(name)
        return out, unresolved

    @staticmethod
    def _auth(tool: ToolDefinition, scope: PolicyScope | None) -> str:
        if scope is None:
            return "allow"
        decision = check_tool_policy(tool, scope)
        if decision.allowed:
            return "allow"
        if decision.needs_approval:
            return "needs_approval"
        return "deny"
