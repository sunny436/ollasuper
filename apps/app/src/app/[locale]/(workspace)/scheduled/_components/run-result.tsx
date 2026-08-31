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

  const { occurrence, prompt, message } = result;
  const delivery =
    deliveries?.find((d) => d.occurrenceKey === occurrence.occurrenceKey) ??
    null;

  return (
    <div>
      <div className="rounded-xl border border-border bg-card/50 p-3">
        <p className="text-xs font-medium text-primary/80">
          {runStatusLabel(occurrence.status, occurrence.scheduledFor)}
          {occurrence.attempts > 1 && ` · ${occurrence.attempts} attempts`}
        </p>
        <dl className="mt-2 space-y-1 text-[11px] text-muted-foreground">
          <Line label="Scheduled" value={formatInstant(occurrence.scheduledFor, "UTC")} />
          {occurrence.startedAt && (
            <Line label="Started" value={formatInstant(occurrence.startedAt, "UTC")} />
          )}
          {occurrence.finishedAt && (
            <Line label="Finished" value={formatInstant(occurrence.finishedAt, "UTC")} />
          )}
        </dl>
        {prompt && (
          <p className="mt-2 border-t border-border pt-2 text-[11px] leading-relaxed text-primary/55">
            {/* The PINNED revision's prompt — what this run actually executed,
                not whatever the task says today. */}
            <span className="uppercase tracking-wide">Ran</span> “{prompt}”
          </p>
        )}
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
