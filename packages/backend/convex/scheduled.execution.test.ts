/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

// Bind the app DataModel so `.withIndex` on the scheduled/chat tables
// type-checks inside helpers. Mirrors chat.durable.test.ts.
type TestT = TestConvex<typeof schema>;

const DAILY = {
  kind: "daily" as const,
  timezone: "UTC",
  hour: 9,
  minute: 0,
};

// startRun schedules chat.stream.dispatch, which POSTs /v1/generate. Point it
// at a stub and intercept fetch so the scheduled action never touches the
// network and never outlives the test transaction. Mirrors chat.security.test.ts.
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

async function seed(t: TestT, email = "o@t.test") {
  const { userId, ws } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email });
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

/** Create a task, queue a manual occurrence, and claim it. */
async function claimed(
  t: TestT,
  userId: Id<"users">,
  ws: Id<"workspaces">,
  prompt = "Search AI news",
) {
  const u = t.withIdentity(as(userId));
  const taskId = await u.mutation(api.scheduled.tasks.create, {
    workspaceId: ws,
    title: "News digest",
    prompt,
    spec: DAILY,
  });
  await u.mutation(api.scheduled.tasks.runNow, { taskId });
  const { claims } = await t.mutation(internal.scheduled.occurrences.claim, {
    limit: 1,
    maxPerUser: 1,
  });
  return { taskId, claim: claims[0], u };
}

async function occurrenceOf(t: TestT, key: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("scheduledTaskOccurrences")
      .withIndex("by_occurrence_key", (q) => q.eq("occurrenceKey", key))
      .unique(),
  );
}

