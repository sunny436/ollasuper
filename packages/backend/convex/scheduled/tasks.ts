import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query } from "../_generated/server";
import { toPublic } from "../chat/public";
import { hasWorkspaceAccess, requireMember } from "../orgs";
import { requireProjectAccess } from "../projects";
import {
  optionalTaskAccess,
  requireTaskAccess,
  requireUserId,
} from "./authz";
import {
  cancelOpenForTask,
  holdOpenForTask,
  releaseHeldForTask,
} from "./occurrences";
import {
  MAX_PROMPT_LEN,
  MAX_TITLE_LEN,
  normalizeSpec,
  occurrenceKey,
  type ScheduleSpec,
  scheduleSpecValidator,
} from "./schedule";

/**
 * Public API for Scheduled Tasks (Phase 1 — backend only, no UI yet).
 *
 * Every function derives the user from the session and refuses anything it does
 * not own with "Not found". Phase 1 deliberately stops at the scheduling
 * foundation: `runNow` creates a durable occurrence, it does NOT execute
 * anything. Execution arrives in Phase 2 behind the same occurrence contract.
 */

/**
 * Bounds a runaway integration, not a product limit. Occurrences are cheap but
 * a task is a standing commitment to future compute, so the count is capped at
 * creation — the same instinct as MAX_GENERATIONS_PER_HOUR in chat/messages.ts.
 */
const MAX_TASKS_PER_USER = 50;


function badRequest(message: string): never {
  throw new ConvexError(message);
}

function cleanTitle(raw: string): string {
  const t = raw.trim().replace(/\s+/g, " ").slice(0, MAX_TITLE_LEN);
  if (!t) badRequest("Title is required");
  return t;
}

function cleanPrompt(raw: string): string {
  const p = raw.trim().slice(0, MAX_PROMPT_LEN);
  if (!p) badRequest("Prompt is required");
  return p;
}

function validateSpec(spec: ScheduleSpec, now: number): ScheduleSpec {
  let normalized: ScheduleSpec;
  try {
    normalized = normalizeSpec(spec);
  } catch (e) {
    return badRequest(e instanceof Error ? e.message : "Invalid schedule");
  }
  // A one-time task in the past would either never fire or fire immediately on
  // a technicality. Refuse it at the boundary instead of guessing.
  if (normalized.kind === "once" && normalized.runAt <= now) {
    badRequest("One-time schedule must be in the future");
  }
  // "End repeat" in the past would create a task that can never run. Refuse it
  // at the boundary rather than silently completing on the first tick.
  if (normalized.kind !== "once" && normalized.endsAt !== undefined) {
    if (normalized.endsAt <= now) {
      badRequest("End date must be in the future");
    }
  }
  return normalized;
}

