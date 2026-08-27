"""Phase 7 — the SEO MUTATION framework: optional, approval-gated site changes.

SAFETY > AUTOMATION. Nothing here runs without the durable approval round-trip (the
write tools classify NEEDS_APPROVAL; see `mutation_policy.py`). This module owns only
the write-tool DEFINITIONS, the rich `ActionPreview` shown before approval, and the
guarded `execute_seo_mutation` wrapper (precondition -> write -> verify -> rollback)
that runs on the approved turn. The real site-write is an INJECTED provider seam
(`SeoWriteProvider`); no real write provider exists yet, so `StubSeoWriteProvider` —
with injectable failure modes — is what the hermetic tests drive.

The mutation RESULT (action/target/before/after/provider/status/verification/rollback)
is posted to Convex `seoMutations.recordResult` for the durable, owner-scoped trail.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, field
from typing import Any, Protocol

from app.models.tools import (
    Availability,
    SideEffect,
    ToolDefinition,
    ToolPermissions,
)
from app.seo.mutation_policy import precheck_mutation

WRITE_PROVIDER = "seo_write"

# tool_id -> the ledger `action` literal (mirrors the Convex seoMutations.action).
ACTION_BY_TOOL_ID: dict[str, str] = {
    "seo_update_metadata": "update_metadata",
    "seo_update_structured_data": "update_structured_data",
    "seo_propose_redirect": "propose_redirect",
    "seo_update_content": "update_content",
}


def _canonical(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, default=str, ensure_ascii=False)


def _hash16(obj: Any) -> str:
    """The 16-char args hash — MIRRORS the executor's approval-id hash so the ledger's
    argsHash lines up with the approval that authorized the write."""
    return hashlib.sha256(_canonical(obj).encode()).hexdigest()[:16]


def _state_hash(state: dict) -> str:
    return hashlib.sha256(_canonical(state).encode()).hexdigest()


def _bounded(obj: Any, limit: int = 8000) -> str:
    s = _canonical(obj)
    return s if len(s) <= limit else s[:limit] + "…"


# --- the write-tool DEFINITIONS ------------------------------------------------


def _write_tool(tool_id: str, summary: str, extra_props: dict) -> ToolDefinition:
    return ToolDefinition(
        tool_id=tool_id,
        name=tool_id,
        description=(
            f"{summary} PROPOSES the change as an ActionPreview and REQUIRES explicit "
            "user approval before it runs; the change is reversible."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "target": {
                    "type": "string",
                    "description": "The absolute URL of the page/resource to change.",
                },
                "changes": {
                    "type": "object",
                    "description": "The proposed new values (intended after-state).",
                    "properties": extra_props,
                },
            },
            "required": ["target", "changes"],
        },
        category="SEO Mutation",
        provider=WRITE_PROVIDER,
        side_effect=SideEffect.EXTERNAL_SIDE_EFFECT,
        permissions=ToolPermissions(
            required_permissions=["seo:write"],
            user_scope=True,
            approval_required=True,
        ),
        # So the executor threads execution_id as the idempotency key (the adapter uses
        # it as the seoMutations idempotency handle -> at-most-once even on resume).
        provider_idempotency_supported=True,
        enabled=True,
        availability=Availability.AVAILABLE,
        required_auth="BearerAuth",  # never AdminToken (that would DENY)
    )


def register_seo_mutation_provider(registry) -> None:
    """Register the SEO write tool set into the registry under provider "seo_write"
    (idempotent, additive; leaves every other provider slice untouched). Called by the
    runner ONLY when ai_seo_mutations_enabled."""
    registry.replace_provider(WRITE_PROVIDER, seo_mutation_tools())


def seo_mutation_tools() -> list[ToolDefinition]:
    """The four reversible SEO write capabilities. Bound ONLY on an interactive turn
    behind `ai_seo_mutations_enabled`; never to the read-only audit/monitoring scope."""
    return [
        _write_tool(
            "seo_update_metadata",
            "Update a page's title / meta description / canonical / meta-robots.",
            {
                "title": {"type": "string"},
                "description": {"type": "string"},
                "canonical": {"type": "string"},
                "robots": {"type": "string"},
            },
        ),
        _write_tool(
            "seo_update_structured_data",
            "Update a page's JSON-LD / structured-data block.",
            {"jsonld": {"type": "object"}},
        ),
        _write_tool(
            "seo_propose_redirect",
            "Record a proposed redirect rule (never deploys server config).",
            {"to": {"type": "string"}, "type": {"type": "string"}},
        ),
        _write_tool(
            "seo_update_content",
            "Update a page's body content.",
            {"content": {"type": "string"}},
        ),
    ]


# --- the provider seam ---------------------------------------------------------


class SeoWriteError(Exception):
    """A provider write failure. `partial` marks a write that applied SOME change
    before failing (so the wrapper must roll back), vs a clean no-op failure."""

    def __init__(self, message: str, *, partial: bool = False) -> None:
        super().__init__(message)
        self.partial = partial


class SeoWriteProvider(Protocol):
    """The injected site-write seam. A real provider (GSC/CMS) is a later drop-in."""

    async def read_state(self, action: str, target: str) -> dict: ...
    async def apply(self, action: str, target: str, changes: dict) -> None: ...
    async def rollback(self, action: str, target: str, before: dict) -> None: ...


@dataclass
class StubSeoWriteProvider:
    """In-memory write provider for hermetic tests. `fail_write` in
    {None,"clean","partial"}, `fail_verify` makes the applied after-state diverge from
    the intent, `fail_rollback` makes compensation raise. Keyed by (action, target)."""

    state: dict[tuple[str, str], dict] = field(default_factory=dict)
    fail_write: str | None = None
    fail_verify: bool = False
    fail_rollback: bool = False
    writes: int = 0
    rollbacks: int = 0

    async def read_state(self, action: str, target: str) -> dict:
        return dict(self.state.get((action, target), {}))

    async def apply(self, action: str, target: str, changes: dict) -> None:
        if self.fail_write == "clean":
            raise SeoWriteError("provider write failed", partial=False)
        before = dict(self.state.get((action, target), {}))
        if self.fail_write == "partial":
            # Apply the FIRST proposed field only, then fail — a genuine partial write.
            first = dict(list(changes.items())[:1])
            self.state[(action, target)] = {**before, **first}
            self.writes += 1
            raise SeoWriteError("provider write failed mid-way", partial=True)
        applied = {**before, **changes}
        if self.fail_verify:
            # after-state won't match the intent -> post-write verification fails.
            applied = {**applied, "_tampered": True}
        self.state[(action, target)] = applied
        self.writes += 1

    async def rollback(self, action: str, target: str, before: dict) -> None:
        if self.fail_rollback:
            raise SeoWriteError("rollback failed")
        self.state[(action, target)] = dict(before)
        self.rollbacks += 1


# --- ActionPreview + ActionResult ----------------------------------------------


@dataclass(frozen=True)
class ActionPreview:
    """The spec's required pre-approval preview (item 1). Shown BEFORE approval; built
    at PARK time by a READ-ONLY before-capture (the handler never runs at park time)."""

    tool_id: str
    action: str
    targets: list[str]
    provider: str
    before: dict
    after: dict
    diff: dict
    before_hash: str
    reversibility: str
    rollback_plan: str
    verification_plan: str
    estimated_cost: dict
    args_hash: str
    expiry_ms: int

    def to_dict(self) -> dict:
        return asdict(self)


# status: succeeded | failed | verification_failed | precondition_failed |
#         rolled_back | rollback_failed
# rollback_status: none | not_needed | succeeded | failed
@dataclass(frozen=True)
class ActionResult:
    """The spec's required mutation result (item 8)."""

    action: str
    target: str
    provider: str
    status: str
    before: dict | None
    after: dict | None
    verification: dict
    rollback_status: str
    reversibility: str = "reversible"
    args_hash: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def _intended_after(before: dict, args: dict) -> dict:
    return {**before, **(args.get("changes") or {})}