// ---------------------------------------------------------------------------
// The turn is created through the EXISTING path — startAssistantTurn — so the
// whole production stack (runner, orchestrator, skills, tools, Ollagraph) is
// inherited rather than reimplemented.
// ---------------------------------------------------------------------------
describe("startRun creates a real chat turn", () => {
  test("it builds a hidden thread, a revision-pinned prompt and a stream", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const { taskId, claim } = await claimed(t, userId, ws);

    const res = await t.mutation(internal.scheduled.execution.startRun, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      deadlineMs: 1_200_000,
    });
    await drain(t);
    expect(res).toMatchObject({ ok: true, started: true });

    const state = await t.run(async (ctx) => {
      const task = await ctx.db.get(taskId);
      const thread = task?.executionThreadId
        ? await ctx.db.get(task.executionThreadId)
        : null;
      const messages = thread
        ? await ctx.db
            .query("chatMessages")
            .withIndex("by_thread_seq", (q) => q.eq("threadId", thread._id))
            .collect()
        : [];
      const stream = await ctx.db
        .query("chatStreams")
        .withIndex("by_streamId", (q) =>
          q.eq("streamId", String(res.streamId)),
        )
        .unique();
      return { thread, messages, stream };
    });

    // Hidden by STATUS — that is what excludes it from threads.list,
    // listPinned and both search paths without touching threads.ts.
    expect(state.thread?.status).toBe("scheduled");
    expect(state.thread?.scheduledTaskId).toBe(taskId);
    // titleSource "user" makes dispatchPayload's titleNeeded false, so the
    // auto-titler never renames a scheduled thread.
    expect(state.thread?.titleSource).toBe("user");

    expect(state.messages).toHaveLength(2);
    expect(state.messages[0].role).toBe("user");
    expect(state.messages[0].content).toBe("Search AI news");
    expect(state.messages[1].role).toBe("assistant");

    // The longer scheduled deadline reached the stream — the Python runner
    // adopts chatStreams.deadlineAt directly, so this IS the deadline chain.
    expect(state.stream?.deadlineAt).toBeGreaterThan(Date.now() + 1_000_000);
    expect(state.stream?.attempts).toBe(0);

    const occ = await occurrenceOf(t, claim.occurrenceKey);
    // The result reference Phase 3 will read.
    expect(occ?.threadId).toBe(state.thread?._id);
    expect(occ?.messageId).toBe(state.messages[1]._id);
    expect(occ?.streamId).toBe(res.streamId);
  });

  test("the scheduled thread is invisible to every chat read path", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const { claim } = await claimed(t, userId, ws);
    await t.mutation(internal.scheduled.execution.startRun, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
    });
    await drain(t);

    const listed = await u.query(api.chat.threads.list, {
      workspaceId: ws,
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(listed.page).toEqual([]);
    expect(
      await u.query(api.chat.threads.listPinned, { workspaceId: ws }),
    ).toEqual([]);
    expect(
      await u.query(api.chat.search.threads, {
        workspaceId: ws,
        query: "News digest",
      }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Editing a task must never rewrite what an already-created occurrence means.
// ---------------------------------------------------------------------------
describe("revision pinning", () => {
  test("an occurrence executes its PINNED revision, not the task's latest", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const { taskId, claim, u } = await claimed(t, userId, ws, "Search AI news");

    // The user edits the task AFTER the occurrence exists.
    await u.mutation(api.scheduled.tasks.update, {
      taskId,
      prompt: "Search AI and robotics news",
    });

    await t.mutation(internal.scheduled.execution.startRun, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
    });
    await drain(t);

    const userMessage = await t.run(async (ctx) => {
      const task = await ctx.db.get(taskId);
      const rows = await ctx.db
        .query("chatMessages")
        .withIndex("by_thread_seq", (q) =>
          q.eq("threadId", task?.executionThreadId as Id<"chatThreads">),
        )
        .collect();
      return rows.find((m) => m.role === "user");
    });
    // Revision 1's prompt, not revision 2's.
    expect(userMessage?.content).toBe("Search AI news");
  });
});

// ---------------------------------------------------------------------------
// A daily task runs on ONE thread forever, so history must be suppressed or it
// would feed the model a year of its own previous answers.
// ---------------------------------------------------------------------------
describe("context isolation", () => {
  test("a scheduled turn carries no history, no summary, and is unattended", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const { taskId, claim } = await claimed(t, userId, ws);
    const started = await t.mutation(internal.scheduled.execution.startRun, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
    });
    await drain(t);

    // Plant prior runs in the same thread, exactly as a recurring task would.
    await t.run(async (ctx) => {
      const task = await ctx.db.get(taskId);
      const threadId = task?.executionThreadId as Id<"chatThreads">;
      const now = Date.now();
      await ctx.db.insert("chatMessages", {
        threadId,
        workspaceId: ws,
        userId,
        role: "assistant",
        seq: 900,
        content: "yesterday's answer",
        status: "complete",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(threadId, { summary: "a rolling digest" });
    });

    const payload = await t.query(internal.chat.stream.dispatchPayload, {
      streamId: String(started.streamId),
    });
    expect(payload).not.toBeNull();
    // EXACTLY ONE message: this occurrence's own pinned prompt. Not zero —
    // history is also how the prompt reaches the model (the runner pops the
    // trailing user entry as `latest` and gates skill activation on it), so an
    // empty history would send no prompt at all.
    expect(payload?.history).toHaveLength(1);
    expect(payload?.history[0].role).toBe("user");
    expect(payload?.history[0].content).toBe("Search AI news");
    // Yesterday's run is NOT in context — that is the unbounded-growth guard.
    expect(JSON.stringify(payload?.history)).not.toContain("yesterday");
    expect(payload?.summary).toBeNull();
    expect(payload?.summaryThroughSeq).toBe(0);
    expect(payload?.titleNeeded).toBe(false);
    // Drives the READ_ONLY scope pin + approval refusal in the Python plane.
    expect(payload?.unattended).toBe(true);
  });

  test("a NORMAL chat turn is completely unaffected", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const threadId = await u.mutation(api.chat.threads.create, {
      workspaceId: ws,
      title: "normal",
    });
    const first = await u.mutation(api.chat.messages.send, {
      threadId,
      content: "first",
      clientId: "c1",
    });
    await drain(t);
    // Finish it, or the thread is still "already generating" for the next send.
    await t.mutation(internal.chat.ingest.finishStream, {
      streamId: String(first.streamId),
      text: "first answer",
    });
    const sent = await u.mutation(api.chat.messages.send, {
      threadId,
      content: "second",
      clientId: "c2",
    });
    await drain(t);

    const payload = await t.query(internal.chat.stream.dispatchPayload, {
      streamId: String(sent.streamId),
    });
    // History still flows, and the turn is NOT unattended.
    expect(payload?.history.length).toBeGreaterThan(0);
    expect(payload?.unattended).toBe(false);
    expect(payload?.titleNeeded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The three startRun paths. Picking the right one is the whole correctness
// story for replay and retry.
// ---------------------------------------------------------------------------
describe("replay and retry", () => {
  test("a replayed startRun RESUMES the live turn instead of starting a second", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const { taskId, claim } = await claimed(t, userId, ws);
    const first = await t.mutation(internal.scheduled.execution.startRun, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
    });
    await drain(t);

    // Exactly what a DBOS-recovered workflow does on re-entry.
    const second = await t.mutation(internal.scheduled.execution.startRun, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
    });
    await drain(t);

    expect(second).toMatchObject({ ok: true, resumed: true });
    expect(second.streamId).toBe(first.streamId);
    const messages = await t.run(async (ctx) => {
      const task = await ctx.db.get(taskId);
      return ctx.db
        .query("chatMessages")
        .withIndex("by_thread_seq", (q) =>
          q.eq("threadId", task?.executionThreadId as Id<"chatThreads">),
        )
        .collect();
    });
    // Still exactly one turn — no duplicate assistant message.
    expect(messages).toHaveLength(2);
  });

  test("a RETRY reuses the assistant message and seeds attempts, so tools replay", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const { taskId, claim } = await claimed(t, userId, ws);
    const first = await t.mutation(internal.scheduled.execution.startRun, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
    });
    await drain(t);

    // The turn fails; Phase 1 bumps the occurrence to a second dispatch attempt.
    await t.mutation(internal.chat.ingest.failStream, {
      streamId: String(first.streamId),
      error: "upstream blew up",
      errorCode: "provider_error",
    });
    await t.run(async (ctx) => {
      const occ = await ctx.db
        .query("scheduledTaskOccurrences")
        .withIndex("by_occurrence_key", (q) =>
          q.eq("occurrenceKey", claim.occurrenceKey),
        )
        .unique();
      if (occ) await ctx.db.patch(occ._id, { attempts: 1 });
    });

    const retried = await t.mutation(internal.scheduled.execution.startRun, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
    });
    await drain(t);
    expect(retried).toMatchObject({ ok: true, retried: true });
    expect(retried.streamId).not.toBe(first.streamId);
    // SAME assistant message: toolExecutions + chatStreamEvents are keyed
    // by_message, so reusing it is what preserves the tool ledger.
    expect(retried.messageId).toBe(first.messageId);

    const payload = await t.query(internal.chat.stream.dispatchPayload, {
      streamId: String(retried.streamId),
    });
    // attempt > 0 is what makes dispatchPayload set doResume, which replays
    // completed + indeterminate tools instead of RE-EXECUTING them. Without
    // this a retry would silently run every side-effecting tool a second time.
    expect(payload?.attempt).toBeGreaterThan(0);

    const messages = await t.run(async (ctx) => {
      const task = await ctx.db.get(taskId);
      return ctx.db
        .query("chatMessages")
        .withIndex("by_thread_seq", (q) =>
          q.eq("threadId", task?.executionThreadId as Id<"chatThreads">),
        )
        .collect();
    });
    // Still ONE logical turn across both attempts.
    expect(messages).toHaveLength(2);
  });

  test("a trashed execution thread is re-created rather than breaking the task", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const { taskId, claim } = await claimed(t, userId, ws);
    await t.mutation(internal.scheduled.execution.startRun, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
    });
    await drain(t);

    const original = await t.run(async (ctx) => {
      const task = await ctx.db.get(taskId);
      const id = task?.executionThreadId as Id<"chatThreads">;
      // Simulate the owner trashing it (or purgeTrashed having run).
      await ctx.db.patch(id, { status: "trashed" });
      // Clear the occurrence's turn so this is a fresh start, not a resume.
      const occ = await ctx.db
        .query("scheduledTaskOccurrences")
        .withIndex("by_occurrence_key", (q) =>
          q.eq("occurrenceKey", claim.occurrenceKey),
        )
        .unique();
      if (occ) {
        await ctx.db.patch(occ._id, {
          streamId: undefined,
          messageId: undefined,
        });
      }
      return id;
    });

    const again = await t.mutation(internal.scheduled.execution.startRun, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
    });
    await drain(t);
    expect(again).toMatchObject({ ok: true, started: true });
    const task = await t.run(async (ctx) => ctx.db.get(taskId));
    expect(task?.executionThreadId).not.toBe(original);
  });
});

