"use client";

import { AlertCircle, Check, ChevronDown, Loader2 } from "lucide-react";
import { memo, useMemo } from "react";
import {
  aggregateStatus,
  buildTimeline,
  isSuppressedRun,
  runRunningLabel,
  type ToolRunModel,
  timelineSignature,
  type TypedEvent,
} from "../_lib/agent-events";
import { ApprovalCard } from "./approval-card";
import { Badge, Disclosure } from "./agent-primitives";
import { LazyMarkdown } from "./lazy-markdown";
import { Mermaid } from "./mermaid";

/** The one status icon for the pill + each row: spinner / check / alert, each with
 *  sr-only text (never color-only). Reduced-motion drops the spin, not the icon. */
function StateIcon({
  state,
  className = "h-3.5 w-3.5",
}: {
  state: "running" | "done" | "error";
  className?: string;
}) {
  if (state === "running")
    return (
      <span className="inline-flex" role="img" aria-label="in progress">
        <Loader2 className={`${className} animate-spin text-brand-ink motion-reduce:animate-none`} />
      </span>
    );
  if (state === "error")
    return (
      <span className="inline-flex" role="img" aria-label="failed">
        <AlertCircle className={`${className} text-destructive`} />
      </span>
    );
  return (
    <span className="inline-flex" role="img" aria-label="completed">
      <Check className={`${className} text-brand-ink`} />
    </span>
  );
}

function runState(run: ToolRunModel): "running" | "done" | "error" {
  return run.status === "running" ? "running" : run.status === "error" ? "error" : "done";
}

/**
 * The agent-activity timeline: paired tool runs rendered ABOVE the answer body,
 * plus any pending approval. Sources/citations/artifacts render BELOW the answer
 * (see agent-sources.tsx). Returns null for a text-only turn, so ordinary chat
 * is visually unchanged. Never renders `TOOL_RESULT.content` (see agent-events).
 */
export function AgentActivity({
  events,
  isStreaming,
  pendingApproval,
  onResolveApproval,
}: {
  events?: TypedEvent[];
  isStreaming: boolean;
  // The live turn's durable pending approval (from stream.active). Absent on
  // settled turns, so their approval card is a neutral historical note.
  pendingApproval?: { _id: string; approvalId: string } | null;
  onResolveApproval?: (
    approvalId: string,
    decision: "approve" | "reject",
  ) => void;
}) {
  // Rebuild only when an event actually appends (not per streamed text token).
  const timeline = useMemo(
    () => buildTimeline(events),
    [timelineSignature(events)],
  );

  // Internal orchestration tools (find_capabilities / delegate / clarify) are not
  // user-meaningful steps — hide them so the pill shows only real work.
  const visibleRuns = timeline.runs.filter((r) => !isSuppressedRun(r));

  // Render nothing unless there is real activity to show (or a pending approval) —
  // a turn whose only tool was suppressed must not leave an empty shell.
  if (visibleRuns.length === 0 && !timeline.approval) return null;

  const current = visibleRuns.find((r) => r.status === "running");

  return (
    <div data-agent-activity className="mb-2.5 flex flex-col gap-1.5">
      {visibleRuns.length > 0 && (
        <ExecutionStatus runs={visibleRuns} isStreaming={isStreaming} />
      )}
      {timeline.approval && (
        <ApprovalCard
          approval={timeline.approval}
          onResolve={
            pendingApproval &&
            onResolveApproval &&
            pendingApproval.approvalId === timeline.approval.approvalId
              ? (decision) => onResolveApproval(pendingApproval._id, decision)
              : undefined
          }
        />
      )}
      {/* One polite live region so a screen reader announces the current step
          without re-reading the whole timeline. */}
      {isStreaming && current && (
        <span className="sr-only" aria-live="polite">
          {runRunningLabel(current)}
        </span>
      )}
    </div>
  );
}