function publicTask(task: Doc<"scheduledTasks">) {
  return {
    _id: task._id,
    title: task.title,
    prompt: task.prompt,
    spec: task.spec,
    status: task.status,
    revision: task.revision,
    nextRunAt: task.nextRunAt ?? null,
    lastRunAt: task.lastRunAt ?? null,
    pausedAt: task.pausedAt ?? null,
    invalidReason: task.invalidReason ?? null,
    terminalReason: task.terminalReason ?? null,
    // Absent means ENABLED — surfaced as an explicit boolean so the UI never
    // has to re-encode that rule.
    notifyOnSuccess: task.notifyOnSuccess !== false,
    notifyOnFailure: task.notifyOnFailure !== false,
    // The INVERSE default to the pair above: absent means off. Surfaced as an
    // explicit boolean so the UI never has to re-encode which way each defaults.
    emailOnSuccess: task.emailOnSuccess === true,
    emailOnFailure: task.emailOnFailure === true,
    attachPdf: task.attachPdf === true,
    executionThreadId: task.executionThreadId ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/**
 * One occurrence, as the UI sees it.
 *
 * `messageId` / `threadId` are the RESULT REFERENCE — without them the UI
 * cannot open what a run produced. Internal execution state (leaseToken,
 * workflowId, streamId, heartbeatAt) is deliberately never exposed.
 */
function publicOccurrence(o: Doc<"scheduledTaskOccurrences">) {
  return {
    _id: o._id,
    occurrenceKey: o.occurrenceKey,
    scheduledFor: o.scheduledFor,
    kind: o.kind,
    status: o.status,
    revision: o.revision,
    attempts: o.attempts,
    startedAt: o.startedAt ?? null,
    finishedAt: o.finishedAt ?? null,
    errorCode: o.errorCode ?? null,
    terminalReason: o.terminalReason ?? null,
    cancelRequested: o.cancelRequested,
    messageId: o.messageId ?? null,
    threadId: o.threadId ?? null,
  };
}

export const create = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    title: v.string(),
    prompt: v.string(),
    spec: scheduleSpecValidator,
    // Optional Project home. Authorized below — a caller cannot schedule work
    // into a Project they do not own, and cannot cross a workspace boundary.
    projectId: v.optional(v.id("projects")),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireMember(ctx, userId, args.workspaceId);

    if (args.projectId) {
      const project = await requireProjectAccess(ctx, userId, args.projectId);
      // Same invariant as threads.create and projects.linkFile: one user may
      // belong to two workspaces, and a task must never straddle them.
      if (project.workspaceId !== args.workspaceId) {
        throw new ConvexError("Not found");
      }
      if (project.status !== "active") {
        throw new ConvexError("This project is archived or deleted");
      }
    }

    const now = Date.now();
    const spec = validateSpec(args.spec, now);
    const title = cleanTitle(args.title);
    const prompt = cleanPrompt(args.prompt);

    const existing = await ctx.db
      .query("scheduledTasks")
      .withIndex("by_user_updated", (q) => q.eq("userId", userId))
      .take(MAX_TASKS_PER_USER + 50);
    const live = existing.filter(
      (t) => t.status === "active" || t.status === "paused",
    );
    if (live.length >= MAX_TASKS_PER_USER) {
      badRequest("Too many scheduled tasks");
    }

    const taskId = await ctx.db.insert("scheduledTasks", {
      userId,
      workspaceId: args.workspaceId,
      ...(args.projectId ? { projectId: args.projectId } : {}),
      title,
      prompt,
      spec,
      status: "active",
      revision: 1,
      // The recurrence timeline starts at creation: nothing before now is ever
      // enumerated, so a new task can never backfill history.
      cursorAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const revisionId = await ctx.db.insert("scheduledTaskRevisions", {
      taskId,
      userId,
      // Pinned alongside the prompt: an occurrence executes the revision it was
      // created under, so this is what a past run actually meant.
      ...(args.projectId ? { projectId: args.projectId } : {}),
      revision: 1,
      title,
      prompt,
      spec,
      createdAt: now,
    });
    // Same transaction, so currentRevisionId is never observably absent.
    await ctx.db.patch(taskId, { currentRevisionId: revisionId });
    return taskId;
  },
});

export const get = query({
  // v.string() + normalizeId, never v.id(): this id comes from the URL, and a
  // typo would raise ArgumentValidationError -> console.error -> a failed e2e
  // run. Same rule chat follows for threadId.
  args: { taskId: v.string() },
  handler: async (ctx, { taskId }) => {
    const userId = await requireUserId(ctx).catch(() => null);
    if (!userId) return null;
    const task = await optionalTaskAccess(ctx, userId, taskId);
    // null, not a throw — the panel has a not-found state and renders it.
    return task ? publicTask(task) : null;
  },
});

export const list = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  handler: async (ctx, { workspaceId }) => {
    // Soft read, matching files.listPaged / chat: a signed-out render returns
    // [] rather than throwing, so it never logs a console error.
    const userId = await requireUserId(ctx).catch(() => null);
    if (!userId) return [];
    const rows = await ctx.db
      .query("scheduledTasks")
      .withIndex("by_user_updated", (q) => q.eq("userId", userId))
      .order("desc")
      .take(200);
    // The detail endpoint (optionalTaskAccess) requires CURRENT membership of
    // the task's workspace; the list used to check only ownership, so a removed
    // member kept reading their standing prompts here (audit F-08). One check
    // per distinct workspace, not per row.
    const entitled = new Map<string, boolean>();
    const visible: typeof rows = [];
    for (const t of rows) {
      if (t.status === "deleted") continue;
      if (workspaceId && t.workspaceId !== workspaceId) continue;
      let ok = entitled.get(t.workspaceId);
      if (ok === undefined) {
        ok = await hasWorkspaceAccess(ctx, userId, t.workspaceId);
        entitled.set(t.workspaceId, ok);
      }
      if (ok) visible.push(t);
    }
    return visible.map(publicTask);
  },
});

