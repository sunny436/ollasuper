/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

const realFetch = globalThis.fetch;
let fetched: string[] = [];
let stubTitle = "Google OAuth Convex";
let fetchThrows = false;

beforeEach(() => {
  process.env.AI_BASE_URL = "http://ai.invalid:8000";
  process.env.AI_SERVICE_KEY = "test-service-key";
  fetched = [];
  stubTitle = "Google OAuth Convex";
  fetchThrows = false;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched.push(typeof input === "string" ? input : String(input));
    if (fetchThrows) throw new Error("inference plane unreachable");
    return new Response(JSON.stringify({ title: stubTitle }), { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  // biome-ignore lint/performance/noDelete: assigning undefined stores "undefined"
  delete process.env.AI_BASE_URL;
  // biome-ignore lint/performance/noDelete: assigning undefined stores "undefined"
  delete process.env.AI_SERVICE_KEY;
});

async function drain(t: ReturnType<typeof convexTest>) {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

async function seedFirstTurn(
  t: ReturnType<typeof convexTest>,
  opts: { assistantSeq?: number; titleSource?: "auto" | "user"; title?: string } = {},
) {
  const assistantSeq = opts.assistantSeq ?? 1;
  const titleSource = opts.titleSource ?? "auto";
  const title = opts.title ?? "How can I integrate…";
  return t.run(async (ctx) => {
    const now = Date.now();
    const owner = await ctx.db.insert("users", { email: "o@t.test" });
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
      title,
      titleSource,
      status: "active",
      pinned: false,
      model: "anthropic/claude-opus-5",
      nextSeq: assistantSeq + 1,
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
      content: "How can I integrate Google OAuth with Convex?",
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
      seq: assistantSeq,
      content: "",
      status: "streaming",
      parentId: userMsgId,
      variantIndex: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(threadId, { streamingMessageId: asstMsgId });
    const streamId = `stream-${assistantSeq}-${titleSource}`;
    await ctx.db.insert("chatStreams", {
      streamId,
      messageId: asstMsgId,
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
    return { threadId, streamId };
  });
}

describe("auto chat-title", () => {
  test("first-turn success generates + persists an AI title", async () => {
    const t = convexTest(schema, modules);
    const { threadId, streamId } = await seedFirstTurn(t);
    await t.mutation(internal.chat.ingest.finishStream, {
      streamId,
      text: "You configure the Google OAuth client in Convex auth…",
    });
    await drain(t);
    expect(fetched.some((u) => u.endsWith("/v1/title"))).toBe(true);
    const thread = await t.run((ctx) => ctx.db.get(threadId));
    expect(thread?.title).toBe("Google OAuth Convex");
    expect(thread?.titleSource).toBe("auto");
  });

  test(">5-word output is truncated to 5; markdown + quotes stripped", async () => {
    const t = convexTest(schema, modules);
    const { threadId, streamId } = await seedFirstTurn(t);
    await t.mutation(internal.chat.ingest.setTitle, {
      streamId,
      title: '  "**one two three four five six seven**"  ',
    });
    const thread = await t.run((ctx) => ctx.db.get(threadId));
    expect(thread?.title).toBe("one two three four five");
  });

  test("generic titles are rejected — existing title is kept", async () => {
    const t = convexTest(schema, modules);
    const { threadId, streamId } = await seedFirstTurn(t, { title: "Keep me" });
    for (const g of ["New Chat", "Conversation", "Untitled"]) {
      await t.mutation(internal.chat.ingest.setTitle, { streamId, title: g });
    }
    const thread = await t.run((ctx) => ctx.db.get(threadId));
    expect(thread?.title).toBe("Keep me");
  });

  test("manual rename is never overwritten", async () => {
    const t = convexTest(schema, modules);
    const { threadId, streamId } = await seedFirstTurn(t, {
      titleSource: "user",
      title: "My Own Title",
    });
    await t.mutation(internal.chat.ingest.setTitle, {
      streamId,
      title: "AI Wants To Overwrite",
    });
    const thread = await t.run((ctx) => ctx.db.get(threadId));
    expect(thread?.title).toBe("My Own Title");
    expect(thread?.titleSource).toBe("user");
  });

  test("Gemini failure never throws and never changes the title", async () => {
    const t = convexTest(schema, modules);
    fetchThrows = true;
    const { threadId, streamId } = await seedFirstTurn(t, { title: "placeholder" });
    await t.mutation(internal.chat.ingest.finishStream, {
      streamId,
      text: "some answer",
    });
    await drain(t); // must not throw
    const thread = await t.run((ctx) => ctx.db.get(threadId));
    expect(thread?.title).toBe("placeholder");
  });

  test("only the first turn (seq 1) triggers — regenerate (seq 2) does not", async () => {
    const t = convexTest(schema, modules);
    const { threadId, streamId } = await seedFirstTurn(t, {
      assistantSeq: 2,
      title: "placeholder",
    });
    await t.mutation(internal.chat.ingest.finishStream, {
      streamId,
      text: "regenerated answer",
    });
    await drain(t);
    expect(fetched.some((u) => u.endsWith("/v1/title"))).toBe(false);
    const thread = await t.run((ctx) => ctx.db.get(threadId));
    expect(thread?.title).toBe("placeholder");
  });
});
