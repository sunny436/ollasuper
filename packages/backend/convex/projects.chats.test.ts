/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

const PAGE = { numItems: 50, cursor: null };

/**
 * PHASE 2 — the Project<->chat relationship across the whole chat lifecycle.
 *
 * The point of this file is a NEGATIVE proof. `projectId` lives on the
 * chatThreads row, and every generation path (send / retry / regenerate /
 * editUserMessage / dispatch / resume) obtains that row by reading it rather
 * than reconstructing it — so Project identity should survive all of them with
 * no Project-specific code anywhere in the chat runtime.
 *
 * These tests are what makes that claim checkable instead of merely asserted.
 */

// messages.send schedules internal.chat.stream.dispatch, which POSTs to the
// Python service. Point AI_BASE_URL at a stub and intercept fetch, exactly as
// chat.security.test.ts does, so nothing touches the network and the scheduler
// stays deterministic.
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
  // `process.env.X = undefined` stores the *string* "undefined", which is
  // truthy — the dispatch config guards would then read as configured.
  // biome-ignore lint/performance/noDelete: the only way to actually unset an env var
  delete process.env.AI_BASE_URL;
  // biome-ignore lint/performance/noDelete: the only way to actually unset an env var
  delete process.env.AI_SERVICE_KEY;
});

/**
 * Run scheduled functions to completion inside the test.
 *
 * runAfter(0, ...) is queued on a macrotask and
 * finishInProgressScheduledFunctions only awaits functions that have already
 * STARTED, so the event loop has to be yielded first — otherwise the dispatch
 * action outlives the test transaction and surfaces as an unhandled
 * "Write outside of transaction".
 */
async function drain(t: ReturnType<typeof convexTest>) {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

async function seed(t: ReturnType<typeof convexTest>) {
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
    return { userId, workspaceId };
  });
}

/**
 * Land an in-flight turn so the next one is allowed to start.
 *
 * Clears the thread's streamingMessageId (assertCanGenerate refuses a second
 * concurrent turn) AND retires the stream row — MAX_CONCURRENT_STREAMS is 3,
 * counted across queued+running, so a test doing send→regenerate→retry would
 * otherwise trip the cap on its third turn.
 */
async function settle(
  t: ReturnType<typeof convexTest>,
  threadId: Id<"chatThreads">,
  assistant?: { messageId: Id<"chatMessages">; status: "complete" | "error" },
) {
  await t.run(async (ctx) => {
    await ctx.db.patch(threadId, { streamingMessageId: undefined });
    // chatStreams has no by_thread index (by_streamId / by_message /
    // by_status_heartbeat / by_user_status only), and a test-scale scan is fine.
    const all = await ctx.db.query("chatStreams").collect();
    const streams = all.filter((s) => s.threadId === threadId);
    for (const s of streams) {
      if (s.status === "queued" || s.status === "running") {
        await ctx.db.patch(s._id, { status: "done" });
      }
    }
    if (assistant) {
      await ctx.db.patch(assistant.messageId, { status: assistant.status });
    }
  });
}

/**
 * Read a thread's projectId.
 *
 * The field is read OUTSIDE t.run deliberately: a bare `undefined` returned as
 * the top-level value of t.run comes back as `null`, which would make an
 * "is it still unassigned?" assertion pass or fail for the wrong reason.
 */
async function projectIdOf(
  t: ReturnType<typeof convexTest>,
  id: Id<"chatThreads">,
) {
  const row = await t.run(async (ctx) => ctx.db.get(id));
  return row?.projectId;
}