export const update = mutation({
  args: {
    taskId: v.id("scheduledTasks"),
    title: v.optional(v.string()),
    prompt: v.optional(v.string()),
    spec: v.optional(scheduleSpecValidator),
    // Optimistic concurrency. The edit modal sends the revision it was opened
    // with; if the task moved on (another tab, another device) the save is
    // REFUSED rather than silently overwriting the newer state.
    expectedRevision: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const task = await requireTaskAccess(ctx, userId, args.taskId);
    if (task.status === "completed") badRequest("Task is already complete");
    if (
      args.expectedRevision !== undefined &&
      args.expectedRevision !== task.revision
    ) {
      badRequest("Task changed elsewhere");
    }

    const now = Date.now();
    const title = args.title === undefined ? task.title : cleanTitle(args.title);
    const prompt =
      args.prompt === undefined ? task.prompt : cleanPrompt(args.prompt);
    const spec =
      args.spec === undefined ? task.spec : validateSpec(args.spec, now);

    const revision = task.revision + 1;
    // Revisions are IMMUTABLE and append-only: an occurrence created under
    // revision N keeps pointing at revision N forever, so editing a task never
    // rewrites what a past execution meant.
    const revisionId = await ctx.db.insert("scheduledTaskRevisions", {
      taskId: args.taskId,
      userId,
      // Carried from the task, not from the caller: an edit cannot move a task
      // into a different Project, and every revision records the Project that
      // was in force when it was written.
      ...(task.projectId ? { projectId: task.projectId } : {}),
      revision,
      title,
      prompt,
      spec,
      createdAt: now,
    });
    // A changed schedule invalidates the DENORMALISED nextRunAt.
    //
    // Nothing else clears it: tick.py skips a task whose window holds nothing
    // due (`if upper <= task.cursor_at: continue`), so after editing a daily
    // 8 AM task to 6 PM — or changing its timezone — the panel kept showing
    // the OLD next run, confidently and wrongly, until the old instant came
    // round. Execution was always correct; only this field lied.
    //
    // It is CLEARED, never recomputed. Calendar arithmetic lives in
    // recurrence.py and must not be duplicated here (see schedule.ts) — the
    // next materialise writes the true value. task-detail.tsx already guards
    // on `task.nextRunAt`, so the line disappears rather than misinforming.
    const specChanged =
      args.spec !== undefined &&
      JSON.stringify(spec) !== JSON.stringify(task.spec);
    await ctx.db.patch(args.taskId, {
      title,
      prompt,
      spec,
      revision,
      currentRevisionId: revisionId,
      // cursorAt is deliberately NOT reset. Resetting forward would drop an
      // occurrence that already came due; resetting back would backfill. The
      // timeline is independent of edits.
      ...(specChanged ? { nextRunAt: undefined } : {}),
      invalidReason: undefined,
      updatedAt: now,
    });
    return { revision };
  },
});

export const pause = mutation({
  args: { taskId: v.id("scheduledTasks") },
  handler: async (ctx, { taskId }) => {
    const userId = await requireUserId(ctx);
    const task = await requireTaskAccess(ctx, userId, taskId);
    if (task.status !== "active") return { paused: false, held: 0 };
    const now = Date.now();
    await ctx.db.patch(taskId, {
      status: "paused",
      pausedAt: now,
      updatedAt: now,
    });
    // Work already created stays durable — suppressed, not discarded.
    const held = await holdOpenForTask(ctx, taskId);
    return { paused: true, held };
  },
});

export const resume = mutation({
  args: { taskId: v.id("scheduledTasks") },
  handler: async (ctx, { taskId }) => {
    const userId = await requireUserId(ctx);
    const task = await requireTaskAccess(ctx, userId, taskId);
    if (task.status !== "paused") return { resumed: false, released: 0 };

    const now = Date.now();
    // THE pause rule, in one line: jumping the cursor to the resume instant is
    // what makes occurrences inside the pause window unreachable forever. They
    // are suppressed by intent and must never be backfilled.
    const cursorAt = Math.max(task.cursorAt, now);

    // A one-time task whose only instant fell inside the pause can never fire
    // (no backfill) and must not sit "active" forever pretending it will.
    if (task.spec.kind === "once" && task.spec.runAt <= now) {
      const key = occurrenceKey(taskId, "scheduled", task.spec.runAt);
      const existing = await ctx.db
        .query("scheduledTaskOccurrences")
        .withIndex("by_occurrence_key", (q) => q.eq("occurrenceKey", key))
        .unique();
      if (!existing) {
        await ctx.db.patch(taskId, {
          status: "completed",
          pausedAt: undefined,
          cursorAt,
          terminalReason: "suppressed_by_pause",
          updatedAt: now,
        });
        const released = await releaseHeldForTask(ctx, taskId);
        return { resumed: true, released, completed: true };
      }
    }

    await ctx.db.patch(taskId, {
      status: "active",
      pausedAt: undefined,
      cursorAt,
      updatedAt: now,
    });
    const released = await releaseHeldForTask(ctx, taskId);
    return { resumed: true, released };
  },
});

