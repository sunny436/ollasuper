/**
 * chat/ingress:apply — the hot ingress ops (delta / event / heartbeat /
 * finalize) as a guarded public mutation, byte-for-byte the same results as the
 * HTTP action, gated by the same constant-time secret check.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
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

/** A user, a workspace, a thread with one turn in flight; returns its streamId. */
async function seedTurn(t: ReturnType<typeof convexTest>) {
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
  if (!sent.streamId) throw new Error("no stream");
  return { owner, ws, threadId, streamId: sent.streamId, assistantMessageId: sent.assistantMessageId as Id<"chatMessages"> };
}

const viaHttp = (t: ReturnType<typeof convexTest>, body: unknown, key = SECRET) =>
  t.fetch("/ai/ingress", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ai-key": key },
    body: JSON.stringify(body),
  });

describe("chat/ingress:apply", () => {
  test("a wrong or missing key is refused before anything is read", { timeout: 180_000 }, async () => {
    const t = convexTest(schema, modules);
    const { streamId } = await seedTurn(t);
    await expect(
      t.mutation(api.chat.ingress.apply, { key: "nope", body: { op: "heartbeat", streamId } }),
    ).rejects.toThrow(/unauthorized/);
    await expect(
      t.mutation(api.chat.ingress.apply, { key: "", body: { op: "heartbeat", streamId } }),
    ).rejects.toThrow(/unauthorized/);
    // same-length wrong key: the constant-time compare still refuses it
    await expect(
      t.mutation(api.chat.ingress.apply, { key: SECRET.replace(/.$/, "X"), body: { op: "heartbeat", streamId } }),
    ).rejects.toThrow(/unauthorized/);
  });

  test("delta via the mutation lands exactly like delta via the HTTP action", async () => {
    const t = convexTest(schema, modules);
    const { streamId, assistantMessageId } = await seedTurn(t);

    const m = await t.mutation(api.chat.ingress.apply, {
      key: SECRET,
      body: { op: "delta", streamId, deltas: [{ seq: 0, text: "Hel" }] },
    });
    expect(m.status).toBe(200);
    expect(m.body).toEqual({ ok: true, cancel: false });

    const h = await viaHttp(t, { op: "delta", streamId, deltas: [{ seq: 1, text: "lo" }] });
    expect(h.status).toBe(200);
    expect(await h.json()).toEqual({ ok: true, cancel: false });

    const chunks = await t.run(async (ctx) =>
      (await ctx.db.query("chatStreamChunks").collect())
        .filter((c) => c.messageId === assistantMessageId)
        .sort((a, b) => a.seq - b.seq)
        .map((c) => c.text),
    );
    expect(chunks).toEqual(["Hel", "lo"]);
    await drain(t);
  });

  test("an unknown streamId is 404 on both paths and writes nothing", async () => {
    const t = convexTest(schema, modules);
    await seedTurn(t);
    const m = await t.mutation(api.chat.ingress.apply, {
      key: SECRET,
      body: { op: "delta", streamId: "not-a-stream", deltas: [{ seq: 0, text: "x" }] },
    });
    expect(m.status).toBe(404);
    const h = await viaHttp(t, { op: "delta", streamId: "not-a-stream", deltas: [{ seq: 0, text: "x" }] });
    expect(h.status).toBe(404);
    await drain(t);
  });

  test("heartbeat, event and finalize go through; a non-hot op is refused", async () => {
    const t = convexTest(schema, modules);
    const { streamId, assistantMessageId } = await seedTurn(t);

    const hb = await t.mutation(api.chat.ingress.apply, { key: SECRET, body: { op: "heartbeat", streamId } });
    expect(hb.status).toBe(200);

    const ev = await t.mutation(api.chat.ingress.apply, {
      key: SECRET,
      body: {
        op: "event",
        streamId,
        events: [
          { eventId: "e1", seq: 0, type: "TOOL_CALL", v: 1, ts: 1, payload: JSON.stringify({ call_id: "c", tool: "web_search" }) },
          { eventId: "bad", seq: 1, type: "NOT_A_TYPE", v: 1, ts: 1, payload: "{}" },
        ],
      },
    });
    expect(ev.status).toBe(200);
    const stored = await t.run(async (ctx) =>
      (await ctx.db.query("chatStreamEvents").collect()).filter((e) => e.messageId === assistantMessageId),
    );
    expect(stored.map((e) => e.eventId)).toEqual(["e1"]); // the unknown type was dropped at the edge

    const other = await t.mutation(api.chat.ingress.apply, { key: SECRET, body: { op: "title", streamId, title: "x" } });
    expect(other.status).toBe(400);

    const fin = await t.mutation(api.chat.ingress.apply, {
      key: SECRET,
      body: { op: "finalize", streamId, status: "done", text: "Hello", usage: { promptTokens: 1, completionTokens: 2 } },
    });
    expect(fin.status).toBe(200);
    const msg = await t.run((ctx) => ctx.db.get(assistantMessageId));
    expect(msg?.status).toBe("complete");
    expect(msg?.content).toBe("Hello");
    await drain(t);
  });

  test("the HTTP action still refuses a bad key", async () => {
    const t = convexTest(schema, modules);
    const { streamId } = await seedTurn(t);
    const r = await viaHttp(t, { op: "heartbeat", streamId }, "wrong");
    expect(r.status).toBe(401);
    await drain(t);
  });
});
