/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { computeNextRunAt } from "./seoSchedules";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
type TestT = TestConvex<typeof schema>;

// dueScanner → enqueueScheduledRun → scheduler.runAfter(0, dispatchRun) POSTs to Python;
// stub fetch so the scheduled action never touches the network.
const realFetch = globalThis.fetch;
beforeEach(() => {
  process.env.AI_BASE_URL = "http://ai.invalid:8000";
  process.env.AI_SERVICE_KEY = "k";
  globalThis.fetch = (async () =>
    new Response("{}", { status: 202 })) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  // biome-ignore lint/performance/noDelete: the only way to unset an env var
  delete process.env.AI_BASE_URL;
  // biome-ignore lint/performance/noDelete: the only way to unset an env var
  delete process.env.AI_SERVICE_KEY;
});

async function drain(t: TestT) {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

// ── computeNextRunAt: deterministic + timezone-aware (pure, no harness) ─────────
describe("computeNextRunAt", () => {
  const FROM = Date.UTC(2026, 0, 15, 12, 0); // 2026-01-15 12:00 UTC (a Thursday)

  test("daily in UTC → the next HH:MM after `from`", () => {
    // 09:00 UTC already passed today (12:00) ⇒ tomorrow 09:00.
    expect(computeNextRunAt("daily", "UTC", 540, undefined, undefined, FROM)).toBe(
      Date.UTC(2026, 0, 16, 9, 0),
    );
    // 18:00 UTC is still ahead today ⇒ today 18:00.
    expect(computeNextRunAt("daily", "UTC", 1080, undefined, undefined, FROM)).toBe(
      Date.UTC(2026, 0, 15, 18, 0),
    );
  });

  test("daily honours the timezone (America/New_York = UTC-5 in January)", () => {
    // 09:00 New York = 14:00 UTC; 14:00 > 12:00 ⇒ today 14:00 UTC.
    expect(
      computeNextRunAt("daily", "America/New_York", 540, undefined, undefined, FROM),
    ).toBe(Date.UTC(2026, 0, 15, 14, 0));
  });

  test("weekly → the next matching weekday at HH:MM", () => {
    // Next Monday (dayOfWeek=1) after Thu Jan 15 is Jan 19, 09:00 UTC.
    expect(computeNextRunAt("weekly", "UTC", 540, 1, undefined, FROM)).toBe(
      Date.UTC(2026, 0, 19, 9, 0),
    );
  });

  test("custom → `from` + intervalDays at HH:MM", () => {
    // every 3 days from Jan 15 ⇒ Jan 18 09:00 UTC.
    expect(computeNextRunAt("custom", "UTC", 540, undefined, 3, FROM)).toBe(
      Date.UTC(2026, 0, 18, 9, 0),
    );
  });

  test("the result is ALWAYS strictly in the future (missed windows don't repeat)", () => {
    const wayPast = Date.UTC(2020, 0, 1, 0, 0);
    const next = computeNextRunAt("daily", "UTC", 540, undefined, undefined, wayPast);
    expect(next).toBeGreaterThan(wayPast);
    expect(next).toBeLessThanOrEqual(wayPast + 2 * 24 * 60 * 60_000);
  });
});

// ── dueScanner (convex-test) ─────────────────────────────────────────────────
async function seedProject(t: TestT, status: "active" | "paused" = "active") {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "u@t.test" });
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: userId,
      createdAt: Date.now(),
    });
    const projectId = await ctx.db.insert("seoProjects", {
      userId,
      workspaceId,
      target: "https://example.com",
      scope: "site",
      maxUrls: 100,
      status,
      retentionDays: 90,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { userId, workspaceId, projectId };
  });
}

