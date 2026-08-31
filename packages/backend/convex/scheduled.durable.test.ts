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
  timezone: "UTC",
  hour: 9,
  minute: 0,
};

const DAY = 86_400_000;

async function seedUser(t: TestT, email: string) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email });
    const ws = await ctx.db.insert("workspaces", {
      name: `WS-${email}`,
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
}

async function mkTask(
  t: TestT,
  userId: Id<"users">,
  ws: Id<"workspaces">,
  title: string,
) {
  return t
    .withIdentity(as(userId))
    .mutation(api.scheduled.tasks.create, {
      workspaceId: ws,
      title,
      prompt: "p",
      spec: DAILY,
    });
}

async function cursorOf(
  t: TestT,
  taskId: Id<"scheduledTasks">,
) {
  return t.run(async (ctx) => (await ctx.db.get(taskId))?.cursorAt ?? 0);
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

// ---------------------------------------------------------------------------
// THE headline guarantee: an outage must produce one execution per missed
// occurrence, never one "catch-up" run and never a missedCount.
// ---------------------------------------------------------------------------
describe("no silent loss", () => {
  test("three missed days produce THREE separate occurrences", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seedUser(t, "a@t.test");
    const taskId = await mkTask(t, userId, ws, "Daily");

    // The scheduler was down for three days: the cursor still sits where it
    // was, which is exactly why the timeline can be reconstructed.
    const start = Date.now() - 3 * DAY;
    await t.run(async (ctx) => ctx.db.patch(taskId, { cursorAt: start }));

    const missed = [start + DAY, start + 2 * DAY, start + 3 * DAY];
    const res = await t.mutation(internal.scheduled.occurrences.materialize, {
      taskId,
      fromCursor: start,
      toCursor: Date.now(),
      scheduledFor: missed,
    });
    expect(res.created).toBe(3);

    const occs = (await occurrencesOf(t, taskId)).sort(
      (a, b) => a.scheduledFor - b.scheduledFor,
    );
    expect(occs).toHaveLength(3);
    expect(occs.map((o) => o.scheduledFor)).toEqual(missed);
    // Each is independently identified and independently executable.
    expect(new Set(occs.map((o) => o.occurrenceKey)).size).toBe(3);
    expect(occs.every((o) => o.status === "queued")).toBe(true);
  });

  test("a duplicate scheduler event materialises nothing new", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seedUser(t, "a@t.test");
    const taskId = await mkTask(t, userId, ws, "Daily");
    const from = await cursorOf(t, taskId);
    const to = from + DAY;
    const instants = [from + 1000, from + 2000];

    const first = await t.mutation(
      internal.scheduled.occurrences.materialize,
      { taskId, fromCursor: from, toCursor: to, scheduledFor: instants },
    );
    expect(first.created).toBe(2);

    // Replaying the SAME call (a recovered tick, a duplicate delivery) creates
    // nothing — and is refused by the cursor CAS besides.
    const replay = await t.mutation(
      internal.scheduled.occurrences.materialize,
      { taskId, fromCursor: from, toCursor: to, scheduledFor: instants },
    );
    expect(replay.stale).toBe(true);
    expect(replay.created).toBe(0);
    expect(await occurrencesOf(t, taskId)).toHaveLength(2);
  });

  test("cursor compare-and-swap stops two ticks skipping the gap between them", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seedUser(t, "a@t.test");
    const taskId = await mkTask(t, userId, ws, "Daily");
    const from = await cursorOf(t, taskId);

    // Tick A commits and moves the cursor forward.
    await t.mutation(internal.scheduled.occurrences.materialize, {
      taskId,
      fromCursor: from,
      toCursor: from + 1000,
      scheduledFor: [from + 500],
    });
    // Tick B started before A and still holds the OLD cursor. If it were
    // allowed to write, it would advance the cursor past instants nobody ever
    // materialised — permanent silent loss.
    const stale = await t.mutation(
      internal.scheduled.occurrences.materialize,
      {
        taskId,
        fromCursor: from,
        toCursor: from + 5000,
        scheduledFor: [from + 4000],
      },
    );
    expect(stale.stale).toBe(true);
    expect(await cursorOf(t, taskId)).toBe(from + 1000);
    expect(await occurrencesOf(t, taskId)).toHaveLength(1);
  });

  test("re-materialising an already-created instant is a no-op, not a duplicate", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seedUser(t, "a@t.test");
    const taskId = await mkTask(t, userId, ws, "Daily");
    const from = await cursorOf(t, taskId);
    await t.mutation(internal.scheduled.occurrences.materialize, {
      taskId,
      fromCursor: from,
      toCursor: from + 1000,
      scheduledFor: [from + 500],
    });
    // Same instant offered again from the CURRENT cursor (e.g. a chunked
    // backfill overlapping its own window).
    const again = await t.mutation(
      internal.scheduled.occurrences.materialize,
      {
        taskId,
        fromCursor: from + 1000,
        toCursor: from + 2000,
        scheduledFor: [from + 500, from + 1500],
      },
    );
    expect(again.created).toBe(1); // only the genuinely new instant
    expect(await occurrencesOf(t, taskId)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Same task: strictly serial. Different tasks: concurrent. Capacity pressure
// must QUEUE, never skip.
// ---------------------------------------------------------------------------
describe("concurrency", () => {
  async function seedBacklog(
    t: TestT,
    userId: Id<"users">,
    ws: Id<"workspaces">,
    title: string,
    n: number,
  ) {
    const taskId = await mkTask(t, userId, ws, title);
    const from = await cursorOf(t, taskId);
    const instants = Array.from({ length: n }, (_, i) => from + (i + 1) * 1000);
    await t.mutation(internal.scheduled.occurrences.materialize, {
      taskId,
      fromCursor: from,
      toCursor: from + (n + 1) * 1000,
      scheduledFor: instants,
    });
    return { taskId, instants };
  }

  test("a busy task yields ONE claim; the rest stay QUEUED, not skipped", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seedUser(t, "a@t.test");
    const { taskId, instants } = await seedBacklog(t, userId, ws, "T", 4);

    const first = await t.mutation(internal.scheduled.occurrences.claim, {
      limit: 10,
      maxPerUser: 10,
    });
    expect(first.claims).toHaveLength(1);
    // FIFO: the OLDEST occurrence runs first, so a backlog drains in schedule
    // order (10:00 before 11:00 before 12:00).
    expect(first.claims[0].scheduledFor).toBe(instants[0]);

    // A second pass while the first is still running claims nothing more…
    const second = await t.mutation(internal.scheduled.occurrences.claim, {
      limit: 10,
      maxPerUser: 10,
    });
    expect(second.claims).toHaveLength(0);
    // …and crucially the other three are still QUEUED — waiting, not dropped.
    const occs = await occurrencesOf(t, taskId);
    expect(occs.filter((o) => o.status === "queued")).toHaveLength(3);
    expect(occs.filter((o) => o.status === "running")).toHaveLength(1);

    // Finish it, and the next one becomes claimable — in order.
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: first.claims[0].occurrenceKey,
      leaseToken: first.claims[0].leaseToken,
      outcome: "succeeded",
    });
    const third = await t.mutation(internal.scheduled.occurrences.claim, {
      limit: 10,
      maxPerUser: 10,
    });
    expect(third.claims).toHaveLength(1);
    expect(third.claims[0].scheduledFor).toBe(instants[1]);
  });

  test("different tasks are claimed concurrently", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seedUser(t, "a@t.test");
    const a = await seedBacklog(t, userId, ws, "A", 2);
    const b = await seedBacklog(t, userId, ws, "B", 2);
    const c = await seedBacklog(t, userId, ws, "C", 2);

    const { claims } = await t.mutation(internal.scheduled.occurrences.claim, {
      limit: 10,
      maxPerUser: 10,
    });
    expect(claims).toHaveLength(3);
    expect(new Set(claims.map((x) => x.taskId))).toEqual(
      new Set([a.taskId, b.taskId, c.taskId]),
    );
  });

  test("the per-user cap QUEUES the overflow instead of dropping it", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seedUser(t, "a@t.test");
    await seedBacklog(t, userId, ws, "A", 1);
    await seedBacklog(t, userId, ws, "B", 1);
    await seedBacklog(t, userId, ws, "C", 1);

    const { claims } = await t.mutation(internal.scheduled.occurrences.claim, {
      limit: 10,
      maxPerUser: 1,
    });
    expect(claims).toHaveLength(1);

    const all = await t.run(async (ctx) =>
      ctx.db.query("scheduledTaskOccurrences").collect(),
    );
    expect(all.filter((o) => o.status === "running")).toHaveLength(1);
    // Capacity pressure must never be a reason to lose an occurrence.
    expect(all.filter((o) => o.status === "queued")).toHaveLength(2);
    expect(all.filter((o) => o.status === "cancelled")).toHaveLength(0);
  });

  test("one user's backlog cannot starve another user", async () => {
    const t = convexTest(schema, modules);
    const a = await seedUser(t, "a@t.test");
    const b = await seedUser(t, "b@t.test");
    await seedBacklog(t, a.userId, a.ws, "A1", 3);
    await seedBacklog(t, a.userId, a.ws, "A2", 3);
    await seedBacklog(t, b.userId, b.ws, "B1", 1);

    const { claims } = await t.mutation(internal.scheduled.occurrences.claim, {
      limit: 10,
      maxPerUser: 1,
    });
    // One per user, so user B still gets served.
    expect(claims).toHaveLength(2);
    const users = await t.run(async (ctx) =>
      Promise.all(
        claims.map(async (c) => {
          const occ = await ctx.db
            .query("scheduledTaskOccurrences")
            .withIndex("by_occurrence_key", (q) =>
              q.eq("occurrenceKey", c.occurrenceKey),
            )
            .unique();
          return occ?.userId;
        }),
      ),
    );
    expect(new Set(users)).toEqual(new Set([a.userId, b.userId]));
  });
});

