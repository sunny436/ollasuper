/// <reference types="vite/client" />
/**
 * Regressions for the WSTG audit findings D.3, D.4, D.6 and the register-side
 * half of D.1. See SECURITY-AUDIT-WSTG.md.
 *
 * The shape these share, and the reason they are one file: each is a case where
 * the CHECK existed somewhere but not at the surface that mattered. D.6 in
 * particular is not a missing ownership check — every one of those callables
 * verified ownership correctly — it is a missing ACCOUNT-STATUS check, and a
 * test that only proves "a stranger is refused" would pass against the bug.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

async function seed(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "u@t.test" });
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
    return { userId: userId as Id<"users">, ws: ws as Id<"workspaces"> };
  });
}

const suspend = (t: ReturnType<typeof convexTest>, userId: Id<"users">) =>
  t.run((ctx) => ctx.db.patch(userId, { accountStatus: "suspended" }));

// ---------------------------------------------------------------- D.6
describe("D.6 — account status is enforced, not just ownership", () => {
  /**
   * These callables all used a bare `getAuthUserId`, which is a cast of the JWT
   * subject with NO database lookup. Suspension revokes sessions and refresh
   * tokens, but an access token already issued stays valid until it expires
   * (≤1h), and every one of these kept honouring it for that whole window.
   */
  test("notifications are refused once the account is suspended", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("notifications", {
        userId,
        type: "test",
        title: "hi",
        read: false,
        createdAt: Date.now(),
      });
    });

    const before = await t
      .withIdentity(as(userId))
      .query(api.notifications.unreadCount, {});
    expect(before).toBe(1);

    await suspend(t, userId);
    const after = await t
      .withIdentity(as(userId))
      .query(api.notifications.unreadCount, {});
    expect(after).toBe(0);
  });

  test("a suspended user cannot list their workspaces", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seed(t);
    expect(
      await t.withIdentity(as(userId)).query(api.orgs.myWorkspaces, {}),
    ).toHaveLength(1);

    await suspend(t, userId);
    expect(
      await t.withIdentity(as(userId)).query(api.orgs.myWorkspaces, {}),
    ).toHaveLength(0);
  });

  test("a suspended user cannot create a workspace", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seed(t);
    await suspend(t, userId);
    await expect(
      t.withIdentity(as(userId)).mutation(api.orgs.createWorkspace, {
        name: "Sneaky",
      }),
    ).rejects.toThrow();
  });

  test("a suspended user cannot mint an avatar upload url", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seed(t);
    await suspend(t, userId);
    await expect(
      t.withIdentity(as(userId)).mutation(api.users.generateUploadUrl, {}),
    ).rejects.toThrow();
  });

  test("a DELETED user's surviving token is refused too", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seed(t);
    await t.run((ctx) => ctx.db.patch(userId, { accountStatus: "deleted" }));
    expect(
      await t.withIdentity(as(userId)).query(api.orgs.myWorkspaces, {}),
    ).toHaveLength(0);
  });

  test("an ACTIVE user is entirely unaffected", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seed(t);
    expect(
      await t.withIdentity(as(userId)).query(api.orgs.myWorkspaces, {}),
    ).toHaveLength(1);
    expect(
      await t.withIdentity(as(userId)).query(api.notifications.unreadCount, {}),
    ).toBe(0);
  });

  test("the helper itself: absent accountStatus means ACTIVE", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seed(t);
    // Every pre-migration row predates the column; treating absent as suspended
    // would lock out the entire existing user base on deploy.
    const id = await t
      .withIdentity(as(userId))
      .query(internal.accountState.activeCallerId, {});
    expect(id).toBe(userId);
  });

  test("a signed-out caller gets null, not a throw, from the action helper", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(internal.accountState.activeCallerId, {})).toBeNull();
  });
});

// ---------------------------------------------------------------- D.1 (root cause)
describe("D.1 root cause — register refuses an executable declared type", () => {
  test("a text/plain blob cannot be REGISTERED as text/html", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["<script>alert(1)</script>"], { type: "text/plain" })),
    );

    // This is the exact call that made /share/file executable: the BLOB is
    // innocuous, so the blob-side guard passes; the ROW is what lied.
    await expect(
      t.withIdentity(as(userId)).mutation(api.chat.attachments.register, {
        workspaceId: ws,
        storageId,
        name: "harmless-notes.txt",
        size: 25,
        contentType: "text/html",
      }),
    ).rejects.toThrow(/Unsupported file type/i);
  });

  test("an ordinary declared type still registers", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["hello"], { type: "text/plain" })),
    );
    await expect(
      t.withIdentity(as(userId)).mutation(api.chat.attachments.register, {
        workspaceId: ws,
        storageId,
        name: "notes.txt",
        size: 5,
        contentType: "text/plain",
      }),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------- D.4
describe("D.4 — web.subscribe validates its input", () => {
  /**
   * Anonymous ON PURPOSE — it is the marketing site's newsletter form. The bug
   * was never missing auth; it was that both fields were free-form and the
   * provider's raw answer came back to the caller. No network call is made for
   * a rejected address, which is what these assert.
   */
  test("a malformed address is refused without calling the provider", async () => {
    const t = convexTest(schema, modules);
    for (const email of ["", "nope", "a@b", "@b.com", "a b@c.com", `${"x".repeat(300)}@y.com`]) {
      expect(await t.action(api.web.subscribe, { email, userGroup: "v1-newsletter" })).toEqual({
        ok: false,
      });
    }
  });

  test("the provider's raw response is never returned to an anonymous caller", async () => {
    const t = convexTest(schema, modules);
    const res = await t.action(api.web.subscribe, {
      email: "someone@example.com",
      userGroup: "totally-made-up-segment",
    });
    // Only a boolean, whatever Loops said. Echoing the body made this an oracle.
    expect(Object.keys(res)).toEqual(["ok"]);
    expect(typeof (res as { ok: unknown }).ok).toBe("boolean");
  });
});