// ---------------------------------------------------------------------------
// A scheduled execution thread is an internal history mechanism, never a
// conversation. Every interactive turn-start path must refuse it.
// ---------------------------------------------------------------------------
describe("no contamination from interactive chat", () => {
  test("send / regenerate / retry / editUserMessage all refuse a scheduled thread", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const { taskId, claim } = await claimed(t, userId, ws);
    await t.mutation(internal.scheduled.execution.startRun, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
    });
    await drain(t);

    const { threadId, userMessageId, assistantMessageId } = await t.run(
      async (ctx) => {
        const task = await ctx.db.get(taskId);
        const id = task?.executionThreadId as Id<"chatThreads">;
        const rows = await ctx.db
          .query("chatMessages")
          .withIndex("by_thread_seq", (q) => q.eq("threadId", id))
          .collect();
        // Clear the in-flight marker so the refusal cannot be the generic
        // "already generating" guard — it must be the scheduled guard itself.
        await ctx.db.patch(id, { streamingMessageId: undefined });
        return {
          threadId: id,
          userMessageId: rows.find((m) => m.role === "user")?._id,
          assistantMessageId: rows.find((m) => m.role === "assistant")?._id,
        };
      },
    );

    await expect(
      u.mutation(api.chat.messages.send, {
        threadId,
        content: "hijack",
        clientId: "x1",
      }),
    ).rejects.toThrow(/Not found/);
    await expect(
      u.mutation(api.chat.messages.regenerate, {
        messageId: assistantMessageId as Id<"chatMessages">,
      }),
    ).rejects.toThrow(/Not found/);
    await expect(
      u.mutation(api.chat.messages.editUserMessage, {
        messageId: userMessageId as Id<"chatMessages">,
        content: "hijack",
        clientId: "x2",
      }),
    ).rejects.toThrow(/Not found/);

    // retry needs a failed reply first; it must STILL refuse.
    await t.run(async (ctx) => {
      await ctx.db.patch(assistantMessageId as Id<"chatMessages">, {
        status: "error",
      });
    });
    await expect(
      u.mutation(api.chat.messages.retry, {
        messageId: assistantMessageId as Id<"chatMessages">,
      }),
    ).rejects.toThrow(/Not found/);

    const messages = await t.run(async (ctx) =>
      ctx.db
        .query("chatMessages")
        .withIndex("by_thread_seq", (q) => q.eq("threadId", threadId))
        .collect(),
    );
    expect(messages).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Authorization, isolation and cancellation.
// ---------------------------------------------------------------------------
describe("security and lifecycle", () => {
  test("every execution op is lease-guarded", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const { claim } = await claimed(t, userId, ws);

    for (const op of ["startRun", "runStatus", "cancelRun"] as const) {
      const res = await t.mutation(internal.scheduled.execution[op], {
        occurrenceKey: claim.occurrenceKey,
        leaseToken: "a-stale-lease",
      });
      expect(res).toMatchObject({ ok: false, stale: true });
    }
    const occ = await occurrenceOf(t, claim.occurrenceKey);
    expect(occ?.streamId).toBeUndefined();
  });

  test("startRun refuses when the owner's entitlement was revoked", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const { claim } = await claimed(t, userId, ws);

    await t.run(async (ctx) => {
      const m = await ctx.db
        .query("members")
        .withIndex("by_user_workspace", (q) =>
          q.eq("userId", userId).eq("workspaceId", ws),
        )
        .unique();
      if (m) await ctx.db.delete(m._id);
    });

    const res = await t.mutation(internal.scheduled.execution.startRun, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
    });
    expect(res).toMatchObject({ ok: false, entitlement: "owner_not_member" });
    const occ = await occurrenceOf(t, claim.occurrenceKey);
    expect(occ?.streamId).toBeUndefined();
  });

  test("another user cannot read the scheduled thread or its messages", async () => {
    const t = convexTest(schema, modules);
    const owner = await seed(t, "owner@t.test");
    const other = await seed(t, "other@t.test");
    const { taskId, claim } = await claimed(t, owner.userId, owner.ws);
    await t.mutation(internal.scheduled.execution.startRun, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
    });
    await drain(t);

    const threadId = await t.run(
      async (ctx) => (await ctx.db.get(taskId))?.executionThreadId,
    );
    // threads.get soft-denies with null rather than throwing — the house
    // convention, so a signed-in stranger never gets an existence oracle and
    // never logs a console error.
    expect(
      await t.withIdentity(as(other.userId)).query(api.chat.threads.get, {
        threadId: threadId as Id<"chatThreads">,
      }),
    ).toBeNull();
    // The messages are refused too.
    await expect(
      t.withIdentity(as(other.userId)).query(api.chat.messages.listPaged, {
        threadId: threadId as Id<"chatThreads">,
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).rejects.toThrow(/Not found/);
  });

  test("cancelRun asks the running turn to stop, durably", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const { claim } = await claimed(t, userId, ws);
    const started = await t.mutation(internal.scheduled.execution.startRun, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
    });
    await drain(t);

    expect(
      await t.mutation(internal.scheduled.execution.cancelRun, {
        occurrenceKey: claim.occurrenceKey,
        leaseToken: claim.leaseToken,
      }),
    ).toMatchObject({ ok: true, requested: true });

    // The same durable flag the Stop button sets: every ingress response
    // carries it, so the worker sees it on its next flush.
    const stream = await t.run(async (ctx) =>
      ctx.db
        .query("chatStreams")
        .withIndex("by_streamId", (q) =>
          q.eq("streamId", String(started.streamId)),
        )
        .unique(),
    );
    expect(stream?.cancelRequested).toBe(true);

    const status = await t.mutation(internal.scheduled.execution.runStatus, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
    });
    expect(status).toMatchObject({ ok: true, cancelRequested: true });
  });

  test("runStatus reports the terminal outcome and its durable error code", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const { claim } = await claimed(t, userId, ws);
    const started = await t.mutation(internal.scheduled.execution.startRun, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
    });
    await drain(t);

    expect(
      await t.mutation(internal.scheduled.execution.runStatus, {
        occurrenceKey: claim.occurrenceKey,
        leaseToken: claim.leaseToken,
      }),
    ).toMatchObject({ ok: true, terminal: false });

    await t.mutation(internal.chat.ingest.failStream, {
      streamId: String(started.streamId),
      error: "inference plane unreachable",
      errorCode: "dispatch_unreachable",
    });

    expect(
      await t.mutation(internal.scheduled.execution.runStatus, {
        occurrenceKey: claim.occurrenceKey,
        leaseToken: claim.leaseToken,
      }),
    ).toMatchObject({
      ok: true,
      terminal: true,
      errorCode: "dispatch_unreachable",
    });
  });

  test("a successful turn leaves the answer where Phase 3 can read it", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const { claim } = await claimed(t, userId, ws);
    const started = await t.mutation(internal.scheduled.execution.startRun, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
    });
    await drain(t);

    await t.mutation(internal.chat.ingest.finishStream, {
      streamId: String(started.streamId),
      text: "Here is your morning digest.",
      tokensIn: 10,
      tokensOut: 20,
    });

    const status = await t.mutation(internal.scheduled.execution.runStatus, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
    });
    expect(status).toMatchObject({ ok: true, terminal: true });
    expect(status.streamStatus).toBe("done");

    // No second result store: the answer is the assistant message, reachable
    // from the occurrence's messageId (artifacts hang off it via by_message).
    const occ = await occurrenceOf(t, claim.occurrenceKey);
    const message = await t.run(async (ctx) =>
      ctx.db.get(occ?.messageId as Id<"chatMessages">),
    );
    expect(message?.content).toBe("Here is your morning digest.");
    expect(message?.status).toBe("complete");
  });
});

