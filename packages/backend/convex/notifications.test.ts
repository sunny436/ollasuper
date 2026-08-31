/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { notify } from "./notifications";
import schema from "./schema";

/**
 * The notification centre.
 *
 * The behaviour under test is mostly about what must NOT happen: opening the
 * panel must not consume unread state, one user must not read another's rows,
 * and a logical event observed twice must not become two notifications.
 */

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });
type TestT = TestConvex<typeof schema>;

async function seedUsers(t: TestT) {
  return t.run(async (ctx) => ({
    alice: await ctx.db.insert("users", { email: "alice@t.test" }),
    bob: await ctx.db.insert("users", { email: "bob@t.test" }),
  }));
}

/** Emit through the real helper, so dedupe is exercised, not simulated. */
async function emit(
  t: TestT,
  userId: Id<"users">,
  type: string,
  title: string,
  dedupeKey?: string,
) {
  return t.run((ctx) =>
    notify(ctx, userId, type, title, undefined, { dedupeKey }),
  );
}

describe("read state", () => {
  test("reading the list does NOT mark anything read", async () => {
    // The defect this replaces: the bell called markAllRead on open, so a
    // glance destroyed every unread mark and the count could never be trusted.
    const t = convexTest(schema, modules);
    const { alice } = await seedUsers(t);
    await emit(t, alice, "scheduled.failed", "A failed");
    await emit(t, alice, "scheduled.succeeded", "B completed");

    const client = t.withIdentity(as(alice));
    expect(await client.query(api.notifications.unreadCount, {})).toBe(2);
    await client.query(api.notifications.myNotifications, {});
    await client.query(api.notifications.myNotifications, {});
    expect(await client.query(api.notifications.unreadCount, {})).toBe(2);
  });

  test("markRead marks exactly one, and the count follows", async () => {
    const t = convexTest(schema, modules);
    const { alice } = await seedUsers(t);
    await emit(t, alice, "scheduled.failed", "A failed");
    await emit(t, alice, "scheduled.succeeded", "B completed");

    const client = t.withIdentity(as(alice));
    const { page } = await client.query(api.notifications.myNotifications, {});
    await client.mutation(api.notifications.markRead, {
      notificationId: page[0]._id,
    });
    expect(await client.query(api.notifications.unreadCount, {})).toBe(1);

    const after = await client.query(api.notifications.myNotifications, {});
    expect(after.page.filter((n) => n.read)).toHaveLength(1);
    expect(after.page.filter((n) => !n.read)).toHaveLength(1);
  });

  test("markRead is idempotent", async () => {
    const t = convexTest(schema, modules);
    const { alice } = await seedUsers(t);
    await emit(t, alice, "invite", "Workspace invitation");
    const client = t.withIdentity(as(alice));
    const { page } = await client.query(api.notifications.myNotifications, {});
    await client.mutation(api.notifications.markRead, {
      notificationId: page[0]._id,
    });
    await client.mutation(api.notifications.markRead, {
      notificationId: page[0]._id,
    });
    expect(await client.query(api.notifications.unreadCount, {})).toBe(0);
  });

  test("markAllRead clears the badge and reports when more remain", async () => {
    const t = convexTest(schema, modules);
    const { alice } = await seedUsers(t);
    for (let i = 0; i < 5; i++) await emit(t, alice, "invite", `n${i}`);
    const client = t.withIdentity(as(alice));
    const res = await client.mutation(api.notifications.markAllRead, {});
    expect(res.remaining).toBe(false);
    expect(await client.query(api.notifications.unreadCount, {})).toBe(0);
  });
});

