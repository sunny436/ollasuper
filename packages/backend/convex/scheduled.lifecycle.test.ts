/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

// Bind the app DataModel so `.withIndex` on the scheduled tables type-checks
// inside helpers (a bare `ReturnType<typeof convexTest>` degrades to
// system-only tables). Mirrors chat.durable.test.ts.
type TestT = TestConvex<typeof schema>;

const DAILY = {
  kind: "daily" as const,
  timezone: "Asia/Kolkata",
  hour: 9,
  minute: 0,
};

async function seed(t: TestT) {
  const { owner, ws } = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { email: "o@t.test" });
    const ws = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: owner,
      createdAt: Date.now(),
    });
    await ctx.db.insert("members", {
      workspaceId: ws,
      userId: owner,
      role: "owner",
      createdAt: Date.now(),
    });
    return { owner, ws };
  });
  return { owner, ws, u: t.withIdentity(as(owner)) };
}

/** Create occurrences directly through the scheduler contract. */
async function materialize(
  t: TestT,
  taskId: Id<"scheduledTasks">,
  instants: number[],
  toCursor: number,
) {
  const fromCursor = await t.run(
    async (ctx) => (await ctx.db.get(taskId))?.cursorAt ?? 0,
  );
  return t.mutation(internal.scheduled.occurrences.materialize, {
    taskId,
    fromCursor,
    toCursor,
    scheduledFor: instants,
  });
}

async function occurrencesOf(
  t: TestT,
  taskId: Id<"scheduledTasks">,
) {
  return t.run(async (ctx) =>
    ctx.db
      .query("scheduledTaskOccurrences")
      .withIndex("by_task_scheduled", (q) => q.eq("taskId", taskId))
      .collect(),
  );
}

describe("create / validate", () => {
  test("a task is created active, at revision 1, with a cursor at creation", async () => {
    const t = convexTest(schema, modules);
    const { u, ws } = await seed(t);
    const before = Date.now();
    const taskId = await u.mutation(api.scheduled.tasks.create, {
      workspaceId: ws,
      title: "  Daily   digest  ",
      prompt: "Summarise my inbox",
      spec: DAILY,
    });
    const task = await u.query(api.scheduled.tasks.get, { taskId });
    expect(task?.status).toBe("active");
    expect(task?.revision).toBe(1);
    expect(task?.title).toBe("Daily digest"); // whitespace normalised
    const row = await t.run(async (ctx) => ctx.db.get(taskId));
    // Nothing before creation can ever be enumerated, so a new task can never
    // backfill history.
    expect(row?.cursorAt).toBeGreaterThanOrEqual(before);
    expect(row?.currentRevisionId).toBeDefined();
  });

  test("weekly accepts MULTIPLE weekdays, deduped and sorted", async () => {
    const t = convexTest(schema, modules);
    const { u, ws } = await seed(t);
    const taskId = await u.mutation(api.scheduled.tasks.create, {
      workspaceId: ws,
      title: "MWF",
      prompt: "p",
      spec: {
        kind: "weekly",
        timezone: "America/New_York",
        weekdays: [5, 1, 3, 3],
        hour: 8,
        minute: 30,
      },
    });
    const task = await u.query(api.scheduled.tasks.get, { taskId });
    expect(task?.spec).toMatchObject({ kind: "weekly", weekdays: [1, 3, 5] });
  });

  test("invalid schedules are refused at the boundary", async () => {
    const t = convexTest(schema, modules);
    const { u, ws } = await seed(t);
    const create = (spec: Record<string, unknown>, title = "x") =>
      u.mutation(api.scheduled.tasks.create, {
        workspaceId: ws,
        title,
        prompt: "p",
        // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid input
        spec: spec as any,
      });

    await expect(
      create({ kind: "daily", timezone: "Not/AZone", hour: 9, minute: 0 }),
    ).rejects.toThrow(/timezone/i);
    await expect(
      create({
        kind: "weekly",
        timezone: "UTC",
        weekdays: [],
        hour: 9,
        minute: 0,
      }),
    ).rejects.toThrow(/weekdays/i);
    await expect(
      create({
        kind: "weekly",
        timezone: "UTC",
        weekdays: [9],
        hour: 9,
        minute: 0,
      }),
    ).rejects.toThrow(/weekdays/i);
    await expect(
      create({ kind: "daily", timezone: "UTC", hour: 24, minute: 0 }),
    ).rejects.toThrow(/hour/i);
    await expect(
      create({ kind: "monthly", timezone: "UTC", dayOfMonth: 0, hour: 9, minute: 0 }),
    ).rejects.toThrow(/dayOfMonth/i);
    // A one-time task in the past would either never fire or fire on a
    // technicality; refuse it rather than guess.
    await expect(
      create({ kind: "once", timezone: "UTC", runAt: Date.now() - 60_000 }),
    ).rejects.toThrow(/future/i);
  });
});