export const remove = mutation({
  args: { taskId: v.id("scheduledTasks") },
  handler: async (ctx, { taskId }) => {
    const userId = await requireUserId(ctx);
    await requireTaskAccess(ctx, userId, taskId);
    const now = Date.now();
    // Soft delete: occurrence history keeps pointing at a real task row, and
    // revisions stay resolvable. The task disappears from every read path.
    await ctx.db.patch(taskId, {
      status: "deleted",
      terminalReason: "deleted",
      updatedAt: now,
    });
    await cancelOpenForTask(ctx, taskId, "task_deleted");
    return { deleted: true };
  },
});

export const runNow = mutation({
  args: { taskId: v.id("scheduledTasks") },
  handler: async (ctx, { taskId }) => {
    const userId = await requireUserId(ctx);
    const task = await requireTaskAccess(ctx, userId, taskId);
    if (!task.currentRevisionId) badRequest("Task is not ready");

    const now = Date.now();
    // Bound manual dispatch: without this a user could queue thousands of
    // manual occurrences. Refusing EXPLICITLY (rather than silently dropping)
    // is the difference between a guard and a lost run.
    const open = await ctx.db
      .query("scheduledTaskOccurrences")
      .withIndex("by_task_scheduled", (q) => q.eq("taskId", taskId))
      .order("desc")
      .take(50);
    const pendingManual = open.find(
      (o) =>
        o.kind === "manual" &&
        o.status !== "succeeded" &&
        o.status !== "failed" &&
        o.status !== "cancelled",
    );
    if (pendingManual) {
      return { queued: false, reason: "already_queued" as const };
    }

    // `kind` is part of the key, so a manual run in the same millisecond as a
    // scheduled instant is a DIFFERENT occurrence, not a silent collision.
    const key = occurrenceKey(taskId, "manual", now);
    const existing = await ctx.db
      .query("scheduledTaskOccurrences")
      .withIndex("by_occurrence_key", (q) => q.eq("occurrenceKey", key))
      .unique();
    if (existing) return { queued: false, reason: "already_queued" as const };

    await ctx.db.insert("scheduledTaskOccurrences", {
      occurrenceKey: key,
      taskId,
      userId,
      workspaceId: task.workspaceId,
      revisionId: task.currentRevisionId,
      revision: task.revision,
      scheduledFor: now,
      kind: "manual",
      // A manual run on a paused task is held, exactly like a scheduled one:
      // pause means "do not execute", whatever the trigger.
      status: task.status === "paused" ? "held" : "queued",
      attempts: 0,
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
    });
    return { queued: true, reason: null };
  },
});

/**
 * Execution history for one task, newest first.
 *
 * DELIBERATELY EXCLUDES IN-FLIGHT ROWS (`running` / `retrying`), which is a
 * performance guarantee, not a filter for tidiness. A running occurrence is
 * heartbeated every 30s; Convex re-sends a query's whole result to every
 * subscriber on any write to a row it read, so leaving the live row in this
 * list would re-push the entire history twice a minute for the duration of a
 * run. `activeRun` below returns the live row on its own and the UI
 * concatenates. This is the same discipline chat uses — `listPaged` excludes
 * in-flight rows so it stays stable during a generation.
 *
 * Cursor paging on `scheduledFor` rather than `.paginate()`: the in-flight
 * filter would otherwise hand back short, ragged pages.
 */