// ---------------------------------------------------------------------------
// A zombie worker — or a DBOS system database restored from an old dump — must
// never be able to advance a newer execution.
// ---------------------------------------------------------------------------
describe("leases and stale workers", () => {
  async function claimOne(t: TestT) {
    const { userId, ws } = await seedUser(t, "a@t.test");
    const taskId = await mkTask(t, userId, ws, "T");
    await t
      .withIdentity(as(userId))
      .mutation(api.scheduled.tasks.runNow, { taskId });
    const { claims } = await t.mutation(internal.scheduled.occurrences.claim, {
      limit: 1,
      maxPerUser: 1,
    });
    return { taskId, claim: claims[0] };
  }

  test("verify refuses a wrong lease — the pre-side-effect gate", async () => {
    const t = convexTest(schema, modules);
    const { claim } = await claimOne(t);
    const ok = await t.mutation(internal.scheduled.occurrences.verify, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      workflowId: "occ:wf-1",
    });
    expect(ok).toMatchObject({ ok: true, cancel: false });

    const zombie = await t.mutation(internal.scheduled.occurrences.verify, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: "some-older-lease",
    });
    expect(zombie).toMatchObject({ ok: false, stale: true, cancel: true });
  });

  test("verify refuses an already-terminal occurrence (stale DBOS restore)", async () => {
    const t = convexTest(schema, modules);
    const { claim } = await claimOne(t);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    // This is precisely what a workflow recovered from a restored, out-of-date
    // DBOS dump looks like. It must exit before doing anything.
    const recovered = await t.mutation(internal.scheduled.occurrences.verify, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
    });
    expect(recovered).toMatchObject({ ok: false, stale: true, cancel: true });
  });

  test("a stale worker cannot mark a rotated occurrence succeeded", async () => {
    const t = convexTest(schema, modules);
    const { claim } = await claimOne(t);

    // The reaper decides the holder is dead and rotates the lease away.
    await t.run(async (ctx) => {
      const occ = await ctx.db
        .query("scheduledTaskOccurrences")
        .withIndex("by_occurrence_key", (q) =>
          q.eq("occurrenceKey", claim.occurrenceKey),
        )
        .unique();
      if (occ) await ctx.db.patch(occ._id, { heartbeatAt: Date.now() - 10 * 60_000 });
    });
    await t.mutation(internal.scheduled.occurrences.reapStalled, {});

    const late = await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    expect(late).toMatchObject({ ok: false, stale: true });

    const occ = await t.run(async (ctx) =>
      ctx.db
        .query("scheduledTaskOccurrences")
        .withIndex("by_occurrence_key", (q) =>
          q.eq("occurrenceKey", claim.occurrenceKey),
        )
        .unique(),
    );
    // Not "succeeded" — the zombie's write was rejected outright.
    expect(occ?.status).toBe("retrying");
    expect(occ?.attempts).toBe(1);
  });

  test("duplicate completion is idempotent", async () => {
    const t = convexTest(schema, modules);
    const { claim } = await claimOne(t);
    const first = await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    expect(first).toMatchObject({ ok: true, status: "succeeded", attempts: 1 });

    const dup = await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "failed",
      errorCode: "should-be-ignored",
    });
    expect(dup).toMatchObject({ ok: true, alreadyTerminal: true, status: "succeeded" });

    const occ = await t.run(async (ctx) =>
      ctx.db
        .query("scheduledTaskOccurrences")
        .withIndex("by_occurrence_key", (q) =>
          q.eq("occurrenceKey", claim.occurrenceKey),
        )
        .unique(),
    );
    expect(occ?.status).toBe("succeeded");
    expect(occ?.errorCode).toBeUndefined();
    expect(occ?.attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Retries are attempts of the SAME occurrence, never a new one.
// ---------------------------------------------------------------------------
describe("retries", () => {
  test("a retryable failure re-runs the SAME occurrence, never a new row", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seedUser(t, "a@t.test");
    const taskId = await mkTask(t, userId, ws, "T");
    await t
      .withIdentity(as(userId))
      .mutation(api.scheduled.tasks.runNow, { taskId });

    const c1 = (
      await t.mutation(internal.scheduled.occurrences.claim, {
        limit: 1,
        maxPerUser: 1,
      })
    ).claims[0];
    const r = await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: c1.occurrenceKey,
      leaseToken: c1.leaseToken,
      outcome: "failed",
      errorCode: "upstream_5xx",
      retryable: true,
    });
    expect(r).toMatchObject({ ok: true, status: "retrying", attempts: 1 });
    // Still exactly ONE occurrence — the logical execution did not fork.
    expect(await occurrencesOf(t, taskId)).toHaveLength(1);

    // Backoff gates the retry: not claimable yet.
    expect(
      (
        await t.mutation(internal.scheduled.occurrences.claim, {
          limit: 5,
          maxPerUser: 5,
        })
      ).claims,
    ).toHaveLength(0);

    // Once the backoff elapses it is claimable again, with a FRESH lease.
    await t.run(async (ctx) => {
      const occ = (
        await ctx.db
          .query("scheduledTaskOccurrences")
          .withIndex("by_task_scheduled", (q) => q.eq("taskId", taskId))
          .collect()
      )[0];
      await ctx.db.patch(occ._id, { nextAttemptAt: Date.now() - 1 });
    });
    const c2 = (
      await t.mutation(internal.scheduled.occurrences.claim, {
        limit: 5,
        maxPerUser: 5,
      })
    ).claims[0];
    expect(c2.occurrenceKey).toBe(c1.occurrenceKey);
    expect(c2.leaseToken).not.toBe(c1.leaseToken);
    expect(await occurrencesOf(t, taskId)).toHaveLength(1);
  });

  test("attempts are bounded — an exhausted occurrence fails, it does not loop", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seedUser(t, "a@t.test");
    const taskId = await mkTask(t, userId, ws, "T");
    await t
      .withIdentity(as(userId))
      .mutation(api.scheduled.tasks.runNow, { taskId });

    let lastStatus = "";
    for (let i = 0; i < 5; i++) {
      const { claims } = await t.mutation(
        internal.scheduled.occurrences.claim,
        { limit: 1, maxPerUser: 1 },
      );
      if (claims.length === 0) break;
      const res = await t.mutation(internal.scheduled.occurrences.finalize, {
        occurrenceKey: claims[0].occurrenceKey,
        leaseToken: claims[0].leaseToken,
        outcome: "failed",
        errorCode: "boom",
        retryable: true,
      });
      lastStatus = String(res.status);
      await t.run(async (ctx) => {
        const occ = (
          await ctx.db
            .query("scheduledTaskOccurrences")
            .withIndex("by_task_scheduled", (q) => q.eq("taskId", taskId))
            .collect()
        )[0];
        await ctx.db.patch(occ._id, { nextAttemptAt: Date.now() - 1 });
      });
    }
    expect(lastStatus).toBe("failed");
    const occs = await occurrencesOf(t, taskId);
    expect(occs).toHaveLength(1);
    expect(occs[0].status).toBe("failed");
    expect(occs[0].attempts).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// The independent backstop for a scheduler that died without DBOS recovering
// it (SIGKILL, or a rebuilt DBOS system database).
// ---------------------------------------------------------------------------
describe("reaper", () => {
  test("a stalled occurrence is requeued with a rotated lease", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seedUser(t, "a@t.test");
    const taskId = await mkTask(t, userId, ws, "T");
    await t
      .withIdentity(as(userId))
      .mutation(api.scheduled.tasks.runNow, { taskId });
    const c1 = (
      await t.mutation(internal.scheduled.occurrences.claim, {
        limit: 1,
        maxPerUser: 1,
      })
    ).claims[0];

    // Nothing has heartbeated for well past the lease TTL.
    await t.run(async (ctx) => {
      const occ = (
        await ctx.db
          .query("scheduledTaskOccurrences")
          .withIndex("by_task_scheduled", (q) => q.eq("taskId", taskId))
          .collect()
      )[0];
      await ctx.db.patch(occ._id, { heartbeatAt: Date.now() - 10 * 60_000 });
    });

    const reaped = await t.mutation(
      internal.scheduled.occurrences.reapStalled,
      {},
    );
    expect(reaped).toMatchObject({ requeued: 1, closed: 0 });

    const occ = (await occurrencesOf(t, taskId))[0];
    expect(occ.status).toBe("retrying");
    expect(occ.attempts).toBe(1);
    // The lease is gone, which is what disarms the old holder.
    expect(occ.leaseToken).toBeUndefined();
    expect(
      await t.mutation(internal.scheduled.occurrences.heartbeat, {
        occurrenceKey: c1.occurrenceKey,
        leaseToken: c1.leaseToken,
      }),
    ).toMatchObject({ ok: false, stale: true });
  });

  test("a healthy occurrence is left alone", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seedUser(t, "a@t.test");
    const taskId = await mkTask(t, userId, ws, "T");
    await t
      .withIdentity(as(userId))
      .mutation(api.scheduled.tasks.runNow, { taskId });
    await t.mutation(internal.scheduled.occurrences.claim, {
      limit: 1,
      maxPerUser: 1,
    });
    const reaped = await t.mutation(
      internal.scheduled.occurrences.reapStalled,
      {},
    );
    expect(reaped).toMatchObject({ requeued: 0, closed: 0 });
    expect((await occurrencesOf(t, taskId))[0].status).toBe("running");
  });

  test("a stalled occurrence that was cancelled is closed as cancelled", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seedUser(t, "a@t.test");
    const taskId = await mkTask(t, userId, ws, "T");
    await t
      .withIdentity(as(userId))
      .mutation(api.scheduled.tasks.runNow, { taskId });
    await t.mutation(internal.scheduled.occurrences.claim, {
      limit: 1,
      maxPerUser: 1,
    });
    await t.run(async (ctx) => {
      const occ = (
        await ctx.db
          .query("scheduledTaskOccurrences")
          .withIndex("by_task_scheduled", (q) => q.eq("taskId", taskId))
          .collect()
      )[0];
      await ctx.db.patch(occ._id, {
        heartbeatAt: Date.now() - 10 * 60_000,
        cancelRequested: true,
      });
    });
    const reaped = await t.mutation(
      internal.scheduled.occurrences.reapStalled,
      {},
    );
    expect(reaped).toMatchObject({ requeued: 0, closed: 1 });
    expect((await occurrencesOf(t, taskId))[0].status).toBe("cancelled");
  });
});

