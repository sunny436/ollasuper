"""Wire models for the Convex -> inference-plane contract.

`extra="forbid"` throughout: if Convex starts sending a field this service does
not know about, that should be a loud 400 rather than silently ignored.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ModelId(StrEnum):
    OPUS = "anthropic/claude-opus-5"
    SONNET = "anthropic/claude-sonnet-5"
    HAIKU = "anthropic/claude-haiku-4.5"


#: Max image long-edge per model. Opus/Sonnet 5 are in the high-resolution
#: vision tier; Haiku is not, and sending it a 2576px image just wastes tokens.
IMAGE_LONG_EDGE: dict[str, int] = {
    ModelId.OPUS: 2576,
    ModelId.SONNET: 2576,
    ModelId.HAIKU: 1568,
}

#: Approximate image token cost, subtracted from the context budget. Four
#: images on Opus is ~19k tokens — over half a 32k window.
IMAGE_TOKENS: dict[str, int] = {
    ModelId.OPUS: 4784,
    ModelId.SONNET: 4784,
    ModelId.HAIKU: 1600,
}

CONTEXT_WINDOW: dict[str, int] = {
    ModelId.OPUS: 1_000_000,
    ModelId.SONNET: 1_000_000,
    ModelId.HAIKU: 200_000,
}


class Attachment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    storageId: str
    name: str = Field(max_length=256)
    contentType: str = Field(max_length=128)
    kind: Literal["image", "document", "text"]
    size: int = Field(gt=0)
    extractedText: str | None = None


class HistoryMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["user", "assistant", "system"]
    content: str
    seq: int
    attachments: list[Attachment] = Field(default_factory=list)


class GenerateRequest(BaseModel):
    """Everything needed for one turn.

    History is PUSHED rather than pulled. The Convex action that dispatches has
    already run requireThreadAccess; making this service fetch would mean
    either a second authorization implementation here or a service-key endpoint
    able to read any thread — strictly worse blast radius.
    """

    model_config = ConfigDict(extra="forbid")

    streamId: str
    threadId: str
    messageId: str
    userId: str
    workspaceId: str
    # A plain str, not ModelId: the model list is fetched live from
    # OpenRouter, so an enum here would 422 every model but three. ModelId
    # survives below as the key for the curated per-model tuning tables.
    model: str = Field(default=ModelId.OPUS, min_length=1, max_length=200)
    # Context window for `model`, supplied by Convex from the cached
    # catalogue. 0/absent means unknown and the caller falls back to the
    # conservative default in CONTEXT_WINDOW.
    contextWindow: int = 0
    systemPrompt: str | None = Field(default=None, max_length=8000)
    customInstructionsAbout: str | None = Field(default=None, max_length=2000)
    customInstructionsStyle: str | None = Field(default=None, max_length=2000)
    summary: str | None = Field(default=None, max_length=8000)
    summaryThroughSeq: int = 0
    history: list[HistoryMessage] = Field(default_factory=list, max_length=200)
    titleNeeded: bool = False


class GenerateAccepted(BaseModel):
    accepted: Literal[True] = True
    messageId: str
    model: str


class CancelResult(BaseModel):
    cancelled: bool
    messageId: str
