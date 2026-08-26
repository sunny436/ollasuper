"use client";

import { api } from "@v1/backend/convex/_generated/api";
import { useMutation } from "convex/react";
import { Download, FileText } from "lucide-react";
import { useMemo, useState } from "react";
import {
  buildTimeline,
  type ParsedArtifact,
  type ParsedCitation,
  timelineSignature,
  type TypedEvent,
} from "../_lib/agent-events";
import { safeUrl } from "../_lib/url-guard";
import { Badge, Disclosure } from "./agent-primitives";

/** Browser-reachable Convex SITE origin (where the /artifact/file proxy lives) —
 *  mirrors the share page: NEXT_PUBLIC_CONVEX_URL is the /__cvx path form. */
function convexSite(): string {
  const u = process.env.NEXT_PUBLIC_CONVEX_URL ?? "";
  return u.includes("/__cvx") ? u.replace("/__cvx", "/__cvx-site") : u;
}

function formatBytes(n?: number): string {
  if (!n || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1_048_576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1_048_576).toFixed(1)} MB`;
}

/**
 * Sources / citations / artifacts, rendered BELOW the answer. Derived from the
 * same event array as the timeline. Returns null when a turn produced neither.
 * Citations already carry filename+page (RAG) or a recall label (memory), so
 * they drive the source list directly; the redundant RAG `files[]` in the tool
 * result are not re-listed.
 */
export function AgentSources({ events }: { events?: TypedEvent[] }) {
  const timeline = useMemo(
    () => buildTimeline(events),
    [timelineSignature(events)],
  );

  const { citations, artifacts } = timeline;
  if (citations.length === 0 && artifacts.length === 0) return null;

  return (
    <div className="mt-2 flex flex-col gap-2">
      {citations.length > 0 && <SourceList citations={citations} />}
      {artifacts.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {artifacts.map((a) => (
            <ArtifactCard key={a.artifactId} artifact={a} />
          ))}
        </div>
      )}
    </div>
  );
}

const KIND_ICON: Record<ParsedCitation["kind"], string> = {
  rag: "📄",
  memory: "🧠",
  web: "🔗",
};

function SourceList({ citations }: { citations: ParsedCitation[] }) {
  const n = citations.length;
  return (
    <Disclosure
      defaultOpen={n <= 3}
      summary={
        <span className="inline-flex items-center gap-1.5 text-xs text-primary/60 hover:text-primary/80">
          <span className="font-medium">Sources</span>
          <Badge>{n}</Badge>
        </span>
      }
    >
      <ol className="flex flex-col gap-1">
        {citations.map((c, i) => (
          <CitationCard key={`${c.sourceId}:${i}`} citation={c} index={i + 1} />
        ))}
      </ol>
    </Disclosure>
  );
}

function CitationCard({
  citation,
  index,
}: {
  citation: ParsedCitation;
  index: number;
}) {
  const href = citation.url ? safeUrl(citation.url) : "";
  const title =
    citation.title ||
    (citation.kind === "web" ? citation.url : citation.sourceId) ||
    "source";
  const label = (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span aria-hidden className="shrink-0">
        {KIND_ICON[citation.kind]}
      </span>
      <span className="truncate text-primary/80">{title}</span>
      {citation.page != null && <Badge>p.{citation.page}</Badge>}
    </span>
  );

  return (
    <li className="flex items-center gap-2 rounded-md border border-border/50 bg-card/40 px-2 py-1 text-xs">
      <span className="shrink-0 text-primary/30 tabular-nums">{index}.</span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 flex-1 rounded outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          {label}
        </a>
      ) : (
        <span className="min-w-0 flex-1">{label}</span>
      )}
    </li>
  );
}

/**
 * An assistant-generated file (File Generation System). Download is OWNERSHIP-
 * enforced: the event carries only the artifact id; clicking Download calls the
 * authenticated `mintDownload` (which checks the caller owns it) to get a short-TTL
 * token URL, then triggers the download. A memory-style artifact (no id/format) still
 * renders as a plain note. `url` is honoured if a tool ever bakes one directly.
 */
function ArtifactCard({ artifact }: { artifact: ParsedArtifact }) {
  const mintDownload = useMutation(api.chat.artifacts.mintDownload);
  const [busy, setBusy] = useState(false);
  const title =
    artifact.filename ||
    (typeof artifact.metadata.title === "string" && artifact.metadata.title) ||
    artifact.artifactType;
  const badge = (artifact.format || artifact.artifactType || "").toUpperCase();
  const size = formatBytes(artifact.size);
  const downloadable = Boolean(artifact.url) || Boolean(artifact.artifactId);

  const onDownload = async () => {
    if (busy) return;
    // A pre-minted url (legacy path) downloads directly; otherwise mint on demand.
    let url = artifact.url ? safeUrl(artifact.url) : "";
    if (!url && artifact.artifactId) {
      setBusy(true);
      try {
        const { token } = await mintDownload({ artifactId: artifact.artifactId });
        url = safeUrl(`${convexSite()}/artifact/file?t=${token}`);
      } catch {
        // ownership/expiry → keep the card, no navigation
      } finally {
        setBusy(false);
      }
    }
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.rel = "noopener";
    a.target = "_blank";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <div
      data-artifact-card
      className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-2.5 py-1.5 text-xs"
    >
      <FileText className="h-4 w-4 shrink-0 text-brand-ink" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-primary/80">{title}</span>
      {size && <span className="shrink-0 text-primary/40 tabular-nums">{size}</span>}
      {badge && <Badge>{badge}</Badge>}
      {downloadable && (
        <button
          type="button"
          data-artifact-download
          onClick={onDownload}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-brand-ink outline-none hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" aria-hidden />
          {busy ? "Preparing…" : "Download"}
        </button>
      )}
    </div>
  );
}
