"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import {
  attachmentNote,
  type DeliveryRow,
  deliveryLabel,
  TONE_CLASS,
} from "../_lib/delivery-format";
import {
  ChatMessage,
  type ChatMessageDoc,
} from "../../chat/_components/chat-message";
import {
  formatInstant,
  runErrorCopy,
  runStatusLabel,
} from "../_lib/schedule-format";

/**
 * One execution's result, rendered with the SAME <ChatMessage> the chat
 * transcript uses — so markdown, code, charts, mermaid, sources and artifacts
 * all work with no second renderer and no second result store.
 *
 * `hideExecutionMeta` is what makes it a RESULT rather than a run log: it drops
 * MessageMeta (the model name) and AgentActivity (step count, tool calls, the
 * agent trace), so the reader sees the report they asked for. Sources survive —
 * citations are part of the answer. None of it is deleted from the database;
 * the execution record stays whole for observability, it is just not rendered.
 *
 * `readOnly` is not cosmetic: ChatMessage wires retry / regenerate / edit
 * mutations, and every one of them is refused on a scheduled thread by the
 * Phase 2 guard. Without the flag the viewer would show three buttons that
 * always throw "Not found" — and ErrorNotice's own Retry appears on exactly the
 * failed runs a user is most likely to click.
 */
export function RunResult({
  taskId,
  occurrenceId,
}: {
  taskId: string;
  occurrenceId: string;
}) {
  const result = useQuery(api.scheduled.tasks.runResult, {
    taskId: taskId as Id<"scheduledTasks">,
    occurrenceId: occurrenceId as Id<"scheduledTaskOccurrences">,
  });
  // A separate subscription on purpose: a delivery row is written after the run
  // is terminal and patched again by the provider webhook, so folding it into
  // runResult would re-send the whole result on an unrelated event.
  const deliveries = useQuery(api.scheduled.tasks.deliveries, {
    taskId: taskId as Id<"scheduledTasks">,
  });

  if (result === undefined) {
    return (
      <div className="space-y-2" aria-hidden>
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-4 animate-pulse rounded bg-primary/5" />
        ))}
      </div>
    );
  }
  if (result === null) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        This run is no longer available.
      </p>
    );
  }

  // The zone THIS run was scheduled in, off its pinned revision. These lines
  // used to be formatted as literal "UTC", which is why a Kolkata task showed
  // 18:44 against a 00:14 chip. Falling back to UTC only when the revision is
  // genuinely gone keeps that honest rather than guessing the browser's zone.
  const { occurrence, message, timezone } = result;
  const zone = timezone ?? "UTC";
  const delivery =
    deliveries?.find((d) => d.occurrenceKey === occurrence.occurrenceKey) ??
    null;

  return (
    <div>
      <div className="rounded-xl border border-border bg-card p-3">
        <p className="text-xs font-medium text-primary/80">
          {runStatusLabel(occurrence.status, occurrence.scheduledFor)}
          {occurrence.attempts > 1 && ` · ${occurrence.attempts} attempts`}
        </p>
        <dl className="mt-2 space-y-1 text-[11px] text-muted-foreground">
          <Line
            label="Scheduled"
            value={formatInstant(occurrence.scheduledFor, zone)}
          />
          {occurrence.startedAt && (
            <Line
              label="Started"
              value={formatInstant(occurrence.startedAt, zone)}
            />
          )}
          {occurrence.finishedAt && (
            <Line
              label="Finished"
              value={formatInstant(occurrence.finishedAt, zone)}
            />
          )}
        </dl>
        {delivery && <DeliveryLine row={delivery} />}
      </div>

      {(occurrence.status === "failed" ||
        occurrence.status === "cancelled") && (
        <p className="mt-3 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-primary/75">
          {occurrence.status === "cancelled"
            ? "This run was cancelled."
            : runErrorCopy(occurrence.errorCode)}
        </p>
      )}

      {message ? (
        <div className="mt-3">
          <ChatMessage
            message={message as unknown as ChatMessageDoc}
            isStreaming={false}
            readOnly
            hideExecutionMeta
          />
        </div>
      ) : (
        <p className="mt-6 text-center text-xs text-muted-foreground">
          This run has not produced a result yet.
        </p>
      )}
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt>{label}</dt>
      <dd className="text-primary/60">{value}</dd>
    </div>
  );
}

/**
 * The delivery outcome, kept visually and semantically apart from the run's own
 * status. A successful run whose email bounced is a SUCCEEDED run — collapsing
 * the two would make people think the task itself failed and re-run it.
 */
function DeliveryLine({ row }: { row: DeliveryRow }) {
  const { label, tone, reason } = deliveryLabel(row);
  const note = attachmentNote(row);
  return (
    <div className="mt-2 border-t border-border/60 pt-2">
      <p className={`text-[11px] font-medium ${TONE_CLASS[tone]}`}>{label}</p>
      {note && <p className="text-[11px] text-muted-foreground">{note}</p>}
      {reason && <p className="mt-0.5 text-[11px] text-muted-foreground">{reason}</p>}
    </div>
  );
}
