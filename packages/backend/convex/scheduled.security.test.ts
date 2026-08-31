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

async function seedWorkspace(t: TestT) {
  return t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { email: "owner@t.test" });
    const member = await ctx.db.insert("users", { email: "member@t.test" });
    const outsider = await ctx.db.insert("users", {
      email: "outsider@t.test",
    });
    const ws = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: owner,
      createdAt: Date.now(),
    });
    for (const [userId, role] of [
      [owner, "owner"],
      [member, "member"],
    ] as const) {
      await ctx.db.insert("members", {
        workspaceId: ws,
        userId,
        role,
        createdAt: Date.now(),
      });
    }
    return { owner, member, outsider, ws };
  });
}

async function seedTask(
  t: TestT,
  owner: Id<"users">,
  ws: Id<"workspaces">,
) {
  return t.withIdentity(as(owner)).mutation(api.scheduled.tasks.create, {
    workspaceId: ws,
    title: "Daily digest",
    prompt: "Summarise my inbox and my calendar for today",
    spec: DAILY,
  });
}

// ---------------------------------------------------------------------------
// Scheduled tasks inherit CHAT's trust model, not the workspace one: a standing
// prompt ("review my portfolio", "summarise my inbox") is exactly as private as
// a conversation. A same-workspace peer must be refused, and refused in a way
// that is not an existence oracle.
// ---------------------------------------------------------------------------
describe("scheduled tasks are private to the USER, not the workspace", () => {
  test("a same-workspace peer cannot read someone else's task", async () => {
    const t = convexTest(schema, modules);
    const { owner, member, ws } = await seedWorkspace(t);
    const taskId = await seedTask(t, owner, ws);
    const peer = t.withIdentity(as(member));

    // Reads return NOTHING rather than throwing — the panel needs to render a
    // not-found state without logging a console error. What matters for
    // isolation is unchanged: the peer learns nothing and gets no data.
    expect(await peer.query(api.scheduled.tasks.get, { taskId })).toBeNull();
    expect(await peer.query(api.scheduled.tasks.history, { taskId })).toEqual({
      page: [],
      nextCursor: null,
    });
    expect(
      await peer.query(api.scheduled.tasks.activeRun, { taskId }),
    ).toBeNull();
    expect(await peer.query(api.scheduled.tasks.deliveries, { taskId })).toEqual(
      [],
    );
    // The peer's own list must not contain it.
    expect(await peer.query(api.scheduled.tasks.list, {})).toEqual([]);
    // And WRITES still refuse loudly, which is where refusing protects anything.
    await expect(
      peer.mutation(api.scheduled.tasks.pause, { taskId }),
    ).rejects.toThrow(/Not found/);
  });

  test("a complete outsider gets the SAME error as a peer (no oracle)", async () => {
    const t = convexTest(schema, modules);
    const { owner, member, outsider, ws } = await seedWorkspace(t);
    const taskId = await seedTask(t, owner, ws);

    const peerRead = await t
      .withIdentity(as(member))
      .query(api.scheduled.tasks.get, { taskId });
    const outsiderRead = await t
      .withIdentity(as(outsider))
      .query(api.scheduled.tasks.get, { taskId });
    // A task id that was never real, for comparison.
    const nonexistentRead = await t
      .withIdentity(as(outsider))
      .query(api.scheduled.tasks.get, { taskId: "not-a-real-id" });

    // All three are IDENTICAL, so nothing distinguishes "not yours" from
    // "does not exist" — the response cannot be used as an existence oracle for
    // someone else's taskId. That property is what this test protects; whether
    // the answer is a throw or a null is incidental to it.
    expect(peerRead).toBeNull();
    expect(outsiderRead).toBeNull();
    expect(nonexistentRead).toBeNull();
    expect(outsiderRead).toEqual(peerRead);

    // The WRITE path is where the wording still has to match, because there the
    // caller does get an error and it must not say more than "Not found".
    const peerErr = await t
      .withIdentity(as(member))
      .mutation(api.scheduled.tasks.pause, { taskId })
      .catch((e: Error) => String(e));
    const outsiderErr = await t
      .withIdentity(as(outsider))
      .mutation(api.scheduled.tasks.pause, { taskId })
      .catch((e: Error) => String(e));
    expect(peerErr).toMatch(/Not found/);
    expect(outsiderErr).toMatch(/Not found/);
    expect(outsiderErr).toEqual(peerErr);
  });

  test("every WRITE path refuses a non-owner", async () => {
    const t = convexTest(schema, modules);
    const { owner, member, ws } = await seedWorkspace(t);
    const taskId = await seedTask(t, owner, ws);
    const peer = t.withIdentity(as(member));

    await expect(
      peer.mutation(api.scheduled.tasks.update, { taskId, title: "pwned" }),
    ).rejects.toThrow(/Not found/);
    await expect(
      peer.mutation(api.scheduled.tasks.pause, { taskId }),
    ).rejects.toThrow(/Not found/);
    await expect(
      peer.mutation(api.scheduled.tasks.resume, { taskId }),
    ).rejects.toThrow(/Not found/);
    await expect(
      peer.mutation(api.scheduled.tasks.remove, { taskId }),
    ).rejects.toThrow(/Not found/);
    await expect(
      peer.mutation(api.scheduled.tasks.runNow, { taskId }),
    ).rejects.toThrow(/Not found/);

    // …and nothing actually changed.
    const task = await t
      .withIdentity(as(owner))
      .query(api.scheduled.tasks.get, { taskId });
    expect(task?.title).toBe("Daily digest");
    expect(task?.status).toBe("active");
  });

  test("a non-owner cannot cancel someone else's occurrence", async () => {
    const t = convexTest(schema, modules);
    const { owner, member, ws } = await seedWorkspace(t);
    const taskId = await seedTask(t, owner, ws);
    await t
      .withIdentity(as(owner))
      .mutation(api.scheduled.tasks.runNow, { taskId });
    const { page } = await t
      .withIdentity(as(owner))
      .query(api.scheduled.tasks.history, { taskId });
    const occ = page[0];

    await expect(
      t
        .withIdentity(as(member))
        .mutation(api.scheduled.tasks.cancelOccurrence, {
          occurrenceId: occ._id,
        }),
    ).rejects.toThrow(/Not found/);

    const after = await t.run(async (ctx) => ctx.db.get(occ._id));
    expect(after?.status).toBe("queued");
    expect(after?.cancelRequested).toBe(false);
  });

  test("an unauthenticated read returns [] rather than throwing", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seedWorkspace(t);
    await seedTask(t, owner, ws);
    // A signed-out render must not log a console error — every e2e script
    // asserts zero console errors.
    expect(await t.query(api.scheduled.tasks.list, {})).toEqual([]);
  });

  test("a task cannot be created in a workspace the user is not in", async () => {
    const t = convexTest(schema, modules);
    const { outsider, ws } = await seedWorkspace(t);
    await expect(
      t.withIdentity(as(outsider)).mutation(api.scheduled.tasks.create, {
        workspaceId: ws,
        title: "sneaky",
        prompt: "exfiltrate",
        spec: DAILY,
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// A task is created by an entitled user and then runs unattended for months.
// Nothing in orgs.removeMember or the account-status flow knows scheduled tasks
// exist, so without a re-check at dispatch a removed or suspended user's work
// would keep executing on their behalf indefinitely.
// ---------------------------------------------------------------------------
describe("server-side entitlement is re-checked at dispatch", () => {
  test("removing the owner from the workspace stops execution", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seedWorkspace(t);
    const taskId = await seedTask(t, owner, ws);
    await t
      .withIdentity(as(owner))
      .mutation(api.scheduled.tasks.runNow, { taskId });

    // The owner leaves / is removed.
    await t.run(async (ctx) => {
      const m = await ctx.db
        .query("members")
        .withIndex("by_user_workspace", (q) =>
          q.eq("userId", owner).eq("workspaceId", ws),
        )
        .unique();
      if (m) await ctx.db.delete(m._id);
    });

    const claimed = await t.mutation(internal.scheduled.occurrences.claim, {
      limit: 10,
      maxPerUser: 5,
    });
    expect(claimed.claims).toHaveLength(0);

    const state = await t.run(async (ctx) => {
      const occ = await ctx.db
        .query("scheduledTaskOccurrences")
        .withIndex("by_task_scheduled", (q) => q.eq("taskId", taskId))
        .first();
      const task = await ctx.db.get(taskId);
      return { occ, task };
    });
    expect(state.occ?.status).toBe("cancelled");
    expect(state.occ?.terminalReason).toBe("owner_not_member");
    // And the task is parked so it stops producing new work.
    expect(state.task?.status).toBe("paused");
  });

  test("a suspended account stops execution", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seedWorkspace(t);
    const taskId = await seedTask(t, owner, ws);
    await t
      .withIdentity(as(owner))
      .mutation(api.scheduled.tasks.runNow, { taskId });

    await t.run(async (ctx) => {
      await ctx.db.patch(owner, { accountStatus: "suspended" });
    });

    const claimed = await t.mutation(internal.scheduled.occurrences.claim, {
      limit: 10,
      maxPerUser: 5,
    });
    expect(claimed.claims).toHaveLength(0);

    const occ = await t.run(async (ctx) =>
      ctx.db
        .query("scheduledTaskOccurrences")
        .withIndex("by_task_scheduled", (q) => q.eq("taskId", taskId))
        .first(),
    );
    expect(occ?.status).toBe("cancelled");
    expect(occ?.terminalReason).toBe("owner_not_active");
  });
});

// ---------------------------------------------------------------------------
// The ingress surface is server-to-server and secret-gated, but the secret must
// not become a cross-user read capability over everyone's standing prompts.
// ---------------------------------------------------------------------------
describe("the scheduler work list leaks no task content", () => {
  test("listSchedulable returns schedule data only — never prompt or title", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seedWorkspace(t);
    await seedTask(t, owner, ws);

    const listed = await t.query(
      internal.scheduled.occurrences.listSchedulable,
      {},
    );
    expect(listed.tasks).toHaveLength(1);
    const row = listed.tasks[0] as Record<string, unknown>;
    expect(row.spec).toBeDefined();
    expect(row.cursorAt).toBeTypeOf("number");
    // The two fields that carry user content must be absent entirely.
    expect(row).not.toHaveProperty("prompt");
    expect(row).not.toHaveProperty("title");
    expect(JSON.stringify(listed)).not.toContain("Summarise my inbox");
  });

  test("claim returns identifiers only — never prompt or title", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seedWorkspace(t);
    const taskId = await seedTask(t, owner, ws);
    await t
      .withIdentity(as(owner))
      .mutation(api.scheduled.tasks.runNow, { taskId });

    const claimed = await t.mutation(internal.scheduled.occurrences.claim, {
      limit: 10,
      maxPerUser: 5,
    });
    expect(claimed.claims).toHaveLength(1);
    const c = claimed.claims[0] as Record<string, unknown>;
    expect(c.occurrenceKey).toBeTypeOf("string");
    expect(c.leaseToken).toBeTypeOf("string");
    expect(c).not.toHaveProperty("prompt");
    expect(c).not.toHaveProperty("title");
    expect(JSON.stringify(claimed)).not.toContain("Summarise my inbox");
  });
});
