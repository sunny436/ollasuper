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


class MemoryItem(BaseModel):
    """One long-term memory pre-loaded into the turn by Convex dispatchPayload.

    The set is already scope-authorized server-side (derived from the stream's
    userId), so the agent's `search_memory` tool only RANKS this pool — it never
    widens scope. `content` is capped to match the Convex write cap."""

    model_config = ConfigDict(extra="forbid")

    id: str
    kind: str = Field(max_length=40)
    content: str = Field(max_length=2000)
    source: str = Field(default="explicit", max_length=20)


class CompletedTool(BaseModel):
    """Phase 7 — one already-executed tool step, reconstructed by Convex from the
    LIVE chatStreamEvents (a TOOL_CALL + its TOOL_RESULT) when a crashed turn is
    resumed. The runner rebuilds `AIMessage(tool_calls) + ToolMessage(result)`
    from these so completed (side-effecting) tools are NEVER re-executed."""

    model_config = ConfigDict(extra="forbid")

    toolId: str = Field(max_length=200)
    args: dict = Field(default_factory=dict)
    resultContent: str = Field(default="", max_length=16000)


class AttemptedTool(BaseModel):
    """Phase 2 — a side-effecting tool that was ATTEMPTED but whose outcome is
    unknown (crash-orphan TOOL_CALL, or a recorded INDETERMINATE). On resume the
    runner injects an 'outcome unknown; not retried' observation and seeds the
    dedup guards so it is NEVER re-executed (at-most-once)."""

    model_config = ConfigDict(extra="forbid")

    toolId: str = Field(max_length=200)
    args: dict = Field(default_factory=dict)


class ApprovedPending(BaseModel):
    """Phase 3 — an approved tool that was parked WAITING_APPROVAL and never got to
    run before the crash/suspend. Carries the DURABLE args + the server-minted
    token, so the runner EXECUTES it directly on resume (no model re-emission).
    Reconstructed from the durable `toolExecutions` table."""

    model_config = ConfigDict(extra="forbid")

    toolId: str = Field(max_length=200)
    args: dict = Field(default_factory=dict)
    token: str = Field(max_length=200)
    approvalId: str = Field(max_length=200)


class ApprovalDecision(BaseModel):
    """Phase 8 — a resolved tool-approval decision, threaded back on the resume
    dispatch. `token` (server-minted on approve, never seen by the model) is the
    ONLY execute capability: absent / rejected / expired never runs the tool."""

    model_config = ConfigDict(extra="forbid")

    approvalId: str = Field(max_length=200)
    toolId: str = Field(max_length=200)
    # A5: new approvals send the 16-char args HASH as the key, so this is tiny in
    # steady state. The ceiling is RAISED (not lowered) to the turn-char budget so
    # a pre-A5 row whose `argsKey` is a full args JSON — written by the old worker
    # and threaded across the Python deploy — still validates instead of 422-ing
    # the resume. `argsKey` is store/observability only; matching is by approvalId.
    argsKey: str = Field(default="", max_length=48_000)
    decision: str = Field(max_length=20)
    token: str | None = Field(default=None, max_length=200)


class ResearchFindingSeed(BaseModel):
    """One COMPACT prior finding, replayed on resume so it is not re-researched.
    Bounded; carries provenance (source + date) but NOT the raw source text."""

    model_config = ConfigDict(extra="ignore")

    subquestion: str = Field(default="", max_length=200)
    claim: str = Field(default="", max_length=600)
    sourceUrl: str = Field(default="", max_length=2000)
    sourceTitle: str = Field(default="", max_length=200)
    sourceDate: str = Field(default="", max_length=200)
    confidence: str = Field(default="", max_length=20)


class ActiveResearchRun(BaseModel):
    """The COMPACT, owner-scoped resume seed for the thread's incomplete research run
    (read by Convex from `researchRuns`, never client-sent). Injected into the prompt
    so the model continues OPEN sub-questions without repeating completed ones. Kept
    compact (completed sub-questions + key findings, not raw evidence) to respect the
    turn budget. `extra="ignore"` so a schema that adds fields never 400s Python."""

    model_config = ConfigDict(extra="ignore")

    runId: str = Field(default="", max_length=200)
    objective: str = Field(default="", max_length=600)
    status: str = Field(default="", max_length=40)
    timeSensitive: bool = False
    subquestions: list[str] = Field(default_factory=list, max_length=32)
    completed: list[str] = Field(default_factory=list, max_length=32)
    findings: list[ResearchFindingSeed] = Field(default_factory=list, max_length=60)
    sourceCount: int = 0


