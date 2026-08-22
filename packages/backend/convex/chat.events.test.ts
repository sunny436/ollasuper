/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

// Schema-typed tester so ctx.db.query(...).withIndex(...) and Doc types resolve.
const makeTester = () => convexTest(schema, modules);
type Tester = ReturnType<typeof makeTester>;

async function seed(t: Tester) {
  return t.run(async (ctx) => {
    const now = Date.now();
    const owner = await ctx.db.insert("users", { email: "e@t.test" });
    const ws = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: owner,
      createdAt: now,
    });
    await ctx.db.insert("members", {
      workspaceId: ws,
      userId: owner,
      role: "owner",
      createdAt: now,
    });
    const threadId = await ctx.db.insert("chatThreads", {
      workspaceId: ws,
      userId: owner,
      title: "t",
      titleSource: "user",
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
    const messageId = await ctx.db.insert("chatMessages", {
      threadId,
      workspaceId: ws,
      userId: owner,
      role: "assistant",
      seq: 1,
      content: "",
      status: "streaming",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(threadId, { streamingMessageId: messageId });
    const streamId = "stream-evt-1";
    await ctx.db.insert("chatStreams", {
      streamId,
      messageId,
      threadId,
      workspaceId: ws,
      userId: owner,
      status: "running",
      cancelRequested: false,
      chunkSeq: 0,
      committedText: "",
      committedSeq: 0,
      heartbeatAt: now,
      startedAt: now,
    });
    return { threadId, messageId, streamId };
  });
}

function ev(seq: number, type: string, body: Record<string, unknown> = {}) {
  return {
    eventId: `ev-${seq}-${type}`,
    seq,
    // biome-ignore lint/suspicious/noExplicitAny: test builds arbitrary types incl. an invalid one
    type: type as any,
    v: 1,
    ts: Date.now(),
    payload: JSON.stringify(body),
  };
}

async function eventRows(
  t: Tester,
  messageId: Id<"chatMessages">,
) {
  return t.run(async (ctx) => {
    const rows = await ctx.db
      .query("chatStreamEvents")
      .withIndex("by_message_seq", (q) => q.eq("messageId", messageId))
      .collect();
    return rows.sort((a, b) => a.seq - b.seq);
  });
}

const getMsg = (t: Tester, id: Id<"chatMessages">) =>
  t.run((ctx) => ctx.db.get(id));

const getStream = (t: Tester, streamId: string) =>
  t.run((ctx) =>
    ctx.db
      .query("chatStreams")
      .withIndex("by_streamId", (q) => q.eq("streamId", streamId))
      .unique(),
  );

describe("typed event protocol", () => {
  test("appendEvent inserts, sets hasEvents, idempotent by (messageId, seq)", async () => {
    const t = makeTester();
    const { messageId, streamId } = await seed(t);
    const r = await t.mutation(internal.chat.ingest.appendEvent, {
      streamId,
      events: [ev(0, "TOOL_CALL", { tool_name: "web_search", call_id: "c1" })],
    });
    expect(r.ok).toBe(true);
    expect((await getStream(t, streamId))?.hasEvents).toBe(true);
    expect((await eventRows(t, messageId)).length).toBe(1);
    // Retrying the same seq must not create a duplicate.
    await t.mutation(internal.chat.ingest.appendEvent, {
      streamId,
      events: [ev(0, "TOOL_CALL", { tool_name: "web_search", call_id: "c1" })],
    });
    expect((await eventRows(t, messageId)).length).toBe(1);
  });

  test("events read back in seq order regardless of arrival order", async () => {
    const t = makeTester();
    const { messageId, streamId } = await seed(t);
    await t.mutation(internal.chat.ingest.appendEvent, {
      streamId,
      events: [ev(2, "TOOL_RESULT", { call_id: "c1" })],
    });
    await t.mutation(internal.chat.ingest.appendEvent, {
      streamId,
      events: [ev(1, "TOOL_PROGRESS", { call_id: "c1", progress: 0.5 })],
    });
    expect((await eventRows(t, messageId)).map((e) => e.seq)).toEqual([1, 2]);
  });

  test("finishStream folds events (+FINAL) into message.events and purges rows", async () => {
    const t = makeTester();
    const { messageId, streamId } = await seed(t);
    await t.mutation(internal.chat.ingest.appendEvent, {
      streamId,
      events: [
        ev(0, "TOOL_CALL", { tool_name: "x", call_id: "c1" }),
        ev(1, "TOOL_RESULT", { call_id: "c1" }),
      ],
    });
    await t.mutation(internal.chat.ingest.finishStream, {
      streamId,
      text: "done",
    });
    const m = await getMsg(t, messageId);
    expect(m?.content).toBe("done");
    expect(m?.status).toBe("complete");
    expect(m?.events?.map((e) => e.type)).toEqual([
      "TOOL_CALL",
      "TOOL_RESULT",
      "FINAL",
    ]);
    expect((await eventRows(t, messageId)).length).toBe(0);
  });

  test("failStream folds events (+ERROR) and purges", async () => {
    const t = makeTester();
    const { messageId, streamId } = await seed(t);
    await t.mutation(internal.chat.ingest.appendEvent, {
      streamId,
      events: [ev(0, "TOOL_CALL", { tool_name: "x", call_id: "c1" })],
    });
    await t.mutation(internal.chat.ingest.failStream, {
      streamId,
      error: "boom",
      errorCode: "provider_error",
    });
    const m = await getMsg(t, messageId);
    expect(m?.status).toBe("error");
    const types = m?.events?.map((e) => e.type) ?? [];
    expect(types.at(-1)).toBe("ERROR");
    expect((await eventRows(t, messageId)).length).toBe(0);
  });

  test("text-only turn writes NO events field (byte-identical)", async () => {
    const t = makeTester();
    const { messageId, streamId } = await seed(t);
    await t.mutation(internal.chat.ingest.finishStream, {
      streamId,
      text: "just text",
    });
    expect((await getMsg(t, messageId))?.events).toBeUndefined();
  });

  test("sequence TOOL_CALL/PROGRESS/PROGRESS/RESULT/FINAL persists in order", async () => {
    const t = makeTester();
    const { messageId, streamId } = await seed(t);
    await t.mutation(internal.chat.ingest.appendEvent, {
      streamId,
      events: [
        ev(0, "TOOL_CALL", { tool_name: "crawl", call_id: "c1" }),
        ev(1, "TOOL_PROGRESS", { call_id: "c1", progress: 0.3 }),
        ev(2, "TOOL_PROGRESS", { call_id: "c1", progress: 0.7 }),
        ev(3, "TOOL_RESULT", { call_id: "c1", status: "success" }),
      ],
    });
    await t.mutation(internal.chat.ingest.finishStream, { streamId, text: "ok" });
    expect((await getMsg(t, messageId))?.events?.map((e) => e.type)).toEqual([
      "TOOL_CALL",
      "TOOL_PROGRESS",
      "TOOL_PROGRESS",
      "TOOL_RESULT",
      "FINAL",
    ]);
  });

  test("sequence TOOL_CALL/APPROVAL_REQUEST/FINAL persists", async () => {
    const t = makeTester();
    const { messageId, streamId } = await seed(t);
    await t.mutation(internal.chat.ingest.appendEvent, {
      streamId,
      events: [
        ev(0, "TOOL_CALL", { tool_name: "delete", call_id: "c1" }),
        ev(1, "APPROVAL_REQUEST", { approval_id: "a1", tool_name: "delete" }),
      ],
    });
    await t.mutation(internal.chat.ingest.finishStream, {
      streamId,
      text: "awaiting",
    });
    expect((await getMsg(t, messageId))?.events?.map((e) => e.type)).toEqual([
      "TOOL_CALL",
      "APPROVAL_REQUEST",
      "FINAL",
    ]);
  });

  test("sequence CITATION/FINAL persists", async () => {
    const t = makeTester();
    const { messageId, streamId } = await seed(t);
    await t.mutation(internal.chat.ingest.appendEvent, {
      streamId,
      events: [ev(0, "CITATION", { source_id: "s1", title: "Doc", url: "https://x" })],
    });
    await t.mutation(internal.chat.ingest.finishStream, { streamId, text: "cited" });
    expect((await getMsg(t, messageId))?.events?.map((e) => e.type)).toEqual([
      "CITATION",
      "FINAL",
    ]);
  });

  test("unknown event type is rejected by the validator", async () => {
    const t = makeTester();
    const { streamId } = await seed(t);
    await expect(
      t.mutation(internal.chat.ingest.appendEvent, {
        streamId,
        events: [ev(0, "BOGUS_TYPE", {})],
      }),
    ).rejects.toThrow();
  });

  test("appendEvent on an unknown stream writes nothing", async () => {
    const t = makeTester();
    const r = await t.mutation(internal.chat.ingest.appendEvent, {
      streamId: "does-not-exist",
      events: [ev(0, "TOOL_CALL", { tool_name: "x", call_id: "c" })],
    });
    expect(r.unknown).toBe(true);
  });

  test("late event after finalize is dropped (terminal guard)", async () => {
    const t = makeTester();
    const { messageId, streamId } = await seed(t);
    await t.mutation(internal.chat.ingest.finishStream, { streamId, text: "done" });
    const r = await t.mutation(internal.chat.ingest.appendEvent, {
      streamId,
      events: [ev(0, "TOOL_CALL", { tool_name: "x", call_id: "c" })],
    });
    expect(r.cancel).toBe(true);
    expect((await eventRows(t, messageId)).length).toBe(0);
  });
});
