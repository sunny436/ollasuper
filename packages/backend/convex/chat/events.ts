import { v } from "convex/values";

/**
 * Typed event protocol (Phase 3), schema version 1.
 *
 * TEXT_DELTA / FINAL / ERROR are represented for protocol completeness, but in
 * the IMPLEMENTATION they ride the existing channels (chatStreamChunks for text,
 * the finishStream/failStream transition for terminal). Only the 6 STRUCTURED
 * types create `chatStreamEvents` rows and flip `chatStreams.hasEvents`.
 *
 * `payload` is a JSON string of the type-specific body — validated at the edges
 * (pydantic on emit, the frontend on render). This keeps Convex free of `v.any()`
 * AND means future payload shapes need no live-schema push (Phase 0: schema
 * pushes on the live self-hosted backend are the highest-risk category).
 */
export const EVENT_TYPES = [
  "TEXT_DELTA",
  "TOOL_CALL",
  "TOOL_RESULT",
  "TOOL_PROGRESS",
  "CITATION",
  "APPROVAL_REQUEST",
  "ARTIFACT",
  // Phase 8: the MODEL's decision at one step (observability trace only — the UI
  // timeline skips it as an unknown kind, so tool-activity rendering is unchanged).
  "MODEL_CALL",
  "FINAL",
  "ERROR",
] as const;

export const eventType = v.union(
  v.literal("TEXT_DELTA"),
  v.literal("TOOL_CALL"),
  v.literal("TOOL_RESULT"),
  v.literal("TOOL_PROGRESS"),
  v.literal("CITATION"),
  v.literal("APPROVAL_REQUEST"),
  v.literal("ARTIFACT"),
  v.literal("MODEL_CALL"),
  v.literal("FINAL"),
  v.literal("ERROR"),
);

/** The stored/persisted shape of one event. Reused by the `chatStreamEvents`
 *  table (live channel) and the `chatMessages.events` array (persisted). */
export const eventFields = {
  eventId: v.string(),
  // Monotonic within a generation, allocated by the writer. Ordering + the
  // (messageId, seq) idempotency probe (mirrors chatStreamChunks).
  seq: v.number(),
  type: eventType,
  // Schema version of the payload body.
  v: v.number(),
  ts: v.number(),
  // Committed-text length when emitted — lets a future phase interleave events
  // with text deterministically. Optional; absent for terminal FINAL/ERROR.
  textOffset: v.optional(v.number()),
  payload: v.string(),
};

export const eventObject = v.object(eventFields);
