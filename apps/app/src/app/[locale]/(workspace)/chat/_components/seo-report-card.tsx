"use client";

import { api } from "@v1/backend/convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  FileJson,
  FileText,
  Gauge,
  MinusCircle,
  ShieldAlert,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import type { ParsedArtifact } from "../_lib/agent-events";
import { safeUrl } from "../_lib/url-guard";
import { Badge, Disclosure } from "./agent-primitives";

/**
 * The rich, evidence-grounded SEO audit report card. Rendered by AgentSources when a
 * message carries an ARTIFACT event with artifact_type="seo_report". It reads the
 * `report_id` from the event metadata and reactively loads the persisted report via
 * the ownership-checked `getReport`. NO 0-100 score — the audit is presented as
 * evidence-grounded counts (checks passed/warned/failed + coverage) and prioritized,
 * drill-down findings with their evidence, recommendations, and verification steps.
 *
 * Every value is extracted defensively (unknown → skipped, never thrown) so a stale or
 * partial payload can never break the message render (the e2e zero-console gate).
 */

// --- defensive extraction --------------------------------------------------
type Dict = Record<string, unknown>;
const asDict = (x: unknown): Dict =>
  typeof x === "object" && x !== null ? (x as Dict) : {};
const asArr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const asStr = (x: unknown): string => (typeof x === "string" ? x : "");
const asNum = (x: unknown): number => (typeof x === "number" ? x : 0);

// --- severity styling (semantic, NOT the brand accent) ---------------------
type Sev = "critical" | "high" | "medium" | "low" | "info";
const SEV_ORDER: Sev[] = ["critical", "high", "medium", "low", "info"];
const SEV: Record<Sev, { label: string; pill: string; bar: string }> = {
  critical: {
    label: "Critical",
    pill: "border-destructive/30 bg-destructive/10 text-destructive",
    bar: "bg-destructive",
  },
  high: {
    label: "High",
    pill: "border-orange-500/30 bg-orange-500/10 text-orange-600 dark:text-orange-400",
    bar: "bg-orange-500",
  },
  medium: {
    label: "Medium",
    pill: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    bar: "bg-amber-500",
  },
  low: {
    label: "Low",
    pill: "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
    bar: "bg-blue-500",
  },
  info: {
    label: "Info",
    pill: "border-border bg-card/60 text-primary/60",
    bar: "bg-primary/30",
  },
};
const toSev = (x: unknown): Sev =>
  SEV_ORDER.includes(x as Sev) ? (x as Sev) : "info";

