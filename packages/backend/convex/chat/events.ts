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

/**
 * The DISPLAY copy of an event.
 *
 * `TOOL_RESULT.content` is the verbatim, injection-framed model-context block
 * (services/ai/app/models/events.py ToolResultPayload.content). It exists for
 * ONE reader: durable resume, which rebuilds the tool's ToolMessage from the
 * live `chatStreamEvents` row (stream.ts dispatchPayload → completedTools).
 * The browser's parser drops it at parse time (chat/_lib/agent-events.ts,
 * rule 1) so no component can render it — yet it was 74 % of every byte in
 * `chatMessages` on production (35 MB of 47 MB of folded events, 60 MB total),
 * re-sent with every transcript page and every stream.active push.
 *
 * So the live table keeps it and every DISPLAY path drops it: the fold into
 * `chatMessages.events` at finalize (new messages shrink at the source, which
 * is also what buildHistory reads), plus toPublic and stream.active for
 * messages folded before this existed. Cheap: a substring check before any
 * JSON work, and TOOL_RESULT only.
 */
export function stripForDisplay<T extends { type: string; payload: string }>(
  e: T,
): T {
  if (e.type !== "TOOL_RESULT" || !e.payload.includes('"content"')) return e;
  try {
    const b: unknown = JSON.parse(e.payload);
    if (!b || typeof b !== "object" || !("content" in b)) return e;
    const { content: _dropped, ...rest } = b as Record<string, unknown>;
    return { ...e, payload: JSON.stringify(rest) };
  } catch {
    return e;
  }
}
