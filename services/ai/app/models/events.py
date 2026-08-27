"""Typed event protocol (Phase 3), schema version 1.

The single typed source of truth for the agent event protocol. Convex stores the
serialized form (a `type` literal + a JSON `payload` string); this module is what
validates the payload body on emit. Nothing here executes tools or binds them to
the LLM — it is a transport/data contract only.

TEXT_DELTA / FINAL / ERROR are represented for completeness, but in the running
system text rides the existing delta channel and FINAL/ERROR ride the finalize
transition; only the 6 structured types are emitted as events.
"""

from __future__ import annotations

import time
import uuid
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

EVENT_SCHEMA_VERSION = 1


# Phase 8 — the identity contract for the execution ledger. Every record links by
# these; they are NEVER collapsed. request & run = streamId (one generation) ·
# step_id = f"{run}:a{attempt}:s{n}" (one executor pass) · model_call_id (uuid4,
# per model invocation) · execution_id (uuid4, per tool execution) · attempt_id =
# f"{execution_id}:a{n}" (per retry) · tool_call_id (the model's, correlation only)
# · provider_request_id (per outbound provider call: the model's from
# response_metadata, the tool's from the Ollagraph response header) · agent_id /
# skill_id (RESERVED — no agents/skills yet; PolicyScope.agent_id is the placeholder).
# Metrics on the ledger: model + tool duration_ms, input/output tokens, retry
# attempt, terminal state, result_size, provider_request_id, finish_reason;
# latency/TTFT/tokens/cost-basis aggregate on the chatMessages record; approval
# wait is derivable from chatApprovals createdAt->resolvedAt.


class EventType(StrEnum):
    TEXT_DELTA = "TEXT_DELTA"
    TOOL_CALL = "TOOL_CALL"
    TOOL_RESULT = "TOOL_RESULT"
    TOOL_PROGRESS = "TOOL_PROGRESS"
    CITATION = "CITATION"
    APPROVAL_REQUEST = "APPROVAL_REQUEST"
    ARTIFACT = "ARTIFACT"
    # Phase 8: the model's decision at one orchestration step (observability).
    MODEL_CALL = "MODEL_CALL"
    FINAL = "FINAL"
    ERROR = "ERROR"


# --- per-type payload bodies (validated on emit) --------------------------
class _Payload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TextDeltaPayload(_Payload):
    delta: str


# Phase 1: the app-authoritative execution identity + lifecycle state, carried
# additively on the two tool events. All optional (older/absent producers omit
# them) and default None, so this is a backward-compatible schema-v1 addition;
# Convex stores the whole payload as an opaque string and ignores these fields,
# and `collectCompletedTools` keys on the pre-existing call_id/tool_id/status.
class _ExecutionFields(_Payload):
    execution_id: str | None = None
    run_id: str | None = None
    step_id: str | None = None
    attempt_id: str | None = None
    attempt: int | None = None
    state: str | None = None


class ToolCallPayload(_ExecutionFields):
    tool_name: str
    call_id: str
    arguments: dict = Field(default_factory=dict)
    status: str = "running"
    # Phase 7: the DURABLE idempotency key (the seen_calls key: an Ollagraph
    # tool_id or a reserved tool name). tool_call_id is model-generated per turn
    # and not resume-stable, so resume reconstruction keys on this instead.
    tool_id: str | None = None
    # Phase 2: the tool's side-effect class, stamped so the durable event log is
    # SELF-DESCRIBING — resume classifies a crash-orphan (a TOOL_CALL with no
    # TOOL_RESULT) without re-discovering the tool. Absent → resume fails safe
    # (treats it as side-effecting → INDETERMINATE, never re-executes).
    side_effect: str | None = None


class ToolResultPayload(_ExecutionFields):
    call_id: str
    status: str = "success"
    result: dict | None = None
    # Phase 7: the exact ToolMessage content, for durable resume reconstruction
    # (§17). `result` stays the compact UI summary; `content` is the reconstruction
    # source. Ollagraph omits it (its `result` already IS the content); the RAG/
    # memory branches set it because their `result` is only a summary.
    content: str | None = None
    # Phase 8 metrics (all optional, additive): the tool's provider request id, the
    # bounded result size in chars, and the call duration.
    provider_request_id: str | None = None
    result_size: int | None = None
    duration_ms: int | None = None


