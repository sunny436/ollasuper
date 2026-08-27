"use client";

import { api } from "@v1/backend/convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import {
  AlertTriangle,
  CheckCircle2,
  Gauge,
  Loader2,
  MinusCircle,
  X,
} from "lucide-react";
import { useState } from "react";
import type { ParsedArtifact } from "../_lib/agent-events";
import { Badge } from "./agent-primitives";
import { SeoReportCard } from "./seo-report-card";

/**
 * The live SEO-run card (Phase 5). Rendered by AgentSources when a message carries an
 * ARTIFACT event with artifact_type="seo_run" — the durable audit the agent handed to
 * the background run subsystem. It reactively loads the run via the ownership-checked
 * `getRun` (null → nothing, never a throw), shows live queued→running progress with a
 * Cancel control, and on completion renders the reused rich SEO report card.
 *
 * Every value is read defensively (unknown → skipped) so a stale/partial payload can
 * never break the message render (the e2e zero-console gate).
 */

const asStr = (x: unknown): string => (typeof x === "string" ? x : "");
const asNum = (x: unknown): number => (typeof x === "number" ? x : 0);

const TERMINAL = new Set([
  "succeeded",
  "partial",
  "failed",
  "cancelled",
  "expired",
]);

type RunStatusMeta = {
  label: string;
  pill: string;
  tone: "active" | "good" | "warn" | "bad";
};
const RUNNING_STATUS: RunStatusMeta = {
  label: "Running",
  pill: "border-brand/30 bg-brand/10 text-brand-ink",
  tone: "active",
};
const RUN_STATUS: Record<string, RunStatusMeta> = {
  queued: { label: "Queued", pill: "border-border bg-card/60 text-primary/60", tone: "active" },
  running: RUNNING_STATUS,
  retry_wait: RUNNING_STATUS,
  succeeded: {
    label: "Completed",
    pill: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    tone: "good",
  },
  partial: {
    label: "Partial",
    pill: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    tone: "warn",
  },
  failed: {
    label: "Failed",
    pill: "border-destructive/30 bg-destructive/10 text-destructive",
    tone: "bad",
  },
  cancelled: {
    label: "Cancelled",
    pill: "border-border bg-card/60 text-primary/50",
    tone: "warn",
  },
  expired: {
    label: "Timed out",
    pill: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    tone: "warn",
  },
};

export function SeoRunCard({ artifact }: { artifact: ParsedArtifact }) {
  const runId = artifact.artifactId || asStr(artifact.metadata.run_id);
  const run = useQuery(api.seoRuns.getRun, runId ? { runId } : "skip");
  const requestCancel = useMutation(api.seoRuns.requestCancel);
  const [cancelling, setCancelling] = useState(false);

  if (!runId) return null;
  if (run === undefined) {
    return (
      <div className="rounded-xl border border-border/60 bg-card/40 px-3 py-2.5 text-xs text-primary/50">
        <span className="inline-flex items-center gap-1.5">
          <Gauge
            className="h-3.5 w-3.5 animate-pulse motion-reduce:animate-none"
            aria-hidden
          />
          Preparing audit…
        </span>
      </div>
    );
  }
  if (run === null) return null; // gone / not owner — never an oracle, never a throw

  const status = asStr(run.status) || "queued";
  const st = RUN_STATUS[status] ?? RUNNING_STATUS;
  const terminal = TERMINAL.has(status);
  const reportId = asStr(run.reportId);
  const target = asStr(run.target);

  // Completed with a report → render the rich report card (reused verbatim).
  if (terminal && reportId) {
    return (
      <SeoReportCard
        artifact={{
          artifactId: reportId,
          artifactType: "seo_report",
          metadata: { report_id: reportId },
        }}
      />
    );
  }

  const processed = asNum(run.processedCount);
  const total = Math.max(1, asNum(run.maxUrls));
  const pct = terminal ? 100 : Math.min(100, Math.round((processed / total) * 100));
  const findings = asNum(run.findingsCount);

  const onCancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    try {
      await requestCancel({ runId });
    } catch {
      // ownership/race → keep the card, the reactive status will settle
    } finally {
      setCancelling(false);
    }
  };

  const StatusIcon =
    st.tone === "good"
      ? CheckCircle2
      : st.tone === "bad"
        ? AlertTriangle
        : st.tone === "warn"
          ? MinusCircle
          : Loader2;

  return (
    <div className="rounded-xl border border-border/60 bg-card/40 px-3 py-2.5 text-xs">
      <div className="flex items-center gap-2">
        <Gauge className="h-4 w-4 shrink-0 text-brand-ink" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium text-primary/80">
          SEO audit{target ? ` · ${target}` : ""}
        </span>
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${st.pill}`}
        >
          <StatusIcon
            className={`h-3 w-3 ${
              st.tone === "active"
                ? "animate-spin motion-reduce:animate-none"
                : ""
            }`}
            aria-hidden
          />
          {st.label}
        </span>
      </div>

      {!terminal && (
        <>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-primary/10">
            <div
              className="h-full rounded-full bg-brand transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2 text-primary/55">
            <span className="tabular-nums">
              {processed > 0
                ? `Crawled ${processed} of ~${total} URLs`
                : "Starting the crawl…"}
              {findings > 0 && (
                <>
                  {" · "}
                  <Badge>{findings} findings so far</Badge>
                </>
              )}
            </span>
            <button
              type="button"
              onClick={onCancel}
              disabled={cancelling}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-primary/60 outline-none hover:bg-primary/5 hover:text-primary/80 focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
              {cancelling ? "Cancelling…" : "Cancel"}
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-primary/40">
            This runs in the background — the full report will appear here when it's
            ready. You can keep chatting.
          </p>
        </>
      )}

      {terminal && !reportId && (
        <p className="mt-2 text-primary/55">
          {status === "cancelled"
            ? "The audit was cancelled."
            : status === "expired"
              ? "The audit ran out of time before it could finish."
              : "The audit did not complete."}
        </p>
      )}
    </div>
  );
}