describe("isolation", () => {
  test("a user sees only their own notifications", async () => {
    const t = convexTest(schema, modules);
    const { alice, bob } = await seedUsers(t);
    await emit(t, alice, "scheduled.failed", "Alice's run failed");
    await emit(t, bob, "scheduled.failed", "Bob's run failed");

    const seen = await t
      .withIdentity(as(bob))
      .query(api.notifications.myNotifications, {});
    expect(seen.page).toHaveLength(1);
    expect(seen.page[0].title).toBe("Bob's run failed");
  });

  test("markRead cannot touch another user's notification", async () => {
    const t = convexTest(schema, modules);
    const { alice, bob } = await seedUsers(t);
    await emit(t, alice, "scheduled.failed", "Alice's run failed");

    const aliceRows = await t
      .withIdentity(as(alice))
      .query(api.notifications.myNotifications, {});
    const foreign = aliceRows.page[0]._id;

    // A silent no-op, not a throw: the id must not be an existence oracle.
    await t
      .withIdentity(as(bob))
      .mutation(api.notifications.markRead, { notificationId: foreign });

    expect(
      await t.withIdentity(as(alice)).query(api.notifications.unreadCount, {}),
    ).toBe(1);
  });

  test("markAllRead does not reach across users", async () => {
    const t = convexTest(schema, modules);
    const { alice, bob } = await seedUsers(t);
    await emit(t, alice, "invite", "for alice");
    await emit(t, bob, "invite", "for bob");
    await t.withIdentity(as(bob)).mutation(api.notifications.markAllRead, {});
    expect(
      await t.withIdentity(as(alice)).query(api.notifications.unreadCount, {}),
    ).toBe(1);
  });

  test("signed out reads nothing", async () => {
    const t = convexTest(schema, modules);
    const { alice } = await seedUsers(t);
    await emit(t, alice, "invite", "for alice");
    expect((await t.query(api.notifications.myNotifications, {})).page).toEqual(
      [],
    );
    expect(await t.query(api.notifications.unreadCount, {})).toBe(0);
  });
});

describe("idempotency", () => {
  test("the same logical event twice is ONE notification", async () => {
    // A DBOS replay, a dispatch retry, a duplicate finalize and the reaper all
    // observe the same occurrence; the user must hear about it once.
    const t = convexTest(schema, modules);
    const { alice } = await seedUsers(t);
    const key = "task123:daily:1788160000000";
    expect(await emit(t, alice, "scheduled.succeeded", "Run done", key)).toBe(
      true,
    );
    expect(await emit(t, alice, "scheduled.succeeded", "Run done", key)).toBe(
      false,
    );
    expect(await emit(t, alice, "scheduled.succeeded", "Run done", key)).toBe(
      false,
    );
    const { page } = await t
      .withIdentity(as(alice))
      .query(api.notifications.myNotifications, {});
    expect(page).toHaveLength(1);
  });

  test("the dedupe key is per user, not global", async () => {
    const t = convexTest(schema, modules);
    const { alice, bob } = await seedUsers(t);
    const key = "shared-key";
    expect(await emit(t, alice, "invite", "a", key)).toBe(true);
    expect(await emit(t, bob, "invite", "b", key)).toBe(true);
  });

  test("without a dedupe key, repeats are allowed", async () => {
    const t = convexTest(schema, modules);
    const { alice } = await seedUsers(t);
    await emit(t, alice, "invite", "x");
    await emit(t, alice, "invite", "x");
    const { page } = await t
      .withIdentity(as(alice))
      .query(api.notifications.myNotifications, {});
    expect(page).toHaveLength(2);
  });
});

describe("listing", () => {
  test("newest first", async () => {
    const t = convexTest(schema, modules);
    const { alice } = await seedUsers(t);
    await emit(t, alice, "invite", "oldest");
    await emit(t, alice, "invite", "middle");
    await emit(t, alice, "invite", "newest");
    const { page } = await t
      .withIdentity(as(alice))
      .query(api.notifications.myNotifications, {});
    expect(page.map((n) => n.title)).toEqual(["newest", "middle", "oldest"]);
  });

  test("a second page continues past the cursor instead of repeating", async () => {
    // The bug this guards: applying the cursor to a fixed newest-N slice makes
    // every page after the first come back empty.
    const t = convexTest(schema, modules);
    const { alice } = await seedUsers(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 25; i++) {
        await ctx.db.insert("notifications", {
          userId: alice,
          type: "invite",
          title: `n${i}`,
          read: false,
          createdAt: 1_000 + i,
        });
      }
    });
    const client = t.withIdentity(as(alice));
    const first = await client.query(api.notifications.myNotifications, {});
    expect(first.page).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();

    const second = await client.query(api.notifications.myNotifications, {
      before: first.nextCursor ?? undefined,
    });
    expect(second.page).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    // No overlap between the pages.
    const ids = new Set(first.page.map((n) => n._id));
    expect(second.page.some((n) => ids.has(n._id))).toBe(false);
  });

  test("an empty history is an empty page, not an error", async () => {
    const t = convexTest(schema, modules);
    const { alice } = await seedUsers(t);
    const res = await t
      .withIdentity(as(alice))
      .query(api.notifications.myNotifications, {});
    expect(res).toEqual({ page: [], nextCursor: null });
  });
});