const STATUS_DEFAULT = {
  label: "Completed",
  pill: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
};
const STATUS: Record<string, { label: string; pill: string }> = {
  completed: STATUS_DEFAULT,
  partial: { label: "Partial", pill: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  failed: { label: "Failed", pill: "border-destructive/30 bg-destructive/10 text-destructive" },
};

const CONF: Record<string, string> = {
  high: "text-emerald-600 dark:text-emerald-400",
  medium: "text-amber-600 dark:text-amber-400",
  low: "text-primary/50",
};

const FORMAT_META: Record<string, { label: string; Icon: typeof FileText }> = {
  md: { label: "Markdown", Icon: FileText },
  json: { label: "JSON", Icon: FileJson },
  pdf: { label: "PDF", Icon: FileText },
};

// --- the card --------------------------------------------------------------
export function SeoReportCard({ artifact }: { artifact: ParsedArtifact }) {
  const reportId = asStr(artifact.metadata.report_id);
  const data = useQuery(
    api.chat.reports.getReport,
    reportId ? { reportId } : "skip",
  );

  if (!reportId) return null;
  if (data === undefined) {
    return (
      <div className="rounded-xl border border-border/60 bg-card/40 px-3 py-2.5 text-xs text-primary/50">
        <span className="inline-flex items-center gap-1.5">
          <Gauge className="h-3.5 w-3.5 animate-pulse motion-reduce:animate-none" aria-hidden />
          Preparing SEO report…
        </span>
      </div>
    );
  }

  const env = asDict(data.report);
  const status = asStr(data.status) || asStr(env.status) || "completed";
  const st = STATUS[status] ?? STATUS_DEFAULT;
  const summary = asDict(env.summary);
  const target = asStr(data.target) || asStr(env.target);
  const findings = asArr(env.findings).map(asDict);
  const categories = asArr(summary.categories).map(asDict);
  const bySeverity = asDict(summary.by_severity);
  const manifest = asArr(data.manifest).map(asDict);
  const provenance = asArr(env.provider_provenance).map(asDict);
  const limitations = asArr(env.limitations).map(asStr).filter(Boolean);
  const unsupported = asArr(env.unsupported_areas).map(asStr).filter(Boolean);
  const coverage = asArr(env.coverage).map(asStr).filter(Boolean);
  const recommendations = asArr(env.recommendations).map(asStr).filter(Boolean);
  const scopeType = asStr(env.scope && asDict(env.scope).type) || asStr(data.scope);
  const confidence = asStr(env.confidence) || "medium";
  const freshness = asStr(env.evidence_freshness);
  const exposure = asStr(env.business_exposure);
  const href = target ? safeUrl(target) : "";

  const total = asNum(summary.total_findings) || asNum(data.summary?.totalFindings) || findings.length;

  return (
    <section
      data-seo-report
      className="workspace flex flex-col gap-4 rounded-xl border border-border/70 bg-card/50 p-3.5 sm:p-4"
      aria-label="SEO audit report"
    >
      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-primary/90">
            <ShieldAlert className="h-4 w-4 shrink-0 text-brand-ink" aria-hidden />
            SEO Audit Report
            <span className={`rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none ${st.pill}`}>
              {st.label}
            </span>
          </div>
          {target &&
            (href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-0.5 inline-flex items-center gap-1 truncate text-xs text-brand-ink outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                {target}
                <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
              </a>
            ) : (
              <span className="mt-0.5 block truncate text-xs text-primary/60">{target}</span>
            ))}
        </div>
        <div className="text-right text-[11px] leading-tight text-primary/40">
          {asStr(env.generated_at || data.generatedAt) && (
            <div className="tabular-nums">{asStr(env.generated_at || data.generatedAt)}</div>
          )}
          <div>
            {asStr(env.methodology && asDict(env.methodology).name) || asStr(data.methodologyName)} v
            {asStr(env.methodology && asDict(env.methodology).version) || asStr(data.methodologyVersion)}
          </div>
        </div>
      </header>

      {status === "failed" ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          The audit did not complete{asStr(env.failure_reason) ? `: ${asStr(env.failure_reason)}` : "."}
        </p>
      ) : (
        <>
          {/* Executive overview */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Total findings" value={total} />
            <Stat label="Failed" value={asNum(summary.failed)} tone="bad" />
            <Stat label="Warnings" value={asNum(summary.warnings)} tone="warn" />
            <Stat label="Passed" value={asNum(summary.passed)} tone="good" />
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-primary/50">
            <Meta label="Scope" value={scopeType === "site" ? "Whole site" : "Single page"} />
            <Meta label="Checks" value={String(asNum(summary.checks_performed) || findings.length)} />
            <Meta label="Coverage" value={`${coverage.length} intents`} />
            {asNum(summary.not_tested) > 0 && (
              <Meta label="Not tested" value={String(asNum(summary.not_tested))} />
            )}
            <span className="inline-flex items-center gap-1">
              <span className="text-primary/40">Confidence</span>
              <span className={`font-medium ${CONF[confidence] ?? ""}`}>
                {confidence} <span className="text-primary/40">(coverage-based)</span>
              </span>
            </span>
          </div>

          {/* Severity distribution — real counts, no composite score */}
          {total > 0 && (
            <SeverityBar bySeverity={bySeverity} total={total} />
          )}

          {/* Category breakdown */}
          {categories.length > 0 && (
            <div>
              <SectionTitle>Category breakdown</SectionTitle>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {categories.map((c) => (
                  <CategoryTile key={asStr(c.category)} c={c} />
                ))}
              </div>
            </div>
          )}

          {/* Prioritized findings */}
          {findings.length > 0 && (
            <div>
              <SectionTitle>
                Findings{" "}
                <span className="font-normal text-primary/40">
                  · prioritized by severity
                </span>
              </SectionTitle>
              <div className="flex flex-col gap-1">
                {sortFindings(findings).map((f, i) => (
                  <FindingRow key={`${asStr(f.check_id)}:${i}`} f={f} />
                ))}
              </div>
            </div>
          )}

          {/* Recommendations */}
          {recommendations.length > 0 && (
            <Disclosure
              summary={
                <SummaryRow>
                  Top recommendations <Badge>{recommendations.length}</Badge>
                </SummaryRow>
              }
            >
              <ul className="ml-1 flex list-disc flex-col gap-0.5 pl-4 text-xs text-primary/70">
                {recommendations.slice(0, 12).map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </Disclosure>
          )}

          {exposure && (
            <div className="rounded-lg border border-border/50 bg-background/40 px-3 py-2 text-xs text-primary/70">
              <span className="font-medium text-primary/80">Business exposure. </span>
              {exposure}
            </div>
          )}
        </>
      )}

      {/* Methodology / provenance + limitations footer */}
      <Disclosure
        summary={<SummaryRow>Methodology, provenance &amp; limitations</SummaryRow>}
      >
        <div className="flex flex-col gap-2 text-[11px] text-primary/60">
          {provenance.length > 0 && (
            <div>
              <span className="text-primary/40">Evidence from </span>
              {provenance.map((p, i) => (
                <span key={asStr(p.provider) || i}>
                  {i > 0 && ", "}
                  <span className="font-medium text-primary/70">{asStr(p.provider)}</span>{" "}
                  ({asArr(p.tool_ids).length} tools, {asStr(p.freshness) || "live"})
                </span>
              ))}
            </div>
          )}
          {freshness && (
            <Meta label="Data freshness" value={freshness} />
          )}
          {unsupported.length > 0 && (
            <div>
              <span className="text-primary/40">
                Unsupported (needs first-party Search Console / Analytics / CrUX data):{" "}
              </span>
              {unsupported.slice(0, 8).join("; ")}
            </div>
          )}
          {limitations.length > 0 && (
            <div>
              <span className="text-primary/40">Limitations: </span>
              {limitations.slice(0, 8).join("; ")}
            </div>
          )}
        </div>
      </Disclosure>

      {/* Downloads */}
      {manifest.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border/50 pt-3">
          <span className="mr-1 text-[11px] text-primary/40">Download</span>
          {manifest.map((m) => (
            <DownloadButton
              key={asStr(m.artifactId)}
              artifactId={asStr(m.artifactId)}
              format={asStr(m.format)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// --- sub-components (module scope, per the chat convention) ----------------
function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary/40">
      {children}
    </h4>
  );
}

function SummaryRow({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-primary/60 hover:text-primary/80">
      {children}
    </span>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-primary/40">{label}</span>
      <span className="font-medium text-primary/70">{value}</span>
    </span>
  );
}

const STAT_TONE = {
  good: "text-emerald-600 dark:text-emerald-400",
  bad: "text-destructive",
  warn: "text-amber-600 dark:text-amber-400",
  plain: "text-primary/90",
} as const;

function Stat({
  label,
  value,
  tone = "plain",
}: {
  label: string;
  value: number;
  tone?: keyof typeof STAT_TONE;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-background/40 px-2.5 py-2">
      <div className={`text-lg font-semibold tabular-nums ${STAT_TONE[tone]}`}>{value}</div>
      <div className="text-[11px] text-primary/40">{label}</div>
    </div>
  );
}

function SeverityBar({
  bySeverity,
  total,
}: {
  bySeverity: Record<string, unknown>;
  total: number;
}) {
  const segs = SEV_ORDER.map((s) => ({ s, n: asNum(bySeverity[s]) })).filter(
    (x) => x.n > 0,
  );
  if (segs.length === 0) return null;
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-primary/5">
        {segs.map(({ s, n }) => (
          <div
            key={s}
            className={SEV[s].bar}
            style={{ width: `${(n / total) * 100}%` }}
            title={`${SEV[s].label}: ${n}`}
          />
        ))}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-primary/50">
        {segs.map(({ s, n }) => (
          <span key={s} className="inline-flex items-center gap-1">
            <span className={`h-2 w-2 rounded-full ${SEV[s].bar}`} aria-hidden />
            {SEV[s].label} <span className="tabular-nums text-primary/70">{n}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function CategoryTile({ c }: { c: Record<string, unknown> }) {
  const pass = asNum(c.passed);
  const warn = asNum(c.warned);
  const fail = asNum(c.failed);
  const findings = asNum(c.findings);
  const denom = pass + warn + fail || 1;
  return (
    <div className="rounded-lg border border-border/50 bg-background/40 px-2.5 py-2">
      <div className="flex items-center justify-between text-xs">
        <span className="truncate font-medium text-primary/80">{asStr(c.category)}</span>
        <span className="shrink-0 text-[11px] text-primary/40 tabular-nums">
          {findings} {findings === 1 ? "finding" : "findings"}
        </span>
      </div>
      <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-primary/5">
        {pass > 0 && <div className="bg-emerald-500" style={{ width: `${(pass / denom) * 100}%` }} />}
        {warn > 0 && <div className="bg-amber-500" style={{ width: `${(warn / denom) * 100}%` }} />}
        {fail > 0 && <div className="bg-destructive" style={{ width: `${(fail / denom) * 100}%` }} />}
      </div>
      <div className="mt-1 flex gap-2.5 text-[11px] text-primary/50 tabular-nums">
        <span className="inline-flex items-center gap-0.5">
          <CheckCircle2 className="h-3 w-3 text-emerald-500" aria-hidden /> {pass}
        </span>
        <span className="inline-flex items-center gap-0.5">
          <AlertTriangle className="h-3 w-3 text-amber-500" aria-hidden /> {warn}
        </span>
        <span className="inline-flex items-center gap-0.5">
          <ShieldAlert className="h-3 w-3 text-destructive" aria-hidden /> {fail}
        </span>
      </div>
    </div>
  );
}

const STATUS_ICON: Record<string, ReactNode> = {
  FAIL: <ShieldAlert className="h-3.5 w-3.5 text-destructive" aria-hidden />,
  WARN: <AlertTriangle className="h-3.5 w-3.5 text-amber-500" aria-hidden />,
  PASS: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" aria-hidden />,
  NOT_TESTED: <MinusCircle className="h-3.5 w-3.5 text-primary/30" aria-hidden />,
  NOT_APPLICABLE: <MinusCircle className="h-3.5 w-3.5 text-primary/30" aria-hidden />,
  UNSUPPORTED: <MinusCircle className="h-3.5 w-3.5 text-primary/30" aria-hidden />,
};

function FindingRow({ f }: { f: Record<string, unknown> }) {
  const sev = toSev(f.severity);
  const status = asStr(f.status) || "INFO";
  const affected = asArr(f.affected).map(asStr).filter(Boolean);
  const evidence = asArr(f.evidence).map(asDict);
  const flags = asArr(f.data_quality_flags).map(asStr).filter(Boolean);
  return (
    <Disclosure
      className="rounded-lg border border-border/50 bg-background/40 px-2.5 py-1.5"
      summary={
        <span className="flex min-w-0 flex-1 items-center gap-2 text-xs">
          {STATUS_ICON[status] ?? STATUS_ICON.UNSUPPORTED}
          <span
            className={`shrink-0 rounded border px-1 py-0.5 text-[10px] font-medium uppercase leading-none ${SEV[sev].pill}`}
          >
            {SEV[sev].label}
          </span>
          <span className="min-w-0 flex-1 truncate text-primary/80">
            {asStr(f.observation) || asStr(f.check_id)}
          </span>
          {affected.length > 0 && (
            <span className="shrink-0 text-[11px] text-primary/40 tabular-nums">
              {affected.length} affected
            </span>
          )}
        </span>
      }
    >
      <div className="ml-5 flex flex-col gap-1.5 pb-1 text-xs text-primary/70">
        <div className="font-mono text-[10px] text-primary/40">{asStr(f.check_id)}</div>
        {asStr(f.expected) && <Field label="Expected">{asStr(f.expected)}</Field>}
        {asStr(f.observation) && <Field label="Observed">{asStr(f.observation)}</Field>}
        {asStr(f.recommendation) && <Field label="Fix">{asStr(f.recommendation)}</Field>}
        {asStr(f.verification) && <Field label="Verify">{asStr(f.verification)}</Field>}
        {affected.length > 0 && (
          <Field label={`Affected (${affected.length})`}>
            <span className="break-all">{affected.slice(0, 25).join(", ")}</span>
          </Field>
        )}
        {evidence.length > 0 && (
          <div className="mt-0.5 overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-primary/40">
                  <th className="pr-2 text-left font-medium">Tool</th>
                  <th className="pr-2 text-left font-medium">Observed at</th>
                  <th className="text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="text-primary/60">
                {evidence.slice(0, 12).map((e, i) => (
                  <tr key={`${asStr(e.tool_id)}:${i}`}>
                    <td className="pr-2 font-mono">{asStr(e.tool_id) || asStr(e.intent) || "—"}</td>
                    <td className="pr-2 tabular-nums">{asStr(e.observed_at) || "—"}</td>
                    <td>{asNum(e.status_code) || (e.ok === false ? "error" : "ok")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {flags.length > 0 && (
          <div className="text-[11px] italic text-primary/40">data quality: {flags.join(", ")}</div>
        )}
      </div>
    </Disclosure>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <span className="text-primary/40">{label}: </span>
      {children}
    </div>
  );
}

/** Browser-reachable Convex SITE origin (the /artifact/file proxy). Mirrors
 *  agent-sources.tsx: NEXT_PUBLIC_CONVEX_URL is the /__cvx path form. */
function convexSite(): string {
  const u = process.env.NEXT_PUBLIC_CONVEX_URL ?? "";
  return u.includes("/__cvx") ? u.replace("/__cvx", "/__cvx-site") : u;
}

function DownloadButton({
  artifactId,
  format,
}: {
  artifactId: string;
  format: string;
}) {
  const mintDownload = useMutation(api.chat.artifacts.mintDownload);
  const [busy, setBusy] = useState(false);
  const meta = FORMAT_META[format] ?? { label: format.toUpperCase(), Icon: FileText };
  const Icon = meta.Icon;

  const onClick = async () => {
    if (busy || !artifactId) return;
    setBusy(true);
    try {
      const { token } = await mintDownload({ artifactId });
      const url = safeUrl(`${convexSite()}/artifact/file?t=${token}`);
      if (url) {
        const a = document.createElement("a");
        a.href = url;
        a.rel = "noopener";
        a.target = "_blank";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    } catch {
      // ownership/expiry → keep the card, no navigation
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-card/60 px-2 py-1 text-[11px] text-primary/70 outline-none hover:bg-primary/5 hover:text-brand-ink focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50"
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {meta.label}
      {busy ? (
        <span className="text-primary/40">…</span>
      ) : (
        <Download className="h-3 w-3 opacity-60" aria-hidden />
      )}
    </button>
  );
}

// --- helpers ---------------------------------------------------------------
function sortFindings(findings: Record<string, unknown>[]): Record<string, unknown>[] {
  const rank = (f: Record<string, unknown>) => SEV_ORDER.indexOf(toSev(f.severity));
  return [...findings].sort((a, b) => rank(a) - rank(b));
}
