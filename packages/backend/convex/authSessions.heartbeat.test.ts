/**
 * heartbeat writes `users.lastActivityAt` at most once per
 * ACTIVITY_WRITE_INTERVAL_MS. The write is what re-executes every live query
 * of the caller (they all read the users row), so a page mount must not pay it
 * when the previous mount was seconds ago. Session revocation is unchanged.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ACTIVITY_WRITE_INTERVAL_MS } from "./authSessions";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

async function seed(t: ReturnType<typeof convexTest>, sessions: number) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "hb@t.test" });
    const ids: Id<"authSessions">[] = [];
    for (let i = 0; i < sessions; i++) {
      const sessionId = await ctx.db.insert("authSessions", {
        userId,
        expirationTime: Date.now() + 3_600_000,
      });
      await ctx.db.insert("authRefreshTokens", {
        sessionId,
        expirationTime: Date.now() + 3_600_000,
      });
      ids.push(sessionId);
    }
    return { userId, ids };
  });
}

const lastActivity = (t: ReturnType<typeof convexTest>, userId: Id<"users">) =>
  t.run(async (ctx) => (await ctx.db.get(userId))?.lastActivityAt);

describe("authSessions.heartbeat activity throttle", () => {
  test("first heartbeat writes, a second one seconds later does not", { timeout: 180_000 }, async () => {
    const t = convexTest(schema, modules);
    const { userId, ids } = await seed(t, 1);
    const me = t.withIdentity({ subject: `${userId}|${ids[0]}` });

    const r1 = await me.mutation(api.authSessions.heartbeat, {});
    expect(r1).toEqual({ ok: true, revoked: 0 });
    const first = await lastActivity(t, userId);
    expect(typeof first).toBe("number");

    const r2 = await me.mutation(api.authSessions.heartbeat, {});
    expect(r2).toEqual({ ok: true, revoked: 0 });
    expect(await lastActivity(t, userId)).toBe(first);
  });

  test("writes again once the interval has elapsed", async () => {
    const t = convexTest(schema, modules);
    const { userId, ids } = await seed(t, 1);
    const me = t.withIdentity({ subject: `${userId}|${ids[0]}` });
    const stale = Date.now() - ACTIVITY_WRITE_INTERVAL_MS - 1;
    await t.run((ctx) => ctx.db.patch(userId, { lastActivityAt: stale }));

    await me.mutation(api.authSessions.heartbeat, {});
    const after = await lastActivity(t, userId);
    expect(after).toBeGreaterThan(stale);
  });

  test("session revocation still runs on every heartbeat, throttled write or not", async () => {
    const t = convexTest(schema, modules);
    const { userId, ids } = await seed(t, 3);
    const me = t.withIdentity({ subject: `${userId}|${ids[2]}` });
    await t.run((ctx) => ctx.db.patch(userId, { lastActivityAt: Date.now() }));

    const r = await me.mutation(api.authSessions.heartbeat, {});
    expect(r).toEqual({ ok: true, revoked: 2 });
    const remaining = await t.run(async (ctx) =>
      (await ctx.db.query("authSessions").collect()).map((s) => s._id),
    );
    expect(remaining).toEqual([ids[2]]);
  });
});
