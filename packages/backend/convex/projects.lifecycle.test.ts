/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });
type TestT = ReturnType<typeof convexTest>;
const PAGE = { numItems: 50, cursor: null };

const DAILY = {
  kind: "daily" as const,
  timezone: "UTC",
  hour: 9,
  minute: 0,
};

/**
 * PHASE 6 — the Project lifecycle, and the cascade that had never existed.
 *
 * Two properties matter more than the rest.
 *
 * DELETE IS RECOVERABLE. chat/threads.ts schedules its purge with runAfter(0),
 * which makes a "trashed" thread gone at once and its restore a race. A Project
 * deliberately does NOT do that — it waits out the TTL — so these tests assert
 * that trashing leaves the row and its dependents intact.
 *
 * DELETING A CONTAINER DOES NOT DELETE THE WORK. The purge unassigns chats and
 * drops file EDGES; it never destroys a conversation, a userFiles row, or a
 * blob that another Project may still reference.
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

async function drain(t: TestT) {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

async function seed(t: TestT) {
  const { userId, ws } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "u@t.test" });
    const ws = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: userId,
      createdAt: Date.now(),
    });
    await ctx.db.insert("members", {
      workspaceId: ws,
      userId,
      role: "owner",
      createdAt: Date.now(),
    });
    return { userId, ws };
  });
  return { userId, ws, u: t.withIdentity(as(userId)) };
}

async function seedFile(
  t: TestT,
  userId: Id<"users">,
  ws: Id<"workspaces">,
  ingestId: string,
) {
  return t.run(async (ctx) => {
    const now = Date.now();
    return ctx.db.insert("userFiles", {
      userId,
      workspaceId: ws,
      name: `${ingestId}.pdf`,
      size: 10,
      contentType: "application/pdf",
      ingestId,
      status: "ready",
      attempts: 0,
      contentHash: ingestId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

const projectRow = (t: TestT, id: Id<"projects">) =>
  t.run(async (ctx) => ctx.db.get(id));

describe("trash blocks new work but destroys nothing", () => {
  test("a trashed project refuses chats, file links and tasks", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const projectId = await u.mutation(api.projects.create, {
      workspaceId: ws,
      name: "P",
    });
    const fileId = await seedFile(t, userId, ws, "ing-1");

    await u.mutation(api.projects.remove, { projectId });

    await expect(
      u.mutation(api.chat.threads.create, { workspaceId: ws, projectId }),
    ).rejects.toThrow(/archived or deleted/i);
    await expect(
      u.mutation(api.projects.linkFile, { projectId, fileId }),
    ).rejects.toThrow(/archived or deleted/i);
    await expect(
      u.mutation(api.scheduled.tasks.create, {
        workspaceId: ws,
        title: "T",
        prompt: "p",
        spec: DAILY,
        projectId,
      }),
    ).rejects.toThrow(/archived or deleted/i);
  });

  test("the row and its dependents SURVIVE the trash — delete is recoverable", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const projectId = await u.mutation(api.projects.create, {
      workspaceId: ws,
      name: "P",
    });
    const fileId = await seedFile(t, userId, ws, "ing-1");
    await u.mutation(api.projects.linkFile, { projectId, fileId });
    const threadId = await u.mutation(api.chat.threads.create, {
      workspaceId: ws,
      projectId,
    });

    await u.mutation(api.projects.remove, { projectId });
    await drain(t);

    // No runAfter(0, purge): unlike threads, the row waits out the TTL. If this
    // ever regresses, "recoverable for 30 days" becomes a lie in the UI.
    const row = await projectRow(t, projectId);
    expect(row?.status).toBe("trashed");
    expect(row?.trashedAt).toBeGreaterThan(0);
    expect(
      await t.run(async (ctx) => (await ctx.db.get(threadId))?.projectId),
    ).toBe(projectId);
    expect(
      await t.run(async (ctx) => ctx.db.query("projectFiles").collect()),
    ).toHaveLength(1);
  });

  test("trash PAUSES scheduled tasks rather than cancelling them", async () => {
    const t = convexTest(schema, modules);
    const { ws, u } = await seed(t);
    const projectId = await u.mutation(api.projects.create, {
      workspaceId: ws,
      name: "P",
    });
    const taskId = await u.mutation(api.scheduled.tasks.create, {
      workspaceId: ws,
      title: "T",
      prompt: "p",
      spec: DAILY,
      projectId,
    });

    await u.mutation(api.projects.remove, { projectId });
    // Paused, not deleted: work already created stays durable and suppressed,
    // so a restore is not preceded by data loss.
    expect(await t.run(async (ctx) => (await ctx.db.get(taskId))?.status)).toBe(
      "paused",
    );
  });

  test("archive cannot resurrect a trashed project", async () => {
    const t = convexTest(schema, modules);
    const { ws, u } = await seed(t);
    const projectId = await u.mutation(api.projects.create, {
      workspaceId: ws,
      name: "P",
    });
    await u.mutation(api.projects.remove, { projectId });

    // Without the guard this set status back to "active" while LEAVING
    // trashedAt set — an undocumented restore producing a row the purge cron
    // still believes is deleted.
    await expect(
      u.mutation(api.projects.archive, { projectId, archived: false }),
    ).rejects.toThrow(/deleted/i);
    expect((await projectRow(t, projectId))?.status).toBe("trashed");
  });

  test("restore reverses the trash and leaves tasks paused", async () => {
    const t = convexTest(schema, modules);
    const { ws, u } = await seed(t);
    const projectId = await u.mutation(api.projects.create, {
      workspaceId: ws,
      name: "P",
    });
    const taskId = await u.mutation(api.scheduled.tasks.create, {
      workspaceId: ws,
      title: "T",
      prompt: "p",
      spec: DAILY,
      projectId,
    });
    await u.mutation(api.projects.remove, { projectId });
    await u.mutation(api.projects.restore, { projectId });

    const row = await projectRow(t, projectId);
    expect(row?.status).toBe("active");
    expect(row?.trashedAt).toBeUndefined();
    // Deliberately still paused: silently resuming unattended work the user
    // believed was gone would be a worse surprise than an explicit Resume.
    expect(await t.run(async (ctx) => (await ctx.db.get(taskId))?.status)).toBe(
      "paused",
    );
    // And it accepts work again.
    expect(
      await u.mutation(api.chat.threads.create, { workspaceId: ws, projectId }),
    ).toBeDefined();
  });

  test("a trashed project leaves the default list but is findable under Trashed", async () => {
    const t = convexTest(schema, modules);
    const { ws, u } = await seed(t);
    const projectId = await u.mutation(api.projects.create, {
      workspaceId: ws,
      name: "P",
    });
    await u.mutation(api.projects.remove, { projectId });

    const active = await u.query(api.projects.list, {
      workspaceId: ws,
      paginationOpts: PAGE,
    });
    expect(active.page).toEqual([]);

    const trashed = await u.query(api.projects.list, {
      workspaceId: ws,
      status: "trashed",
      paginationOpts: PAGE,
    });
    expect(trashed.page.map((p) => p._id)).toEqual([projectId]);
  });
});

describe("a trashed project contributes no context, immediately", () => {
  test("instructions, memory and RAG scope all stop at trash time", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const projectId = await u.mutation(api.projects.create, {
      workspaceId: ws,
      name: "P",
      instructions: "Project voice.",
    });
    const fileId = await seedFile(t, userId, ws, "ing-1");
    await u.mutation(api.projects.linkFile, { projectId, fileId });
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("userMemories", {
        userId,
        workspaceId: ws,
        kind: "fact",
        content: "project fact",
        source: "explicit",
        scope: "project",
        projectId,
        status: "active",
        normalizedKey: "project fact",
        createdAt: now,
        updatedAt: now,
      });
    });

    const threadId = await u.mutation(api.chat.threads.create, {
      workspaceId: ws,
      projectId,
    });
    const first = await u.mutation(api.chat.messages.send, {
      threadId,
      content: "one",
      clientId: "c1",
    });
    await drain(t);
    const before = await t.query(internal.chat.stream.dispatchPayload, {
      streamId: first.streamId as string,
    });
    expect(before?.projectInstructions).toBe("Project voice.");
    expect(before?.ragFileIds).toEqual(["ing-1"]);
    expect(before?.memories?.map((m) => m.content)).toContain("project fact");

    // Delete. The chat is still assigned (the purge is 30 days away) but the
    // Project must stop speaking into it at once — otherwise a "deleted"
    // Project keeps steering conversations for the whole retention window.
    await u.mutation(api.projects.remove, { projectId });
    await t.run(async (ctx) => {
      await ctx.db.patch(threadId, { streamingMessageId: undefined });
      for (const s of await ctx.db.query("chatStreams").collect()) {
        if (s.status === "queued" || s.status === "running") {
          await ctx.db.patch(s._id, { status: "done" });
        }
      }
    });

    const second = await u.mutation(api.chat.messages.send, {
      threadId,
      content: "two",
      clientId: "c2",
    });
    await drain(t);
    const after = await t.query(internal.chat.stream.dispatchPayload, {
      streamId: second.streamId as string,
    });
    expect(after?.projectInstructions).toBeNull();
    // The chat behaves as an ordinary chat, which is what it will permanently
    // become once the purge unassigns it: the account scope, spelled out.
    expect(after?.ragFileIds).not.toBeNull();
    expect(after?.ragFileIds).toEqual(expect.any(Array));
    expect(after?.memories?.map((m) => m.content)).not.toContain("project fact");
  });
});

describe("purge: detach before destroy", () => {
  async function trashedProject(t: TestT) {
    const { userId, ws, u } = await seed(t);
    const projectId = await u.mutation(api.projects.create, {
      workspaceId: ws,
      name: "P",
    });
    return { userId, ws, u, projectId };
  }

  test("chats are UNASSIGNED, never destroyed", async () => {
    const t = convexTest(schema, modules);
    const { u, ws, projectId } = await trashedProject(t);
    const threadId = await u.mutation(api.chat.threads.create, {
      workspaceId: ws,
      projectId,
    });
    const sent = await u.mutation(api.chat.messages.send, {
      threadId,
      content: "keep me",
      clientId: "c1",
    });
    await drain(t);
    void sent;

    await u.mutation(api.projects.remove, { projectId });
    await t.mutation(internal.projects.purge, { projectId });
    await drain(t);

    // The conversation belongs to the person who had it, not to the container
    // it was filed under.
    const thread = await t.run(async (ctx) => ctx.db.get(threadId));
    expect(thread).not.toBeNull();
    expect(thread?.projectId).toBeUndefined();
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("chatMessages")
          .withIndex("by_thread_seq", (q) => q.eq("threadId", threadId))
          .collect(),
      ),
    ).not.toHaveLength(0);
    // And the project row is gone.
    expect(await projectRow(t, projectId)).toBeNull();
  });

  test("file EDGES go; the file and a second project's claim on it survive", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const a = await u.mutation(api.projects.create, {
      workspaceId: ws,
      name: "A",
    });
    const b = await u.mutation(api.projects.create, {
      workspaceId: ws,
      name: "B",
    });
    // ONE physical file, shared. Dedup makes this the normal case, not an edge
    // case: re-uploading the same bytes returns this very row.
    const fileId = await seedFile(t, userId, ws, "ing-shared");
    await u.mutation(api.projects.linkFile, { projectId: a, fileId });
    await u.mutation(api.projects.linkFile, { projectId: b, fileId });

    await u.mutation(api.projects.remove, { projectId: a });
    await t.mutation(internal.projects.purge, { projectId: a });
    await drain(t);

    // The blob and row survive, and B still has it.
    expect(await t.run(async (ctx) => ctx.db.get(fileId))).not.toBeNull();
    const edges = await t.run(async (ctx) =>
      ctx.db.query("projectFiles").collect(),
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]?.projectId).toBe(b);
  });

  test("project memories go across ALL statuses; global and workspace survive", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const projectId = await u.mutation(api.projects.create, {
      workspaceId: ws,
      name: "P",
    });
    await t.run(async (ctx) => {
      const now = Date.now();
      const mk = (
        content: string,
        scope: "user" | "workspace" | "project",
        status: "active" | "disabled",
        pid?: Id<"projects">,
      ) =>
        ctx.db.insert("userMemories", {
          userId,
          workspaceId: ws,
          kind: "fact" as const,
          content,
          source: "explicit" as const,
          scope,
          ...(pid ? { projectId: pid } : {}),
          status,
          normalizedKey: content,
          createdAt: now,
          updatedAt: now,
        });
      await mk("proj active", "project", "active", projectId);
      // A DISABLED project memory. An active-only sweep would strand this.
      await mk("proj disabled", "project", "disabled", projectId);
      await mk("global", "user", "active");
      await mk("ws", "workspace", "active");
    });

    await u.mutation(api.projects.remove, { projectId });
    await t.mutation(internal.projects.purge, { projectId });
    await drain(t);

    const left = await t.run(async (ctx) =>
      ctx.db.query("userMemories").collect(),
    );
    expect(left.map((m) => m.content).sort()).toEqual(["global", "ws"]);
  });

  test("scheduled tasks are SOFT-deleted so occurrence history still resolves", async () => {
    const t = convexTest(schema, modules);
    const { ws, u } = await seed(t);
    const projectId = await u.mutation(api.projects.create, {
      workspaceId: ws,
      name: "P",
    });
    const taskId = await u.mutation(api.scheduled.tasks.create, {
      workspaceId: ws,
      title: "T",
      prompt: "p",
      spec: DAILY,
      projectId,
    });

    await u.mutation(api.projects.remove, { projectId });
    await t.mutation(internal.projects.purge, { projectId });
    await drain(t);

    // Hard-deleting would break the existing invariant that occurrence history
    // keeps pointing at a real task row and its revisions stay resolvable.
    const task = await t.run(async (ctx) => ctx.db.get(taskId));
    expect(task).not.toBeNull();
    expect(task?.status).toBe("deleted");
    expect(
      await t.run(async (ctx) =>
        ctx.db.query("scheduledTaskRevisions").collect(),
      ),
    ).not.toHaveLength(0);
  });

  test("purge is idempotent and refuses a project that is not trashed", async () => {
    const t = convexTest(schema, modules);
    const { ws, u } = await seed(t);
    const projectId = await u.mutation(api.projects.create, {
      workspaceId: ws,
      name: "P",
    });

    // Active project: the purge must be a no-op, not a silent deletion.
    await t.mutation(internal.projects.purge, { projectId });
    expect(await projectRow(t, projectId)).not.toBeNull();

    await u.mutation(api.projects.remove, { projectId });
    await t.mutation(internal.projects.purge, { projectId });
    // Running it again on a vanished row must not throw.
    await t.mutation(internal.projects.purge, { projectId });
    expect(await projectRow(t, projectId)).toBeNull();
    await drain(t);
  });

  test("the TTL cron only reclaims projects past retention", async () => {
    const t = convexTest(schema, modules);
    const { ws, u } = await seed(t);
    const fresh = await u.mutation(api.projects.create, {
      workspaceId: ws,
      name: "Fresh",
    });
    const old = await u.mutation(api.projects.create, {
      workspaceId: ws,
      name: "Old",
    });
    await u.mutation(api.projects.remove, { projectId: fresh });
    await u.mutation(api.projects.remove, { projectId: old });
    // Backdate one past the 30-day window.
    await t.run(async (ctx) => {
      await ctx.db.patch(old, {
        trashedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
      });
    });

    const swept = await t.mutation(internal.projects.purgeTrashed, {});
    expect(swept).toBe(1);
    await drain(t);

    expect(await projectRow(t, old)).toBeNull();
    // The recent one is still recoverable — the whole point of the divergence
    // from threads.remove.
    expect((await projectRow(t, fresh))?.status).toBe("trashed");
  });
});

describe("authorization is unchanged by the new surface", () => {
  test("a peer can neither delete nor restore another user's project", async () => {
    const t = convexTest(schema, modules);
    const { ws, u } = await seed(t);
    const bob = await t.run(async (ctx) => {
      const bob = await ctx.db.insert("users", { email: "b@t.test" });
      await ctx.db.insert("members", {
        workspaceId: ws,
        userId: bob,
        role: "member",
        createdAt: Date.now(),
      });
      return bob;
    });
    const projectId = await u.mutation(api.projects.create, {
      workspaceId: ws,
      name: "Alice",
    });

    const asBob = t.withIdentity(as(bob));
    await expect(
      asBob.mutation(api.projects.remove, { projectId }),
    ).rejects.toThrow(/Not found/);
    await expect(
      asBob.mutation(api.projects.restore, { projectId }),
    ).rejects.toThrow(/Not found/);
    expect((await projectRow(t, projectId))?.status).toBe("active");
  });
});
