"use client";

import { Check, ShieldAlert, X } from "lucide-react";
import type { ParsedApproval } from "../_lib/agent-events";

/**
 * A tool that requested user approval before running. In PR 8a this is
 * presentation-only: the approval round-trip (durable state + resolve mutation)
 * lands in PR 8b, which passes `onResolve` to enable the Approve/Reject buttons.
 * Without a handler the card shows the pending request without actions — a
 * hidden/disabled button is never the security authority; the backend is.
 */
export function ApprovalCard({
  approval,
  onResolve,
  pending = true,
}: {
  approval: ParsedApproval;
  onResolve?: (decision: "approve" | "reject") => void;
  /** False once the approval is resolved (8b) — collapses to a static line. */
  pending?: boolean;
}) {
  const resolved = !pending || approval.status !== "pending";

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-primary/80">
            Approval required · {approval.toolName}
          </p>
          {approval.reason && (
            <p className="mt-0.5 text-primary/60 [overflow-wrap:anywhere]">
              {approval.reason}
            </p>
          )}

          {resolved ? (
            <p className="mt-1 text-primary/50">
              {approval.status === "approved"
                ? "Approved."
                : approval.status === "rejected"
                  ? "Rejected."
                  : approval.status === "expired"
                    ? "Expired."
                    : "Awaiting approval."}
            </p>
          ) : onResolve ? (
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
            <p className="mt-1 text-primary/50">Awaiting approval.</p>
          )}
        </div>
      </div>
    </div>
  );
}