def _rollback_plan(action: str) -> str:
    return f"Re-write the captured before-state for this {action} target."


def _verification_plan(action: str) -> str:
    return "Re-read the target after the write and confirm it matches the change."


# --- build the preview (PARK time, read-only) ----------------------------------


async def build_action_preview(
    provider: SeoWriteProvider,
    *,
    tool_id: str,
    args: dict,
    expiry_ms: int,
) -> ActionPreview:
    """Read the live before-state and compute the proposed diff — NO write. The output
    is embedded in the APPROVAL_REQUEST event payload so the user sees the change."""
    action = ACTION_BY_TOOL_ID.get(tool_id, tool_id)
    target = str(args.get("target") or args.get("url") or "")
    before = await provider.read_state(action, target)
    after = _intended_after(before, args)
    diff = {
        k: {"before": before.get(k), "after": v}
        for k, v in (args.get("changes") or {}).items()
    }
    return ActionPreview(
        tool_id=tool_id,
        action=action,
        targets=[target],
        provider=WRITE_PROVIDER,
        before=before,
        after=after,
        diff=diff,
        before_hash=_state_hash(before),
        reversibility="reversible",
        rollback_plan=_rollback_plan(action),
        verification_plan=_verification_plan(action),
        estimated_cost={"unit": "writes", "writes": 1, "token_cost": 0},
        args_hash=_hash16(args),
        expiry_ms=expiry_ms,
    )


