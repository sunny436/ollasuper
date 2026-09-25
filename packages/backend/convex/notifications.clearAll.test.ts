import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
type TestT = TestConvex<typeof schema>;
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

/** clearRemaining reschedules itself, so pump until the chain is done. */
async function drain(t: TestT) {
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

async function user(t: TestT, email: string) {
  return t.run((ctx) => ctx.db.insert("users", { email }));
}

async function seed(t: TestT, userId: Id<"users">, n: number, read = false) {
  await t.run(async (ctx) => {
    for (let i = 0; i < n; i++) {
      await ctx.db.insert("notifications", {
        userId,
        type: "invite",
        title: `n${i}`,
        read,
        createdAt: Date.now(),
      });
    }
  });
}

const count = (t: TestT, userId: Id<"users">) =>
  t.run(
    async (ctx) =>
      (
        await ctx.db
          .query("notifications")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect()
      ).length,
  );

describe("notifications.clearAll", () => {
  test("clears every notification of the caller and nobody else's", async () => {
    const t = convexTest(schema, modules);
    const me = await user(t, "me@t.test");
    const other = await user(t, "other@t.test");
    await seed(t, me, 25);
    await seed(t, other, 7);

    const r = await t.withIdentity(as(me)).mutation(api.notifications.clearAll, {});

    expect(r).toEqual({ cleared: 25 });
    expect(await count(t, me)).toBe(0);
    expect(await count(t, other)).toBe(7);
  });

  test("afterwards the centre is empty: no page, no older page, no badge", async () => {
    const t = convexTest(schema, modules);
    const me = await user(t, "me@t.test");
    await seed(t, me, 25); // > one page of 20, so "Show older" was showing
    const u = t.withIdentity(as(me));
    expect((await u.query(api.notifications.myNotifications, {})).nextCursor).not.toBeNull();

    await u.mutation(api.notifications.clearAll, {});

    expect(await u.query(api.notifications.myNotifications, {})).toEqual({
      page: [],
      nextCursor: null,
    });
    expect(await u.query(api.notifications.unreadCount, {})).toBe(0);
  });

  test("signed out is a no-op", async () => {
    const t = convexTest(schema, modules);
    const me = await user(t, "me@t.test");
    await seed(t, me, 3);

    expect(await t.mutation(api.notifications.clearAll, {})).toEqual({ cleared: 0 });
    expect(await count(t, me)).toBe(3);
  });

  test("a long history clears in bounded batches and finishes in the background", async () => {
    const t = convexTest(schema, modules);
    const me = await user(t, "me@t.test");
    await seed(t, me, 1200);

    const r = await t.withIdentity(as(me)).mutation(api.notifications.clearAll, {});

    // One transaction never deletes more than one batch...
    expect(r.cleared).toBe(500);
    // ...and the continuation removes the rest.
    await drain(t);
    expect(await count(t, me)).toBe(0);
  });

  test("a notification that arrives after the click survives the background clear", async () => {
    const t = convexTest(schema, modules);
    const me = await user(t, "me@t.test");
    await seed(t, me, 1200);

    await t.withIdentity(as(me)).mutation(api.notifications.clearAll, {});
    // Lands while 700 old rows are still waiting for the background batches.
    await seed(t, me, 1);
    await drain(t);

    expect(await count(t, me)).toBe(1);
    const page = await t.withIdentity(as(me)).query(api.notifications.myNotifications, {});
    expect(page.page).toHaveLength(1);
    expect(await t.withIdentity(as(me)).query(api.notifications.unreadCount, {})).toBe(1);
  });

  test("a notification created in the same millisecond, before the click, is cleared", async () => {
    // Regression: a Date.now() cutoff is integer ms while _creationTime has
    // sub-ms precision, so the second of two rows written in the click's own
    // millisecond used to survive.
    const t = convexTest(schema, modules);
    const me = await user(t, "me@t.test");
    await seed(t, me, 2);
    const r = await t.withIdentity(as(me)).mutation(api.notifications.clearAll, {});
    expect(r).toEqual({ cleared: 2 });
    expect(await count(t, me)).toBe(0);
  });

  test("clearing an empty centre, or clearing twice, is harmless", async () => {
    const t = convexTest(schema, modules);
    const me = await user(t, "me@t.test");
    const u = t.withIdentity(as(me));
    expect(await u.mutation(api.notifications.clearAll, {})).toEqual({ cleared: 0 });
    await seed(t, me, 2, true);
    expect(await u.mutation(api.notifications.clearAll, {})).toEqual({ cleared: 2 });
    expect(await u.mutation(api.notifications.clearAll, {})).toEqual({ cleared: 0 });
  });
});
