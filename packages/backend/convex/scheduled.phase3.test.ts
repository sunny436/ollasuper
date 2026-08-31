/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });
type TestT = TestConvex<typeof schema>;

const DAILY = { kind: "daily" as const, timezone: "UTC", hour: 9, minute: 0 };
const DAY = 86_400_000;

const realFetch = globalThis.fetch;
beforeEach(() => {
  process.env.AI_BASE_URL = "http://ai.invalid:8000";
  process.env.AI_SERVICE_KEY = "test-service-key";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ accepted: true }), {
      status: 202,
    })) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  // biome-ignore lint/performance/noDelete: the only way to actually unset an env var
  delete process.env.AI_BASE_URL;
  // biome-ignore lint/performance/noDelete: the only way to actually unset an env var
  delete process.env.AI_SERVICE_KEY;
});

async function drain(t: TestT) {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

async function seed(t: TestT, email = "o@t.test") {
  const { userId, ws } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email });
    const ws = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: userId,
      createdAt: Date.now(),
    });
    await ctx.db.insert("members", {
      workspaceId: ws,
      userId,
      role: "owner",
      createdAt: Date.now(),
    });
    return { userId, ws };
  });
  return { userId, ws, u: t.withIdentity(as(userId)) };
}

async function mkTask(t: TestT, userId: Id<"users">, ws: Id<"workspaces">, spec = DAILY) {
  return t.withIdentity(as(userId)).mutation(api.scheduled.tasks.create, {
    workspaceId: ws,
    title: "Daily digest",
    prompt: "Summarise my inbox",
    spec,
  });
}

/** Queue a manual occurrence and claim it, returning the lease. */
async function claimOne(t: TestT, userId: Id<"users">, taskId: Id<"scheduledTasks">) {
  await t
    .withIdentity(as(userId))
    .mutation(api.scheduled.tasks.runNow, { taskId });
  const { claims } = await t.mutation(internal.scheduled.occurrences.claim, {
    limit: 1,
    maxPerUser: 1,
  });
  return claims[0];
}