class ModelCallPayload(_Payload):
    """Phase 8: the model's decision at one orchestration step — the missing
    model-decision half of the trace. Observability only (re-derived on resume, so
    not a recovery record). `decision` is 'text' or 'tools:{n}'."""

    model_call_id: str
    run_id: str | None = None
    model: str
    attempt: int | None = None
    decision: str
    duration_ms: int | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    provider_request_id: str | None = None
    finish_reason: str | None = None
    # Phase 9: the agent identity this model decision belongs to (present only on
    # an agent-run MODEL_CALL; None/omitted for the default assistant). Optional +
    # opaque in Convex, so no schema push.
    agent_id: str | None = None


class ToolProgressPayload(_Payload):
    call_id: str
    progress: float = Field(ge=0.0, le=1.0)
    message: str | None = None


class CitationPayload(_Payload):
    source_id: str
    title: str | None = None
    url: str | None = None
    metadata: dict = Field(default_factory=dict)


class ApprovalRequestPayload(_Payload):
    approval_id: str
    tool_name: str
    reason: str = ""
    status: str = "pending"
    # Phase 7: the rich SEO ActionPreview (targets/diff/before/after/provider/cost/
    # reversibility/rollback/verification/expiry/args-hash) for a mutation approval.
    # Rides the opaque payload STRING Convex already stores (chat/events.ts
    # payload:v.string()) — NO live-schema push, no v.any(). Absent for other approvals.
    preview: dict | None = None


class ArtifactPayload(_Payload):
    artifact_id: str
    artifact_type: str
    metadata: dict = Field(default_factory=dict)


class FinalPayload(_Payload):
    finish_reason: str | None = None


class ErrorPayload(_Payload):
    code: str
    message: str
    retryable: bool = False


PAYLOAD_MODELS: dict[EventType, type[_Payload]] = {
    EventType.TEXT_DELTA: TextDeltaPayload,
    EventType.TOOL_CALL: ToolCallPayload,
    EventType.TOOL_RESULT: ToolResultPayload,
    EventType.TOOL_PROGRESS: ToolProgressPayload,
    EventType.CITATION: CitationPayload,
    EventType.APPROVAL_REQUEST: ApprovalRequestPayload,
    EventType.ARTIFACT: ArtifactPayload,
    EventType.MODEL_CALL: ModelCallPayload,
    EventType.FINAL: FinalPayload,
    EventType.ERROR: ErrorPayload,
}


class EventEnvelope(BaseModel):
    """One typed event. `payload` is the JSON-serialized, validated body of the
    type-specific model. `generationId` (= streamId) is carried for correlation
    but is NOT sent on the wire (the ingress op already scopes by streamId)."""

    model_config = ConfigDict(extra="forbid")

    eventId: str
    generationId: str
    seq: int
    type: EventType
    v: int = EVENT_SCHEMA_VERSION
    ts: int
    textOffset: int | None = None
    payload: str

    def to_wire(self) -> dict:
        """The event dict for the Convex `event` ingress op (no generationId)."""
        wire = {
            "eventId": self.eventId,
            "seq": self.seq,
            "type": str(self.type),
            "v": self.v,
            "ts": self.ts,
            "payload": self.payload,
        }
        if self.textOffset is not None:
            wire["textOffset"] = self.textOffset
        return wire


def make_event(
    type: EventType,
    seq: int,
    *,
    generation_id: str,
    text_offset: int | None = None,
    **body: object,
) -> EventEnvelope:
    """Validate the type-specific body, serialize it, and build an envelope.
    Raises pydantic ValidationError on an invalid body (the emit-edge gate)."""
    model = PAYLOAD_MODELS[type]
    payload = model(**body).model_dump_json()
    return EventEnvelope(
        eventId=str(uuid.uuid4()),
        generationId=generation_id,
        seq=seq,
        type=type,
        v=EVENT_SCHEMA_VERSION,
        ts=int(time.time() * 1000),
        textOffset=text_offset,
        payload=payload,
    )