// ---------------------------------------------------------------------------
// The execution thread uses the OWNER'S model, not the build-time constant.
//
// Hardcoding DEFAULT_MODEL made a scheduled task unfixable by its owner. When
// that one model stopped serving, every scheduled run failed with an opaque
// `internal` while the same user's chat — on a model they had picked — kept
// working, and nothing in the product could route around it. Production did
// exactly that: gpt-5.6-luna returned 502 from the provider's upstream while
// three other models answered 200.
// ---------------------------------------------------------------------------
describe("the execution thread's model", () => {
  async function threadOf(t: TestT, taskId: Id<"scheduledTasks">) {
    return t.run(async (ctx) => {
      const task = await ctx.db.get(taskId);
      return task?.executionThreadId
        ? await ctx.db.get(task.executionThreadId)
        : null;
    });
  }

  test("follows the owner's chosen model", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    // Written directly, and the catalogue seeded alongside it: convex-test has
    // no network, so chatModels is empty and only DEFAULT_MODEL would validate.
    await t.run(async (ctx) => {
      await ctx.db.insert("chatModels", {
        modelId: "glm-5.2",
        name: "GLM 5.2",
        contextLength: 128000,
        promptPrice: "0",
        completionPrice: "0",
        vision: false,
        updatedAt: Date.now(),
      });
      await ctx.db.insert("chatSettings", {
        workspaceId: ws,
        userId,
        defaultModel: "glm-5.2",
        sendOnEnter: true,
        updatedAt: Date.now(),
      });
    });

    const { taskId, claim } = await claimed(t, userId, ws);
    await t.mutation(internal.scheduled.execution.startRun, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
    });
    await drain(t);
    expect((await threadOf(t, taskId))?.model).toBe("glm-5.2");
  });

  test("falls back to the default when the owner has chosen none", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const { taskId, claim } = await claimed(t, userId, ws);
    await t.mutation(internal.scheduled.execution.startRun, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
    });
    await drain(t);
    expect((await threadOf(t, taskId))?.model).toBe("gpt-5.6-luna");
  });

  test("an unknown stored model degrades to the default rather than failing", async () => {
    // assertAllowedModel still guards dispatch, so a retired model id must not
    // turn every future run of the task into an error.
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("chatSettings", {
        workspaceId: ws,
        userId,
        defaultModel: "a-model-that-was-retired",
        sendOnEnter: true,
        updatedAt: Date.now(),
      });
    });
    const { taskId, claim } = await claimed(t, userId, ws);
    const res = await t.mutation(internal.scheduled.execution.startRun, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
    });
    await drain(t);
    expect(res.ok).toBe(true);
    expect((await threadOf(t, taskId))?.model).toBeTruthy();
  });
});