// ---------------------------------------------------------------------------
// C2 — a running occurrence heartbeats every 30s. If it lived in `history`,
// Convex would re-send the whole list to every subscriber twice a minute.
// ---------------------------------------------------------------------------
describe("history excludes in-flight rows", () => {
  test("a running occurrence is served by activeRun, never by history", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const taskId = await mkTask(t, userId, ws);
    const claim = await claimOne(t, userId, taskId);

    expect((await u.query(api.scheduled.tasks.history, { taskId })).page).toEqual(
      [],
    );
    const live = await u.query(api.scheduled.tasks.activeRun, { taskId });
    expect(live?.status).toBe("running");

    // Once terminal it moves into history and OUT of activeRun.
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    expect(await u.query(api.scheduled.tasks.activeRun, { taskId })).toBeNull();
    const { page } = await u.query(api.scheduled.tasks.history, { taskId });
    expect(page).toHaveLength(1);
    expect(page[0].status).toBe("succeeded");
  });

  test("a retrying occurrence is also in-flight", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const taskId = await mkTask(t, userId, ws);
    const claim = await claimOne(t, userId, taskId);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "failed",
      errorCode: "provider_error",
      retryable: true,
    });
    expect((await u.query(api.scheduled.tasks.history, { taskId })).page).toEqual(
      [],
    );
    expect(
      (await u.query(api.scheduled.tasks.activeRun, { taskId }))?.status,
    ).toBe("retrying");
  });

  test("history carries the result reference Phase 3 needs", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const taskId = await mkTask(t, userId, ws);
    const claim = await claimOne(t, userId, taskId);
    await t.mutation(internal.scheduled.execution.startRun, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
    });
    await drain(t);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });

    const { page } = await u.query(api.scheduled.tasks.history, { taskId });
    // Without these the UI cannot open what a run produced.
    expect(page[0].messageId).not.toBeNull();
    expect(page[0].threadId).not.toBeNull();
  });

  test("history pages backwards with a stable cursor", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const taskId = await mkTask(t, userId, ws);
    const from = await t.run(
      async (ctx) => (await ctx.db.get(taskId))?.cursorAt ?? 0,
    );
    const instants = Array.from({ length: 8 }, (_, i) => from + (i + 1) * 1000);
    await t.mutation(internal.scheduled.occurrences.materialize, {
      taskId,
      fromCursor: from,
      toCursor: from + 9000,
      scheduledFor: instants,
    });

    const first = await u.query(api.scheduled.tasks.history, {
      taskId,
      limit: 3,
    });
    expect(first.page).toHaveLength(3);
    // Newest first.
    expect(first.page[0].scheduledFor).toBe(instants[7]);
    expect(first.nextCursor).toBe(instants[5]);

    const second = await u.query(api.scheduled.tasks.history, {
      taskId,
      limit: 3,
      before: first.nextCursor ?? undefined,
    });
    expect(second.page.map((o) => o.scheduledFor)).toEqual([
      instants[4],
      instants[3],
      instants[2],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Concurrent edits must not silently overwrite newer state.
// ---------------------------------------------------------------------------
describe("optimistic concurrency on edit", () => {
  test("a stale expectedRevision is refused", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const taskId = await mkTask(t, userId, ws);

    // Tab A saves first.
    await u.mutation(api.scheduled.tasks.update, {
      taskId,
      title: "From tab A",
      expectedRevision: 1,
    });
    // Tab B still holds revision 1.
    await expect(
      u.mutation(api.scheduled.tasks.update, {
        taskId,
        title: "From tab B",
        expectedRevision: 1,
      }),
    ).rejects.toThrow(/changed elsewhere/i);
    expect((await u.query(api.scheduled.tasks.get, { taskId })).title).toBe(
      "From tab A",
    );
  });

  test("omitting expectedRevision keeps the pre-Phase-3 behaviour", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const taskId = await mkTask(t, userId, ws);
    await u.mutation(api.scheduled.tasks.update, { taskId, title: "No guard" });
    expect((await u.query(api.scheduled.tasks.get, { taskId })).title).toBe(
      "No guard",
    );
  });
});

// ---------------------------------------------------------------------------
// "End repeat".
// ---------------------------------------------------------------------------
describe("endsAt", () => {
  test("a schedule that has ended completes the task", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const taskId = await mkTask(t, userId, ws, {
      ...DAILY,
      endsAt: Date.now() + 30 * DAY,
    } as typeof DAILY);
    const from = await t.run(
      async (ctx) => (await ctx.db.get(taskId))?.cursorAt ?? 0,
    );
    await t.mutation(internal.scheduled.occurrences.materialize, {
      taskId,
      fromCursor: from,
      toCursor: from + 1000,
      scheduledFor: [],
      scheduleEnded: true,
    });
    const task = await u.query(api.scheduled.tasks.get, { taskId });
    expect(task.status).toBe("completed");
    expect(task.terminalReason).toBe("schedule_ended");
  });

  test("an owed occurrence still runs before the task closes", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const taskId = await mkTask(t, userId, ws, {
      ...DAILY,
      endsAt: Date.now() + 30 * DAY,
    } as typeof DAILY);
    await claimOne(t, userId, taskId); // one occurrence still in flight
    const from = await t.run(
      async (ctx) => (await ctx.db.get(taskId))?.cursorAt ?? 0,
    );
    await t.mutation(internal.scheduled.occurrences.materialize, {
      taskId,
      fromCursor: from,
      toCursor: from + 1000,
      scheduledFor: [],
      scheduleEnded: true,
    });
    // Still active — work it already owed has not finished.
    expect((await u.query(api.scheduled.tasks.get, { taskId })).status).toBe(
      "active",
    );
  });

  test("an end date in the past is refused at creation", async () => {
    const t = convexTest(schema, modules);
    const { ws, u } = await seed(t);
    await expect(
      u.mutation(api.scheduled.tasks.create, {
        workspaceId: ws,
        title: "x",
        prompt: "p",
        spec: { ...DAILY, endsAt: Date.now() - DAY } as typeof DAILY,
      }),
    ).rejects.toThrow(/End date/i);
  });
});