# --- execute the mutation (APPROVED turn) --------------------------------------


async def execute_seo_mutation(
    provider: SeoWriteProvider,
    *,
    tool_id: str,
    args: dict,
    expected_before_hash: str | None = None,
) -> ActionResult:
    """Run ONE approved SEO write, guarded end-to-end:

      precondition (A3) -> write -> re-read -> verify -> (on fail/partial) rollback.

    `expected_before_hash` is the ActionPreview's before-hash the user approved: if the
    live before-state has DRIFTED (the page changed between preview and approval) the
    write is ABORTED — never overwrite a stale-approved diff. Returns the auditable
    ActionResult; on any failure the net effect is nothing or reverted (rollback).
    """
    action = ACTION_BY_TOOL_ID.get(tool_id, tool_id)
    target = str(args.get("target") or args.get("url") or "")
    args_hash = _hash16(args)

    before = await provider.read_state(action, target)
    before_hash = _state_hash(before)

    # A3 — stale-approval / precondition guard. Abort BEFORE any write.
    if expected_before_hash is not None and before_hash != expected_before_hash:
        return ActionResult(
            action=action,
            target=target,
            provider=WRITE_PROVIDER,
            status="precondition_failed",
            before=before,
            after=None,
            verification={
                "method": "precondition",
                "passed": False,
                "detail": "target changed since approval; write aborted",
            },
            rollback_status="none",
            args_hash=args_hash,
        )

    intended = _intended_after(before, args)

    # The write.
    try:
        await provider.apply(action, target, args.get("changes") or {})
    except SeoWriteError as e:
        if not e.partial:
            # Clean failure — nothing applied, nothing to roll back.
            return ActionResult(
                action=action,
                target=target,
                provider=WRITE_PROVIDER,
                status="failed",
                before=before,
                after=None,
                verification={
                    "method": "re-read",
                    "passed": False,
                    "detail": str(e),
                },
                rollback_status="none",
                args_hash=args_hash,
            )
        # Partial write — compensate.
        return await _rollback_result(
            provider,
            action,
            target,
            before,
            args_hash,
            detail=f"partial write: {e}",
        )

    # Re-read + verify the effect.
    after = await provider.read_state(action, target)
    if after == intended:
        return ActionResult(
            action=action,
            target=target,
            provider=WRITE_PROVIDER,
            status="succeeded",
            before=before,
            after=after,
            verification={
                "method": "re-read",
                "passed": True,
                "detail": "matches approved change",
            },
            rollback_status="not_needed",
            args_hash=args_hash,
        )

    # Verification failed — revert.
    return await _rollback_result(
        provider,
        action,
        target,
        before,
        args_hash,
        detail="post-write verification mismatch",
    )


