"use client";

import {
  Blocks,
  Braces,
  Briefcase,
  CalendarDays,
  Compass,
  FileText,
  Globe,
  HardDrive,
  Mail,
  MessageSquare,
  PiggyBank,
  Plane,
  Search,
} from "lucide-react";
import Link from "next/link";
import type { ConnectorView } from "../_lib/dto";
import { ConnectAction } from "./connect-action";
import { ConnectionStatus } from "./connection-status";

/**
 * One connector, as a card.
 *
 * NO REMOTE LOGOS, AND THE REASON IS MEASURED RATHER THAN STYLISTIC. The app
 * ships `Content-Security-Policy: img-src 'self' data: blob: <convex origin>`
 * (`next.config.mjs`), added to close a prompt-injection image-exfiltration
 * channel. A provider logo from a third-party host is BLOCKED BY THE BROWSER,
 * and §177 forbids widening the policy to show one. So identity comes from a
 * category icon — `lucide-react` is already a dependency — with the first letter
 * of the name as the fallback. Nothing is fetched, nothing leaks a page view to
 * a provider, and the card renders offline.
 *
 * EVERY STRING IS A TEXT NODE. `description` originates in the public MCP
 * registry and is third-party by definition. It is bounded and control-stripped
 * server-side, and rendered here as a React child — never through
 * `dangerouslySetInnerHTML`, which this codebase permits in exactly one audited
 * place (mermaid) and nowhere else.
 */

const ICON: Record<string, typeof Globe> = {
  productivity: Blocks,
  communication: MessageSquare,
  developer: Braces,
  documents: FileText,
  research: Search,
  browser: Globe,
  business: Briefcase,
  finance: PiggyBank,
  travel: Plane,
  calendar: CalendarDays,
  email: Mail,
  other: Compass,
};

export function ConnectorCard({
  view,
  onRun,
}: {
  view: ConnectorView;
  onRun: (view: ConnectorView) => void;
}) {
  const Icon = ICON[view.category] ?? Compass;
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-card">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-background text-primary/60"
        >
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <Link
            href={`/settings/connectors/${encodeURIComponent(view.slug)}`}
            className="block truncate text-sm font-medium text-primary hover:underline"
          >
            {view.displayName}
          </Link>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[11px] text-primary/60">
              {view.categoryLabel}
            </span>
            {view.runtime === "local" && (
              // §34: "Runs locally", never "Docker" or "stdio gateway".
              <span className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-primary/65">
                <HardDrive aria-hidden className="h-3 w-3" />
                Runs locally
              </span>
            )}
          </div>
        </div>
      </div>

      {view.description && (
        <p className="line-clamp-2 text-xs leading-relaxed text-primary/65">
          {view.description}
        </p>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <ConnectionStatus state={view.state} />
        <ConnectAction view={view} onRun={onRun} />
      </div>
    </div>
  );
}
