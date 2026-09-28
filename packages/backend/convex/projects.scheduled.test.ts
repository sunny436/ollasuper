/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });
type TestT = ReturnType<typeof convexTest>;

// Matches scheduleSpecValidator: the field is `timezone`, not `tz`.
const DAILY = {
  kind: "daily" as const,
  timezone: "UTC",
  hour: 9,
  minute: 0,
};

/**
 * PHASE 5 — Project identity through the scheduler.
 *
 * The chain is:
 *
 *   task -> revision (PINNED) -> occurrence -> hidden thread -> dispatchPayload
 *
 * dispatchPayload reads the THREAD, so the whole Phase 1-4 stack (instructions,
 * memory pool, RAG scope) follows automatically once the hidden thread carries
 * the right projectId. The subtlety this file exists for: there is exactly ONE
 * execution thread per task and it is REUSED for the life of that task, so the
 * Project has to be reconciled on every occurrence rather than only at creation.
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

/** Queue a manual occurrence for a task and claim it. */
async function claimOne(t: TestT, u: ReturnType<TestT["withIdentity"]>, taskId: Id<"scheduledTasks">) {
  await u.mutation(api.scheduled.tasks.runNow, { taskId });
  const { claims } = await t.mutation(internal.scheduled.occurrences.claim, {
    limit: 1,
    maxPerUser: 1,
  });
  return claims[0];
}

const threadOfTask = (t: TestT, taskId: Id<"scheduledTasks">) =>
  t.run(async (ctx) => {
    const task = await ctx.db.get(taskId);
    return task?.executionThreadId ? ctx.db.get(task.executionThreadId) : null;
  });

describe("project scheduled tasks", () => {
  test("a task can be created inside a Project and pins it on revision 1", async () => {
    const t = convexTest(schema, modules);
    const { ws, u } = await seed(t);
    const projectId = await u.mutation(api.projects.create, {
      workspaceId: ws,
      name: "P",
    });

    const taskId = await u.mutation(api.scheduled.tasks.create, {
      workspaceId: ws,
      title: "Digest",
      prompt: "Summarise the project files",
      spec: DAILY,
      projectId,
    });

    const { task, rev } = await t.run(async (ctx) => {
      const task = await ctx.db.get(taskId);
      const rev = task?.currentRevisionId
        ? await ctx.db.get(task.currentRevisionId)
        : null;
      return { task, rev };
    });
    expect(task?.projectId).toBe(projectId);
    // Pinned alongside the prompt: this is what a run created now will mean.
    expect(rev?.projectId).toBe(projectId);
  });

  test("a task with no Project is unchanged", async () => {
    const t = convexTest(schema, modules);
    const { ws, u } = await seed(t);
    const taskId = await u.mutation(api.scheduled.tasks.create, {
      workspaceId: ws,
      title: "Plain",
      prompt: "Do the thing",
      spec: DAILY,
    });
    const { task, rev } = await t.run(async (ctx) => {
      const task = await ctx.db.get(taskId);
      const rev = task?.currentRevisionId
        ? await ctx.db.get(task.currentRevisionId)
        : null;
      return { task, rev };
    });
    expect(task?.projectId).toBeUndefined();
    expect(rev?.projectId).toBeUndefined();
  });

  test("editing a task carries its Project onto the new revision", async () => {
    const t = convexTest(schema, modules);
    const { ws, u } = await seed(t);
    const projectId = await u.mutation(api.projects.create, {
      workspaceId: ws,
      name: "P",
    });
    const taskId = await u.mutation(api.scheduled.tasks.create, {
      workspaceId: ws,
      title: "Digest",
      prompt: "old prompt",
      spec: DAILY,
      projectId,
    });
    await u.mutation(api.scheduled.tasks.update, {
      taskId,
      prompt: "new prompt",
    });

    const revisions = await t.run(async (ctx) =>
      ctx.db.query("scheduledTaskRevisions").collect(),
    );
    expect(revisions).toHaveLength(2);
    // Every revision records the Project in force when it was written, so an
    // occurrence created under either one resolves the same Project.
    expect(revisions.every((r) => r.projectId === projectId)).toBe(true);
  });
});