async function seedSchedule(
  t: TestT,
  o: { userId: Id<"users">; projectId: Id<"seoProjects"> },
  nextRunAt: number,
  status: "active" | "paused" = "active",
) {
  return t.run(async (ctx) =>
    ctx.db.insert("seoSchedules", {
      userId: o.userId,
      projectId: o.projectId,
      cadence: "daily",
      timezone: "UTC",
      minuteOfDay: 540,
      status,
      nextRunAt,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

async function projectRuns(t: TestT, projectId: Id<"seoProjects">) {
  return t.run(async (ctx) =>
    ctx.db
      .query("seoRuns")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect(),
  );
}

describe("dueScanner", () => {
  test("a due active schedule enqueues a monitoring run + advances nextRunAt", async () => {
    const t = convexTest(schema, modules);
    const o = await seedProject(t);
    const sid = await seedSchedule(t, o, Date.now() - 60_000);
    const r = await t.mutation(internal.seoSchedules.dueScanner, {});
    expect(r).toMatchObject({ scanned: 1, enqueued: 1 });
    const runs = await projectRuns(t, o.projectId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.origin).toBe("schedule");
    const s = await t.run(async (ctx) => ctx.db.get(sid));
    expect(s?.nextRunAt).toBeGreaterThan(Date.now()); // advanced to the future
    await drain(t);
  });

  test("a MISSED window (nextRunAt far in the past) catches up ONCE + advances forward", async () => {
    const t = convexTest(schema, modules);
    const o = await seedProject(t);
    const sid = await seedSchedule(t, o, Date.UTC(2020, 0, 1)); // years overdue
    await t.mutation(internal.seoSchedules.dueScanner, {});
    expect(await projectRuns(t, o.projectId)).toHaveLength(1); // exactly one, not N
    const s = await t.run(async (ctx) => ctx.db.get(sid));
    expect(s?.nextRunAt).toBeGreaterThan(Date.now());
    // A second immediate scan does nothing (nextRunAt is now in the future).
    const r2 = await t.mutation(internal.seoSchedules.dueScanner, {});
    expect(r2).toMatchObject({ scanned: 0 });
    await drain(t);
  });

  test("duplicate/no-stacking: a project with an in-flight run is skipped", async () => {
    const t = convexTest(schema, modules);
    const o = await seedProject(t);
    // A run already in flight for this project.
    await t.run(async (ctx) => {
      await ctx.db.insert("seoRuns", {
        runId: "r_active",
        projectId: o.projectId,
        origin: "schedule",
        userId: o.userId,
        workspaceId: o.workspaceId,
        target: "https://example.com",
        scope: "site",
        maxUrls: 100,
        status: "running",
        heartbeatAt: Date.now(),
        attempts: 0,
        deadlineAt: Date.now() + 3_600_000,
        cancelRequested: false,
        workflowVersion: 1,
        schemaVersion: 1,
        inputHash: "x",
        costBudget: 100,
        costSpent: 0,
        processedCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    const sid = await seedSchedule(t, o, Date.now() - 60_000);
    const r = await t.mutation(internal.seoSchedules.dueScanner, {});
    expect(r).toMatchObject({ scanned: 1, enqueued: 0 }); // skipped — no second run
    expect(await projectRuns(t, o.projectId)).toHaveLength(1);
    const s = await t.run(async (ctx) => ctx.db.get(sid));
    expect(s?.nextRunAt).toBeGreaterThan(Date.now()); // still advanced (no tight loop)
  });

  test("a paused schedule is not scanned", async () => {
    const t = convexTest(schema, modules);
    const o = await seedProject(t);
    await seedSchedule(t, o, Date.now() - 60_000, "paused");
    const r = await t.mutation(internal.seoSchedules.dueScanner, {});
    expect(r).toMatchObject({ scanned: 0, enqueued: 0 });
    expect(await projectRuns(t, o.projectId)).toHaveLength(0);
  });

  test("a paused PROJECT advances its schedule but enqueues nothing", async () => {
    const t = convexTest(schema, modules);
    const o = await seedProject(t, "paused");
    const sid = await seedSchedule(t, o, Date.now() - 60_000);
    const r = await t.mutation(internal.seoSchedules.dueScanner, {});
    expect(r).toMatchObject({ scanned: 1, enqueued: 0 });
    expect(await projectRuns(t, o.projectId)).toHaveLength(0);
    const s = await t.run(async (ctx) => ctx.db.get(sid));
    expect(s?.nextRunAt).toBeGreaterThan(Date.now());
  });
});