/**
 * The unified live execution pill: ONE compact, collapsible status that
 * aggregates every tool run into a single conversational line. Collapsed by
 * default — the chevron reveals the per-run detail. Parallel runs are just the
 * independent rows (buildTimeline keys them by call_id); nothing here fakes
 * concurrency or duplicates state. Repaints only when an event appends.
 */
function ExecutionStatusImpl({
  runs,
  isStreaming,
}: {
  runs: ToolRunModel[];
  isStreaming: boolean;
}) {
  const agg = aggregateStatus(runs, isStreaming);
  return (
    <Disclosure
      className="rounded-full border border-border/60 bg-card/40 px-3 py-1 text-xs open:rounded-2xl"
      summary={
        <>
          <StateIcon state={agg.state} />
          <span className="min-w-0 flex-1 truncate text-primary/80">
            {agg.label}
          </span>
          {runs.length > 1 && (
            <span className="shrink-0 tabular-nums text-[11px] text-primary/60">
              {runs.filter((r) => r.status !== "running").length}/{runs.length}
            </span>
          )}
          <ChevronDown
            aria-hidden
            className="h-3.5 w-3.5 shrink-0 text-primary/60 transition-transform duration-200 group-open/disc:rotate-180"
          />
        </>
      }
    >
      <div className="flex flex-col gap-1 pl-0.5">
        {runs.map((run) => (
          <ToolRun key={run.callId} run={run} />
        ))}
      </div>
    </Disclosure>
  );
}

export const ExecutionStatus = memo(
  ExecutionStatusImpl,
  (a, b) =>
    a.isStreaming === b.isStreaming &&
    a.runs.length === b.runs.length &&
    a.runs.every((r, i) => r.signature === b.runs[i]?.signature),
);

function resultSummary(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (typeof r.n_results === "number") {
    const n = r.n_results;
    return n === 0 ? "no results" : `${n} result${n === 1 ? "" : "s"}`;
  }
  if (r.saved === true) return "saved";
  if (r.saved === false) return "not saved";
  return null;
}

function hasPreviewContent(result: unknown): boolean {
  if (result == null) return false;
  if (typeof result === "string") return result.trim().length > 0;
  if (Array.isArray(result)) return result.length > 0;
  if (typeof result === "object") {
    const r = result as Record<string, unknown>;
    // A bare {n_results} / {saved} summary needs no expandable body.
    const keys = Object.keys(r);
    if (keys.length === 0) return false;
    if (keys.every((k) => k === "n_results" || k === "files")) return false;
    return true;
  }
  return false;
}

function ToolRunImpl({ run }: { run: ToolRunModel }) {
  const label = runRunningLabel(run);
  const state = runState(run);
  const duration =
    run.endedTs != null ? (run.endedTs - run.startedTs) / 1000 : undefined;
  const summary = resultSummary(run.result);
  const pct = run.progress ? Math.round(run.progress.progress * 100) : null;

  return (
    <div className="text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <StateIcon state={state} />
        {/* Completed rows are quieter than the active one (the icon carries state). */}
        <span
          className={`[overflow-wrap:anywhere] ${
            run.status === "running" ? "text-primary/80" : "text-primary/65"
          }`}
        >
          {label}
        </span>
        {run.status === "success" && summary && (
          <Badge tone="brand">{summary}</Badge>
        )}
        {run.status === "error" && <Badge tone="destructive">failed</Badge>}
        {duration != null && run.status !== "running" && (
          <Badge>{duration < 0.05 ? "<0.1s" : `${duration.toFixed(1)}s`}</Badge>
        )}
        {pct != null && run.status === "running" && <Badge>{pct}%</Badge>}
      </div>

      {run.status === "running" && run.progress?.message && (
        <p className="mt-0.5 pl-5 text-primary/65 [overflow-wrap:anywhere]">
          {run.progress.message}
        </p>
      )}

      {run.status === "success" && hasPreviewContent(run.result) && (
        <Disclosure
          className="mt-0.5 pl-5"
          summary={
            <span className="text-[11px] text-primary/65 hover:text-primary/70">
              View result
            </span>
          }
        >
          <ResultPreview result={run.result} />
        </Disclosure>
      )}
    </div>
  );
}