async def _rollback_result(
    provider: SeoWriteProvider,
    action: str,
    target: str,
    before: dict,
    args_hash: str,
    *,
    detail: str,
) -> ActionResult:
    try:
        await provider.rollback(action, target, before)
        rollback_status, status = "succeeded", "rolled_back"
    except SeoWriteError:
        rollback_status, status = "failed", "rollback_failed"
    after = await provider.read_state(action, target)
    return ActionResult(
        action=action,
        target=target,
        provider=WRITE_PROVIDER,
        status=status,
        before=before,
        after=after,
        verification={"method": "re-read", "passed": False, "detail": detail},
        rollback_status=rollback_status,
        args_hash=args_hash,
    )


# --- the adapter (executor dispatch target) ------------------------------------


PostResult = Callable[[dict], Awaitable[dict]]


class SeoWriteAdapter:
    """A `ToolAdapter` (see app/agent/adapters.py) for `provider="seo_write"`. The
    executor parks these tools for approval and, on the approved turn, dispatches here.
    This adapter runs the guarded write and posts the durable result to Convex
    `seoMutations.recordResult` via the injected `post_result` (runner: ingress)."""

    def __init__(
        self,
        provider: SeoWriteProvider,
        *,
        stream_id: str,
        post_result: PostResult,
    ) -> None:
        self._provider = provider
        self._stream_id = stream_id
        self._post_result = post_result

    async def build_preview(
        self, tool: ToolDefinition, args: dict, *, ttl_ms: int
    ) -> dict:
        """Called by the executor at PARK time (read-only) to build the ActionPreview
        embedded in the approval — the write handler never runs at park time."""
        preview = await build_action_preview(
            self._provider, tool_id=tool.tool_id, args=args, expiry_ms=ttl_ms
        )
        return preview.to_dict()

    async def call_tool(
        self,
        tool: ToolDefinition,
        payload: dict,
        *,
        input_schema: dict | None = None,
        idempotency_key: str | None = None,
        user_id: str = "",
        workspace_id: str = "",
    ) -> dict:
        tool_id = tool.tool_id
        action = ACTION_BY_TOOL_ID.get(tool_id, tool_id)
        target = str(payload.get("target") or payload.get("url") or "")
        args_hash = _hash16(payload)
        approval_id = f"{tool_id}:{args_hash}"

        # Provider-specific policy — a last hard gate before the (approved) write.
        refusal = precheck_mutation(
            tool_id=tool_id, provider=WRITE_PROVIDER, reversibility="reversible"
        )
        if refusal is not None:
            result = ActionResult(
                action=action,
                target=target,
                provider=WRITE_PROVIDER,
                status="failed",
                before=None,
                after=None,
                verification={"method": "policy", "passed": False, "detail": refusal},
                rollback_status="none",
                args_hash=args_hash,
            )
        else:
            result = await execute_seo_mutation(
                self._provider, tool_id=tool_id, args=payload
            )

        # Durable, owner-scoped ledger record (Convex derives owner from stream).
        cost = _bounded({"unit": "writes", "writes": 1, "token_cost": 0})
        await self._post_result(
            {
                "op": "seo-mutation-result",
                "streamId": self._stream_id,
                "approvalId": approval_id,
                "executionId": idempotency_key,
                "toolId": tool_id,
                "action": result.action,
                "target": result.target,
                "provider": result.provider,
                "argsHash": args_hash,
                "reversibility": result.reversibility,
                "estimatedCost": cost,
                "status": result.status,
                "before": None if result.before is None else _bounded(result.before),
                "after": None if result.after is None else _bounded(result.after),
                "verification": _bounded(result.verification),
                "rollbackStatus": result.rollback_status,
            }
        )
        return {
            "ok": result.status == "succeeded",
            "tool_id": tool_id,
            "data": result.to_dict(),
        }


__all__ = [
    "ACTION_BY_TOOL_ID",
    "ActionPreview",
    "ActionResult",
    "SeoWriteAdapter",
    "SeoWriteError",
    "SeoWriteProvider",
    "StubSeoWriteProvider",
    "build_action_preview",
    "execute_seo_mutation",
    "register_seo_mutation_provider",
    "seo_mutation_tools",
]
