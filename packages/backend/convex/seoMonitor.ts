import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";
import { notify } from "./notifications";
import { purgeOldProjectRuns } from "./seoRuns";

/**
 * Phase 6 — DETERMINISTIC change detection (NO LLM).
 *
 * When a monitoring run finalizes, its report is diffed against the project's baseline
 * report by comparing findings keyed on `check_id`. Every classification (new / resolved
 * / regressed / changed), its category, and the meaningful/degraded decision is a pure
 * data comparison — the exit criterion: continuous monitoring without invoking the LLM
 * for every check. An LLM is only ever needed to WRITE prose interpretation, which this
 * feature templates instead.
 */

const SEV_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};
// A finding is an "issue" iff its status is FAIL or WARN.
function isIssue(status: string): boolean {
  return status === "FAIL" || status === "WARN";
}
// Data-quality flags that make a change low-confidence (provider sampling / provisional
// windows). A change riding these must never fire a false alert.
const DEGRADING_FLAGS = new Set([
  "PROVISIONAL",
  "QUOTA_SAMPLED",
  "GA4_SAMPLED",
  "NO_FIELD_DATA",
  "CAPPED_50K",
  "ANONYMIZED",
  "THRESHOLDED",
  "OTHER_ROW_LOSS",
]);
const MAX_CHANGES = 200; // bound the diff row well under the ~1 MiB Convex doc cap

type Finding = {
  check_id: string;
  status: string;
  severity: string;
  observation: string;
  affected: string[];
  data_quality_flags: string[];
};

function categorize(checkId: string): string {
  const phase = checkId.split(".")[0] ?? "";
  if (checkId.includes("redirect")) return "redirects";
  if (checkId.includes("core_web_vitals") || checkId.includes("performance"))
    return "performance";
  if (
    checkId.includes("search_analytics") ||
    checkId.includes("ranking") ||
    checkId.startsWith("gsc") ||
    checkId.startsWith("ga4")
  )
    return "search_performance";
  if (phase === "crawl_index") return "indexability";
  if (phase === "onpage") return "metadata";
  if (phase === "content") return "content";
  if (phase === "technical") return "technical";
  return phase || "other";
}

function parseFindings(reportJson: string): Map<string, Finding> {
  const out = new Map<string, Finding>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(reportJson);
  } catch {
    return out;
  }
  const findings = (parsed as { findings?: unknown })?.findings;
  if (!Array.isArray(findings)) return out;
  for (const f of findings) {
    if (typeof f !== "object" || f === null) continue;
    const r = f as Record<string, unknown>;
    const checkId = typeof r.check_id === "string" ? r.check_id : "";
    if (!checkId) continue;
    out.set(checkId, {
      check_id: checkId,
      status: typeof r.status === "string" ? r.status : "",
      severity: typeof r.severity === "string" ? r.severity : "info",
      observation: typeof r.observation === "string" ? r.observation : "",
      affected: Array.isArray(r.affected)
        ? r.affected.filter((x): x is string => typeof x === "string")
        : [],
      data_quality_flags: Array.isArray(r.data_quality_flags)
        ? r.data_quality_flags.filter((x): x is string => typeof x === "string")
        : [],
    });
  }
  return out;
}

type Change = {
  checkId: string;
  category: string;
  kind: "new" | "resolved" | "regressed" | "changed";
  severity: string;
  before: string;
  after: string;
  degraded: boolean;
};

/** The whole comparison — pure function of the two finding sets. Exported for tests. */
export function diffFindings(
  baseline: Map<string, Finding>,
  current: Map<string, Finding>,
): Change[] {
  const changes: Change[] = [];
  const keys = new Set([...baseline.keys(), ...current.keys()]);
  for (const checkId of keys) {
    const b = baseline.get(checkId);
    const c = current.get(checkId);
    const category = categorize(checkId);
    const degraded = (c?.data_quality_flags ?? []).some((fl) =>
      DEGRADING_FLAGS.has(fl),
    );
    const bIssue = b ? isIssue(b.status) : false;
    const cIssue = c ? isIssue(c.status) : false;

    if (cIssue && !bIssue) {
      changes.push({
        checkId, category, kind: "new", severity: c?.severity ?? "info",
        before: b?.status ?? "absent", after: c?.observation ?? "", degraded,
      });
    } else if (bIssue && !cIssue) {
      changes.push({
        checkId, category, kind: "resolved", severity: b?.severity ?? "info",
        before: b?.observation ?? "", after: c?.status ?? "resolved", degraded,
      });
    } else if (bIssue && cIssue && b && c) {
      const worseSeverity =
        (SEV_ORDER[c.severity] ?? 9) < (SEV_ORDER[b.severity] ?? 9);
      const worseStatus = b.status === "WARN" && c.status === "FAIL";
      if (worseSeverity || worseStatus) {
        changes.push({
          checkId, category, kind: "regressed", severity: c.severity,
          before: `${b.status}/${b.severity}`, after: `${c.status}/${c.severity}`, degraded,
        });
      } else if (
        c.observation !== b.observation ||
        c.affected.join("|") !== b.affected.join("|")
      ) {
        changes.push({
          checkId, category, kind: "changed", severity: c.severity,
          before: b.observation, after: c.observation, degraded,
        });
      }
    } else if (b && c && !bIssue && !cIssue) {
      // Both non-issues but the OBSERVATION moved (redirect flip, metadata edit, a metric
      // shift) — a "changed" that still matters for redirects/indexability/perf/search.
      if (
        c.observation !== b.observation ||
        c.affected.join("|") !== b.affected.join("|")
      ) {
        changes.push({
          checkId, category, kind: "changed", severity: c.severity,
          before: b.observation, after: c.observation, degraded,
        });
      }
    }
  }
  // Deterministic order: severity, then check_id.
  changes.sort(
    (x, y) =>
      (SEV_ORDER[x.severity] ?? 9) - (SEV_ORDER[y.severity] ?? 9) ||
      x.checkId.localeCompare(y.checkId),
  );
  return changes.slice(0, MAX_CHANGES);
}

