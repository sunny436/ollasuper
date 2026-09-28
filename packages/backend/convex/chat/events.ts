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

// ------------------------------------------------------------ document bounds
//
// A finalized assistant message carries the answer AND the folded timeline, and
// Convex refuses a document over 1 MiB - measured in UTF-8 BYTES, not
// characters (400k characters of Devanagari is 1.2 MB). A 451-event research
// turn on production folded to 1.23 MiB: its finalize threw, and so did every
// stall-reaper pass after it. The reaper finalized its batch in one
// transaction, so from then on NO stalled stream anywhere was reaped. These
// bound both halves so a finalize can always commit.

const utf8Size = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length;

/** `text` cut to at most `maxBytes` of UTF-8, never inside a character. */
export function fitUtf8(text: string, maxBytes: number): string {
  if (text.length * 3 <= maxBytes) return text; // a UTF-16 unit is <= 3 bytes
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--; // continuation byte
  return new TextDecoder().decode(bytes.subarray(0, end));
}

function shortenStrings(value: unknown, cap: number): unknown {
  if (typeof value === "string") return value.length > cap ? `${value.slice(0, cap)}…` : value;
  if (Array.isArray(value)) return value.map((x) => shortenStrings(x, cap));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, shortenStrings(x, cap)]));
  }
  return value;
}

function shortenPayload(payload: string, cap: number): string {
  try {
    return JSON.stringify(shortenStrings(JSON.parse(payload), cap));
  } catch {
    return payload.length > cap ? payload.slice(0, cap) : payload;
  }
}

/**
 * The folded timeline within `maxBytes`. Untouched when it fits - every
 * ordinary turn. Past the bound, long strings inside payloads shorten first
 * (every step survives, with less text; payloads stay valid JSON); only if that
 * is still too big do the OLDEST steps go. The last event - the terminal
 * FINAL/ERROR that closes the timeline - always stays.
 */
export function fitEvents<T extends { payload: string }>(events: T[], maxBytes: number): T[] {
  if (utf8Size(events) <= maxBytes) return events;
  let out = events;
  for (const cap of [2_000, 500]) {
    out = out.map((e) => ({ ...e, payload: shortenPayload(e.payload, cap) }));
    if (utf8Size(out) <= maxBytes) return out;
  }
  const last = out.at(-1);
  if (!last) return out;
  const kept: T[] = [];
  let size = utf8Size([last]);
  for (let i = out.length - 2; i >= 0; i--) {
    const e = out[i] as T;
    const s = utf8Size(e) + 1;
    if (size + s > maxBytes) break;
    kept.push(e);
    size += s;
  }
  return [...kept.reverse(), last];
}
