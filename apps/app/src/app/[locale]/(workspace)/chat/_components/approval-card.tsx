"use client";

import { Check, ShieldAlert, X } from "lucide-react";
import type { ParsedActionPreview, ParsedApproval } from "../_lib/agent-events";

function fmt(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  return typeof v === "string" ? v : JSON.stringify(v);
}

/**
 * Phase 7 — the read-only SEO ActionPreview: exactly what a mutation will change, shown
 * BEFORE approval. The buttons above still call the server, which mints the execute token;
 * this is presentation only, so a doctored preview cannot authorize anything.
 */
function ActionPreview({ preview }: { preview: ParsedActionPreview }) {
  const entries = Object.entries(preview.diff);
  return (
    <div className="mt-2 rounded-md border border-border bg-card p-2">
      <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-primary/65">
        <span className="rounded bg-primary/5 px-1.5 py-0.5 font-medium text-primary/70">
          {preview.action || "change"}
        </span>
        {preview.targets.map((t) => (
          <span key={t} className="truncate [overflow-wrap:anywhere]">
            {t}
          </span>
        ))}
      </div>
      {entries.length > 0 && (
        <dl className="mt-1.5 space-y-1">
          {entries.map(([field, d]) => (
            <div key={field} className="text-[11px]">
              <dt className="font-medium text-primary/60">{field}</dt>
              <dd className="mt-0.5 flex flex-wrap items-center gap-1 text-primary/70">
                <span className="rounded bg-muted px-1 py-0.5 text-destructive line-through [overflow-wrap:anywhere] dark:text-destructive">
                  {fmt(d.before)}
                </span>
                <span aria-hidden>→</span>
                <span className="rounded bg-muted px-1 py-0.5 text-success [overflow-wrap:anywhere] dark:text-success">
                  {fmt(d.after)}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      )}
      <p className="mt-1.5 text-[10px] text-primary/60">
        {preview.reversibility === "reversible" ? "Reversible" : "Irreversible"} ·{" "}
        {preview.verificationPlan || "Verified after the change."}
      </p>
    </div>
  );
}

/**
 * A tool that requested user approval before running (Phase 8). Actionable ONLY
 * when `onResolve` is supplied — i.e. on the LIVE turn whose durable pending
 * approval matches this event. On a settled turn (no handler) it is a neutral
 * historical note. The frontend is never the security authority: the buttons
 * call `chat.approvals.resolve`, which re-checks ownership and mints the execute
 * token server-side.
 */
export function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: ParsedApproval;
  onResolve?: (decision: "approve" | "reject") => void;
}) {
  return (
    <div className="rounded-lg border border-warning bg-muted px-3 py-2 text-xs">
      <div className="flex items-start gap-2">
        <ShieldAlert
          className="mt-0.5 h-4 w-4 shrink-0 text-warning"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-primary/80">
            Approval required · {approval.toolName}
          </p>
          {approval.reason && (
            <p className="mt-0.5 text-primary/60 [overflow-wrap:anywhere]">
              {approval.reason}
            </p>
          )}

          {approval.preview && <ActionPreview preview={approval.preview} />}

          {onResolve ? (
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => onResolve("approve")}
                className="inline-flex items-center gap-1 rounded-md bg-brand px-2.5 py-1 text-brand-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                <Check className="h-3.5 w-3.5" aria-hidden /> Approve
              </button>
              <button
                type="button"
                onClick={() => onResolve("reject")}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-primary/70 outline-none hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                <X className="h-3.5 w-3.5" aria-hidden /> Reject
              </button>
            </div>
          ) : (
            <p className="mt-1 text-primary/65">This action required approval.</p>
          )}
        </div>
      </div>
    </div>
  );
}