const MEANINGFUL_CHANGE_CATEGORIES = new Set(["indexability", "redirects"]);

/** A change alerts iff it is high-signal AND on trustworthy (non-degraded) data. */
function isMeaningful(ch: Change): boolean {
  if (ch.degraded) return false;
  const sev = SEV_ORDER[ch.severity] ?? 9;
  if ((ch.kind === "new" || ch.kind === "regressed") && sev <= 1) return true;
  if (ch.kind === "resolved" && sev <= 1) return true;
  // A redirect / indexability change (even PASS→PASS) at medium+ is worth surfacing.
  if (
    ch.kind === "changed" &&
    MEANINGFUL_CHANGE_CATEGORIES.has(ch.category) &&
    sev <= 2
  )
    return true;
  return false;
}

async function loadReport(ctx: MutationCtx, reportId: string) {
  return ctx.db
    .query("seoReports")
    .withIndex("by_report_id", (q) => q.eq("reportId", reportId))
    .first();
}

/**
 * The monitoring hook (scheduled from finalizeRun for a project run). First run for a
 * project with no baseline ⇒ this report becomes the baseline (no diff/alert). Otherwise
 * diff vs baseline, store the change-set, and notify only on meaningful changes.
 */
export const runDiff = internalMutation({
  args: { runId: v.string() },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db
      .query("seoRuns")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .unique();
    if (!run || !run.projectId || !run.reportId) return;
    const project = await ctx.db.get(run.projectId);
    if (!project) return;
    const now = Date.now();

    // Baseline seeding: the first successful project run anchors the comparison.
    if (!project.baselineReportId) {
      if (run.status === "succeeded" || run.status === "partial") {
        const rep = await loadReport(ctx, run.reportId);
        await ctx.db.patch(run.projectId, {
          baselineRunId: run.runId,
          baselineReportId: run.reportId,
          methodologyVersion: rep?.methodologyVersion,
          updatedAt: now,
        });
      }
      return;
    }

    // Provider outage: a partial/failed run produced degraded/incomplete evidence — never
    // alert off it (baseline stays; next healthy run diffs normally).
    const runDegraded = run.status !== "succeeded";

    const currentRep = await loadReport(ctx, run.reportId);
    const baselineRep = await loadReport(ctx, project.baselineReportId);
    if (!currentRep) return;

    const changes = diffFindings(
      parseFindings(baselineRep?.report ?? "{}"),
      parseFindings(currentRep.report),
    );
    const counts = {
      newIssues: changes.filter((c) => c.kind === "new").length,
      resolved: changes.filter((c) => c.kind === "resolved").length,
      regressed: changes.filter((c) => c.kind === "regressed").length,
      changed: changes.filter((c) => c.kind === "changed").length,
    };
    const meaningfulChanges = runDegraded
      ? []
      : changes.filter(isMeaningful);
    const meaningful = meaningfulChanges.length > 0;
    const anyDegraded = runDegraded || changes.some((c) => c.degraded);

    await ctx.db.insert("seoRunDiffs", {
      runId: run.runId,
      projectId: run.projectId,
      userId: run.userId,
      baselineReportId: project.baselineReportId,
      currentReportId: run.reportId,
      counts,
      changes: JSON.stringify(changes).slice(0, 900_000),
      meaningful,
      degraded: anyDegraded,
      notified: meaningful,
      createdAt: now,
    });

    if (meaningful) {
      const nNew = meaningfulChanges.filter((c) => c.kind === "new").length;
      const nReg = meaningfulChanges.filter((c) => c.kind === "regressed").length;
      const nRes = meaningfulChanges.filter((c) => c.kind === "resolved").length;
      const parts: string[] = [];
      if (nNew) parts.push(`${nNew} new`);
      if (nReg) parts.push(`${nReg} regressed`);
      if (nRes) parts.push(`${nRes} resolved`);
      await notify(
        ctx,
        run.userId,
        "seo_monitor",
        `SEO changes on ${project.target}`,
        `${parts.join(" · ")} — important SEO ${
          nNew + nReg > 0 ? "issue" : "change"
        }${nNew + nReg + nRes === 1 ? "" : "s"} detected.`,
      );
    }
  },
});

// ── Retention ───────────────────────────────────────────────────────────────────

/** Cron: purge monitoring runs (+ their reports/diffs/artifacts) older than a project's
 *  retentionDays — NEVER the baseline. Self-bounded per tick. */
export const reapOld = internalMutation({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db.query("seoProjects").take(50);
    let purged = 0;
    for (const project of projects) {
      const olderThan = Date.now() - project.retentionDays * 24 * 60 * 60_000;
      const keep = new Set<string>();
      if (project.baselineRunId) keep.add(project.baselineRunId);
      if (project.lastRunId) keep.add(project.lastRunId);
      purged += await purgeOldProjectRuns(
        ctx,
        project._id as Id<"seoProjects">,
        keep,
        olderThan,
      );
    }
    return { purged };
  },
});