describe("project identity survives the whole generation lifecycle", () => {
  test("send, regenerate, retry and editUserMessage all preserve projectId", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "Durable",
    });
    const threadId = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
      projectId,
    });

    // --- send
    const sent = await asUser.mutation(api.chat.messages.send, {
      threadId,
      content: "first",
      clientId: "c1",
    });
    await drain(t);
    expect(await projectIdOf(t, threadId)).toBe(projectId);
    await settle(t, threadId, {
      messageId: sent.assistantMessageId as Id<"chatMessages">,
      status: "complete",
    });

    // --- regenerate (new variant of the latest assistant reply)
    const regen = await asUser.mutation(api.chat.messages.regenerate, {
      messageId: sent.assistantMessageId as Id<"chatMessages">,
    });
    await drain(t);
    expect(await projectIdOf(t, threadId)).toBe(projectId);
    await settle(t, threadId, {
      messageId: regen.assistantMessageId,
      status: "error",
    });

    // --- retry (in place, no new variant)
    await asUser.mutation(api.chat.messages.retry, {
      messageId: regen.assistantMessageId,
    });
    await drain(t);
    expect(await projectIdOf(t, threadId)).toBe(projectId);
    await settle(t, threadId, {
      messageId: regen.assistantMessageId,
      status: "complete",
    });

    // --- editUserMessage (truncates and resends — the one path that rewrites
    //     message history, so the most likely place to lose the association)
    await asUser.mutation(api.chat.messages.editUserMessage, {
      messageId: sent.userMessageId,
      content: "first, edited",
      clientId: "c2",
    });
    await drain(t);
    expect(await projectIdOf(t, threadId)).toBe(projectId);

    // Still listed under its Project after all of it.
    const chats = await asUser.query(api.projects.listThreads, {
      projectId,
      paginationOpts: PAGE,
    });
    expect(chats.page.map((c) => c._id)).toEqual([threadId]);
  });

  test("projectId survives archive/restore and trash/restore", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "Cycled",
    });
    const threadId = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
      projectId,
    });

    await asUser.mutation(api.chat.threads.archive, {
      threadId,
      archived: true,
    });
    expect(await projectIdOf(t, threadId)).toBe(projectId);
    await asUser.mutation(api.chat.threads.archive, {
      threadId,
      archived: false,
    });
    expect(await projectIdOf(t, threadId)).toBe(projectId);

    await asUser.mutation(api.chat.threads.remove, { threadId });
    expect(await projectIdOf(t, threadId)).toBe(projectId);
    await asUser.mutation(api.chat.threads.restore, { threadId });
    expect(await projectIdOf(t, threadId)).toBe(projectId);

    // Restore returns it to its OWN project, never to some other one.
    const chats = await asUser.query(api.projects.listThreads, {
      projectId,
      paginationOpts: PAGE,
    });
    expect(chats.page.map((c) => c._id)).toEqual([threadId]);
    await drain(t);
  });

  test("an unassigned chat never silently acquires a project", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    // A project exists and is the user's own — the tempting thing to leak in.
    await asUser.mutation(api.projects.create, { workspaceId, name: "Nearby" });

    const threadId = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
    });
    const sent = await asUser.mutation(api.chat.messages.send, {
      threadId,
      content: "hello",
      clientId: "u1",
    });
    await drain(t);
    await settle(t, threadId, {
      messageId: sent.assistantMessageId as Id<"chatMessages">,
      status: "error",
    });
    await asUser.mutation(api.chat.messages.retry, {
      messageId: sent.assistantMessageId as Id<"chatMessages">,
    });
    await drain(t);

    expect(await projectIdOf(t, threadId)).toBeUndefined();
    const thread = await asUser.query(api.chat.threads.get, { threadId });
    expect(thread?.project).toBeNull();
  });
});

describe("dispatch is project-agnostic", () => {
  test("dispatchPayload has the same key set for a project and an ordinary chat", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "Payload",
    });
    const inProject = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
      projectId,
    });
    const loose = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
    });

    const a = await asUser.mutation(api.chat.messages.send, {
      threadId: inProject,
      content: "p",
      clientId: "p1",
    });
    const b = await asUser.mutation(api.chat.messages.send, {
      threadId: loose,
      content: "l",
      clientId: "l1",
    });
    await drain(t);

    const pa = await t.query(internal.chat.stream.dispatchPayload, {
      streamId: a.streamId as string,
    });
    const pb = await t.query(internal.chat.stream.dispatchPayload, {
      streamId: b.streamId as string,
    });

    expect(pa).not.toBeNull();
    expect(pb).not.toBeNull();
    // Key SET, not deep equality — ids and text legitimately differ. This is
    // the executable proof that no project value reaches the Python contract,
    // so Phase 2 needs no GenerateRequest change and no Python change at all.
    expect(Object.keys(pa as object).sort()).toEqual(
      Object.keys(pb as object).sort(),
    );
    expect(JSON.stringify(pa)).not.toContain(projectId);
  });
});