// ---------------------------------------------------------------------------
// Notifications: idempotent, preference-driven, and never fatal.
// ---------------------------------------------------------------------------
describe("notifications", () => {
  async function notifications(t: TestT, userId: Id<"users">) {
    return t.run(async (ctx) =>
      ctx.db
        .query("notifications")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect(),
    );
  }

  test("a finished run notifies exactly once, with a deep link", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const taskId = await mkTask(t, userId, ws);
    const claim = await claimOne(t, userId, taskId);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });

    const rows = await notifications(t, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("scheduled.succeeded");
    expect(rows[0].dedupeKey).toBe(claim.occurrenceKey);
    expect(rows[0].taskId).toBe(taskId);
    expect(rows[0].read).toBe(false);
  });

  test("a replayed finalize cannot produce a second notification", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const taskId = await mkTask(t, userId, ws);
    const claim = await claimOne(t, userId, taskId);
    for (let i = 0; i < 3; i++) {
      await t.mutation(internal.scheduled.occurrences.finalize, {
        occurrenceKey: claim.occurrenceKey,
        leaseToken: claim.leaseToken,
        outcome: "succeeded",
      });
    }
    // The alreadyTerminal guard means a replay never even reaches the emit.
    expect(await notifications(t, userId)).toHaveLength(1);
  });

  test("the dedupe key blocks a duplicate even if the emit is reached twice", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const taskId = await mkTask(t, userId, ws);
    await t.run(async (ctx) => {
      for (let i = 0; i < 2; i++) {
        await ctx.runMutation(internal.scheduled.occurrences.reapStalled, {});
      }
    });
    // Direct double-emit with the same key.
    await t.run(async (ctx) => {
      const { notify } = await import("./notifications");
      await notify(ctx, userId, "scheduled.succeeded", "A", undefined, {
        dedupeKey: "dupe-1",
        taskId,
      });
      await notify(ctx, userId, "scheduled.succeeded", "A again", undefined, {
        dedupeKey: "dupe-1",
        taskId,
      });
    });
    const rows = (await notifications(t, userId)).filter(
      (n) => n.dedupeKey === "dupe-1",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("A");
  });

  test("preferences default to enabled and can be turned off", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const taskId = await mkTask(t, userId, ws);

    const task = await u.query(api.scheduled.tasks.get, { taskId });
    // Absent means enabled — no migration needed for pre-Phase-3 tasks.
    expect(task.notifyOnSuccess).toBe(true);
    expect(task.notifyOnFailure).toBe(true);

    await u.mutation(api.scheduled.tasks.setNotifyPrefs, {
      taskId,
      notifyOnSuccess: false,
    });
    const claim = await claimOne(t, userId, taskId);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    expect(await notifications(t, userId)).toEqual([]);
  });

  test("a failure still notifies when only success is disabled", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const taskId = await mkTask(t, userId, ws);
    await u.mutation(api.scheduled.tasks.setNotifyPrefs, {
      taskId,
      notifyOnSuccess: false,
    });
    const claim = await claimOne(t, userId, taskId);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "failed",
      errorCode: "deadline",
    });
    const rows = await notifications(t, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("scheduled.failed");
    expect(rows[0].body).toContain("deadline");
  });

  test("an enormous error string cannot blow the notification document", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const taskId = await mkTask(t, userId, ws);
    const claim = await claimOne(t, userId, taskId);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "failed",
      errorCode: "x".repeat(5_000),
    });
    const rows = await notifications(t, userId);
    // Clamped — an oversized document inside the finalize transaction would
    // abort the terminal transition and get the run re-executed.
    expect(rows[0].title.length).toBeLessThanOrEqual(120);
    expect((rows[0].body ?? "").length).toBeLessThanOrEqual(500);
    // …and the occurrence still reached its terminal state.
    const { page } = await t
      .withIdentity(as(userId))
      .query(api.scheduled.tasks.history, { taskId });
    expect(page[0].status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Result access is owner- AND task-scoped.
// ---------------------------------------------------------------------------
describe("runResult", () => {
  test("it returns the pinned prompt and the rendered message", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const taskId = await mkTask(t, userId, ws);
    const claim = await claimOne(t, userId, taskId);
    const started = await t.mutation(internal.scheduled.execution.startRun, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
    });
    await drain(t);
    await t.mutation(internal.chat.ingest.finishStream, {
      streamId: String(started.streamId),
      text: "Here is your digest.",
    });
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });

    const { page } = await u.query(api.scheduled.tasks.history, { taskId });
    const res = await u.query(api.scheduled.tasks.runResult, {
      taskId,
      occurrenceId: page[0]._id,
    });
    expect(res.prompt).toBe("Summarise my inbox");
    expect(res.message?.content).toBe("Here is your digest.");
    expect(res.message?.status).toBe("complete");
  });

  test("an occurrence from ANOTHER task is refused", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const taskA = await mkTask(t, userId, ws);
    const taskB = await mkTask(t, userId, ws);
    const claim = await claimOne(t, userId, taskA);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    const { page } = await u.query(api.scheduled.tasks.history, {
      taskId: taskA,
    });

    // Same owner, wrong task — still refused.
    await expect(
      u.query(api.scheduled.tasks.runResult, {
        taskId: taskB,
        occurrenceId: page[0]._id,
      }),
    ).rejects.toThrow(/Not found/);
  });

  test("another user cannot read a result", async () => {
    const t = convexTest(schema, modules);
    const owner = await seed(t, "owner@t.test");
    const other = await seed(t, "other@t.test");
    const taskId = await mkTask(t, owner.userId, owner.ws);
    const claim = await claimOne(t, owner.userId, taskId);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    const { page } = await owner.u.query(api.scheduled.tasks.history, {
      taskId,
    });
    await expect(
      t
        .withIdentity(as(other.userId))
        .query(api.scheduled.tasks.runResult, {
          taskId,
          occurrenceId: page[0]._id,
        }),
    ).rejects.toThrow(/Not found/);
  });

  test("a run with no message yet returns null rather than failing", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const taskId = await mkTask(t, userId, ws);
    const claim = await claimOne(t, userId, taskId);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "cancelled",
    });
    const { page } = await u.query(api.scheduled.tasks.history, { taskId });
    const res = await u.query(api.scheduled.tasks.runResult, {
      taskId,
      occurrenceId: page[0]._id,
    });
    expect(res.message).toBeNull();
    expect(res.occurrence.status).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------
