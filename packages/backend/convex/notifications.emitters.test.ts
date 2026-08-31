/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

/**
 * Which real events become notifications — and, more importantly, which do not.
 *
 * Every rule here exists because the naive version double-notifies or nags:
 * scheduled runs travel the ordinary chat path, an expired approval terminates
 * its turn through the generic failure path, and a turn the user stopped is not
 * a failure they need telling about.
 */

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
type TestT = TestConvex<typeof schema>;

const LONG_AGO = 3 * 60_000; // comfortably past LONG_RUN_MS (2 min)

async function seedStream(
  t: TestT,
  opts: { threadStatus?: "active" | "scheduled"; startedAgoMs?: number } = {},
) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "u@t.test" });
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: userId,
      createdAt: Date.now(),
    });
    await ctx.db.insert("members", {
      workspaceId,
      userId,
      role: "owner",
      createdAt: Date.now(),
    });
    const threadId = await ctx.db.insert("chatThreads", {
      userId,
      workspaceId,
      title: "My conversation",
      titleSource: "user",
      status: opts.threadStatus ?? "active",
      pinned: false,
      model: "m",
      nextSeq: 3,
      messageCount: 2,
      tokensIn: 0,
      tokensOut: 0,
      lastMessageAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const messageId = await ctx.db.insert("chatMessages", {
      threadId,
      userId,
      workspaceId,
      role: "assistant",
      content: "",
      seq: 2,
      status: "streaming",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.patch(threadId, { streamingMessageId: messageId });
    const streamId = `stream_${Math.random()}`;
    await ctx.db.insert("chatStreams", {
      streamId,
      messageId,
      threadId,
      workspaceId,
      userId,
      status: "running",
      cancelRequested: false,
      chunkSeq: -1,
      committedText: "partial",
      committedSeq: -1,
      heartbeatAt: Date.now(),
      startedAt: Date.now() - (opts.startedAgoMs ?? 0),
      attempts: 0,
      deadlineAt: Date.now() + 300_000,
    });
    return { streamId, threadId, userId, messageId };
  });
}

const notifsOf = (t: TestT, userId: Id<"users">) =>
  t.run(async (ctx) =>
    ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect(),
  );

describe("chat turn failures", () => {
  test("a failed turn notifies once", async () => {
    const t = convexTest(schema, modules);
    const { streamId, userId } = await seedStream(t);
    await t.mutation(internal.chat.ingest.failStream, {
      streamId,
      error: "provider exploded",
      errorCode: "provider_error",
    });
    const rows = await notifsOf(t, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("chat.turn_failed");
    // No raw error text or code reaches the user.
    expect(`${rows[0].title} ${rows[0].body}`).not.toMatch(
      /provider_error|exploded/,
    );
  });

  test("a turn the USER stopped is not reported as a failure", async () => {
    // reapStalled finalises a stopped turn through this same path with
    // errorCode "cancelled". The user pressed stop; telling them it failed is
    // both wrong and annoying.
    const t = convexTest(schema, modules);
    const { streamId, userId } = await seedStream(t);
    await t.mutation(internal.chat.ingest.failStream, {
      streamId,
      error: "Cancelled",
      errorCode: "cancelled",
    });
    expect(await notifsOf(t, userId)).toHaveLength(0);
  });

  test("an expired approval is not ALSO reported as a generic failure", async () => {
    // Approval expiry terminates the parked turn through the failure path, so
    // without the skip the user gets two notifications for one event.
    const t = convexTest(schema, modules);
    const { streamId, userId } = await seedStream(t);
    await t.mutation(internal.chat.ingest.failStream, {
      streamId,
      error: "The approval request expired",
      errorCode: "approval_expired",
    });
    expect(await notifsOf(t, userId)).toHaveLength(0);
  });

  test("a SCHEDULED run does not raise a chat notification", async () => {
    // The whole point: scheduled execution reuses this path, and
    // notifyRunFinished is the emitter that honours the task's preferences.
    // Without the thread-status check every scheduled run notifies twice.
    const t = convexTest(schema, modules);
    const { streamId, userId } = await seedStream(t, {
      threadStatus: "scheduled",
    });
    await t.mutation(internal.chat.ingest.failStream, {
      streamId,
      error: "boom",
      errorCode: "provider_error",
    });
    expect(await notifsOf(t, userId)).toHaveLength(0);
  });
});

describe("long chat turns", () => {
  test("a long turn notifies on success", async () => {
    const t = convexTest(schema, modules);
    const { streamId, userId } = await seedStream(t, {
      startedAgoMs: LONG_AGO,
    });
    await t.mutation(internal.chat.ingest.finishStream, {
      streamId,
      text: "done",
    });
    const rows = await notifsOf(t, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("chat.turn_done");
  });

  test("a SHORT turn notifies nothing", async () => {
    // The user is watching a normal reply land; a notification is pure noise.
    const t = convexTest(schema, modules);
    const { streamId, userId } = await seedStream(t, { startedAgoMs: 5_000 });
    await t.mutation(internal.chat.ingest.finishStream, {
      streamId,
      text: "done",
    });
    expect(await notifsOf(t, userId)).toHaveLength(0);
  });

  test("a long SCHEDULED run does not raise a chat notification", async () => {
    const t = convexTest(schema, modules);
    const { streamId, userId } = await seedStream(t, {
      threadStatus: "scheduled",
      startedAgoMs: LONG_AGO,
    });
    await t.mutation(internal.chat.ingest.finishStream, {
      streamId,
      text: "done",
    });
    expect(await notifsOf(t, userId)).toHaveLength(0);
  });

  test("a chat notification deep-links to its thread", async () => {
    const t = convexTest(schema, modules);
    const { streamId, userId, threadId } = await seedStream(t, {
      startedAgoMs: LONG_AGO,
    });
    await t.mutation(internal.chat.ingest.finishStream, {
      streamId,
      text: "done",
    });
    const rows = await notifsOf(t, userId);
    expect(rows[0].threadId).toBe(threadId);
    expect(rows[0].dedupeKey).toBe(`stream:${streamId}`);
  });
});
