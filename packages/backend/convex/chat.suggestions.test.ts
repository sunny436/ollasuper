/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

/**
 * Composer follow-up chips.
 *
 * The load-bearing property here is ORDERING, not content. Chips are produced
 * out-of-band on a cheap model after a turn finalizes, so a slow call from an
 * older turn can return after a newer turn has already finished — and it must
 * never win. The other half is that they are composer UI: they must not become
 * conversation, and they must not reach the sidebar.
 */

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

// messages.send schedules a dispatch that POSTs to the Python service. Same
// reasoning as chat.security.test.ts: make it "configured" and keep fetch off
// the network, then drain the scheduler explicitly.
const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.AI_BASE_URL = "http://ai.invalid:8000";
  process.env.AI_SERVICE_KEY = "test-service-key";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ accepted: true }), {
      status: 202,
    })) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.AI_BASE_URL = undefined as unknown as string;
  process.env.AI_SERVICE_KEY = undefined as unknown as string;
});

async function drain(t: ReturnType<typeof convexTest>) {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

type Seed = {
  threadId: Id<"chatThreads">;
  userId: Id<"users">;
  workspaceId: Id<"workspaces">;
};

async function seedThread(t: ReturnType<typeof convexTest>): Promise<Seed> {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "u@t.test" });
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: userId,
      createdAt: Date.now(),
    });
    // requireMember reads this; without it every authed query is Forbidden.
    await ctx.db.insert("members", {
      workspaceId,
      userId,
      role: "owner",
      createdAt: Date.now(),
    });
    const threadId = await ctx.db.insert("chatThreads", {
      userId,
      workspaceId,
      title: "t",
      titleSource: "user",
      status: "active",
      pinned: false,
      model: "m",
      nextSeq: 0,
      messageCount: 0,
      tokensIn: 0,
      tokensOut: 0,
      lastMessageAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { threadId, userId, workspaceId };
  });
}