describe("cancellation", () => {
  test("cancelling a queued occurrence stops it ever being claimed", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seedUser(t, "a@t.test");
    const taskId = await mkTask(t, userId, ws, "T");
    const u = t.withIdentity(as(userId));
    await u.mutation(api.scheduled.tasks.runNow, { taskId });
    const { page } = await u.query(api.scheduled.tasks.history, { taskId });
    const occ = page[0];

    expect(
      await u.mutation(api.scheduled.tasks.cancelOccurrence, {
        occurrenceId: occ._id,
      }),
    ).toMatchObject({ cancelled: true });

    const { claims } = await t.mutation(internal.scheduled.occurrences.claim, {
      limit: 5,
      maxPerUser: 5,
    });
    expect(claims).toHaveLength(0);
    expect((await occurrencesOf(t, taskId))[0].status).toBe("cancelled");
  });

  test("cancelling a running occurrence is a durable request the worker observes", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seedUser(t, "a@t.test");
    const taskId = await mkTask(t, userId, ws, "T");
    const u = t.withIdentity(as(userId));
    await u.mutation(api.scheduled.tasks.runNow, { taskId });
    const claim = (
      await t.mutation(internal.scheduled.occurrences.claim, {
        limit: 1,
        maxPerUser: 1,
      })
    ).claims[0];
    // A RUNNING occurrence is deliberately absent from `history` — that list
    // excludes in-flight rows so a 30s heartbeat cannot churn it. The live row
    // comes from activeRun instead.
    expect(
      (await u.query(api.scheduled.tasks.history, { taskId })).page,
    ).toEqual([]);
    const occ = await u.query(api.scheduled.tasks.activeRun, { taskId });
    expect(occ).not.toBeNull();

    expect(
      await u.mutation(api.scheduled.tasks.cancelOccurrence, {
        occurrenceId: occ!._id,
      }),
    ).toMatchObject({ cancelled: false, reason: "requested" });

    // The worker learns about it on its very next heartbeat — no push needed.
    expect(
      await t.mutation(internal.scheduled.occurrences.heartbeat, {
        occurrenceKey: claim.occurrenceKey,
        leaseToken: claim.leaseToken,
      }),
    ).toMatchObject({ ok: true, cancel: true });

    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "cancelled",
    });
    expect((await occurrencesOf(t, taskId))[0].status).toBe("cancelled");
  });
});