// ---------------------------------------------------------------------------
// Editing a task must never rewrite what an already-created occurrence meant.
// ---------------------------------------------------------------------------
describe("revisions", () => {
  test("an occurrence created under r1 keeps r1; new work uses r2", async () => {
    const t = convexTest(schema, modules);
    const { u, ws } = await seed(t);
    const taskId = await u.mutation(api.scheduled.tasks.create, {
      workspaceId: ws,
      title: "News",
      prompt: "Search AI news",
      spec: DAILY,
    });

    const t1 = Date.now() + 1000;
    await materialize(t, taskId, [t1], t1);

    // The user edits the task.
    const { revision } = await u.mutation(api.scheduled.tasks.update, {
      taskId,
      prompt: "Search AI and robotics news",
    });
    expect(revision).toBe(2);

    const t2 = t1 + 86_400_000;
    await materialize(t, taskId, [t2], t2);

    const occs = (await occurrencesOf(t, taskId)).sort(
      (a, b) => a.scheduledFor - b.scheduledFor,
    );
    expect(occs).toHaveLength(2);
    expect(occs[0].revision).toBe(1);
    expect(occs[1].revision).toBe(2);

    // The r1 revision row is immutable and still says what it always said.
    const r1 = await t.run(async (ctx) => ctx.db.get(occs[0].revisionId));
    expect(r1?.prompt).toBe("Search AI news");
    const r2 = await t.run(async (ctx) => ctx.db.get(occs[1].revisionId));
    expect(r2?.prompt).toBe("Search AI and robotics news");
  });

  test("editing does NOT move the cursor (no backfill, no double-fire)", async () => {
    const t = convexTest(schema, modules);
    const { u, ws } = await seed(t);
    const taskId = await u.mutation(api.scheduled.tasks.create, {
      workspaceId: ws,
      title: "News",
      prompt: "p",
      spec: DAILY,
    });
    const before = await t.run(
      async (ctx) => (await ctx.db.get(taskId))?.cursorAt,
    );
    await u.mutation(api.scheduled.tasks.update, { taskId, title: "News 2" });
    const after = await t.run(
      async (ctx) => (await ctx.db.get(taskId))?.cursorAt,
    );
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Pause suppresses FUTURE work but must never destroy work already created.
// ---------------------------------------------------------------------------
describe("pause / resume", () => {
  test("pause holds already-queued work; resume releases it", async () => {
    const t = convexTest(schema, modules);
    const { u, ws } = await seed(t);
    const taskId = await u.mutation(api.scheduled.tasks.create, {
      workspaceId: ws,
      title: "T",
      prompt: "p",
      spec: DAILY,
    });
    const at = Date.now() + 1000;
    await materialize(t, taskId, [at], at);
    expect((await occurrencesOf(t, taskId))[0].status).toBe("queued");

    const paused = await u.mutation(api.scheduled.tasks.pause, { taskId });
    expect(paused).toMatchObject({ paused: true, held: 1 });
    // HELD, not deleted: the occurrence survives the pause intact.
    expect((await occurrencesOf(t, taskId))[0].status).toBe("held");

    const resumed = await u.mutation(api.scheduled.tasks.resume, { taskId });
    expect(resumed).toMatchObject({ resumed: true, released: 1 });
    expect((await occurrencesOf(t, taskId))[0].status).toBe("queued");
  });

  test("resume jumps the cursor so the pause window is never backfilled", async () => {
    const t = convexTest(schema, modules);
    const { u, ws } = await seed(t);
    const taskId = await u.mutation(api.scheduled.tasks.create, {
      workspaceId: ws,
      title: "T",
      prompt: "p",
      spec: DAILY,
    });
    // Simulate a long pause: drag the cursor far into the past, as it would be
    // after the scheduler materialised up to pausedAt hours ago.
    const old = Date.now() - 6 * 3600_000;
    await t.run(async (ctx) => {
      await ctx.db.patch(taskId, { cursorAt: old });
    });
    await u.mutation(api.scheduled.tasks.pause, { taskId });
    const resumeAt = Date.now();
    await u.mutation(api.scheduled.tasks.resume, { taskId });

    const task = await t.run(async (ctx) => ctx.db.get(taskId));
    expect(task?.status).toBe("active");
    expect(task?.pausedAt).toBeUndefined();
    // The cursor is now at (or after) the resume instant, so every instant
    // inside the pause window is unreachable forever. That is the requirement:
    // suppressed, never backfilled.
    expect(task?.cursorAt).toBeGreaterThanOrEqual(resumeAt);
    expect(task?.cursorAt).toBeGreaterThan(old);
  });

  test("an occurrence materialised while paused is born HELD", async () => {
    const t = convexTest(schema, modules);
    const { u, ws } = await seed(t);
    const taskId = await u.mutation(api.scheduled.tasks.create, {
      workspaceId: ws,
      title: "T",
      prompt: "p",
      spec: DAILY,
    });
    await u.mutation(api.scheduled.tasks.pause, { taskId });
    const at = Date.now() + 1000;
    await materialize(t, taskId, [at], at);
    expect((await occurrencesOf(t, taskId))[0].status).toBe("held");
  });

  test("a one-time task paused across its only instant COMPLETES, never hangs", async () => {
    const t = convexTest(schema, modules);
    const { u, ws } = await seed(t);
    const runAt = Date.now() + 50;
    const taskId = await u.mutation(api.scheduled.tasks.create, {
      workspaceId: ws,
      title: "One shot",
      prompt: "p",
      spec: { kind: "once", timezone: "UTC", runAt },
    });
    await u.mutation(api.scheduled.tasks.pause, { taskId });
    // The instant passes while paused, so it is never materialised.
    await new Promise((r) => setTimeout(r, 80));
    const res = await u.mutation(api.scheduled.tasks.resume, { taskId });
    expect(res).toMatchObject({ resumed: true, completed: true });

    const task = await t.run(async (ctx) => ctx.db.get(taskId));
    // Without this the task would sit "active" forever, promising a run that
    // pause semantics forbid it from ever making.
    expect(task?.status).toBe("completed");
    expect(task?.terminalReason).toBe("suppressed_by_pause");
  });
});

describe("one-time completion", () => {
  test("a one-time task completes only after its occurrence is terminal", async () => {
    const t = convexTest(schema, modules);
    const { u, ws } = await seed(t);
    const runAt = Date.now() + 60_000;
    const taskId = await u.mutation(api.scheduled.tasks.create, {
      workspaceId: ws,
      title: "One shot",
      prompt: "p",
      spec: { kind: "once", timezone: "UTC", runAt },
    });
    await materialize(t, taskId, [runAt], runAt);
    expect(
      (await t.run(async (ctx) => ctx.db.get(taskId)))?.status,
    ).toBe("active");

    const { claims } = await t.mutation(internal.scheduled.occurrences.claim, {
      limit: 5,
      maxPerUser: 5,
    });
    expect(claims).toHaveLength(1);
    // Still active while the occurrence runs.
    expect(
      (await t.run(async (ctx) => ctx.db.get(taskId)))?.status,
    ).toBe("active");

    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claims[0].occurrenceKey,
      leaseToken: claims[0].leaseToken,
      outcome: "succeeded",
    });
    const task = await t.run(async (ctx) => ctx.db.get(taskId));
    expect(task?.status).toBe("completed");
    expect(task?.lastRunAt).toBeTypeOf("number");
  });
});

describe("run now", () => {
  test("run-now creates a manual occurrence and refuses a second while pending", async () => {
    const t = convexTest(schema, modules);
    const { u, ws } = await seed(t);
    const taskId = await u.mutation(api.scheduled.tasks.create, {
      workspaceId: ws,
      title: "T",
      prompt: "p",
      spec: DAILY,
    });
    expect(
      await u.mutation(api.scheduled.tasks.runNow, { taskId }),
    ).toMatchObject({ queued: true });
    // Explicitly refused, NOT silently dropped — the difference between a
    // guard and a lost run.
    expect(
      await u.mutation(api.scheduled.tasks.runNow, { taskId }),
    ).toMatchObject({ queued: false, reason: "already_queued" });
    expect(await occurrencesOf(t, taskId)).toHaveLength(1);
  });

  test("a manual run does not collide with a scheduled instant at the same ms", async () => {
    const t = convexTest(schema, modules);
    const { u, ws } = await seed(t);
    const taskId = await u.mutation(api.scheduled.tasks.create, {
      workspaceId: ws,
      title: "T",
      prompt: "p",
      spec: DAILY,
    });
    await u.mutation(api.scheduled.tasks.runNow, { taskId });
    const manual = (await occurrencesOf(t, taskId))[0];
    // Materialise a SCHEDULED occurrence at the exact same instant. Without
    // `kind` in the occurrence key this would be swallowed as a duplicate.
    await materialize(t, taskId, [manual.scheduledFor], manual.scheduledFor);
    const all = await occurrencesOf(t, taskId);
    expect(all).toHaveLength(2);
    expect(new Set(all.map((o) => o.kind))).toEqual(
      new Set(["manual", "scheduled"]),
    );
  });
});

describe("delete", () => {
  test("deleting a task cancels its open work and hides it from reads", async () => {
    const t = convexTest(schema, modules);
    const { u, ws } = await seed(t);
    const taskId = await u.mutation(api.scheduled.tasks.create, {
      workspaceId: ws,
      title: "T",
      prompt: "p",
      spec: DAILY,
    });
    const at = Date.now() + 1000;
    await materialize(t, taskId, [at], at);

    await u.mutation(api.scheduled.tasks.remove, { taskId });

    // Without this a soft-deleted task would keep executing forever.
    expect((await occurrencesOf(t, taskId))[0].status).toBe("cancelled");
    expect((await occurrencesOf(t, taskId))[0].terminalReason).toBe(
      "task_deleted",
    );
    expect(await u.query(api.scheduled.tasks.list, {})).toEqual([]);
    // Hidden from reads by returning nothing, not by throwing: the deep link
    // has to render the "deleted" panel without logging a console error.
    expect(await u.query(api.scheduled.tasks.get, { taskId })).toBeNull();
    // Still refused where it counts.
    await expect(
      u.mutation(api.scheduled.tasks.runNow, { taskId }),
    ).rejects.toThrow(/Not found/);
  });

  test("deleting while an occurrence is RUNNING requests cancellation durably", async () => {
    const t = convexTest(schema, modules);
    const { u, ws } = await seed(t);
    const taskId = await u.mutation(api.scheduled.tasks.create, {
      workspaceId: ws,
      title: "T",
      prompt: "p",
      spec: DAILY,
    });
    await u.mutation(api.scheduled.tasks.runNow, { taskId });
    const { claims } = await t.mutation(internal.scheduled.occurrences.claim, {
      limit: 5,
      maxPerUser: 5,
    });
    expect(claims).toHaveLength(1);

    await u.mutation(api.scheduled.tasks.remove, { taskId });
    const occ = (await occurrencesOf(t, taskId))[0];
    // Convex cannot push to Python, so cancellation is a durable flag the
    // worker observes on its next heartbeat — exactly like chat's stop button.
    expect(occ.status).toBe("running");
    expect(occ.cancelRequested).toBe(true);

    const hb = await t.mutation(internal.scheduled.occurrences.heartbeat, {
      occurrenceKey: claims[0].occurrenceKey,
      leaseToken: claims[0].leaseToken,
    });
    expect(hb).toMatchObject({ ok: true, cancel: true });
  });
});
