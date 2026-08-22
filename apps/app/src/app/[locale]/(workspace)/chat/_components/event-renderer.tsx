"use client";

import type { ReactNode } from "react";

/**
 * Phase 3 — safe, extensible renderer for the typed event protocol.
 *
 * TEXT_DELTA / FINAL / ERROR are handled by the EXISTING text + status paths
 * (committedText+chunks, settled content, the error block), so this renders ONLY
 * the structured events. The `default:` branch guarantees an unknown or future
 * event type is ignored rather than crashing the chat. Nothing here executes a
 * tool — it presents metadata only.
 */
export interface TypedEvent {
  eventId: string;
  seq: number;
  type: string;
  v: number;
  ts: number;
  textOffset?: number;
  // JSON string of the type-specific body, parsed defensively.
  payload: string;
}

function parseBody(payload: string): Record<string, unknown> {
  try {
    const b: unknown = JSON.parse(payload);
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// Only these are rendered inline here; text + terminal events ride other paths.
const RENDERED = new Set([
  "TOOL_CALL",
  "TOOL_RESULT",
  "TOOL_PROGRESS",
  "CITATION",
  "APPROVAL_REQUEST",
  "ARTIFACT",
]);

function Chip({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-card/60 px-2 py-0.5 text-xs text-primary/70">
      <span aria-hidden>{icon}</span>
      {children}
    </span>
  );
}

function EventChip({ event }: { event: TypedEvent }) {
  const b = parseBody(event.payload);
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
  switch (event.type) {
    case "TOOL_CALL":
      return (
        <Chip icon="🔧">
          {str("tool_name") || "tool"} · {str("status") || "running"}
        </Chip>
      );
    case "TOOL_RESULT":
      return <Chip icon="✓">result{str("status") ? ` · ${str("status")}` : ""}</Chip>;
    case "TOOL_PROGRESS": {
      const pct =
        typeof b.progress === "number"
          ? Math.round((b.progress as number) * 100)
          : null;
      return (
        <Chip icon="…">
          {str("message") || "working"}
          {pct !== null ? ` · ${pct}%` : ""}
        </Chip>
      );
    }
    case "CITATION":
      return <Chip icon="🔗">{str("title") || str("url") || "source"}</Chip>;
    case "APPROVAL_REQUEST":
      return <Chip icon="⚠">approval: {str("tool_name") || "action"}</Chip>;
    case "ARTIFACT":
      return <Chip icon="📄">{str("artifact_type") || "artifact"}</Chip>;
    default:
      // Unknown / future event type — ignore, never crash (§9/§11).
      return null;
  }
}

export function EventList({ events }: { events?: TypedEvent[] }) {
  if (!events || events.length === 0) return null;
  const structured = events.filter((e) => RENDERED.has(e.type));
  if (structured.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {structured.map((e) => (
        <EventChip key={e.eventId} event={e} />
      ))}
    </div>
  );
}