describe("threads.list — project chats leave the rail", () => {
  test("unassignedOnly excludes project chats; without it both are returned", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "Rail",
    });
    const inProject = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
      projectId,
    });
    const loose = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
    });

    // The conversation rail.
    const rail = await asUser.query(api.chat.threads.list, {
      workspaceId,
      unassignedOnly: true,
      paginationOpts: PAGE,
    });
    expect(rail.page.map((c) => c._id)).toEqual([loose]);

    // Settings -> Archived Chats deliberately does NOT pass the flag, so a
    // project chat stays reachable there rather than being stranded.
    const all = await asUser.query(api.chat.threads.list, {
      workspaceId,
      paginationOpts: PAGE,
    });
    expect(all.page.map((c) => c._id).sort()).toEqual(
      [inProject, loose].sort(),
    );
  });

  test("withProject labels rows so a restore is not a mystery", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "Labelled",
    });
    const inProject = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
      projectId,
    });
    await asUser.mutation(api.chat.threads.create, { workspaceId });
    await asUser.mutation(api.chat.threads.archive, {
      threadId: inProject,
      archived: true,
    });

    const archived = await asUser.query(api.chat.threads.list, {
      workspaceId,
      status: "archived",
      withProject: true,
      paginationOpts: PAGE,
    });
    expect(archived.page).toHaveLength(1);
    expect(archived.page[0]?.project?.name).toBe("Labelled");

    // Off by default: the rail pays no read cost for a label it never shows.
    const rail = await asUser.query(api.chat.threads.list, {
      workspaceId,
      unassignedOnly: true,
      paginationOpts: PAGE,
    });
    expect(rail.page[0]?.project).toBeNull();
  });

  test("unassignedOnly still respects status and stays paginated", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const ids: Id<"chatThreads">[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        await asUser.mutation(api.chat.threads.create, { workspaceId }),
      );
    }
    await asUser.mutation(api.chat.threads.archive, {
      threadId: ids[0] as Id<"chatThreads">,
      archived: true,
    });

    const first = await asUser.query(api.chat.threads.list, {
      workspaceId,
      unassignedOnly: true,
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);

    const archived = await asUser.query(api.chat.threads.list, {
      workspaceId,
      status: "archived",
      unassignedOnly: true,
      paginationOpts: PAGE,
    });
    expect(archived.page.map((c) => c._id)).toEqual([ids[0]]);
  });
});