class Dataset(BaseModel):
    """A thread's tabular attachment (CSV/XLSX), surfaced EVERY turn so follow-ups
    analyse the same data without re-uploading. `storageId` is the server-side fetch
    capability (thread-scoped); it is resolved by NAME and never shown to the model."""

    model_config = ConfigDict(extra="ignore")

    name: str = Field(default="", max_length=256)
    storageId: str = Field(default="", max_length=200)
    mime: str = Field(default="", max_length=200)


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
    # Phase 5: the AUTHORITATIVE caller identity threaded into the per-turn scope
    # + the outbound Ollagraph tenant/user headers. Required non-empty so an empty
    # identity fails loud at the API boundary and can never silently omit the
    # isolation scope (dispatchPayload always supplies these from the
    # authenticated stream).
    userId: str = Field(min_length=1, max_length=200)
    workspaceId: str = Field(min_length=1, max_length=200)
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
    # >0 when the user has ready knowledge-base files; gates RAG retrieval so
    # users with no files pay no extra latency. Computed in Convex dispatchPayload.
    ragFileCount: int = 0
    # Phase 6 long-term memory. `memoryEnabled` is the user's setting (default
    # false here so an older Convex deploy that omits it disables memory safely);
    # `memories` is the bounded, scope-authorized active set Convex pre-loaded for
    # this turn. Both default so `extra="forbid"` never 400s a pre-Phase-6 caller.
    memoryEnabled: bool = False
    memories: list[MemoryItem] = Field(default_factory=list, max_length=200)
    # Phase 7 durable resume. All default so `extra="forbid"` never 400s a caller
    # that predates Phase 7. `attempt` > 0 means this is a reaper-driven resume of
    # a crashed turn: `completedTools` reconstructs the already-run steps (so they
    # are not re-executed), `eventSeqBaseline` continues the typed-event seq space
    # (so resumed events don't collide with survivors), and `deadlineAt` (epoch ms)
    # bounds the whole turn.
    attempt: int = 0
    deadlineAt: int = 0
    # Phase 2 (Scheduled Tasks): this turn runs UNATTENDED — no human is present
    # to approve anything. Two consequences downstream, both security-relevant:
    #   * the agent is pinned to READ_ONLY scope regardless of the global
    #     ai_agent_side_effect_enabled flag (an operator enabling side effects
    #     for interactive chat must not silently elevate background jobs);
    #   * a tool that needs approval is REFUSED, not parked — a parked turn would
    #     hang until the approval reaper expired it.
    # Defaulted False so extra="forbid" never 400s a caller that predates this.
    unattended: bool = False
    completedTools: list[CompletedTool] = Field(default_factory=list, max_length=64)
    # Phase 2: side-effecting tools attempted with an UNKNOWN outcome (crash /
    # INDETERMINATE). Replayed as an 'outcome unknown; not retried' observation +
    # seeded into the dedup guards so they are never re-executed. Default-empty so
    # extra="forbid" never 400s a pre-Phase-2 caller.
    attemptedTools: list[AttemptedTool] = Field(default_factory=list, max_length=64)
    # Phase 3: approved-but-not-yet-run parked tools, reconstructed from the durable
    # toolExecutions table. The runner executes them DIRECTLY on resume (deterministic
    # continuation — no model re-emission). Default-empty so a pre-Phase-3 Convex that
    # omits it is fine, and extra="forbid" never 400s (deploy Python before Convex).
    approvedPending: list[ApprovedPending] = Field(default_factory=list, max_length=64)
    eventSeqBaseline: int = 0
    # Phase 8: resolved approval decisions for this stream (empty on a normal
    # turn). Default-empty so extra="forbid" never 400s a pre-Phase-8 caller.
    approvals: list[ApprovalDecision] = Field(default_factory=list, max_length=64)
    # Deep Research: the compact resume seed for the thread's incomplete research run
    # (Convex reads it owner-scoped from researchRuns). None on every non-research
    # turn and for callers that predate this field (default => extra="forbid" safe).
    activeResearchRun: ActiveResearchRun | None = None
    # Data Analysis: the thread's tabular attachments (Convex lists them owner-scoped
    # every turn) so a follow-up analyses the same dataset without re-uploading.
    # Empty on non-data threads and pre-field callers (default => extra="forbid" safe).
    datasets: list[Dataset] = Field(default_factory=list, max_length=32)


class GenerateAccepted(BaseModel):
    accepted: Literal[True] = True
    messageId: str
    model: str


class CancelResult(BaseModel):
    cancelled: bool
    messageId: str


class TitleRequest(BaseModel):
    """First user input + first assistant output — the only context a title needs."""

    model_config = ConfigDict(extra="forbid")

    firstUser: str = Field(min_length=1, max_length=8000)
    firstAssistant: str = Field(min_length=1, max_length=16000)


class TitleResponse(BaseModel):
    # Empty string signals "no usable title" — Convex keeps the existing title.
    title: str


class IngestRequest(BaseModel):
    """A file to ingest into the knowledge base. ids are opaque Convex strings;
    ingestId is the capability used to fetch bytes + report status."""

    model_config = ConfigDict(extra="forbid")

    ingestId: str = Field(min_length=1, max_length=200)
    userId: str = Field(min_length=1, max_length=200)
    workspaceId: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=500)
    contentType: str = Field(default="application/octet-stream", max_length=300)
    size: int = Field(ge=0)


class IngestAccepted(BaseModel):
    ingestId: str
