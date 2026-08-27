/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { diffFindings } from "./seoMonitor";

const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });
const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
type TestT = TestConvex<typeof schema>;

const realFetch = globalThis.fetch;
beforeEach(() => {
  process.env.AI_BASE_URL = "http://ai.invalid:8000";
  process.env.AI_SERVICE_KEY = "k";
  globalThis.fetch = (async () => new Response("{}", { status: 202 })) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  // biome-ignore lint/performance/noDelete: only way to unset an env var
  delete process.env.AI_BASE_URL;
  // biome-ignore lint/performance/noDelete: only way to unset an env var
  delete process.env.AI_SERVICE_KEY;
});
async function drain(t: TestT) {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

type F = {
  check_id: string;
  status: string;
  severity?: string;
  observation?: string;
  affected?: string[];
  data_quality_flags?: string[];
};
function fmap(findings: F[]) {
  const m = new Map();
  for (const f of findings)
    m.set(f.check_id, {
      severity: "medium",
      observation: "",
      affected: [],
      data_quality_flags: [],
      ...f,
    });
  return m;
}

// ── diffFindings: the pure deterministic core (NO LLM) ─────────────────────────
describe("diffFindings", () => {
  test("new issue (PASS/absent → FAIL)", () => {
    const d = diffFindings(
      fmap([{ check_id: "crawl_index.robots", status: "PASS" }]),
      fmap([{ check_id: "crawl_index.robots", status: "FAIL", severity: "critical" }]),
    );
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ kind: "new", category: "indexability", severity: "critical" });
  });

  test("resolved (FAIL → PASS)", () => {
    const d = diffFindings(
      fmap([{ check_id: "onpage.title", status: "FAIL", severity: "high" }]),
      fmap([{ check_id: "onpage.title", status: "PASS" }]),
    );
    expect(d[0]).toMatchObject({ kind: "resolved", category: "metadata" });
  });

  test("regressed (WARN → FAIL, and severity worsened)", () => {
    const d = diffFindings(
      fmap([{ check_id: "technical.x", status: "WARN", severity: "medium" }]),
      fmap([{ check_id: "technical.x", status: "FAIL", severity: "high" }]),
    );
    expect(d[0]).toMatchObject({ kind: "regressed", category: "technical" });
  });

  test("changed (same status, observation moved) — a redirect flip", () => {
    const d = diffFindings(
      fmap([{ check_id: "seo_redirect_chain", status: "PASS", observation: "301" }]),
      fmap([{ check_id: "seo_redirect_chain", status: "PASS", observation: "302" }]),
    );
    expect(d[0]).toMatchObject({ kind: "changed", category: "redirects" });
  });

  test("identical findings ⇒ no changes", () => {
    const same = [{ check_id: "onpage.title", status: "PASS", observation: "ok" }];
    expect(diffFindings(fmap(same), fmap(same))).toHaveLength(0);
  });

  test("a change on PROVISIONAL/sampled data is flagged degraded", () => {
    const d = diffFindings(
      fmap([{ check_id: "gsc.search_analytics", status: "PASS", observation: "100 clicks" }]),
      fmap([
        {
          check_id: "gsc.search_analytics",
          status: "FAIL",
          severity: "high",
          observation: "10 clicks",
          data_quality_flags: ["PROVISIONAL"],
        },
      ]),
    );
    expect(d[0]).toMatchObject({ kind: "new", category: "search_performance", degraded: true });
  });
});

// ── runDiff integration ────────────────────────────────────────────────────────
async function seedUser(t: TestT) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "u@t.test" });
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: userId,
      createdAt: Date.now(),
    });
    return { userId, workspaceId };
  });
}

