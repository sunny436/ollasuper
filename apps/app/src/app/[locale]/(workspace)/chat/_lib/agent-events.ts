/**
 * Phase 8 — the typed-event → view-model layer.
 *
 * The backend (convex/chat/events.ts + services/ai/app/models/events.py) is the
 * SINGLE source of truth for the event protocol; this module only PARSES and
 * GROUPS what already arrives on `stream.active.events` / `chatMessages.events`.
 * It is deliberately pure (no React, no Convex) so it unit-tests under `bun test`
 * and memoises cheaply inside the render tree.
 *
 * Two hard safety rules, both enforced here rather than in a component:
 *  1. `TOOL_RESULT.content` is the verbatim model-context block (near
 *     chain-of-thought / injection-framed RAG). It is dropped at parse time so
 *     NO downstream component can render it. Only the compact `result` survives.
 *  2. Any malformed payload or unknown event type degrades to `{kind:"unknown"}`
 *     and is skipped by the timeline — it never throws.
 */

/** The wire shape returned by stream.active / listPaged (payload is a JSON string). */
export interface TypedEvent {
  eventId: string;
  seq: number;
  type: string;
  v: number;
  ts: number;
  textOffset?: number;
  payload: string;
}

export type ToolStatus = "running" | "success" | "error";

export type ParsedEvent =
  | {
      kind: "tool_call";
      eventId: string;
      seq: number;
      ts: number;
      callId: string;
      toolName: string;
      toolId?: string;
      /** Backend-stamped human-readable action phrase ("Auditing page metadata"). */
      label?: string;
      status: string;
      args: Record<string, unknown>;
    }
  | {
      kind: "tool_result";
      eventId: string;
      seq: number;
      ts: number;
      callId: string;
      status: string;
      // `content` is intentionally NOT captured (see file header).
      result?: unknown;
    }
  | {
      kind: "tool_progress";
      eventId: string;
      seq: number;
      ts: number;
      callId: string;
      progress: number;
      message?: string;
    }
  | {
      kind: "citation";
      eventId: string;
      seq: number;
      ts: number;
      sourceId: string;
      title?: string;
      url?: string;
      metadata: Record<string, unknown>;
    }
  | {
      kind: "approval";
      eventId: string;
      seq: number;
      ts: number;
      approvalId: string;
      toolName: string;
      reason: string;
      status: string;
      preview?: ParsedActionPreview;
    }
  | {
      kind: "artifact";
      eventId: string;
      seq: number;
      ts: number;
      artifactId: string;
      artifactType: string;
      metadata: Record<string, unknown>;
    }
  | {
      kind: "final";
      eventId: string;
      seq: number;
      ts: number;
      finishReason?: string;
    }
  | {
      kind: "error";
      eventId: string;
      seq: number;
      ts: number;
      code: string;
      message: string;
      retryable?: boolean;
    }
  | { kind: "unknown"; eventId: string; seq: number; ts: number };

