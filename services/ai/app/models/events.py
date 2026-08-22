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


class EventType(StrEnum):
    TEXT_DELTA = "TEXT_DELTA"
    TOOL_CALL = "TOOL_CALL"
    TOOL_RESULT = "TOOL_RESULT"
    TOOL_PROGRESS = "TOOL_PROGRESS"
    CITATION = "CITATION"
    APPROVAL_REQUEST = "APPROVAL_REQUEST"
    ARTIFACT = "ARTIFACT"
    FINAL = "FINAL"
    ERROR = "ERROR"


# --- per-type payload bodies (validated on emit) --------------------------
class _Payload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TextDeltaPayload(_Payload):
    delta: str


class ToolCallPayload(_Payload):
    tool_name: str
    call_id: str
    arguments: dict = Field(default_factory=dict)
    status: str = "running"


class ToolResultPayload(_Payload):
    call_id: str
    status: str = "success"
    result: dict | None = None


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