async function seedReport(
  t: TestT,
  o: { userId: Id<"users">; workspaceId: Id<"workspaces"> },
  reportId: string,
  findings: F[],
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("seoReports", {
      sourceRunId: reportId,
      reportId,
      workspaceId: o.workspaceId,
      userId: o.userId,
      status: "completed",
      target: "https://example.com",
      scope: "site",
      methodologyName: "SEO",
      methodologyVersion: "1",
      generatedAt: "2026-01-01T00:00:00Z",
      summary: { totalFindings: findings.length, passed: 0, failed: 0, warnings: 0, notTested: 0 },
      report: JSON.stringify({
        findings: findings.map((f) => ({
          severity: "medium",
          observation: "",
          affected: [],
          data_quality_flags: [],
          ...f,
        })),
      }),
      manifest: [],
      createdAt: Date.now(),
    });
  });
}

async function seedProjectAndRun(
  t: TestT,
  o: { userId: Id<"users">; workspaceId: Id<"workspaces"> },
  opts: {
    baselineReportId?: string;
    currentReportId: string;
    runStatus?: "succeeded" | "partial" | "failed";
  },
) {
  return t.run(async (ctx) => {
    const projectId = await ctx.db.insert("seoProjects", {
      userId: o.userId,
      workspaceId: o.workspaceId,
      target: "https://example.com",
      scope: "site",
      maxUrls: 100,
      status: "active",
      baselineReportId: opts.baselineReportId,
      baselineRunId: opts.baselineReportId ? "run_baseline" : undefined,
      retentionDays: 90,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const runId = `run_${Math.random()}`;
    await ctx.db.insert("seoRuns", {
      runId,
      projectId,
      origin: "schedule",
      userId: o.userId,
      workspaceId: o.workspaceId,
      target: "https://example.com",
      scope: "site",
      maxUrls: 100,
      status: opts.runStatus ?? "succeeded",
      heartbeatAt: Date.now(),
      attempts: 0,
      deadlineAt: Date.now() + 3_600_000,
      cancelRequested: false,
      workflowVersion: 1,
      schemaVersion: 1,
      inputHash: "x",
      costBudget: 100,
      costSpent: 0,
      processedCount: 10,
      reportId: opts.currentReportId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { projectId, runId };
  });
}

async function notifsFor(t: TestT, userId: Id<"users">) {
  return t.run(async (ctx) =>
    ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect(),
  );
}

describe("runDiff", () => {
  test("first run with no baseline ⇒ becomes the baseline, no alert", async () => {
    const t = convexTest(schema, modules);
    const o = await seedUser(t);
    await seedReport(t, o, "rep_1", [{ check_id: "onpage.title", status: "PASS" }]);
    const { projectId, runId } = await seedProjectAndRun(t, o, { currentReportId: "rep_1" });
    await t.mutation(internal.seoMonitor.runDiff, { runId });
    const project = await t.run(async (ctx) => ctx.db.get(projectId));
    expect(project?.baselineReportId).toBe("rep_1");
    expect(await notifsFor(t, o.userId)).toHaveLength(0); // no alert on baseline
  });

  test("a new CRITICAL issue ⇒ meaningful diff + a notification", async () => {
    const t = convexTest(schema, modules);
    const o = await seedUser(t);
    await seedReport(t, o, "base", [{ check_id: "crawl_index.robots", status: "PASS" }]);
    await seedReport(t, o, "cur", [
      { check_id: "crawl_index.robots", status: "FAIL", severity: "critical" },
    ]);
    const { runId } = await seedProjectAndRun(t, o, {
      baselineReportId: "base",
      currentReportId: "cur",
    });
    await t.mutation(internal.seoMonitor.runDiff, { runId });
    const diffs = await t.run(async (ctx) =>
      ctx.db.query("seoRunDiffs").withIndex("by_run", (q) => q.eq("runId", runId)).collect(),
    );
    expect(diffs[0]).toMatchObject({ meaningful: true, counts: { newIssues: 1 } });
    const n = await notifsFor(t, o.userId);
    expect(n).toHaveLength(1);
    expect(n[0]?.type).toBe("seo_monitor");
  });

  test("only LOW churn ⇒ diff recorded but NOT meaningful, no notification", async () => {
    const t = convexTest(schema, modules);
    const o = await seedUser(t);
    await seedReport(t, o, "base", [{ check_id: "onpage.alt", status: "PASS" }]);
    await seedReport(t, o, "cur", [
      { check_id: "onpage.alt", status: "WARN", severity: "low" },
    ]);
    const { runId } = await seedProjectAndRun(t, o, {
      baselineReportId: "base",
      currentReportId: "cur",
    });
    await t.mutation(internal.seoMonitor.runDiff, { runId });
    const diffs = await t.run(async (ctx) =>
      ctx.db.query("seoRunDiffs").withIndex("by_run", (q) => q.eq("runId", runId)).collect(),
    );
    expect(diffs[0]?.meaningful).toBe(false);
    expect(await notifsFor(t, o.userId)).toHaveLength(0);
  });

  test("false-alert suppression: a HIGH new issue on PROVISIONAL data is NOT meaningful", async () => {
    const t = convexTest(schema, modules);
    const o = await seedUser(t);
    await seedReport(t, o, "base", [{ check_id: "gsc.search_analytics", status: "PASS" }]);
    await seedReport(t, o, "cur", [
      {
        check_id: "gsc.search_analytics",
        status: "FAIL",
        severity: "high",
        data_quality_flags: ["QUOTA_SAMPLED"],
      },
    ]);
    const { runId } = await seedProjectAndRun(t, o, {
      baselineReportId: "base",
      currentReportId: "cur",
    });
    await t.mutation(internal.seoMonitor.runDiff, { runId });
    const diffs = await t.run(async (ctx) =>
      ctx.db.query("seoRunDiffs").withIndex("by_run", (q) => q.eq("runId", runId)).collect(),
    );
    expect(diffs[0]).toMatchObject({ meaningful: false, degraded: true });
    expect(await notifsFor(t, o.userId)).toHaveLength(0);
  });

  test("provider outage: a PARTIAL run never alerts (baseline preserved)", async () => {
    const t = convexTest(schema, modules);
    const o = await seedUser(t);
    await seedReport(t, o, "base", [{ check_id: "crawl_index.robots", status: "PASS" }]);
    await seedReport(t, o, "cur", [
      { check_id: "crawl_index.robots", status: "FAIL", severity: "critical" },
    ]);
    const { runId } = await seedProjectAndRun(t, o, {
      baselineReportId: "base",
      currentReportId: "cur",
      runStatus: "partial",
    });
    await t.mutation(internal.seoMonitor.runDiff, { runId });
    const diffs = await t.run(async (ctx) =>
      ctx.db.query("seoRunDiffs").withIndex("by_run", (q) => q.eq("runId", runId)).collect(),
    );
    expect(diffs[0]).toMatchObject({ meaningful: false, degraded: true });
    expect(await notifsFor(t, o.userId)).toHaveLength(0);
  });
});

// ── retention ───────────────────────────────────────────────────────────────
describe("reapOld retention", () => {
  test("purges runs older than retentionDays but keeps the baseline + last run", async () => {
    const t = convexTest(schema, modules);
    const o = await seedUser(t);
    const oldTs = Date.now() - 200 * 24 * 60 * 60_000; // 200 days ago (retention 90)
    const projectId = await t.run(async (ctx) => {
      const pid = await ctx.db.insert("seoProjects", {
        userId: o.userId, workspaceId: o.workspaceId, target: "https://example.com",
        scope: "site", maxUrls: 100, status: "active", retentionDays: 90,
        baselineRunId: "run_base", lastRunId: "run_last",
        createdAt: Date.now(), updatedAt: Date.now(),
      });
      const mk = (runId: string, createdAt: number) =>
        ctx.db.insert("seoRuns", {
          runId, projectId: pid, origin: "schedule", userId: o.userId,
          workspaceId: o.workspaceId, target: "x", scope: "site", maxUrls: 100,
          status: "succeeded", heartbeatAt: createdAt, attempts: 0,
          deadlineAt: createdAt, cancelRequested: false, workflowVersion: 1,
          schemaVersion: 1, inputHash: "x", costBudget: 100, costSpent: 0,
          processedCount: 0, createdAt, updatedAt: createdAt,
        });
      await mk("run_base", oldTs); // old but the BASELINE → keep
      await mk("run_last", oldTs); // old but the LAST run → keep
      await mk("run_old", oldTs); // old + not kept → purge
      await mk("run_new", Date.now()); // recent → keep
      return pid;
    });
    const r = await t.mutation(internal.seoMonitor.reapOld, {});
    expect(r.purged).toBe(1);
    const left = await t.run(async (ctx) =>
      ctx.db.query("seoRuns").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect(),
    );
    expect(left.map((x) => x.runId).sort()).toEqual(["run_base", "run_last", "run_new"]);
  });
});

// ── project lifecycle + authz ─────────────────────────────────────────────────
describe("seoProjects lifecycle + authz", () => {
  test("create → pause → resume flips the project + its schedules", async () => {
    const t = convexTest(schema, modules);
    const o = await seedUser(t);
    const { projectId } = await t
      .withIdentity(as(o.userId))
      .mutation(api.seoProjects.createProject, {
        target: "https://example.com",
        workspaceId: o.workspaceId,
      });
    const sid = await t
      .withIdentity(as(o.userId))
      .mutation(api.seoSchedules.createSchedule, {
        projectId: projectId as Id<"seoProjects">,
        cadence: "daily",
        timezone: "UTC",
        minuteOfDay: 540,
      });
    await t.withIdentity(as(o.userId)).mutation(api.seoProjects.pauseProject, { projectId });
    let s = await t.run(async (ctx) => ctx.db.get(sid.scheduleId));
    expect(s?.status).toBe("paused");
    await t.withIdentity(as(o.userId)).mutation(api.seoProjects.resumeProject, { projectId });
    s = await t.run(async (ctx) => ctx.db.get(sid.scheduleId));
    expect(s?.status).toBe("active");
  });

  test("a non-owner cannot read or rerun a project (Not found)", async () => {
    const t = convexTest(schema, modules);
    const o = await seedUser(t);
    const { projectId } = await t
      .withIdentity(as(o.userId))
      .mutation(api.seoProjects.createProject, {
        target: "https://example.com",
        workspaceId: o.workspaceId,
      });
    const other = await t.run(async (ctx) => ctx.db.insert("users", { email: "e@t.test" }));
    await expect(
      t.withIdentity(as(other)).query(api.seoProjects.getProject, { projectId }),
    ).rejects.toThrow(/Not found/);
    await expect(
      t.withIdentity(as(other)).mutation(api.seoProjects.rerunNow, { projectId }),
    ).rejects.toThrow(/Not found/);
  });

  test("deleting a user cascades their projects", async () => {
    const t = convexTest(schema, modules);
    const o = await seedUser(t);
    await t.withIdentity(as(o.userId)).mutation(api.seoProjects.createProject, {
      target: "https://example.com",
      workspaceId: o.workspaceId,
    });
    await t.mutation(internal.users.deleteUserAccount, { userId: o.userId });
    await drain(t);
    const left = await t.run(async (ctx) =>
      ctx.db.query("seoProjects").withIndex("by_user", (q) => q.eq("userId", o.userId)).collect(),
    );
    expect(left).toHaveLength(0);
  });

  test("rerunNow enqueues a manual run for the owner", async () => {
    const t = convexTest(schema, modules);
    const o = await seedUser(t);
    const { projectId } = await t
      .withIdentity(as(o.userId))
      .mutation(api.seoProjects.createProject, {
        target: "https://example.com",
        workspaceId: o.workspaceId,
      });
    const res = await t
      .withIdentity(as(o.userId))
      .mutation(api.seoProjects.rerunNow, { projectId });
    expect(res).toMatchObject({ ok: true });
    const runs = await t.run(async (ctx) =>
      ctx.db
        .query("seoRuns")
        .withIndex("by_project", (q) => q.eq("projectId", projectId as Id<"seoProjects">))
        .collect(),
    );
    expect(runs[0]?.origin).toBe("manual");
    await drain(t);
  });
});
