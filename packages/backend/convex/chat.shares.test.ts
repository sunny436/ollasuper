/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });
const PAGE = { numItems: 20, cursor: null };

async function seed(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { email: "owner@t.test" });
    const other = await ctx.db.insert("users", { email: "other@t.test" });
    const ws = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: owner,
      createdAt: Date.now(),
    });
    for (const [u, role] of [
      [owner, "owner"],
      [other, "member"],
    ] as const) {
      await ctx.db.insert("members", {
        workspaceId: ws,
        userId: u,
        role,
        createdAt: Date.now(),
      });
    }
    return { owner, other, ws };
  });
}

async function seedThread(
  t: ReturnType<typeof convexTest>,
  owner: Id<"users">,
  ws: Id<"workspaces">,
) {
  return t.run(async (ctx) => {
    const now = Date.now();
    const threadId = await ctx.db.insert("chatThreads", {
      workspaceId: ws,
      userId: owner,
      title: "My chat",
      titleSource: "auto",
      status: "active",
      pinned: false,
      model: "anthropic/claude-opus-5",
      nextSeq: 2,
      messageCount: 2,
      tokensIn: 0,
      tokensOut: 0,
      lastMessageAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const userMsgId = await ctx.db.insert("chatMessages", {
      threadId,
      workspaceId: ws,
      userId: owner,
      role: "user",
      seq: 0,
      content: "Hello there",
      status: "complete",
      variantCount: 1,
      activeVariantIndex: 0,
      createdAt: now,
      updatedAt: now,
    });
    const asstMsgId = await ctx.db.insert("chatMessages", {
      threadId,
      workspaceId: ws,
      userId: owner,
      role: "assistant",
      seq: 1,
      content: "Hi! A **markdown** reply.",
      status: "complete",
      parentId: userMsgId,
      variantIndex: 0,
      createdAt: now,
      updatedAt: now,
    });
    return { threadId, userMsgId, asstMsgId };
  });
}

describe("chat shares", () => {
  test("full_chat snapshot + public read is sanitized", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const { threadId } = await seedThread(t, owner, ws);
    const u = t.withIdentity(as(owner));

    const { token } = await u.mutation(api.chat.shares.create, {
      shareType: "full_chat",
      threadId,
    });
    expect(token).toMatch(/^[0-9a-f]{48}$/); // 192-bit hex, unguessable

    const res = await t.query(api.chat.shares.getByToken, { token });
    expect(res.state).toBe("ok");
    if (res.state !== "ok") throw new Error("expected ok");
    expect(res.share.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(res.share.messages[1].content).toContain("markdown");

    const json = JSON.stringify(res);
    expect(json).not.toContain(owner); // no userId
    expect(json).not.toContain("owner@t.test"); // no email
    expect(json).not.toContain("storageId");
    expect(json).not.toContain(threadId); // no internal ids
  });

  test("single_turn exposes ONLY the selected pair", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const { threadId, asstMsgId } = await seedThread(t, owner, ws);
    // A second turn that must NEVER appear in a single-turn share.
    await t.run(async (ctx) => {
      const now = Date.now();
      const u2 = await ctx.db.insert("chatMessages", {
        threadId,
        workspaceId: ws,
        userId: owner,
        role: "user",
        seq: 2,
        content: "SECRET second question",
        status: "complete",
        variantCount: 1,
        activeVariantIndex: 0,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("chatMessages", {
        threadId,
        workspaceId: ws,
        userId: owner,
        role: "assistant",
        seq: 3,
        content: "SECRET second answer",
        status: "complete",
        parentId: u2,
        variantIndex: 0,
        createdAt: now,
        updatedAt: now,
      });
    });

    const u = t.withIdentity(as(owner));
    const { token } = await u.mutation(api.chat.shares.create, {
      shareType: "single_turn",
      messageId: asstMsgId,
    });
    const res = await t.query(api.chat.shares.getByToken, { token });
    expect(res.state).toBe("ok");
    if (res.state !== "ok") throw new Error("expected ok");
    expect(res.share.messages.length).toBe(2);
    const text = JSON.stringify(res.share.messages);
    expect(text).toContain("Hello there");
    expect(text).not.toContain("SECRET");
  });

  test("cross-user isolation: cannot create/revoke/list another user's shares", async () => {
    const t = convexTest(schema, modules);
    const { owner, other, ws } = await seed(t);
    const { threadId, asstMsgId } = await seedThread(t, owner, ws);
    const peer = t.withIdentity(as(other));

    await expect(
      peer.mutation(api.chat.shares.create, {
        shareType: "full_chat",
        threadId,
      }),
    ).rejects.toThrow();
    await expect(
      peer.mutation(api.chat.shares.create, {
        shareType: "single_turn",
        messageId: asstMsgId,
      }),
    ).rejects.toThrow();

    const u = t.withIdentity(as(owner));
    await u.mutation(api.chat.shares.create, {
      shareType: "full_chat",
      threadId,
    });
    const mine = await u.query(api.chat.shares.listMine, { workspaceId: ws, paginationOpts: PAGE });
    expect(mine.page.length).toBe(1);
    await expect(
      peer.mutation(api.chat.shares.revoke, { shareId: mine.page[0]._id }),
    ).rejects.toThrow();

    const peerList = await peer.query(api.chat.shares.listMine, { workspaceId: ws, paginationOpts: PAGE });
    expect(peerList.page.length).toBe(0);
  });

  test("expiry + revocation gate the public read and the attachment resolver", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const { threadId } = await seedThread(t, owner, ws);
    const u = t.withIdentity(as(owner));
    const { token } = await u.mutation(api.chat.shares.create, {
      shareType: "full_chat",
      threadId,
    });

    // Expire it → public read + resolver both refuse.
    await t.run(async (ctx) => {
      const s = await ctx.db
        .query("chatShares")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique();
      await ctx.db.patch(s!._id, { expiresAt: Date.now() - 1000 });
    });
    expect(
      (await t.query(api.chat.shares.getByToken, { token })).state,
    ).toBe("expired");
    expect(
      await t.query(internal.chat.shares.resolveAttachment, {
        token,
        m: 0,
        a: 0,
      }),
    ).toBeNull();

    // Un-expire, then revoke → revoked.
    let shareId!: Id<"chatShares">;
    await t.run(async (ctx) => {
      const s = await ctx.db
        .query("chatShares")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique();
      shareId = s!._id;
      await ctx.db.patch(s!._id, { expiresAt: Date.now() + 100000 });
    });
    await u.mutation(api.chat.shares.revoke, { shareId });
    expect(
      (await t.query(api.chat.shares.getByToken, { token })).state,
    ).toBe("revoked");
  });

  test("revoking one share does not revoke another; invalid token", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const { threadId } = await seedThread(t, owner, ws);
    const u = t.withIdentity(as(owner));
    const a = await u.mutation(api.chat.shares.create, {
      shareType: "full_chat",
      threadId,
    });
    const b = await u.mutation(api.chat.shares.create, {
      shareType: "full_chat",
      threadId,
      forceNew: true,
    });
    expect(a.token).not.toBe(b.token);

    const list = await u.query(api.chat.shares.listMine, { workspaceId: ws, paginationOpts: PAGE });
    const first = list.page.find((r) => r.token === a.token);
    if (!first) throw new Error("share not found");
    await u.mutation(api.chat.shares.revoke, { shareId: first._id });

    expect(
      (await t.query(api.chat.shares.getByToken, { token: a.token })).state,
    ).toBe("revoked");
    expect(
      (await t.query(api.chat.shares.getByToken, { token: b.token })).state,
    ).toBe("ok");
    expect(
      (await t.query(api.chat.shares.getByToken, { token: "deadbeef" }))
        .state,
    ).toBe("invalid");
  });

  test("dedup returns the same active share unless forceNew", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const { threadId } = await seedThread(t, owner, ws);
    const u = t.withIdentity(as(owner));
    const a = await u.mutation(api.chat.shares.create, {
      shareType: "full_chat",
      threadId,
    });
    const b = await u.mutation(api.chat.shares.create, {
      shareType: "full_chat",
      threadId,
    });
    expect(b.reused).toBe(true);
    expect(b.token).toBe(a.token);
    const c = await u.mutation(api.chat.shares.create, {
      shareType: "full_chat",
      threadId,
      forceNew: true,
    });
    expect(c.token).not.toBe(a.token);
  });

  // ---- QA #6: opening the dialog must not publish anything ---------------
  //
  // The dialog used to call `create` from a useEffect on open, so opening it
  // and closing it again left a live public link — `getByToken` is
  // unauthenticated, so the conversation was readable by anyone with the URL
  // for the full TTL. `activeForTarget` is the read-only lookup that replaced
  // it: it answers "is one already live?" without ever writing.
  test("#6: activeForTarget never creates a share", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const { threadId } = await seedThread(t, owner, ws);
    const u = t.withIdentity(as(owner));

    const before = await u.query(api.chat.shares.activeForTarget, {
      shareType: "full_chat",
      threadId,
    });
    expect(before).toBeNull();
    // The property that actually matters: nothing was persisted.
    expect(await t.run((ctx) => ctx.db.query("chatShares").collect())).toEqual([]);

    // Calling it repeatedly is still a no-op — this runs on every dialog open.
    await u.query(api.chat.shares.activeForTarget, {
      shareType: "full_chat",
      threadId,
    });
    expect(await t.run((ctx) => ctx.db.query("chatShares").collect())).toEqual([]);
  });

  test("#6: after an explicit create, the same link is returned", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const { threadId } = await seedThread(t, owner, ws);
    const u = t.withIdentity(as(owner));

    const made = await u.mutation(api.chat.shares.create, {
      shareType: "full_chat",
      threadId,
    });
    const found = await u.query(api.chat.shares.activeForTarget, {
      shareType: "full_chat",
      threadId,
    });
    expect(found?.token).toBe(made.token);
    expect(found?.expiresAt).toBe(made.expiresAt);
    // Still exactly one row: the lookup did not mint a second.
    expect(
      (await t.run((ctx) => ctx.db.query("chatShares").collect())).length,
    ).toBe(1);
  });

  test("#6: a revoked or expired share reads as none, so the UI offers a new one", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const { threadId } = await seedThread(t, owner, ws);
    const u = t.withIdentity(as(owner));
    const made = await u.mutation(api.chat.shares.create, {
      shareType: "full_chat",
      threadId,
    });
    const row = await t.run((ctx) =>
      ctx.db
        .query("chatShares")
        .withIndex("by_token", (q) => q.eq("token", made.token))
        .unique(),
    );
    await t.run((ctx) => ctx.db.patch(row!._id, { revokedAt: Date.now() }));
    expect(
      await u.query(api.chat.shares.activeForTarget, {
        shareType: "full_chat",
        threadId,
      }),
    ).toBeNull();
  });

  test("#6: single_turn is scoped to its own message", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const { threadId, asstMsgId } = await seedThread(t, owner, ws);
    const u = t.withIdentity(as(owner));
    await u.mutation(api.chat.shares.create, {
      shareType: "single_turn",
      messageId: asstMsgId,
    });
    // A full_chat share of the same thread is a DIFFERENT target.
    expect(
      await u.query(api.chat.shares.activeForTarget, {
        shareType: "full_chat",
        threadId,
      }),
    ).toBeNull();
    expect(
      await u.query(api.chat.shares.activeForTarget, {
        shareType: "single_turn",
        messageId: asstMsgId,
      }),
    ).not.toBeNull();
  });

  test("#6: another user's target reads as none and does NOT throw", async () => {
    const t = convexTest(schema, modules);
    const { owner, other, ws } = await seed(t);
    const { threadId } = await seedThread(t, owner, ws);
    await t.withIdentity(as(owner)).mutation(api.chat.shares.create, {
      shareType: "full_chat",
      threadId,
    });
    // Returning null rather than throwing is deliberate twice over: a rejected
    // Convex call logs console.error and every e2e script asserts zero of
    // those, and "throws vs null" would be an existence oracle for someone
    // else's threadId.
    await expect(
      t
        .withIdentity(as(other))
        .query(api.chat.shares.activeForTarget, {
          shareType: "full_chat",
          threadId,
        }),
    ).resolves.toBeNull();
    await expect(
      t.withIdentity(as(other)).query(api.chat.shares.activeForTarget, {
        shareType: "full_chat",
        threadId: "not-a-real-id",
      }),
    ).resolves.toBeNull();
    await expect(
      t.query(api.chat.shares.activeForTarget, {
        shareType: "full_chat",
        threadId,
      }),
    ).resolves.toBeNull();
  });

  test("cannot share while the response is streaming", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const { threadId, asstMsgId } = await seedThread(t, owner, ws);
    await t.run(async (ctx) => {
      await ctx.db.patch(threadId, { streamingMessageId: asstMsgId });
    });
    const u = t.withIdentity(as(owner));
    await expect(
      u.mutation(api.chat.shares.create, {
        shareType: "full_chat",
        threadId,
      }),
    ).rejects.toThrow();
  });

  test("create rate limit", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const { threadId } = await seedThread(t, owner, ws);
    const u = t.withIdentity(as(owner));
    for (let i = 0; i < 30; i++) {
      await u.mutation(api.chat.shares.create, {
        shareType: "full_chat",
        threadId,
        forceNew: true,
      });
    }
    await expect(
      u.mutation(api.chat.shares.create, {
        shareType: "full_chat",
        threadId,
        forceNew: true,
      }),
    ).rejects.toThrow();
  });
});