describe("the hidden execution thread", () => {
  test("carries the Project from its first run", async () => {
    const t = convexTest(schema, modules);
    const { ws, u } = await seed(t);
    const projectId = await u.mutation(api.projects.create, {
      workspaceId: ws,
      name: "P",
    });
    const taskId = await u.mutation(api.scheduled.tasks.create, {
      workspaceId: ws,
      title: "Digest",
      prompt: "Summarise",
      spec: DAILY,
      projectId,
    });

    const claim = await claimOne(t, u, taskId);
    await t.mutation(internal.scheduled.execution.startRun, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      deadlineMs: 1_200_000,
    });
    await drain(t);

    const thread = await threadOfTask(t, taskId);
    expect(thread?.status).toBe("scheduled");
    expect(thread?.projectId).toBe(projectId);
  });

  test("REGRESSION: the reused thread is re-pointed when the revision's Project changes", async () => {
    const t = convexTest(schema, modules);
    const { ws, u } = await seed(t);
    const projectId = await u.mutation(api.projects.create, {
      workspaceId: ws,
      name: "Later",
    });

    // Created with NO Project, so the first run makes an unscoped thread.
    const taskId = await u.mutation(api.scheduled.tasks.create, {
      workspaceId: ws,
      title: "Digest",
      prompt: "Summarise",
      spec: DAILY,
    });
    const first = await claimOne(t, u, taskId);
    await t.mutation(internal.scheduled.execution.startRun, {
      occurrenceKey: first.occurrenceKey,
      leaseToken: first.leaseToken,
      deadlineMs: 1_200_000,
    });
    await drain(t);
    expect((await threadOfTask(t, taskId))?.projectId).toBeUndefined();

    // The task gains a Project. There is ONE execution thread per task and it is
    // REUSED, so without reconciliation it would keep running unscoped forever —
    // and dispatchPayload reads the THREAD, so pinning the revision alone would
    // have been ornamental.
    await t.run(async (ctx) => {
      const task = await ctx.db.get(taskId);
      await ctx.db.patch(taskId, { projectId });
      if (task?.currentRevisionId) {
        await ctx.db.patch(task.currentRevisionId, { projectId });
      }
      // Land the previous turn so a second one may start.
      if (task?.executionThreadId) {
        await ctx.db.patch(task.executionThreadId, {
          streamingMessageId: undefined,
        });
      }
      for (const st of await ctx.db.query("chatStreams").collect()) {
        if (st.status === "queued" || st.status === "running") {
          await ctx.db.patch(st._id, { status: "done" });
        }
      }
      // Retire the first occurrence: the claimer enforces maxPerUser, so a
      // still-running occurrence blocks the second claim.
      for (const occ of await ctx.db
        .query("scheduledTaskOccurrences")
        .collect()) {
        await ctx.db.patch(occ._id, { status: "succeeded" });
      }
    });

    const second = await claimOne(t, u, taskId);
    await t.mutation(internal.scheduled.execution.startRun, {
      occurrenceKey: second.occurrenceKey,
      leaseToken: second.leaseToken,
      deadlineMs: 1_200_000,
    });
    await drain(t);

    expect((await threadOfTask(t, taskId))?.projectId).toBe(projectId);
  });
});

