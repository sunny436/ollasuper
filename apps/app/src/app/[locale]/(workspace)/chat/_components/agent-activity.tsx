"use client";

import { memo, useMemo } from "react";
import {
  buildTimeline,
  type ToolRunModel,
  timelineSignature,
  toolLabel,
  type TypedEvent,
} from "../_lib/agent-events";
import { ApprovalCard } from "./approval-card";
import { Badge, Disclosure, StatusDot } from "./agent-primitives";
import { LazyMarkdown } from "./lazy-markdown";
import { Mermaid } from "./mermaid";

/**
 * The agent-activity timeline: paired tool runs rendered ABOVE the answer body,
 * plus any pending approval. Sources/citations/artifacts render BELOW the answer
 * (see agent-sources.tsx). Returns null for a text-only turn, so ordinary chat
 * is visually unchanged. Never renders `TOOL_RESULT.content` (see agent-events).
 */
export function AgentActivity({
  events,
  isStreaming,
}: {
  events?: TypedEvent[];
  isStreaming: boolean;
}) {
  // Rebuild only when an event actually appends (not per streamed text token).
  const timeline = useMemo(
    () => buildTimeline(events),
    [timelineSignature(events)],
  );

  if (!timeline.hasActivity) return null;

  const current = timeline.runs.find((r) => r.status === "running");

  return (
    <div data-agent-activity className="mb-2.5 flex flex-col gap-1.5">
      {timeline.runs.map((run) => (
        <ToolRun key={run.callId} run={run} />
      ))}
      {timeline.approval && <ApprovalCard approval={timeline.approval} />}
      {/* One polite live region so a screen reader announces the current step
          without re-reading the whole timeline. */}
      {isStreaming && current && (
        <span className="sr-only" aria-live="polite">
          {toolLabel(current.toolName, current.toolId).running}
        </span>
      )}
    </div>
  );
}

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
  const label = toolLabel(run.toolName, run.toolId);
  const state =
    run.status === "running"
      ? "running"
      : run.status === "success"
        ? "done"
        : "error";
  const duration =
    run.endedTs != null ? (run.endedTs - run.startedTs) / 1000 : undefined;
  const summary = resultSummary(run.result);
  const pct = run.progress ? Math.round(run.progress.progress * 100) : null;

  return (
    <div className="rounded-lg border border-border/60 bg-card/40 px-2.5 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span aria-hidden>{label.icon}</span>
        <StatusDot state={state} />
        <span className="text-primary/80 [overflow-wrap:anywhere]">
          {run.status === "running" ? `${label.running}…` : label.noun}
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
        <p className="mt-1 text-primary/50 [overflow-wrap:anywhere]">
          {run.progress.message}
        </p>
      )}

      {run.status === "success" && hasPreviewContent(run.result) && (
        <Disclosure
          className="mt-1"
          summary={
            <span className="text-[11px] text-primary/50 hover:text-primary/70">
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
                  <td className="py-0.5 pr-3 align-top font-medium text-primary/50 [overflow-wrap:anywhere]">
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