/** One completed assistant turn at `seq`, with the stream ingress is keyed on. */
async function turn(
  t: ReturnType<typeof convexTest>,
  s: Seed,
  seq: number,
): Promise<string> {
  const streamId = `stream_${seq}_${Math.random().toString(36).slice(2)}`;
  await t.run(async (ctx) => {
    const messageId = await ctx.db.insert("chatMessages", {
      threadId: s.threadId,
      userId: s.userId,
      workspaceId: s.workspaceId,
      role: "assistant",
      content: `answer ${seq}`,
      seq,
      status: "complete",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.insert("chatStreams", {
      streamId,
      messageId,
      threadId: s.threadId,
      workspaceId: s.workspaceId,
      userId: s.userId,
      status: "done",
      cancelRequested: false,
      chunkSeq: 0,
      committedText: `answer ${seq}`,
      committedSeq: 0,
      heartbeatAt: Date.now(),
      startedAt: Date.now(),
    });
  });
  return streamId;
}

const readThread = (t: ReturnType<typeof convexTest>, s: Seed) =>
  t.run(async (ctx) => ctx.db.get(s.threadId));

describe("setSuggestions ordering", () => {
  test("a completed turn's chips land on the thread", async () => {
    const t = convexTest(schema, modules);
    const s = await seedThread(t);
    const streamId = await turn(t, s, 1);

    await t.mutation(internal.chat.ingest.setSuggestions, {
      streamId,
      suggestions: ["Roll back release", "Check logs"],
    });

    const thread = await readThread(t, s);
    expect(thread?.suggestions).toEqual(["Roll back release", "Check logs"]);
    expect(thread?.suggestionsForSeq).toBe(1);
  });

  test("a slow call from an older turn cannot overwrite a newer turn", async () => {
    // THE race this table exists for: turn 1's model call is slow, turn 2
    // finishes first, then turn 1 finally returns.
    const t = convexTest(schema, modules);
    const s = await seedThread(t);
    const first = await turn(t, s, 1);
    const second = await turn(t, s, 2);

    await t.mutation(internal.chat.ingest.setSuggestions, {
      streamId: second,
      suggestions: ["Turn two"],
    });
    await t.mutation(internal.chat.ingest.setSuggestions, {
      streamId: first,
      suggestions: ["Turn one, far too late"],
    });

    const thread = await readThread(t, s);
    expect(thread?.suggestions).toEqual(["Turn two"]);
    expect(thread?.suggestionsForSeq).toBe(2);
  });

  test("a duplicate write for the SAME turn loses to the one already stored", async () => {
    // Why the guard is `>=` and not `>`. A retry that re-sent the op could
    // otherwise clobber the result with a differently-parsed one.
    const t = convexTest(schema, modules);
    const s = await seedThread(t);
    const streamId = await turn(t, s, 1);

    await t.mutation(internal.chat.ingest.setSuggestions, {
      streamId,
      suggestions: ["First"],
    });
    await t.mutation(internal.chat.ingest.setSuggestions, {
      streamId,
      suggestions: ["Second"],
    });

    expect((await readThread(t, s))?.suggestions).toEqual(["First"]);
  });

  test("an empty result CLEARS the previous turn's chips", async () => {
    // The staleness bug: turn 1 suggests, turn 2 is trivial. If a trivial turn
    // wrote nothing, turn 1's chips would reappear when streaming ends.
    const t = convexTest(schema, modules);
    const s = await seedThread(t);
    const first = await turn(t, s, 1);
    const second = await turn(t, s, 2);

    await t.mutation(internal.chat.ingest.setSuggestions, {
      streamId: first,
      suggestions: ["Extend the analysis"],
    });
    await t.mutation(internal.chat.ingest.setSuggestions, {
      streamId: second,
      suggestions: [],
    });

    const thread = await readThread(t, s);
    expect(thread?.suggestions).toEqual([]);
    expect(thread?.suggestionsForSeq).toBe(2);
  });

  test("an unknown stream is a no-op, not a throw", async () => {
    const t = convexTest(schema, modules);
    const res = await t.mutation(internal.chat.ingest.setSuggestions, {
      streamId: "nope",
      suggestions: ["x"],
    });
    expect(res.ok).toBe(false);
  });

  test("chips never become conversation", async () => {
    const t = convexTest(schema, modules);
    const s = await seedThread(t);
    const streamId = await turn(t, s, 1);
    const before = await t.run(async (ctx) =>
      (await ctx.db.query("chatMessages").collect()).length,
    );

    await t.mutation(internal.chat.ingest.setSuggestions, {
      streamId,
      suggestions: ["Roll back release"],
    });

    const after = await t.run(async (ctx) =>
      (await ctx.db.query("chatMessages").collect()).length,
    );
    expect(after).toBe(before);
  });

  test("more than three are capped at the boundary", async () => {
    const t = convexTest(schema, modules);
    const s = await seedThread(t);
    const streamId = await turn(t, s, 1);
    await t.mutation(internal.chat.ingest.setSuggestions, {
      streamId,
      suggestions: ["a", "b", "c", "d", "e"],
    });
    expect((await readThread(t, s))?.suggestions).toHaveLength(3);
  });
});

describe("what the client can see", () => {
  test("threads.get exposes chips and threads.list does not", async () => {
    const t = convexTest(schema, modules);
    const s = await seedThread(t);
    const streamId = await turn(t, s, 1);
    await t.mutation(internal.chat.ingest.setSuggestions, {
      streamId,
      suggestions: ["Roll back release"],
    });

    const u = t.withIdentity(as(s.userId));
    const got = await u.query(api.chat.threads.get, { threadId: s.threadId });
    expect(got?.suggestions).toEqual(["Roll back release"]);

    // toListItem is shared with the sidebar, which has no use for them.
    const listed = await u.query(api.chat.threads.list, {
      workspaceId: s.workspaceId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(listed.page.length).toBeGreaterThan(0);
    for (const row of listed.page as Array<Record<string, unknown>>) {
      expect(row).not.toHaveProperty("suggestions");
    }
  });

  test("sending clears the chips but KEEPS the seq that guards them", async () => {
    // The seq must survive the clear: it is what makes a late write from the
    // previous turn lose, instead of repopulating chips the user moved past.
    const t = convexTest(schema, modules);
    const s = await seedThread(t);
    const streamId = await turn(t, s, 1);
    await t.mutation(internal.chat.ingest.setSuggestions, {
      streamId,
      suggestions: ["Roll back release"],
    });

    const u = t.withIdentity(as(s.userId));
    await u.mutation(api.chat.messages.send, {
      threadId: s.threadId,
      content: "next question",
      clientId: `c-${Math.random()}`,
    });
    await drain(t);

    const thread = await readThread(t, s);
    expect(thread?.suggestions ?? []).toEqual([]);
    expect(thread?.suggestionsForSeq).toBe(1);
  });
});
