/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

/**
 * PHASE 4 — Project instructions reaching the runtime.
 *
 * They are DYNAMIC: read fresh from the Project row on every dispatch, never
 * snapshotted onto a thread the way thread.systemPrompt snapshots account
 * settings at creation. Editing a Project's instructions therefore changes the
 * next turn of every chat inside it, including conversations that already
 * exist — which is the whole point of instructions belonging to the container.
 */

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
  // biome-ignore lint/performance/noDelete: the only way to actually unset an env var
  delete process.env.AI_BASE_URL;
  // biome-ignore lint/performance/noDelete: the only way to actually unset an env var
  delete process.env.AI_SERVICE_KEY;
});

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

/** Send a turn and return what dispatchPayload would hand the inference plane. */
async function payloadFor(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  threadId: Id<"chatThreads">,
  clientId: string,
) {
  const sent = await t
    .withIdentity(as(userId))
    .mutation(api.chat.messages.send, {
      threadId,
      content: "hello",
      clientId,
    });
  await drain(t);
  const payload = await t.query(internal.chat.stream.dispatchPayload, {
    streamId: sent.streamId as string,
  });
  // Land the turn so the next send is allowed.
  await t.run(async (ctx) => {
    await ctx.db.patch(threadId, { streamingMessageId: undefined });
    const streams = (await ctx.db.query("chatStreams").collect()).filter(
      (s) => s.threadId === threadId,
    );
    for (const s of streams) {
      if (s.status === "queued" || s.status === "running") {
        await ctx.db.patch(s._id, { status: "done" });
      }
    }
  });
  return payload;
}

describe("project instructions reach dispatch", () => {
  test("an ordinary chat sends null", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const threadId = await t
      .withIdentity(as(userId))
      .mutation(api.chat.threads.create, { workspaceId });

    const payload = await payloadFor(t, userId, threadId, "c1");
    expect(payload?.projectInstructions).toBeNull();
  });

  test("a project chat carries its instructions", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));
    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "P",
      instructions: "Always answer in British English.",
    });
    const threadId = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
      projectId,
    });

    const payload = await payloadFor(t, userId, threadId, "c1");
    expect(payload?.projectInstructions).toBe(
      "Always answer in British English.",
    );
  });

  test("a project with no instructions sends null, not an empty string", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));
    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "P",
    });
    const threadId = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
      projectId,
    });

    const payload = await payloadFor(t, userId, threadId, "c1");
    expect(payload?.projectInstructions).toBeNull();
  });

  test("DYNAMIC: editing instructions changes the next turn of an EXISTING chat", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));
    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "P",
      instructions: "Instruction A.",
    });
    const threadId = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
      projectId,
    });

    const first = await payloadFor(t, userId, threadId, "c1");
    expect(first?.projectInstructions).toBe("Instruction A.");

    await asUser.mutation(api.projects.setInstructions, {
      projectId,
      instructions: "Instruction B.",
    });

    // The SAME conversation, continued. Nothing was snapshotted onto the
    // thread, so the edit takes effect immediately rather than only for chats
    // created afterwards.
    const second = await payloadFor(t, userId, threadId, "c2");
    expect(second?.projectInstructions).toBe("Instruction B.");
  });

  test("clearing instructions removes them from the next turn", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));
    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "P",
      instructions: "Temporary.",
    });
    const threadId = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
      projectId,
    });
    expect((await payloadFor(t, userId, threadId, "c1"))?.projectInstructions).toBe(
      "Temporary.",
    );

    await asUser.mutation(api.projects.setInstructions, {
      projectId,
      instructions: null,
    });
    expect(
      (await payloadFor(t, userId, threadId, "c2"))?.projectInstructions,
    ).toBeNull();
  });

  test("an archived project's chats keep their instructions", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));
    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "P",
      instructions: "Still applies.",
    });
    const threadId = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
      projectId,
    });
    await asUser.mutation(api.projects.archive, { projectId, archived: true });

    // Archive hides a Project; it does not silently change how its existing
    // conversations behave.
    const payload = await payloadFor(t, userId, threadId, "c1");
    expect(payload?.projectInstructions).toBe("Still applies.");
  });
});

describe("instruction authorization", () => {
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

  test("a same-workspace peer can neither read nor write another user's instructions", async () => {
    const t = convexTest(schema, modules);
    const { alice, bob, workspaceId } = await seedTwo(t);

    const projectId = await t
      .withIdentity(as(alice))
      .mutation(api.projects.create, {
        workspaceId,
        name: "Alice",
        instructions: "Private working agreement.",
      });

    const asBob = t.withIdentity(as(bob));
    expect(await asBob.query(api.projects.get, { projectId })).toBeNull();
    await expect(
      asBob.mutation(api.projects.setInstructions, {
        projectId,
        instructions: "hijacked",
      }),
    ).rejects.toThrow(/Not found/);

    // Unchanged.
    const still = await t
      .withIdentity(as(alice))
      .query(api.projects.get, { projectId });
    expect(still?.instructions).toBe("Private working agreement.");
  });

  test("a signed-out caller cannot set instructions", async () => {
    const t = convexTest(schema, modules);
    const { alice, workspaceId } = await seedTwo(t);
    const projectId = await t
      .withIdentity(as(alice))
      .mutation(api.projects.create, { workspaceId, name: "P" });

    await expect(
      t.mutation(api.projects.setInstructions, {
        projectId,
        instructions: "anon",
      }),
    ).rejects.toThrow(/Not authenticated/);
  });

  test("oversized instructions are bounded at the write boundary", async () => {
    const t = convexTest(schema, modules);
    const { alice, workspaceId } = await seedTwo(t);
    const asAlice = t.withIdentity(as(alice));
    const projectId = await asAlice.mutation(api.projects.create, {
      workspaceId,
      name: "P",
    });

    await asAlice.mutation(api.projects.setInstructions, {
      projectId,
      instructions: "x".repeat(50_000),
    });
    const stored = await asAlice.query(api.projects.get, { projectId });
    // Convex caps on write; the runtime has its own backstop. A Project must
    // not be able to spend the whole context window.
    expect(stored?.instructions?.length).toBe(8000);
  });

  test("instructions never leak through a thread in another user's chat", async () => {
    const t = convexTest(schema, modules);
    const { alice, bob, workspaceId } = await seedTwo(t);

    // Force the inconsistent state directly: Bob owns the thread, Alice owns
    // the Project. No public path produces this, which is exactly why
    // dispatchPayload re-checks ownership on the project row.
    const aliceProject = await t
      .withIdentity(as(alice))
      .mutation(api.projects.create, {
        workspaceId,
        name: "Alice",
        instructions: "SECRET working agreement.",
      });
    const bobThread = await t
      .withIdentity(as(bob))
      .mutation(api.chat.threads.create, { workspaceId });
    await t.run(async (ctx) => {
      await ctx.db.patch(bobThread, { projectId: aliceProject });
    });

    const payload = await payloadFor(t, bob, bobThread, "c1");
    expect(payload?.projectInstructions).toBeNull();
    expect(JSON.stringify(payload)).not.toContain("SECRET working agreement.");
  });
});