describe("moveThread", () => {
  test("all three transitions, preserving thread identity and history", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const a = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "A",
    });
    const b = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "B",
    });

    const threadId = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
    });
    const sent = await asUser.mutation(api.chat.messages.send, {
      threadId,
      content: "keep me",
      clientId: "m1",
    });
    await drain(t);
    await settle(t, threadId, {
      messageId: sent.assistantMessageId as Id<"chatMessages">,
      status: "complete",
    });

    const before = await t.run(async (ctx) => {
      const thread = await ctx.db.get(threadId);
      const messages = await ctx.db
        .query("chatMessages")
        .withIndex("by_thread_seq", (q) => q.eq("threadId", threadId))
        .collect();
      return {
        id: thread?._id,
        nextSeq: thread?.nextSeq,
        model: thread?.model,
        messageIds: messages.map((m) => m._id),
        contents: messages.map((m) => m.content),
      };
    });

    // unassigned -> A
    await asUser.mutation(api.projects.moveThread, { threadId, projectId: a });
    expect(await projectIdOf(t, threadId)).toBe(a);

    // A -> B
    await asUser.mutation(api.projects.moveThread, { threadId, projectId: b });
    expect(await projectIdOf(t, threadId)).toBe(b);
    const inA = await asUser.query(api.projects.listThreads, {
      projectId: a,
      paginationOpts: PAGE,
    });
    expect(inA.page).toEqual([]);

    // B -> unassigned
    await asUser.mutation(api.projects.moveThread, {
      threadId,
      projectId: null,
    });
    expect(await projectIdOf(t, threadId)).toBeUndefined();

    // A move rewrites the relationship and NOTHING else.
    const after = await t.run(async (ctx) => {
      const thread = await ctx.db.get(threadId);
      const messages = await ctx.db
        .query("chatMessages")
        .withIndex("by_thread_seq", (q) => q.eq("threadId", threadId))
        .collect();
      return {
        id: thread?._id,
        nextSeq: thread?.nextSeq,
        model: thread?.model,
        messageIds: messages.map((m) => m._id),
        contents: messages.map((m) => m.content),
      };
    });
    expect(after).toEqual(before);
  });

  test("moving to the project it is already in is a no-op", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "Same",
    });
    const threadId = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
      projectId,
    });
    const before = (await t.run(async (ctx) => ctx.db.get(threadId)))
      ?.updatedAt;

    await asUser.mutation(api.projects.moveThread, { threadId, projectId });

    // updatedAt untouched: a no-op must not jump the chat to the top of both
    // lists.
    expect(
      (await t.run(async (ctx) => ctx.db.get(threadId)))?.updatedAt,
    ).toBe(before);
  });

  test("a chat can always be pulled OUT of an archived project", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "Shut down",
    });
    const threadId = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
      projectId,
    });
    await asUser.mutation(api.projects.archive, { projectId, archived: true });

    // Only the TARGET is validated, so removal is always available. Without
    // this the chat would be locked inside a project the user archived.
    await asUser.mutation(api.projects.moveThread, {
      threadId,
      projectId: null,
    });
    expect(await projectIdOf(t, threadId)).toBeUndefined();

    // ...but it cannot be moved back INTO the archived project.
    await expect(
      asUser.mutation(api.projects.moveThread, { threadId, projectId }),
    ).rejects.toThrow(/archived/i);
  });

  test("an archived chat can be moved; a trashed one cannot", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "Target",
    });
    const archived = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
    });
    const trashed = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
    });

    await asUser.mutation(api.chat.threads.archive, {
      threadId: archived,
      archived: true,
    });
    await asUser.mutation(api.projects.moveThread, {
      threadId: archived,
      projectId,
    });
    expect(await projectIdOf(t, archived)).toBe(projectId);

    await asUser.mutation(api.chat.threads.remove, { threadId: trashed });
    await expect(
      asUser.mutation(api.projects.moveThread, {
        threadId: trashed,
        projectId,
      }),
    ).rejects.toThrow(/Not found/);
    await drain(t);
  });

  test("a mid-generation chat cannot be moved", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "Busy",
    });
    const threadId = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
    });
    await asUser.mutation(api.chat.messages.send, {
      threadId,
      content: "streaming",
      clientId: "s1",
    });
    await drain(t);

    // Harmless today, but Phase 3 puts project-derived retrieval scope INTO
    // dispatchPayload — at which point a mid-flight move would change what the
    // model can see partway through its own answer.
    await expect(
      asUser.mutation(api.projects.moveThread, { threadId, projectId }),
    ).rejects.toThrow(/already generating/i);
    expect(await projectIdOf(t, threadId)).toBeUndefined();
  });

  test("a scheduled execution thread is not movable", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "Nope",
    });
    // Fabricated directly: no public path creates one, and it must stay an
    // internal history mechanism rather than becoming a conversation.
    const hidden = await t.run(async (ctx) => {
      const now = Date.now();
      return ctx.db.insert("chatThreads", {
        workspaceId,
        userId,
        title: "Nightly",
        titleSource: "user",
        status: "scheduled",
        pinned: false,
        model: "deepseek-v4-flash",
        nextSeq: 0,
        messageCount: 0,
        tokensIn: 0,
        tokensOut: 0,
        lastMessageAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });

    await expect(
      asUser.mutation(api.projects.moveThread, {
        threadId: hidden,
        projectId,
      }),
    ).rejects.toThrow(/Not found/);
  });
});