export const history = query({
  args: {
    // Mounted from a URL id alongside get/activeRun, so it degrades the same way.
    taskId: v.string(),
    before: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { taskId, before, limit }) => {
    const userId = await requireUserId(ctx).catch(() => null);
    const task = userId
      ? await optionalTaskAccess(ctx, userId, taskId)
      : null;
    // An empty page, not a throw: the panel renders its deleted state and the
    // browser console stays clean.
    if (!task) return { page: [], nextCursor: null };
    const cap = Math.min(Math.max(limit ?? 25, 1), 100);
    // Over-fetch, because the in-flight filter below removes rows: a task with
    // a run in progress would otherwise hand back a short page.
    const fetchCap = cap * 2 + 10;
    const rows = await ctx.db
      .query("scheduledTaskOccurrences")
      .withIndex("by_task_scheduled", (q) =>
        before === undefined
          ? q.eq("taskId", task._id)
          : q.eq("taskId", task._id).lt("scheduledFor", before),
      )
      .order("desc")
      .take(fetchCap);

    const settled = rows.filter(
      (o) => o.status !== "running" && o.status !== "retrying",
    );
    const page = settled.slice(0, cap);
    // More to show if we filtered/sliced anything off, or if the index scan
    // itself hit the fetch ceiling. null makes "Load more" disappear.
    const hasMore = settled.length > cap || rows.length >= fetchCap;
    return {
      page: page.map(publicOccurrence),
      nextCursor:
        hasMore && page.length > 0
          ? (page[page.length - 1]?.scheduledFor ?? null)
          : null,
    };
  },
});

/**
 * The task's currently-executing occurrence, or null.
 *
 * A single small document, exactly like `chat.stream.active`: this is the ONLY
 * scheduled query that re-fires during a run, so the heartbeat cannot churn the
 * history list.
 */
export const activeRun = query({
  args: { taskId: v.string() },
  handler: async (ctx, { taskId }) => {
    const userId = await requireUserId(ctx).catch(() => null);
    if (!userId) return null;
    const task = await optionalTaskAccess(ctx, userId, taskId);
    if (!task) return null;
    for (const status of ["running", "retrying"] as const) {
      const row = await ctx.db
        .query("scheduledTaskOccurrences")
        .withIndex("by_task_status_scheduled", (q) =>
          q.eq("taskId", task._id).eq("status", status),
        )
        .order("desc")
        .first();
      if (row) return publicOccurrence(row);
    }
    return null;
  },
});

/** Cancel one in-flight or pending occurrence, durably. */
export const cancelOccurrence = mutation({
  args: { occurrenceId: v.id("scheduledTaskOccurrences") },
  handler: async (ctx, { occurrenceId }) => {
    const userId = await requireUserId(ctx);
    const occ = await ctx.db.get(occurrenceId);
    if (!occ || occ.userId !== userId) throw new ConvexError("Not found");
    await requireTaskAccess(ctx, userId, occ.taskId);
    const now = Date.now();
    if (
      occ.status === "succeeded" ||
      occ.status === "failed" ||
      occ.status === "cancelled"
    ) {
      return { cancelled: false, reason: "already_terminal" as const };
    }
    if (occ.status === "running") {
      // Durable request; the worker sees it on its next heartbeat.
      await ctx.db.patch(occurrenceId, {
        cancelRequested: true,
        updatedAt: now,
      });
      return { cancelled: false, reason: "requested" as const };
    }
    await ctx.db.patch(occurrenceId, {
      status: "cancelled",
      cancelRequested: true,
      finishedAt: now,
      terminalReason: "cancelled_by_user",
      leaseToken: undefined,
      updatedAt: now,
    });
    return { cancelled: true, reason: null };
  },
});


/**
 * One execution's result, rendered by the SAME message renderer chat uses.
 *
 * `taskId` is not decoration: an occurrence id from a URL must be proven to
 * belong to THIS task as well as to this user, or a user who owns two tasks
 * could read one task's run under the other's route.
 */
export const runResult = query({
  args: {
    taskId: v.id("scheduledTasks"),
    occurrenceId: v.id("scheduledTaskOccurrences"),
  },
  handler: async (ctx, { taskId, occurrenceId }) => {
    const userId = await requireUserId(ctx);
    await requireTaskAccess(ctx, userId, taskId);
    const occ = await ctx.db.get(occurrenceId);
    if (!occ || occ.taskId !== taskId || occ.userId !== userId) {
      throw new ConvexError("Not found");
    }
    const revision = await ctx.db.get(occ.revisionId);
    const message = occ.messageId ? await ctx.db.get(occ.messageId) : null;
    return {
      occurrence: publicOccurrence(occ),
      // The prompt this run actually executed — the PINNED revision, never the
      // task's current one.
      prompt: revision?.prompt ?? null,
      // ...and the zone it was scheduled in, for the same reason. The viewer
      // used to format these instants as literal UTC, which is why a Kolkata
      // task showed 18:44 beside a 00:14 chip. Reading it off the pinned
      // revision rather than the task means editing a task's timezone later
      // does not silently re-date every run that already happened.
      timezone: revision?.spec?.timezone ?? null,
      revision: occ.revision,
      // null when the run never produced a message (claimed then cancelled, or
      // still starting). The viewer renders "no result yet" rather than failing.
      message: message ? await toPublic(ctx, message) : null,
    };
  },
});