describe("scheduled dispatch carries the full Project context", () => {
  test("instructions, memory pool and RAG scope all follow the hidden thread", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const projectId = await u.mutation(api.projects.create, {
      workspaceId: ws,
      name: "P",
      instructions: "Answer only from the project files.",
    });

    // A ready Project file, and a project-scoped memory.
    await t.run(async (ctx) => {
      const now = Date.now();
      const fileId = await ctx.db.insert("userFiles", {
        userId,
        workspaceId: ws,
        name: "spec.pdf",
        size: 10,
        contentType: "application/pdf",
        ingestId: "ing-sched",
        status: "ready",
        attempts: 0,
        contentHash: "h",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("projectFiles", {
        projectId,
        fileId,
        userId,
        addedAt: now,
      });
      await ctx.db.insert("userMemories", {
        userId,
        workspaceId: ws,
        kind: "fact",
        content: "project-only fact",
        source: "explicit",
        scope: "project",
        projectId,
        status: "active",
        normalizedKey: "project-only fact",
        createdAt: now,
        updatedAt: now,
      });
    });

    const taskId = await u.mutation(api.scheduled.tasks.create, {
      workspaceId: ws,
      title: "Digest",
      prompt: "Summarise",
      spec: DAILY,
      projectId,
    });
    const claim = await claimOne(t, u, taskId);
    const started = await t.mutation(internal.scheduled.execution.startRun, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      deadlineMs: 1_200_000,
    });
    await drain(t);

    const payload = await t.query(internal.chat.stream.dispatchPayload, {
      streamId: started.streamId as string,
    });

    // One line on the hidden thread buys the entire Phase 1-4 stack.
    expect(payload?.projectInstructions).toBe(
      "Answer only from the project files.",
    );
    expect(payload?.ragFileIds).toEqual(["ing-sched"]);
    expect(payload?.memories?.map((m) => m.content)).toContain(
      "project-only fact",
    );
    // Still an unattended run, which is what withholds the memory WRITE tools.
    expect(payload?.unattended).toBe(true);
  });

  test("a scheduled task with no Project sends the account scope spelled out, not a widened one", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    // The user owns a file that is NOT in any project.
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("userFiles", {
        userId,
        workspaceId: ws,
        name: "account.pdf",
        size: 10,
        contentType: "application/pdf",
        ingestId: "ing-account",
        status: "ready",
        attempts: 0,
        contentHash: "h2",
        createdAt: now,
        updatedAt: now,
      });
    });

    const taskId = await u.mutation(api.scheduled.tasks.create, {
      workspaceId: ws,
      title: "Plain",
      prompt: "Summarise",
      spec: DAILY,
    });
    const claim = await claimOne(t, u, taskId);
    const started = await t.mutation(internal.scheduled.execution.startRun, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      deadlineMs: 1_200_000,
    });
    await drain(t);

    const payload = await t.query(internal.chat.stream.dispatchPayload, {
      streamId: started.streamId as string,
    });
    expect(payload?.projectInstructions).toBeNull();
    // null, not [] — an ordinary scheduled task keeps account-wide retrieval.
    // The account scope, spelled out — never null ("whole corpus").
    expect(Array.isArray(payload?.ragFileIds)).toBe(true);
  });
});

describe("scheduled task authorization", () => {
  test("a user cannot schedule work into another user's Project", async () => {
    const t = convexTest(schema, modules);
    const { ws, u } = await seed(t);
    const { userId: bob } = await t.run(async (ctx) => {
      const bob = await ctx.db.insert("users", { email: "b@t.test" });
      await ctx.db.insert("members", {
        workspaceId: ws,
        userId: bob,
        role: "member",
        createdAt: Date.now(),
      });
      return { userId: bob };
    });

    const aliceProject = await u.mutation(api.projects.create, {
      workspaceId: ws,
      name: "Alice",
    });

    await expect(
      t.withIdentity(as(bob)).mutation(api.scheduled.tasks.create, {
        workspaceId: ws,
        title: "Sneaky",
        prompt: "read her files",
        spec: DAILY,
        projectId: aliceProject,
      }),
    ).rejects.toThrow(/Not found/);
  });

  test("a task cannot be scheduled into a Project in another workspace", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const wsB = await t.run(async (ctx) => {
      const id = await ctx.db.insert("workspaces", {
        name: "Second",
        ownerId: userId,
        createdAt: Date.now(),
      });
      await ctx.db.insert("members", {
        workspaceId: id,
        userId,
        role: "owner",
        createdAt: Date.now(),
      });
      return id;
    });
    const projectInB = await u.mutation(api.projects.create, {
      workspaceId: wsB,
      name: "In B",
    });

    await expect(
      u.mutation(api.scheduled.tasks.create, {
        workspaceId: ws,
        title: "Cross",
        prompt: "x",
        spec: DAILY,
        projectId: projectInB,
      }),
    ).rejects.toThrow(/Not found/);
  });

  test("an archived Project accepts no new scheduled work", async () => {
    const t = convexTest(schema, modules);
    const { ws, u } = await seed(t);
    const projectId = await u.mutation(api.projects.create, {
      workspaceId: ws,
      name: "Old",
    });
    await u.mutation(api.projects.archive, { projectId, archived: true });

    await expect(
      u.mutation(api.scheduled.tasks.create, {
        workspaceId: ws,
        title: "Late",
        prompt: "x",
        spec: DAILY,
        projectId,
      }),
    ).rejects.toThrow(/archived/i);
  });
});