/** Repaints only when this run's own signature changes (append-only events). */
export const ToolRun = memo(
  ToolRunImpl,
  (a, b) => a.run.signature === b.run.signature,
);

// ---------------------------------------------------------------------------
// ResultPreview — safe, shape-dispatched rendering of TOOL_RESULT.result.
// Whitelist only. Never arbitrary HTML/JS; never the `content` channel.
// ---------------------------------------------------------------------------

function isScalar(v: unknown): v is string | number | boolean {
  return (
    typeof v === "string" || typeof v === "number" || typeof v === "boolean"
  );
}

/** Escape a value for a single GFM table cell (pipe + newlines are the footguns). */
function cell(v: unknown): string {
  return String(v).replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").slice(0, 200);
}

function chartToMermaid(chart: Record<string, unknown>): string | null {
  const type = typeof chart.type === "string" ? chart.type : "";
  const data = chart.data;
  if (type === "pie" && data && typeof data === "object") {
    const lines = ["pie showData"];
    for (const [k, val] of Object.entries(data as Record<string, unknown>)) {
      if (typeof val === "number")
        lines.push(`  "${String(k).replace(/"/g, "")}" : ${val}`);
    }
    return lines.length > 1 ? lines.join("\n") : null;
  }
  return null;
}

export function ResultPreview({ result }: { result: unknown }) {
  // string → markdown (inherits the XSS-safe pipeline: no rehype-raw, url-guard)
  if (typeof result === "string") {
    return (
      <div className="rounded-md bg-card/50 px-2 py-1.5 text-[13px]">
        <LazyMarkdown content={result} streaming={false} />
      </div>
    );
  }

  // array of scalars → bulleted list
  if (Array.isArray(result)) {
    const scalars = result.filter(isScalar).slice(0, 50);
    if (scalars.length === 0) return null;
    return (
      <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-primary/70">
        {scalars.map((v, i) => (
          <li
            key={`${i}:${String(v).slice(0, 24)}`}
            className="[overflow-wrap:anywhere]"
          >
            {String(v)}
          </li>
        ))}
      </ul>
    );
  }

  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;

    // structured chart → mermaid (built from data, never tool HTML)
    if (r.chart && typeof r.chart === "object") {
      const code = chartToMermaid(r.chart as Record<string, unknown>);
      if (code) return <Mermaid code={code} complete />;
    }

    // { columns, rows } → GFM table via the safe markdown path
    if (Array.isArray(r.columns) && Array.isArray(r.rows)) {
      const cols = r.columns.filter(isScalar).map(String);
      if (cols.length > 0) {
        const header = `| ${cols.map(cell).join(" | ")} |`;
        const sep = `| ${cols.map(() => "---").join(" | ")} |`;
        const body = (r.rows as unknown[])
          .slice(0, 50)
          .map((row) => {
            const cells = Array.isArray(row) ? row : cols.map((c) => (row as Record<string, unknown>)?.[c]);
            return `| ${cols.map((_, i) => cell(cells[i] ?? "")).join(" | ")} |`;
          })
          .join("\n");
        return (
          <div className="overflow-x-auto text-[13px]">
            <LazyMarkdown content={`${header}\n${sep}\n${body}`} streaming={false} />
          </div>
        );
      }
    }

    // flat object of scalars → key/value table (React-escaped, no markdown parse
    // of untrusted keys)
    const entries = Object.entries(r).filter(([, v]) => isScalar(v));
    if (entries.length > 0) {
      return (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <tbody>
              {entries.slice(0, 30).map(([k, v]) => (
                <tr key={k} className="border-border/40 border-b last:border-0">
                  <td className="py-0.5 pr-3 align-top font-medium text-primary/65 [overflow-wrap:anywhere]">
                    {k}
                  </td>
                  <td className="py-0.5 align-top text-primary/80 [overflow-wrap:anywhere]">
                    {String(v)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
  }

  // Unknown / unrenderable shape → nothing (never dump raw JSON).
  return null;
}
