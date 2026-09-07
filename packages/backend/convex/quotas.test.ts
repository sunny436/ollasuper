import { type TestConvex, convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type TestT = TestConvex<typeof schema>;
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

async function seedUserWithWorkspaces(t: TestT, n = 2) {
  return t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { email: "q@t.test" });
    const wss: Id<"workspaces">[] = [];
    for (let i = 0; i < n; i++) {
      const ws = await ctx.db.insert("workspaces", {
        name: `WS${i}`,
        ownerId: user,
        createdAt: Date.now(),
      });
      await ctx.db.insert("members", {
        workspaceId: ws,
        userId: user,
        role: "owner",
        createdAt: Date.now(),
      });
      wss.push(ws);
    }
    return { user, wss };
  });
}

const quotaFor = (
  t: TestT,
  user: Id<"users">,
  kind: string,
) =>
  t.run(async (ctx) =>
    ctx.db
      .query("userQuotas")
      .withIndex("by_user_kind", (q) => q.eq("userId", user).eq("kind", kind))
      .unique(),
  );

describe("rate windows are per-user and not user-resettable", () => {
  test("a quota row is keyed on the user, not on user+workspace", async () => {
    const t = convexTest(schema, modules);
    const { user, wss } = await seedUserWithWorkspaces(t, 2);

    // Spend from workspace A, then from workspace B: the SAME counter must move.
    await t.run(async (ctx) => {
      const { consumeWindow } = await import("./quotas");
      await consumeWindow(ctx as never, user, "chat", 10, 60_000);
      await consumeWindow(ctx as never, user, "chat", 10, 60_000);
    });
    void wss;

    const row = await quotaFor(t, user, "chat");
    expect(row?.windowCount).toBe(2);

    const all = await t.run(async (ctx) => ctx.db.query("userQuotas").collect());
    // One row for the user — NOT one per workspace, which is what let a second
    // workspace hand out a second full allowance.
    expect(all.length).toBe(1);
  });

  test("resetting preferences does NOT restore allowance", async () => {
    const t = convexTest(schema, modules);
    const { user, wss } = await seedUserWithWorkspaces(t, 1);
    const ws = wss[0] as never;

    await t.run(async (ctx) => {
      const { consumeWindow } = await import("./quotas");
      for (let i = 0; i < 5; i++)
        await consumeWindow(ctx as never, user, "chat", 10, 60_000);
    });
    expect((await quotaFor(t, user, "chat"))?.windowCount).toBe(5);

    // The exact bypass: clear your own preferences and get a fresh allowance.
    await t.withIdentity(as(user)).mutation(api.chat.settings.reset, {
      workspaceId: ws,
    });

    expect((await quotaFor(t, user, "chat"))?.windowCount).toBe(5);
  });

  test("the window still refuses once the limit is reached", async () => {
    const t = convexTest(schema, modules);
    const { user } = await seedUserWithWorkspaces(t, 1);
    const results = await t.run(async (ctx) => {
      const { consumeWindow } = await import("./quotas");
      const out: boolean[] = [];
      for (let i = 0; i < 4; i++)
        out.push((await consumeWindow(ctx as never, user, "parse", 3, 60_000)).ok);
      return out;
    });
    expect(results).toEqual([true, true, true, false]);
  });

  test("kinds have separate budgets — one cannot spend another's", async () => {
    const t = convexTest(schema, modules);
    const { user } = await seedUserWithWorkspaces(t, 1);
    const out = await t.run(async (ctx) => {
      const { consumeWindow } = await import("./quotas");
      await consumeWindow(ctx as never, user, "chat", 1, 60_000);
      // chat is now exhausted; schedRun must be untouched.
      return {
        chat: (await consumeWindow(ctx as never, user, "chat", 1, 60_000)).ok,
        sched: (await consumeWindow(ctx as never, user, "schedRun", 1, 60_000)).ok,
      };
    });
    expect(out).toEqual({ chat: false, sched: true });
  });

  test("the migration carries consumed usage over and never lowers it", async () => {
    const t = convexTest(schema, modules);
    const { user, wss } = await seedUserWithWorkspaces(t, 2);
    const now = Date.now();
    await t.run(async (ctx) => {
      // Two workspaces, different consumption. The LARGER must win.
      await ctx.db.insert("chatSettings", {
        userId: user, workspaceId: wss[0] as never, defaultModel: "", sendOnEnter: true,
        updatedAt: now, rateWindowStart: now, rateWindowCount: 7,
      });
      await ctx.db.insert("chatSettings", {
        userId: user, workspaceId: wss[1] as never, defaultModel: "", sendOnEnter: true,
        updatedAt: now, rateWindowStart: now, rateWindowCount: 42,
      });
    });

    await t.mutation(internal.quotas.backfillFromChatSettings, {});
    expect((await quotaFor(t, user, "chat"))?.windowCount).toBe(42);

    // Re-running must be idempotent — never hand allowance back.
    await t.mutation(internal.quotas.backfillFromChatSettings, {});
    expect((await quotaFor(t, user, "chat"))?.windowCount).toBe(42);
  });

  test("an EXPIRED window is not carried over", async () => {
    const t = convexTest(schema, modules);
    const { user, wss } = await seedUserWithWorkspaces(t, 1);
    await t.run(async (ctx) => {
      await ctx.db.insert("chatSettings", {
        userId: user, workspaceId: wss[0] as never, defaultModel: "", sendOnEnter: true,
        updatedAt: Date.now(),
        rateWindowStart: Date.now() - 2 * 60 * 60 * 1000, // two hours ago
        rateWindowCount: 99,
      });
    });
    await t.mutation(internal.quotas.backfillFromChatSettings, {});
    expect(await quotaFor(t, user, "chat")).toBeNull();
  });
  // THE MECHANISM OF THE ORIGINAL BUG, kept as a standing guard.
  //
  // chat.settings.reset still deletes the chatSettings row — that is correct for
  // preferences. It is only safe because no quota lives there any more. If anyone
  // ever moves a rate window back onto that row, this test is the reason it must
  // not be done: the delete below would silently return a full allowance.
  test("reset still deletes the preferences row — which is why quotas left it", async () => {
    const t = convexTest(schema, modules);
    const { user, wss } = await seedUserWithWorkspaces(t, 1);
    const ws = wss[0] as never;
    await t.run(async (ctx) => {
      await ctx.db.insert("chatSettings", {
        userId: user, workspaceId: ws, defaultModel: "", sendOnEnter: true,
        updatedAt: Date.now(),
      });
    });
    await t.withIdentity(as(user)).mutation(api.chat.settings.reset, { workspaceId: ws });
    const rows = await t.run(async (ctx) => ctx.db.query("chatSettings").collect());
    expect(rows.length).toBe(0);
  });
});
