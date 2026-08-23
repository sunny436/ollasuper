"use client";

import { Check, ShieldAlert, X } from "lucide-react";
import type { ParsedApproval } from "../_lib/agent-events";

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
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
      <div className="flex items-start gap-2">
        <ShieldAlert
          className="mt-0.5 h-4 w-4 shrink-0 text-amber-600"
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
            <p className="mt-1 text-primary/50">This action required approval.</p>
          )}
        </div>
      </div>
    </div>
  );
}
