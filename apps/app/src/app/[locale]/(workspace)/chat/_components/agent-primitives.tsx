"use client";

import type { ReactNode } from "react";

/**
 * Small chat-local primitives for the agent-activity UI. Kept here (not in
 * packages/ui) because they are chat-specific and the design system deliberately
 * lacks badge/collapsible/status primitives. All module-scope.
 */

type DotState = "running" | "done" | "error" | "waiting" | "unknown";

const DOT_CLASS: Record<DotState, string> = {
  running: "bg-brand animate-pulse motion-reduce:animate-none",
  done: "bg-muted",
  error: "bg-destructive",
  waiting: "bg-muted",
  unknown: "bg-primary/30",
};

const DOT_LABEL: Record<DotState, string> = {
  running: "in progress",
  done: "completed",
  error: "failed",
  waiting: "waiting",
  unknown: "",
};

/** A status dot with an sr-only textual status (the dot itself is decorative). */
export function StatusDot({ state }: { state: DotState }) {
  return (
    <span className="inline-flex items-center">
      <span
        aria-hidden
        className={`h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[state]}`}
      />
      {DOT_LABEL[state] && <span className="sr-only">{DOT_LABEL[state]}</span>}
    </span>
  );
}

type BadgeTone = "muted" | "brand" | "destructive";

const BADGE_TONE: Record<BadgeTone, string> = {
  muted: "border-border bg-card text-primary/60",
  brand: "border-brand/30 bg-brand/5 text-brand-ink",
  destructive: "border-destructive/30 bg-destructive/5 text-destructive",
};

/** A small static pill for counts / durations / statuses. */
export function Badge({
  tone = "muted",
  children,
}: {
  tone?: BadgeTone;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-none ${BADGE_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * A native <details>/<summary> disclosure. Native gives keyboard toggle,
 * aria-expanded, and focusability for free, needs no JS state, and works with
 * the append-only repaint model. `summary` is the always-visible row.
 */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  className = "",
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  return (
    <details open={defaultOpen} className={`group/disc ${className}`}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-brand/40 [&::-webkit-details-marker]:hidden">
        {summary}
      </summary>
      <div className="mt-1.5">{children}</div>
    </details>
  );
}