function body(payload: string): Record<string, unknown> {
  try {
    const b: unknown = JSON.parse(payload);
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (b: Record<string, unknown>, k: string): string | undefined =>
  typeof b[k] === "string" ? (b[k] as string) : undefined;

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/** Phase 7 — the rich SEO ActionPreview carried in an APPROVAL_REQUEST payload (absent
 *  for every other approval). Rendered read-only in the approval card so the user sees the
 *  exact change before approving. */
export interface ParsedActionPreview {
  action: string;
  targets: string[];
  provider: string;
  reversibility: string;
  diff: Record<string, { before: unknown; after: unknown }>;
  rollbackPlan: string;
  verificationPlan: string;
  estimatedCost: Record<string, unknown>;
}

function parsePreview(v: unknown): ParsedActionPreview | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const p = v as Record<string, unknown>;
  const targets = (Array.isArray(p.targets) ? p.targets : []).filter(
    (t): t is string => typeof t === "string",
  );
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  for (const [k, val] of Object.entries(obj(p.diff))) {
    const e = obj(val);
    diff[k] = { before: e.before, after: e.after };
  }
  return {
    action: str(p, "action") ?? "",
    targets,
    provider: str(p, "provider") ?? "",
    reversibility: str(p, "reversibility") ?? "",
    diff,
    rollbackPlan: str(p, "rollback_plan") ?? "",
    verificationPlan: str(p, "verification_plan") ?? "",
    estimatedCost: obj(p.estimated_cost),
  };
}

/** Defensive parse of one wire event into the discriminated union. */
export function parseEvent(e: TypedEvent): ParsedEvent {
  const b = body(e.payload);
  const base = { eventId: e.eventId, seq: e.seq, ts: e.ts };
  switch (e.type) {
    case "TOOL_CALL": {
      const callId = str(b, "call_id");
      if (!callId) return { kind: "unknown", ...base };
      return {
        kind: "tool_call",
        ...base,
        callId,
        toolName: str(b, "tool_name") ?? "tool",
        toolId: str(b, "tool_id"),
        label: str(b, "label"),
        status: str(b, "status") ?? "running",
        args: obj(b.arguments),
      };
    }
    case "TOOL_RESULT": {
      const callId = str(b, "call_id");
      if (!callId) return { kind: "unknown", ...base };
      return {
        kind: "tool_result",
        ...base,
        callId,
        status: str(b, "status") ?? "success",
        result: b.result,
      };
    }
    case "TOOL_PROGRESS": {
      const callId = str(b, "call_id");
      if (!callId) return { kind: "unknown", ...base };
      const p = typeof b.progress === "number" ? b.progress : 0;
      return {
        kind: "tool_progress",
        ...base,
        callId,
        progress: Math.max(0, Math.min(1, p)),
        message: str(b, "message"),
      };
    }
    case "CITATION": {
      const sourceId = str(b, "source_id");
      if (!sourceId) return { kind: "unknown", ...base };
      return {
        kind: "citation",
        ...base,
        sourceId,
        title: str(b, "title"),
        url: str(b, "url"),
        metadata: obj(b.metadata),
      };
    }
    case "APPROVAL_REQUEST": {
      const approvalId = str(b, "approval_id");
      if (!approvalId) return { kind: "unknown", ...base };
      return {
        kind: "approval",
        ...base,
        approvalId,
        toolName: str(b, "tool_name") ?? "action",
        reason: str(b, "reason") ?? "",
        status: str(b, "status") ?? "pending",
        preview: parsePreview(b.preview),
      };
    }
    case "ARTIFACT": {
      const artifactId = str(b, "artifact_id");
      if (!artifactId) return { kind: "unknown", ...base };
      return {
        kind: "artifact",
        ...base,
        artifactId,
        artifactType: str(b, "artifact_type") ?? "artifact",
        metadata: obj(b.metadata),
      };
    }
    case "FINAL":
      return { kind: "final", ...base, finishReason: str(b, "finishReason") };
    case "ERROR":
      return {
        kind: "error",
        ...base,
        code: str(b, "code") ?? "error",
        message: str(b, "message") ?? "",
        retryable: typeof b.retryable === "boolean" ? b.retryable : undefined,
      };
    default:
      return { kind: "unknown", ...base };
  }
}

// ---------------------------------------------------------------------------
// Timeline: pair TOOL_CALL / TOOL_RESULT / TOOL_PROGRESS by call_id.
// ---------------------------------------------------------------------------

export interface RagFile {
  fileId: string;
  filename: string;
  page?: number;
}

export interface ToolRunModel {
  callId: string;
  toolName: string;
  toolId?: string;
  /** Backend-stamped action phrase; the pill prefers it over toolLabel(). */
  label?: string;
  args: Record<string, unknown>;
  status: ToolStatus;
  startedTs: number;
  endedTs?: number;
  result?: unknown;
  progress?: { progress: number; message?: string };
  /** Cheap identity for React.memo — changes only when this run actually changes. */
  signature: string;
}

export interface ParsedCitation {
  sourceId: string;
  title?: string;
  url?: string;
  page?: number;
  kind: "rag" | "memory" | "web";
}

export interface ArtifactPreview {
  /** Total pages/slides in the document (may exceed `shown`). */
  pages: number;
  /** How many preview images were rendered/stored (the strip length). */
  shown: number;
  /** True when the preview is a faithful render (LibreOffice/pypdfium); false when it
   *  is the approximate spec-based fallback and must be labeled as such. */
  faithful: boolean;
  /** A short caveat to show when not faithful (e.g. "approximate preview — …"). */
  note: string;
}

export interface ParsedArtifact {
  artifactId: string;
  artifactType: string;
  url?: string;
  filename?: string;
  format?: string;
  size?: number;
  preview?: ArtifactPreview;
  metadata: Record<string, unknown>;
}

export interface ParsedApproval {
  approvalId: string;
  toolName: string;
  reason: string;
  status: string;
  preview?: ParsedActionPreview;
}

export interface TimelineModel {
  runs: ToolRunModel[];
  citations: ParsedCitation[];
  ragFiles: RagFile[];
  artifacts: ParsedArtifact[];
  approval?: ParsedApproval;
  terminal?: { kind: "final" | "error"; code?: string; message?: string };
  /** True once any structured (non-terminal) event exists — drives whether to render. */
  hasActivity: boolean;
}

function citationKind(sourceId: string): ParsedCitation["kind"] {
  if (sourceId.startsWith("memory:")) return "memory";
  if (/^https?:\/\//.test(sourceId)) return "web";
  return "rag";
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function extractRagFiles(result: unknown): RagFile[] {
  const r = obj(result);
  const files = Array.isArray(r.files) ? r.files : [];
  const out: RagFile[] = [];
  for (const f of files) {
    const fo = obj(f);
    const fileId = str(fo, "file_id");
    const filename = str(fo, "filename");
    if (fileId && filename) out.push({ fileId, filename, page: num(fo.page) });
  }
  return out;
}

/** Parse the optional `metadata.preview` manifest a Documents artifact carries. Absent
 *  / malformed ⇒ undefined (the card renders as a plain download, exactly as before). */
function parsePreviewMeta(v: unknown): ArtifactPreview | undefined {
  const p = obj(v);
  const shown = num(p.shown) ?? 0;
  if (shown <= 0) return undefined;
  return {
    pages: num(p.pages) ?? shown,
    shown,
    faithful: p.faithful !== false,
    note: str(p, "note") ?? "",
  };
}

/**
 * Build the ordered view-model from the raw event array. Runs are ordered by
 * first appearance (TOOL_CALL seq). Progress folds to the latest tick per call.
 * The FINAL/ERROR terminal (server-synthesized at fold) becomes `terminal`.
 */
export function buildTimeline(events: TypedEvent[] | undefined): TimelineModel {
  const runs = new Map<string, ToolRunModel>();
  const citations: ParsedCitation[] = [];
  const ragFileById = new Map<string, RagFile>();
  const artifacts: ParsedArtifact[] = [];
  let approval: ParsedApproval | undefined;
  let terminal: TimelineModel["terminal"];
  let hasActivity = false;

  const sorted = [...(events ?? [])].sort((a, b) => a.seq - b.seq);
  for (const raw of sorted) {
    const e = parseEvent(raw);
    switch (e.kind) {
      case "tool_call": {
        hasActivity = true;
        runs.set(e.callId, {
          callId: e.callId,
          toolName: e.toolName,
          toolId: e.toolId,
          label: e.label,
          args: e.args,
          status: "running",
          startedTs: e.ts,
          signature: `${e.callId}:call:${e.eventId}`,
        });
        break;
      }
      case "tool_result": {
        hasActivity = true;
        const run = runs.get(e.callId) ?? {
          callId: e.callId,
          toolName: "tool",
          args: {},
          status: "running" as ToolStatus,
          startedTs: e.ts,
          signature: e.callId,
        };
        run.status = e.status === "success" ? "success" : "error";
        run.result = e.result;
        run.endedTs = e.ts;
        run.signature = `${run.signature}|result:${e.eventId}`;
        runs.set(e.callId, run);
        for (const f of extractRagFiles(e.result)) ragFileById.set(f.fileId, f);
        break;
      }
      case "tool_progress": {
        hasActivity = true;
        const run = runs.get(e.callId);
        if (run) {
          run.progress = { progress: e.progress, message: e.message };
          run.signature = `${run.signature}|prog:${e.eventId}`;
          runs.set(e.callId, run);
        }
        break;
      }
      case "citation": {
        hasActivity = true;
        citations.push({
          sourceId: e.sourceId,
          title: e.title,
          url: e.url,
          page: num(e.metadata.page),
          kind: citationKind(e.sourceId),
        });
        break;
      }
      case "artifact": {
        hasActivity = true;
        artifacts.push({
          artifactId: e.artifactId,
          artifactType: e.artifactType,
          url: str(e.metadata, "url"),
          filename: str(e.metadata, "filename"),
          format: str(e.metadata, "format"),
          size: num(e.metadata.size),
          preview: parsePreviewMeta(e.metadata.preview),
          metadata: e.metadata,
        });
        break;
      }
      case "approval": {
        hasActivity = true;
        approval = {
          approvalId: e.approvalId,
          toolName: e.toolName,
          reason: e.reason,
          status: e.status,
          preview: e.preview,
        };
        break;
      }
      case "final":
        terminal = { kind: "final" };
        break;
      case "error":
        terminal = { kind: "error", code: e.code, message: e.message };
        break;
      default:
        break; // unknown → skipped, never crashes
    }
  }

  return {
    runs: [...runs.values()],
    citations,
    ragFiles: [...ragFileById.values()],
    artifacts,
    approval,
    terminal,
    hasActivity,
  };
}

/** Cheap memo signature for a whole timeline — changes only when an event appends. */
export function timelineSignature(events: TypedEvent[] | undefined): string {
  const n = events?.length ?? 0;
  return `${n}:${events?.at(-1)?.eventId ?? ""}`;
}

// ---------------------------------------------------------------------------
// Human-readable tool labels — synchronous, query-free, no per-model hardcoding.
// ---------------------------------------------------------------------------

export interface ToolLabel {
  icon: string;
  /** Present-progressive, shown while running: "Searching the web". */
  running: string;
  /** Short noun for the settled/idle line: "Web search". */
  noun: string;
}

const RESERVED: Record<string, ToolLabel> = {
  search_knowledge: {
    icon: "📄",
    running: "Reading your documents",
    noun: "Document search",
  },
  search_memory: {
    icon: "🧠",
    running: "Recalling memory",
    noun: "Memory",
  },
  remember: {
    icon: "🧠",
    running: "Saving to memory",
    noun: "Memory",
  },
};

const VERB_PREFIXES: Array<[RegExp, string, string]> = [
  [/^(web_)?search|^search_/, "Searching", "🔎"],
  [/^(scrape|fetch|get|read|crawl)/, "Fetching", "🌐"],
  [/^convert|^transform/, "Converting", "🔁"],
  [/^weather/, "Checking weather", "⛅"],
];

function titleCase(slug: string): string {
  const words = slug
    .replace(/[-_.]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words
    .map((w) => (w[0] ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Derive a friendly icon + label from a tool's id/name. Never throws. */
export function toolLabel(toolName: string, toolId?: string): ToolLabel {
  const key = (toolId ?? toolName ?? "").toLowerCase();
  if (RESERVED[key]) return RESERVED[key];
  const name = toolName || toolId || "tool";
  const lower = name.toLowerCase();
  for (const [re, verb, icon] of VERB_PREFIXES) {
    if (re.test(lower)) {
      const rest = titleCase(lower.replace(re, "")).trim();
      return {
        icon,
        running: rest ? `${verb} ${rest.toLowerCase()}` : verb,
        noun: titleCase(name),
      };
    }
  }
  const nice = titleCase(name);
  return { icon: "🔧", running: `Running ${nice}`, noun: nice };
}

// ---------------------------------------------------------------------------
// Execution-status pill helpers — suppression + a stable aggregate header.
// ---------------------------------------------------------------------------

/** Internal orchestration tools — not user-meaningful "steps", hidden from the
 *  pill (the "Find Capabilities" noise). App-level constants, not per-SEO-tool. */
export const SUPPRESSED_TOOLS: ReadonlySet<string> = new Set([
  "find_capabilities",
  "delegate_to_agent",
  "request_clarification",
]);

export function isSuppressedRun(run: {
  toolName: string;
  toolId?: string;
}): boolean {
  return SUPPRESSED_TOOLS.has(run.toolId ?? "") || SUPPRESSED_TOOLS.has(run.toolName);
}

/** A run's present-progressive phrase: the backend label first, else the generic
 *  frontend derivation — so a tool without a curated label still never shows raw. */
export function runRunningLabel(run: ToolRunModel): string {
  return run.label?.trim() ? run.label : toolLabel(run.toolName, run.toolId).running;
}

export interface AggregateStatus {
  state: "running" | "done" | "error";
  label: string;
}

function isParkedForApproval(run: ToolRunModel): boolean {
  const result = run.result;
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { status?: unknown }).status === "awaiting_approval"
  );
}

/**
 * The single, stable header for the execution pill. Keys on the SET of running
 * runs (not per-progress ticks), so the header never jitters:
 *  exactly one running → its own label; several running → "Working on N tasks";
 *  none running mid-stream → "Working"; settled → "Done · N steps" / failure.
 * Expects the already-VISIBLE (non-suppressed) runs.
 */
export function aggregateStatus(
  runs: ToolRunModel[],
  isStreaming: boolean,
): AggregateStatus {
  const running = runs.filter((r) => r.status === "running");
  // A call parked for approval arrives as an "error" result carrying
  // `{status: "awaiting_approval"}` — that is how the backend stops the model
  // until the user decides (executor.py `_park_all_for_approval`). The approved
  // re-run is a NEW call, so the parked one keeps that status forever. It is a
  // pause, not a failure: measured on production, every approved Gmail draft
  // and Sheets write ended with "Some steps didn't complete" beside "Done".
  const failed = runs.some((r) => r.status === "error" && !isParkedForApproval(r));
  const one = running[0];
  if (running.length === 1 && one)
    return { state: "running", label: runRunningLabel(one) };
  if (running.length > 1) {
    // Show the ACTUAL current activity (the most-recently-started running tool)
    // plus a "+N more" for the parallel work — real, from the event stream, never
    // a hardcoded "Working on N tasks".
    const latest = running.reduce((a, b) => (b.startedTs >= a.startedTs ? b : a));
    return {
      state: "running",
      label: `${runRunningLabel(latest)} · +${running.length - 1} more`,
    };
  }
  if (isStreaming && runs.length > 0) return { state: "running", label: "Working" };
  if (failed) return { state: "error", label: "Some steps didn’t complete" };
  const n = runs.length;
  return { state: "done", label: `Done · ${n} step${n === 1 ? "" : "s"}` };
}

// ---------------------------------------------------------------------------
// Error copy — the centralized code → {message, retryable} registry (§16/17).
// Codes originate in runner.py, chat/stream.ts and http.ts; both spellings of
// the deadline/timeout family map to the same user-facing copy.
// ---------------------------------------------------------------------------

export const ERROR_COPY: Record<string, { message: string; retryable: boolean }> =
  {
    not_configured: {
      message: "Chat isn't configured yet. Contact your administrator.",
      retryable: false,
    },
    dispatch_failed: {
      message: "Couldn't reach the model service. Please try again.",
      retryable: true,
    },
    dispatch_unreachable: {
      message: "Couldn't reach the model service. Please try again.",
      retryable: true,
    },
    ingress_unavailable: {
      message: "The model service is temporarily unavailable. Please try again.",
      retryable: true,
    },
    cancelled: { message: "You stopped this response.", retryable: true },
    interrupted: { message: "The response was interrupted. Please try again.", retryable: true },
    deadline: { message: "This response took too long and was stopped.", retryable: true },
    deadline_exceeded: {
      message: "This response took too long and was stopped.",
      retryable: true,
    },
    timeout: { message: "This response timed out. Please try again.", retryable: true },
    provider_timeout: { message: "The model timed out. Please try again.", retryable: true },
    provider_error: { message: "The model had a problem. Please try again.", retryable: true },
    // Capacity, not a fault in the request. "Try again" is the WRONG advice here —
    // the same model will refuse again — so this names the cause and the action.
    // Folding this into provider_error is what made a provider-side weekly-quota
    // outage read as an application bug.
    provider_quota: {
      // Names neither the model nor a picker: the user does not choose one
      // (the Master Model Router does) and the picker no longer exists, so the
      // old copy both leaked the routing concept and gave dead advice.
      message:
        "OllaSuper is at capacity right now. Please try again in a few minutes.",
      retryable: false,
    },
    attachment_failed: {
      message: "One of your attachments couldn't be processed.",
      retryable: true,
    },
    approval_expired: {
      message: "The approval request expired before it was answered.",
      retryable: true,
    },
    internal: { message: "Something went wrong. Please try again.", retryable: true },
  };

/**
 * Resolve an errorCode (+ optional raw backend message) to display copy. An
 * unknown code falls back to the raw message (already length-capped server-side)
 * and, absent that, a safe generic — and is treated as retryable so the user is
 * never stranded (the backend `retry` mutation is the real idempotency gate).
 */
export function errorCopy(
  code?: string | null,
  fallback?: string | null,
): { message: string; retryable: boolean } {
  if (code && ERROR_COPY[code]) return ERROR_COPY[code];
  return { message: fallback || "Something went wrong.", retryable: true };
}
