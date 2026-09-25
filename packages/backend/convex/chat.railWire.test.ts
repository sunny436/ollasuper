import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

/**
 * The chat list's wire contract.
 *
 * Convex re-sends a query's whole result when any of it changes. `list` used to
 * return isStreaming / messageCount / lastMessageAt / model — all of which a
 * send changes — so every turn pushed the whole first page at send AND at
 * finalize. These tests pin the lean row and the separate `streaming` query
 * that now carries the rail's streaming dot.
 */

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
type TestT = TestConvex<typeof schema>;
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });
type Status = "queued" | "running" | "done" | "error" | "aborted" | "waiting_approval";

async function account(t: TestT, email: string) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email });
    const ws = await ctx.db.insert("workspaces", { name: "WS", ownerId: userId, createdAt: 0 });
    await ctx.db.insert("members", { workspaceId: ws, userId, role: "owner", createdAt: 0 });
    return { userId, ws };
  });
}

async function thread(t: TestT, userId: Id<"users">, ws: Id<"workspaces">, title: string, stream?: Status) {
  return t.run(async (ctx) => {
    const threadId = await ctx.db.insert("chatThreads", {
      workspaceId: ws,
      userId,
      title,
      titleSource: "auto" as const,
      status: "active" as const,
      pinned: false,
      model: "anthropic/claude-opus-5",
      nextSeq: 2,
      messageCount: 2,
      tokensIn: 0,
      tokensOut: 0,
      lastMessageAt: 5,
      createdAt: 1,
      updatedAt: 5,
    });
    if (stream) {
      const messageId = await ctx.db.insert("chatMessages", {
        threadId,
        workspaceId: ws,
        userId,
        role: "assistant" as const,
        seq: 1,
        content: "",
        status: "streaming" as const,
        createdAt: 5,
        updatedAt: 5,
      });
      await ctx.db.insert("chatStreams", {
        streamId: `s-${title}`,
        messageId,
        threadId,
        workspaceId: ws,
        userId,
        status: stream,
        cancelRequested: false,
        chunkSeq: 0,
        committedText: "",
        committedSeq: 0,
        heartbeatAt: 5,
        startedAt: 5,
      });
    }
    return threadId;
  });
}

const page = { numItems: 30, cursor: null };

describe("chat list wire contract", () => {
  test("a list row carries only what the rail and Archived render", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await account(t, "a@t.test");
    await thread(t, userId, ws, "one");

    const res = await t.withIdentity(as(userId)).query(api.chat.threads.list, {
      workspaceId: ws,
      unassignedOnly: true,
      paginationOpts: page,
    });

    expect(Object.keys(res.page[0] ?? {}).sort()).toEqual(["_id", "pinned", "project", "title", "updatedAt"]);
  });

  test("streaming returns exactly the chats with an active stream", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await account(t, "a@t.test");
    const queued = await thread(t, userId, ws, "queued", "queued");
    const running = await thread(t, userId, ws, "running", "running");
    const parked = await thread(t, userId, ws, "parked", "waiting_approval");
    await thread(t, userId, ws, "done", "done");
    await thread(t, userId, ws, "error", "error");
    await thread(t, userId, ws, "aborted", "aborted");
    await thread(t, userId, ws, "idle");

    const ids = await t.withIdentity(as(userId)).query(api.chat.threads.streaming, { workspaceId: ws });

    expect([...ids].sort()).toEqual([queued, running, parked].sort());
  });

  test("streaming never reveals another user's chats, or another workspace's", async () => {
    const t = convexTest(schema, modules);
    const me = await account(t, "me@t.test");
    const other = await account(t, "other@t.test");
    await thread(t, other.userId, other.ws, "theirs", "running");
    const otherWs = await t.run(async (ctx) => {
      const w = await ctx.db.insert("workspaces", { name: "Second", ownerId: me.userId, createdAt: 0 });
      await ctx.db.insert("members", { workspaceId: w, userId: me.userId, role: "owner", createdAt: 0 });
      return w;
    });
    await thread(t, me.userId, otherWs, "mine elsewhere", "running");

    expect(await t.withIdentity(as(me.userId)).query(api.chat.threads.streaming, { workspaceId: me.ws })).toEqual([]);
    // A workspace the caller does not belong to is refused, not answered.
    await expect(
      t.withIdentity(as(me.userId)).query(api.chat.threads.streaming, { workspaceId: other.ws }),
    ).rejects.toThrow();
  });

  test("signed out gets nothing", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await account(t, "a@t.test");
    await thread(t, userId, ws, "running", "running");
    expect(await t.query(api.chat.threads.streaming, { workspaceId: ws })).toEqual([]);
  });
});
