/**
 * Client-side accumulation of a streamed reply's TYPED EVENTS.
 *
 * Same problem as stream-text.ts, one query along. `chat.stream.events` used to
 * return every event of the turn on every append, so a tool turn paid
 * O(k²) on the wire: measured on production 2026-09-24, a 733-character answer
 * that used tools sent 47,406 bytes over 16 pushes (growing to 6,367 each) —
 * 43% of that whole turn's socket traffic, and the largest single line item.
 *
 * So the query takes an `afterSeq` and returns only what is newer, and the
 * client keeps what it has already seen. Each push then costs one event instead
 * of the whole timeline.
 *
 * WHY THIS CANNOT DROP AN EVENT. Moving `afterSeq` swaps one subscription for
 * another, and the replacement is computed from the database, not from a diff:
 * it returns everything with `seq > afterSeq` at the moment it runs, so an
 * event appended during the swap is in the next result rather than lost. Events
 * are append-only and `seq` is monotonic per message, which is what makes
 * "everything above the high-water mark" a complete description of the rest.
 *
 * Belt and braces anyway: append dedupes on `eventId`, because the SAME event
 * legitimately arrives twice — once in the result that raised the high-water
 * mark, and once more if a re-execution of the old subscription lands after it.
 *
 * Pure so it can be unit-tested; message-list.tsx owns the state.
 */
import type { TypedEvent } from "./agent-events";

export type EventAcc = {
  messageId: string;
  /** Every event with seq <= maxSeq is in `events`. -1 = nothing yet. */
  maxSeq: number;
  events: TypedEvent[];
};

/**
 * The high-water mark to ask for next, or undefined for "everything".
 *
 * Undefined on a different message — a mid-stream mount, a reload, a reconnect,
 * or simply the next reply — so a fresh subscriber gets the whole (bounded)
 * timeline exactly as it did before.
 */
export function afterSeqFor(
  acc: EventAcc | null,
  messageId: string | null,
): number | undefined {
  if (!messageId || !acc || acc.messageId !== messageId) return undefined;
  return acc.maxSeq < 0 ? undefined : acc.maxSeq;
}

/**
 * Fold a result into the accumulator. Returns the SAME object when nothing
 * changed, so React can skip the re-render.
 */
export function accumulateEvents(
  acc: EventAcc | null,
  messageId: string | null,
  incoming: TypedEvent[] | null | undefined,
): EventAcc | null {
  if (!messageId) return null;
  const base: EventAcc =
    acc && acc.messageId === messageId
      ? acc
      : { messageId, maxSeq: -1, events: [] };
  if (!incoming || incoming.length === 0) return base;

  const seen = new Set(base.events.map((e) => e.eventId));
  const added = incoming.filter((e) => !seen.has(e.eventId));
  if (added.length === 0) return base;

  // Sorted by seq: the query returns them ordered, but a swap of `afterSeq`
  // can interleave two results, and the timeline reads this array in order.
  const events = [...base.events, ...added].sort((a, b) => a.seq - b.seq);
  const maxSeq = events.reduce((m, e) => (e.seq > m ? e.seq : m), base.maxSeq);
  return { messageId, maxSeq, events };
}