/**
 * The task's execution transcript, read-only.
 *
 * Backs "Open chat" WITHOUT routing into /chat: the scheduled thread stays
 * hidden from the conversation list, and this surface renders no composer, so
 * there is no send path to expose. Phase 2's `assertCanGenerate` guard refuses
 * a send into a scheduled thread anyway — two independent layers.
 */
export const transcript = query({
  args: {
    taskId: v.id("scheduledTasks"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { taskId, paginationOpts }) => {
    const userId = await requireUserId(ctx);
    const task = await requireTaskAccess(ctx, userId, taskId);
    // A task that has never run has no thread yet. Return the same shape
    // paginate() would, so the caller needs no special case.
    if (!task.executionThreadId) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const res = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread_seq", (q) =>
        q.eq("threadId", task.executionThreadId as Id<"chatThreads">),
      )
      .order("desc")
      .paginate(paginationOpts);
    return {
      ...res,
      page: await Promise.all(res.page.map((m) => toPublic(ctx, m))),
    };
  },
});

/** Per-task in-app notification preferences. Absent means enabled. */
export const setNotifyPrefs = mutation({
  args: {
    taskId: v.id("scheduledTasks"),
    notifyOnSuccess: v.optional(v.boolean()),
    notifyOnFailure: v.optional(v.boolean()),
    // Phase 4 email preferences. Separate from the in-app pair, and separately
    // defaulted: absent means DISABLED here, so no task emails anyone until its
    // owner asks for it.
    emailOnSuccess: v.optional(v.boolean()),
    emailOnFailure: v.optional(v.boolean()),
    attachPdf: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireTaskAccess(ctx, userId, args.taskId);
    const patch: Partial<Doc<"scheduledTasks">> = { updatedAt: Date.now() };
    if (args.notifyOnSuccess !== undefined) {
      patch.notifyOnSuccess = args.notifyOnSuccess;
    }
    if (args.notifyOnFailure !== undefined) {
      patch.notifyOnFailure = args.notifyOnFailure;
    }
    if (args.emailOnSuccess !== undefined) {
      patch.emailOnSuccess = args.emailOnSuccess;
    }
    if (args.emailOnFailure !== undefined) {
      patch.emailOnFailure = args.emailOnFailure;
    }
    if (args.attachPdf !== undefined) patch.attachPdf = args.attachPdf;
    await ctx.db.patch(args.taskId, patch);
    return { ok: true };
  },
});

/**
 * Delivery outcomes for a task's runs, keyed by occurrence.
 *
 * A SEPARATE query rather than a field on `history`, for the same reason
 * `activeRun` is separate: a delivery row is written after the run is terminal
 * and then patched again by the provider webhook, so folding it into the history
 * page would make that page re-send to every subscriber on an event that has
 * nothing to do with the list. Delivery rows are few and stable, so this is one
 * small extra subscription rather than a chatty one.
 */
export const deliveries = query({
  args: { taskId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { taskId, limit }) => {
    const userId = await requireUserId(ctx).catch(() => null);
    if (!userId) return [];
    const task = await optionalTaskAccess(ctx, userId, taskId);
    if (!task) return [];
    const cap = Math.min(Math.max(limit ?? 50, 1), 200);
    const rows = await ctx.db
      .query("scheduledDeliveries")
      .withIndex("by_user_created", (q) => q.eq("userId", userId))
      .order("desc")
      .take(cap * 3);
    return rows
      .filter((r) => r.taskId === task._id)
      .slice(0, cap)
      .map((r) => ({
        occurrenceKey: r.occurrenceKey,
        // `accepted` is not `delivered` — the UI must be able to say which.
        status: r.status,
        pdfStatus: r.pdfStatus,
        attachment: r.attachment,
        errorCode: r.errorCode ?? null,
        // Deliberately NOT the recipient: it is the caller's own address, so
        // echoing it adds nothing and puts PII in one more place.
        updatedAt: r.updatedAt,
      }));
  },
});
