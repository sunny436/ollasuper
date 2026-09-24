/**
 * TOOL_RESULT.content (the model-context block, 74 % of chatMessages bytes on
 * production) is kept ONLY where resume reads it — the live chatStreamEvents
 * row — and dropped on every display path: the fold at finalize, listPaged /
 * toPublic (legacy messages), and stream.active.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { stripForDisplay } from "./chat/events";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });
const SECRET = "ingress-test-secret-0123456789";

const realFetch = globalThis.fetch;
beforeEach(() => {
  process.env.AI_BASE_URL = "http://ai.invalid:8000";
  process.env.AI_SERVICE_KEY = "test-service-key";
  process.env.AI_INGRESS_SECRET = SECRET;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ accepted: true }), { status: 202 })) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  // biome-ignore lint/performance/noDelete: must be absent, not "undefined"
  delete process.env.AI_BASE_URL;
  // biome-ignore lint/performance/noDelete: same
  delete process.env.AI_SERVICE_KEY;
  // biome-ignore lint/performance/noDelete: same
  delete process.env.AI_INGRESS_SECRET;
});

async function drain(t: ReturnType<typeof convexTest>) {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

const BIG = "x".repeat(5000);
const toolResult = (callId: string) =>
  JSON.stringify({ call_id: callId, status: "success", result: { n_results: 3 }, content: BIG, result_size: 5000 });

describe("TOOL_RESULT.content never reaches a display path", () => {
  test("pure helper: strips content from TOOL_RESULT only, keeps everything else", { timeout: 180_000 }, async () => {
    const e = { eventId: "e", seq: 0, type: "TOOL_RESULT", v: 1, ts: 1, payload: toolResult("c1") };
    const out = stripForDisplay(e);
    const b = JSON.parse(out.payload);
    expect(b.content).toBeUndefined();
    expect(b).toMatchObject({ call_id: "c1", status: "success", result: { n_results: 3 }, result_size: 5000 });
    expect(out.eventId).toBe("e");
    // other types untouched, even with a "content" key
    const call = { eventId: "f", seq: 1, type: "TOOL_CALL", v: 1, ts: 1, payload: JSON.stringify({ call_id: "c1", content: "keep" }) };
    expect(stripForDisplay(call)).toBe(call);
    // malformed payload untouched
    const bad = { eventId: "g", seq: 2, type: "TOOL_RESULT", v: 1, ts: 1, payload: '{"content": ' };
    expect(stripForDisplay(bad)).toBe(bad);
  });

  test("live: the table keeps content for resume, stream.active does not carry it", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await t.run(async (ctx) => {
      const owner = await ctx.db.insert("users", { email: "o@t.test" });
      const ws = await ctx.db.insert("workspaces", { name: "WS", ownerId: owner, createdAt: Date.now() });
      await ctx.db.insert("members", { workspaceId: ws, userId: owner, role: "owner", createdAt: Date.now() });
      return { owner, ws };
    });
    const u = t.withIdentity(as(owner));
    const threadId = await u.mutation(api.chat.threads.create, { workspaceId: ws });
    const sent = await u.mutation(api.chat.messages.send, { threadId, content: "hi", clientId: "c1" });
    await drain(t);
    const streamId = sent.streamId as string;
    const mid = sent.assistantMessageId as Id<"chatMessages">;

    await t.mutation(api.chat.ingress.apply, {
      key: SECRET,
      body: {
        op: "event",
        streamId,
        events: [
          { eventId: "e1", seq: 0, type: "TOOL_CALL", v: 1, ts: 1, payload: JSON.stringify({ call_id: "c1", tool: "web_search", arguments: { q: "x" } }) },
          { eventId: "e2", seq: 1, type: "TOOL_RESULT", v: 1, ts: 2, payload: toolResult("c1") },
        ],
      },
    });

    const rows = await t.run(async (ctx) =>
      (await ctx.db.query("chatStreamEvents").collect()).filter((e) => e.messageId === mid),
    );
    const stored = rows.find((e) => e.eventId === "e2");
    expect(JSON.parse(stored?.payload ?? "{}").content).toBe(BIG); // resume source intact

    const live = await u.query(api.chat.stream.active, { threadId });
    expect(live?.hasEvents).toBe(true);
    const liveEvents = await u.query(api.chat.stream.events, { messageId: mid });
    const liveResult = liveEvents?.find((e) => e.eventId === "e2");
    expect(liveResult).toBeDefined();
    expect(JSON.parse(liveResult?.payload ?? "{}").content).toBeUndefined();
    expect(JSON.parse(liveResult?.payload ?? "{}").result).toEqual({ n_results: 3 });
    expect(liveResult?.payload.length).toBeLessThan(200);

    // finalize folds the events onto the message WITHOUT the content
    await t.mutation(api.chat.ingress.apply, {
      key: SECRET,
      body: { op: "finalize", streamId, status: "done", text: "done", usage: {} },
    });
    const msg = await t.run((ctx) => ctx.db.get(mid));
    const folded = (msg?.events ?? []).find((e) => e.eventId === "e2");
    expect(folded).toBeDefined();
    expect(JSON.parse(folded?.payload ?? "{}").content).toBeUndefined();
    expect(JSON.stringify(msg?.events ?? []).length).toBeLessThan(1000);

    const page = await u.query(api.chat.messages.listPaged, {
      threadId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    const pub = page.page.find((m) => m._id === mid);
    expect(JSON.parse(pub?.events.find((e) => e.eventId === "e2")?.payload ?? "{}").content).toBeUndefined();
    await drain(t);
  });

  test("a message folded before the strip existed is stripped when read", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await t.run(async (ctx) => {
      const owner = await ctx.db.insert("users", { email: "o@t.test" });
      const ws = await ctx.db.insert("workspaces", { name: "WS", ownerId: owner, createdAt: Date.now() });
      await ctx.db.insert("members", { workspaceId: ws, userId: owner, role: "owner", createdAt: Date.now() });
      return { owner, ws };
    });
    const u = t.withIdentity(as(owner));
    const threadId = await u.mutation(api.chat.threads.create, { workspaceId: ws });
    const legacy = await t.run(async (ctx) => {
      const now = Date.now();
      return ctx.db.insert("chatMessages", {
        threadId: ctx.db.normalizeId("chatThreads", threadId) as Id<"chatThreads">,
        workspaceId: ws,
        userId: owner,
        role: "assistant",
        seq: 0,
        content: "old answer",
        status: "complete",
        events: [
          { eventId: "L1", seq: 0, type: "TOOL_RESULT", v: 1, ts: 1, payload: toolResult("k") },
        ],
        createdAt: now,
        updatedAt: now,
      });
    });
    const page = await u.query(api.chat.messages.listPaged, {
      threadId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    const pub = page.page.find((m) => m._id === legacy);
    const payload = JSON.parse(pub?.events[0]?.payload ?? "{}");
    expect(payload.content).toBeUndefined();
    expect(payload.result).toEqual({ n_results: 3 });
    // and the stored document itself is untouched by a read
    const doc = await t.run((ctx) => ctx.db.get(legacy));
    expect(JSON.parse(doc?.events?.[0]?.payload ?? "{}").content).toBe(BIG);
  });

  test("afterSeq returns only what is newer — the wire is linear, not quadratic", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await t.run(async (ctx) => {
      const owner = await ctx.db.insert("users", { email: "o2@t.test" });
      const ws = await ctx.db.insert("workspaces", { name: "WS", ownerId: owner, createdAt: Date.now() });
      await ctx.db.insert("members", { workspaceId: ws, userId: owner, role: "owner", createdAt: Date.now() });
      return { owner, ws };
    });
    const u = t.withIdentity(as(owner));
    const threadId = await u.mutation(api.chat.threads.create, { workspaceId: ws });
    const sent = await u.mutation(api.chat.messages.send, { threadId, content: "hi", clientId: "c1" });
    await drain(t);
    const streamId = sent.streamId as string;
    const mid = sent.assistantMessageId as Id<"chatMessages">;

    const append = (seq: number) =>
      t.mutation(api.chat.ingress.apply, {
        key: SECRET,
        body: {
          op: "event",
          streamId,
          events: [
            {
              eventId: `e${seq}`,
              seq,
              type: "TOOL_CALL",
              v: 1,
              ts: seq,
              payload: JSON.stringify({ call_id: `c${seq}`, tool: "web_search", arguments: { q: "x" } }),
            },
          ],
        },
      });

    for (const seq of [0, 1, 2]) await append(seq);

    // No afterSeq: the whole (bounded) timeline, exactly as a fresh subscriber
    // — a mid-stream mount, a reload, a reconnect — must still receive.
    const all = await u.query(api.chat.stream.events, { messageId: mid });
    expect(all?.map((e) => e.seq)).toEqual([0, 1, 2]);

    // Above the high-water mark: only what the client has not seen.
    expect(
      (await u.query(api.chat.stream.events, { messageId: mid, afterSeq: 1 }))?.map((e) => e.seq),
    ).toEqual([2]);

    // Caught up: nothing, and NOT the whole timeline again.
    expect(await u.query(api.chat.stream.events, { messageId: mid, afterSeq: 2 })).toEqual([]);

    // The event appended after that mark is what the next push carries — this
    // is the property that makes swapping afterSeq unable to drop one.
    await append(3);
    expect(
      (await u.query(api.chat.stream.events, { messageId: mid, afterSeq: 2 }))?.map((e) => e.seq),
    ).toEqual([3]);

    // Still owner-scoped with the new arg.
    const other = await t.run((ctx) => ctx.db.insert("users", { email: "x@t.test" }));
    expect(
      await t.withIdentity(as(other)).query(api.chat.stream.events, { messageId: mid, afterSeq: 0 }),
    ).toBeNull();
  });
});