// Deleted tasks: rows preserved, reads refused, deep links safe.
// ---------------------------------------------------------------------------
describe("deleted tasks", () => {
  test("history rows survive deletion but become unreachable", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const taskId = await mkTask(t, userId, ws);
    const claim = await claimOne(t, userId, taskId);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });

    await u.mutation(api.scheduled.tasks.remove, { taskId });

    // The rows are still there — nothing is purged.
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("scheduledTaskOccurrences")
        .withIndex("by_task_scheduled", (q) => q.eq("taskId", taskId))
        .collect(),
    );
    expect(rows).toHaveLength(1);

    // …but every read path refuses, by design. The UI renders a "deleted"
    // state rather than an error, and the guard is never weakened.
    for (const call of [
      u.query(api.scheduled.tasks.get, { taskId }),
      u.query(api.scheduled.tasks.history, { taskId }),
      u.query(api.scheduled.tasks.activeRun, { taskId }),
    ]) {
      await expect(call).rejects.toThrow(/Not found/);
    }
    // The delivered notification is kept.
    const notes = await t.run(async (ctx) =>
      ctx.db
        .query("notifications")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect(),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0].taskId).toBe(taskId);
  });
});

// ---------------------------------------------------------------------------
// The parser never creates anything, and is gated before it can spend money.
// ---------------------------------------------------------------------------
describe("schedule parser gate", () => {
  test("an oversized message is refused without spending a rate-limit slot", async () => {
    const t = convexTest(schema, modules);
    const { ws, u } = await seed(t);
    const res = await u.action(api.scheduled.parse.parse, {
      workspaceId: ws,
      text: "x".repeat(2_500),
    });
    expect(res).toMatchObject({ ok: false, reason: "too_long" });
    // No task was created, and no schedule row exists.
    expect(await u.query(api.scheduled.tasks.list, {})).toEqual([]);
  });

  test("an empty message is refused", async () => {
    const t = convexTest(schema, modules);
    const { ws, u } = await seed(t);
    expect(
      await u.action(api.scheduled.parse.parse, { workspaceId: ws, text: "   " }),
    ).toMatchObject({ ok: false, reason: "empty" });
  });

  test("the hourly window eventually refuses, and still creates nothing", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("chatSettings", {
        userId,
        workspaceId: ws,
        defaultModel: "",
        sendOnEnter: true,
        updatedAt: Date.now(),
        parseWindowStart: Date.now(),
        parseWindowCount: 60,
      });
    });
    const res = await t
      .withIdentity(as(userId))
      .action(api.scheduled.parse.parse, {
        workspaceId: ws,
        text: "every day at 9am summarise my inbox",
      });
    expect(res).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(
      await t.withIdentity(as(userId)).query(api.scheduled.tasks.list, {}),
    ).toEqual([]);
  });

  test("a non-member cannot parse into someone else's workspace", async () => {
    const t = convexTest(schema, modules);
    const owner = await seed(t, "owner@t.test");
    const outsider = await seed(t, "outsider@t.test");
    await expect(
      t.withIdentity(as(outsider.userId)).action(api.scheduled.parse.parse, {
        workspaceId: owner.ws,
        text: "every day at 9am",
      }),
    ).rejects.toThrow();
  });
});