describe("moveThread security", () => {
  async function seedTwo(t: ReturnType<typeof convexTest>) {
    return t.run(async (ctx) => {
      const alice = await ctx.db.insert("users", { email: "a@t.test" });
      const bob = await ctx.db.insert("users", { email: "b@t.test" });
      const workspaceId = await ctx.db.insert("workspaces", {
        name: "Shared",
        ownerId: alice,
        createdAt: Date.now(),
      });
      for (const [userId, role] of [
        [alice, "owner"],
        [bob, "member"],
      ] as const) {
        await ctx.db.insert("members", {
          workspaceId,
          userId,
          role,
          createdAt: Date.now(),
        });
      }
      return { alice, bob, workspaceId };
    });
  }

  test("a user cannot move their own thread into someone else's project", async () => {
    const t = convexTest(schema, modules);
    const { alice, bob, workspaceId } = await seedTwo(t);

    const aliceProject = await t
      .withIdentity(as(alice))
      .mutation(api.projects.create, { workspaceId, name: "Alice only" });
    const bobThread = await t
      .withIdentity(as(bob))
      .mutation(api.chat.threads.create, { workspaceId });

    // Bob is a legitimate member of the same workspace and still gets the
    // non-committal error — the message must not confirm the project exists.
    await expect(
      t.withIdentity(as(bob)).mutation(api.projects.moveThread, {
        threadId: bobThread,
        projectId: aliceProject,
      }),
    ).rejects.toThrow(/Not found/);
    expect(await projectIdOf(t, bobThread)).toBeUndefined();
  });

  test("a user cannot move someone else's thread into their own project", async () => {
    const t = convexTest(schema, modules);
    const { alice, bob, workspaceId } = await seedTwo(t);

    const bobProject = await t
      .withIdentity(as(bob))
      .mutation(api.projects.create, { workspaceId, name: "Bob only" });
    const aliceThread = await t
      .withIdentity(as(alice))
      .mutation(api.chat.threads.create, { workspaceId });

    await expect(
      t.withIdentity(as(bob)).mutation(api.projects.moveThread, {
        threadId: aliceThread,
        projectId: bobProject,
      }),
    ).rejects.toThrow(/Not found/);
    expect(await projectIdOf(t, aliceThread)).toBeUndefined();
  });

  test("a thread cannot be moved into a project in another workspace", async () => {
    const t = convexTest(schema, modules);
    const { alice, workspaceId: wsA } = await seedTwo(t);

    // Alice legitimately owns BOTH sides — only the workspace mismatch makes
    // this illegal, which is what makes it a real test of the invariant.
    const wsB = await t.run(async (ctx) => {
      const id = await ctx.db.insert("workspaces", {
        name: "Second",
        ownerId: alice,
        createdAt: Date.now(),
      });
      await ctx.db.insert("members", {
        workspaceId: id,
        userId: alice,
        role: "owner",
        createdAt: Date.now(),
      });
      return id;
    });

    const projectInB = await t
      .withIdentity(as(alice))
      .mutation(api.projects.create, { workspaceId: wsB, name: "In B" });
    const threadInA = await t
      .withIdentity(as(alice))
      .mutation(api.chat.threads.create, { workspaceId: wsA });

    await expect(
      t.withIdentity(as(alice)).mutation(api.projects.moveThread, {
        threadId: threadInA,
        projectId: projectInB,
      }),
    ).rejects.toThrow(/Not found/);
    expect(await projectIdOf(t, threadInA)).toBeUndefined();
  });

  test("a signed-out caller cannot move anything", async () => {
    const t = convexTest(schema, modules);
    const { alice, workspaceId } = await seedTwo(t);
    const projectId = await t
      .withIdentity(as(alice))
      .mutation(api.projects.create, { workspaceId, name: "P" });
    const threadId = await t
      .withIdentity(as(alice))
      .mutation(api.chat.threads.create, { workspaceId });

    await expect(
      t.mutation(api.projects.moveThread, { threadId, projectId }),
    ).rejects.toThrow(/Not authenticated/);
  });

  test("a peer cannot see another user's project chats through the rail query", async () => {
    const t = convexTest(schema, modules);
    const { alice, bob, workspaceId } = await seedTwo(t);

    const projectId = await t
      .withIdentity(as(alice))
      .mutation(api.projects.create, { workspaceId, name: "Alice" });
    await t
      .withIdentity(as(alice))
      .mutation(api.chat.threads.create, { workspaceId, projectId });

    for (const args of [
      { workspaceId, unassignedOnly: true, paginationOpts: PAGE },
      { workspaceId, withProject: true, paginationOpts: PAGE },
      { workspaceId, paginationOpts: PAGE },
    ]) {
      const res = await t
        .withIdentity(as(bob))
        .query(api.chat.threads.list, args);
      expect(res.page).toEqual([]);
    }
  });
});
