/**
 * Client-side accumulation of a streamed reply.
 *
 * `chat.stream.active` no longer carries the whole answer on every push — that
 * made the wire quadratic in the answer length (a p99 answer of 28k chars over
 * 121 flushes was ~1.7 MB through the socket). It carries the RESIDENT chunks
 * (those after `committedSeq`) plus `committedSeq` itself. The client keeps the
 * text it has already seen and appends only new chunks. A chunk stays resident
 * for 24 flushes before compaction folds it into the committed prefix, and a
 * subscriber receives every push, so in steady state nothing is ever missed.
 *
 * A gap opens only when the subscriber was not there for a compaction: a
 * mid-stream mount, a reload, a reconnect. Then `committedSeq` is ahead of what
 * we hold, and the prefix is fetched ONCE through `chat.stream.committed`
 * (`needsCommitted`), after which the subscription is dropped again.
 *
 * Pure so it can be unit-tested; message-list.tsx owns the state.
 */
export type LiveTail = {
  messageId: string;
  committedSeq: number;
  chunks: { seq: number; text: string }[];
};

export type CommittedPrefix = {
  messageId: string;
  committedSeq: number;
  committedText: string;
};

export type Accumulated = {
  messageId: string;
  /** Every chunk with seq <= upToSeq is in `text`. -1 = nothing yet. */
  upToSeq: number;
  text: string;
};

/** True when the prefix up to `live.committedSeq` is not in `acc`. */
export function needsCommitted(
  acc: Accumulated | null,
  live: LiveTail | null | undefined,
): boolean {
  if (!live) return false;
  if (!acc || acc.messageId !== live.messageId) return live.committedSeq > -1;
  return live.committedSeq > acc.upToSeq;
}

/**
 * Fold one push (and, when present, the committed prefix) into the
 * accumulator. Returns the same object when nothing changed, so callers can
 * compare by identity.
 *
 * While a gap is open and the prefix has not arrived, resident chunks are NOT
 * appended — they belong after the missing text — and the previous text (if
 * any) is kept on screen.
 */
export function accumulate(
  acc: Accumulated | null,
  live: LiveTail | null | undefined,
  committed: CommittedPrefix | null | undefined,
): Accumulated | null {
  if (!live) return null;
  let next: Accumulated =
    acc && acc.messageId === live.messageId
      ? acc
      : { messageId: live.messageId, upToSeq: -1, text: "" };
  let changed = next !== acc;

  if (live.committedSeq > next.upToSeq) {
    // Gap: only the committed prefix can close it.
    if (
      committed &&
      committed.messageId === live.messageId &&
      committed.committedSeq >= live.committedSeq
    ) {
      next = {
        messageId: next.messageId,
        upToSeq: committed.committedSeq,
        text: committed.committedText,
      };
      changed = true;
    } else {
      return changed ? next : acc;
    }
  }

  // Append the resident chunks we have not seen, in seq order. Seqs may have
  // holes (the writer drops a batch under back-pressure and finalize repairs
  // the text), so "unseen" means "above what we hold", not "next integer".
  const fresh = live.chunks
    .filter((c) => c.seq > next.upToSeq)
    .sort((a, b) => a.seq - b.seq);
  if (fresh.length === 0) return changed ? next : acc;
  return {
    messageId: next.messageId,
    upToSeq: fresh[fresh.length - 1]?.seq ?? next.upToSeq,
    text: next.text + fresh.map((c) => c.text).join(""),
  };
}
