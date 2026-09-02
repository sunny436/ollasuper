import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalMutation, mutation, query } from "../_generated/server";
import { bump } from "../counters";
import { recordUsage } from "../usage";
import { deleteArtifactsForMessage } from "./artifacts";
import { bindAttachments } from "./attachments";
import { toPublic } from "./public";
import {
  assertAllowedModel,
  DEFAULT_MODEL,
  getUserIdOrNull,
  requireMessageAccess,
  requireThreadAccess,
  requireUserId,
} from "./authz";
import { titleFromText } from "./threads";

const EMPTY_PAGE = { page: [], isDone: true, continueCursor: "" };

const MAX_CONTENT = 100_000;
/** A user may have this many generations running at once, across all threads. */
const MAX_CONCURRENT_STREAMS = 3;
// Phase 7: total wall-clock deadline for one turn (incl. any reaper resumes).
// Mirrors the Python ai_agent_total_deadline_s; the reaper fails a stream past
// this instead of resuming it.
const AGENT_TOTAL_DEADLINE_MS = 300_000;
const MAX_ATTACHMENTS = 6;
/** Bound for truncate/delete cascades. */
const TAIL_BATCH = 200;

/** Context window handed to the Python service. */
const HISTORY_MAX_MESSAGES = 60;
/**
 * TRANSPORT bound on the Convex -> Python payload. NOT a token budget.
 *
 * Characters are not tokens, and the ratio swings by a factor of three between
 * prose and code, so this number cannot stand in for one. The real budget is
 * computed in agent/context.py:budget_for against the model's actual context
 * window from the OpenRouter catalogue, and trim() enforces it. This bound
 * exists only so a pathological thread cannot post a megabyte over HTTP.
 *
 * It was 24_000, which is roughly 6k tokens against a 32k-token Python budget:
 * Convex was destroying content five times sooner than the layer that actually
 * knows the window. A 25,348-char blog therefore never reached the model, and
 * the model correctly said it could not see it.
 */
const HISTORY_MAX_CHARS = 96_000;
/**
 * Below this there is no point clipping — a 200-character fragment of an
 * article tells the model less than the marker does.
 */
const MIN_CLIP_CHARS = 2_000;
/**
 * Floor for a PINNED message (the newest turn, and the newest assistant turn).
 * Those two are what a follow-up refers to, so they are never absent — at worst
 * they arrive clipped.
 */
const PINNED_MIN_CHARS = 6_000;
/**
 * The most of the REMAINING budget any one clipped message may claim.
 *
 * Without this the fix relocates the bug rather than removing it: a 200k
 * message clipped to the whole remaining budget leaves nothing for the older
 * turns, so the thread keeps its newest artifact and loses the subject that
 * gives it meaning. Caught by chat.context.test.ts, which asserted on the
 * compiled history and returned ['HUGE', 'NEWEST'] with both older messages
 * gone.
 *
 * Half is arbitrary but the property is not: one message must never be able to
 * starve every message behind it.
 */
const MAX_SINGLE_CLIP_SHARE = 0.5;

/**
 * Clip to `room`, keeping the head AND the tail with an explicit marker.
 *
 * Head-and-tail rather than head-only because the ends of a document are the
 * parts a follow-up asks about: the title and opening frame the subject, the
 * conclusion and closing sections are what an "expand this" turn continues.
 *
 * The marker is the load-bearing part. A silently dropped message leaves the
 * model believing the content never existed, which is how a retrieval failure
 * turns into a confident false statement to the user; a marked elision tells it
 * the text exists and can be asked for.
 */
function clipForContext(text: string, room: number): string {
  const marker =
      "\n\n[... this message was truncated to fit the context window. The full " +
      "text exists earlier in this conversation and can be quoted back in full " +
      "on request; do not tell the user the content is missing ...]\n\n";
  const usable = Math.max(0, room - marker.length);
  if (usable <= 0 || text.length <= room) return text.slice(0, room);
  const head = Math.ceil(usable * 0.6);
  const tail = usable - head;
  return text.slice(0, head) + marker + (tail > 0 ? text.slice(-tail) : "");
}

/** A message is "in flight" while the assistant is still producing it. */
function isInFlight(m: Doc<"chatMessages">): boolean {
  return m.status === "pending" || m.status === "streaming";
}

/**
 * Settled messages only, newest-first (the client reverses for display and
 * pages backwards for history).
 *
 * In-flight messages are EXCLUDED on purpose. Convex hands back fresh object
 * identities on every push, so if the streaming row lived in this array every
 * token would invalidate the whole page and re-render every message in the
 * thread. The in-flight row is served by chat.stream.active instead, which is
 * a single tiny document.
 */
export const listPaged = query({
  args: { threadId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const userId = await getUserIdOrNull(ctx);
    if (!userId) return EMPTY_PAGE;
    const id = ctx.db.normalizeId("chatThreads", args.threadId);
    if (!id) return EMPTY_PAGE;
    await requireThreadAccess(ctx, userId, id);

    const res = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread_seq", (q) => q.eq("threadId", id))
      .order("desc")
      .paginate(args.paginationOpts);

    const settled = res.page.filter((m) => !isInFlight(m));
    return {
      ...res,
      page: await Promise.all(settled.map((m) => toPublic(ctx, m))),
    };
  },
});

export const get = query({
  args: { messageId: v.id("chatMessages") },
  handler: async (ctx, { messageId }) => {
    const userId = await getUserIdOrNull(ctx);
    if (!userId) return null;
    const { message } = await requireMessageAccess(ctx, userId, messageId);
    return await toPublic(ctx, message);
  },
});

/**
 * Rate limit: generations started per user per rolling hour.
 *
 * MAX_CONCURRENT_STREAMS alone is not a spend control — it bounds *parallel*
 * generations, not *sequential* ones. A `send → stop → retry` loop never has
 * more than one stream running and can be driven as fast as the round trip
 * allows, each iteration billing a full context to OpenRouter. This is the
 * only thing standing between one compromised session and an unbounded bill.
 *
 * Fixed window, not sliding: a sliding window needs per-event rows, and the
 * failure mode of a fixed window (2x the limit across a boundary) is
 * irrelevant at this scale.
 */
const MAX_GENERATIONS_PER_HOUR = 120;
const RATE_WINDOW_MS = 60 * 60 * 1000;

async function assertRateLimit(
  ctx: MutationCtx,
  userId: Id<"users">,
  workspaceId: Id<"workspaces">,
) {
  const now = Date.now();
  const settings = await ctx.db
    .query("chatSettings")
    .withIndex("by_user_workspace", (q) =>
      q.eq("userId", userId).eq("workspaceId", workspaceId),
    )
    .unique();

  const start = settings?.rateWindowStart ?? 0;
  const fresh = now - start >= RATE_WINDOW_MS;
  const count = fresh ? 0 : (settings?.rateWindowCount ?? 0);

  if (count >= MAX_GENERATIONS_PER_HOUR) {
    const mins = Math.ceil((start + RATE_WINDOW_MS - now) / 60_000);
    throw new ConvexError(
      `Hourly message limit reached — try again in ${mins} minute${mins === 1 ? "" : "s"}`,
    );
  }

  const patch = {
    rateWindowStart: fresh ? now : start,
    rateWindowCount: count + 1,
  };
  if (settings) {
    await ctx.db.patch(settings._id, patch);
  } else {
    await ctx.db.insert("chatSettings", {
      workspaceId,
      userId,
      defaultModel: DEFAULT_MODEL,
      sendOnEnter: true,
      updatedAt: now,
      ...patch,
    });
  }
}

/** Reject a second concurrent generation, per-thread and per-user. */
async function assertCanGenerate(
  ctx: MutationCtx,
  userId: Id<"users">,
  thread: Doc<"chatThreads">,
) {
  // Scheduled Tasks (Phase 2). A scheduled task's execution thread is an
  // INTERNAL history mechanism, not a conversation. Every interactive
  // turn-start path — send, regenerate, retry, editUserMessage — funnels
  // through here, so this single guard is what stops a user message ever
  // contaminating a scheduled run's context. The scheduled path does not call
  // this function; it goes through scheduled/execution.ts.
  if (thread.status === "scheduled") {
    throw new ConvexError("Not found");
  }
  if (thread.streamingMessageId) {
    throw new ConvexError("This conversation is already generating a reply");
  }
  const running = await ctx.db
    .query("chatStreams")
    .withIndex("by_user_status", (q) =>
      q.eq("userId", userId).eq("status", "running"),
    )
    .take(MAX_CONCURRENT_STREAMS + 1);
  const queued = await ctx.db
    .query("chatStreams")
    .withIndex("by_user_status", (q) =>
      q.eq("userId", userId).eq("status", "queued"),
    )
    .take(MAX_CONCURRENT_STREAMS + 1);
  if (running.length + queued.length >= MAX_CONCURRENT_STREAMS) {
    throw new ConvexError(
      "Too many generations in progress — wait for one to finish",
    );
  }
  // Last, so that a user who is merely clicking too fast gets the clearer
  // "already generating" message and does not burn window budget on it.
  await assertRateLimit(ctx, userId, thread.workspaceId);
}

/**
 * Create the assistant placeholder + its stream control row and dispatch.
 * Shared by send / regenerate / retry so there is exactly one dispatch path.
 */
export async function startAssistantTurn(
  ctx: MutationCtx,
  thread: Doc<"chatThreads">,
  userId: Id<"users">,
  opts: {
    seq: number;
    model: string;
    parentId?: Id<"chatMessages">;
    variantIndex?: number;
    reuseMessageId?: Id<"chatMessages">;
    // Phase 2 (scheduled tasks only; both undefined on every chat turn).
    //
    // `deadlineMs` widens the per-turn budget — the Python runner adopts
    // chatStreams.deadlineAt directly (runner.py `_compute_deadline_mono`), and
    // stream.reapStalled fails a past-deadline turn, so this one field is the
    // whole deadline chain.
    //
    // `attempts` is LOAD-BEARING on a scheduled retry. dispatchPayload computes
    // `doResume = attempt > 0 || hasEvents`, and a fresh stream has neither —
    // so without seeding this, a retry would NOT replay completedTools /
    // attemptedTools and every side-effecting tool the previous attempt ran
    // would execute a second time.
    deadlineMs?: number;
    attempts?: number;
  },
): Promise<{ assistantMessageId: Id<"chatMessages">; streamId: string }> {
  const now = Date.now();
  let assistantMessageId: Id<"chatMessages">;

  if (opts.reuseMessageId) {
    assistantMessageId = opts.reuseMessageId;
    await ctx.db.patch(assistantMessageId, {
      content: "",
      status: "pending",
      error: undefined,
      errorCode: undefined,
      finishReason: undefined,
      // The folded timeline of the FAILED attempt: the turn regenerates from the
      // durable checkpoint, so leaving it would render the old run's tool rows
      // alongside the new ones.
      events: undefined,
      model: opts.model,
      updatedAt: now,
    });
  } else {
    assistantMessageId = await ctx.db.insert("chatMessages", {
      threadId: thread._id,
      workspaceId: thread.workspaceId,
      userId,
      role: "assistant",
      seq: opts.seq,
      content: "",
      status: "pending",
      parentId: opts.parentId,
      variantIndex: opts.variantIndex,
      model: opts.model,
      provider: "openrouter",
      createdAt: now,
      updatedAt: now,
    });
  }

  // Drop any stale stream row for a reused message before inserting the new one.
  const stale = await ctx.db
    .query("chatStreams")
    .withIndex("by_message", (q) => q.eq("messageId", assistantMessageId))
    .unique();
  if (stale) await ctx.db.delete(stale._id);

  // The capability handed to the Python service. A leaked ingress secret still
  // cannot target a thread without one of these.
  const streamId = crypto.randomUUID();
  await ctx.db.insert("chatStreams", {
    streamId,
    messageId: assistantMessageId,
    threadId: thread._id,
    workspaceId: thread.workspaceId,
    userId,
    status: "queued",
    cancelRequested: false,
    chunkSeq: -1,
    committedText: "",
    committedSeq: -1,
    heartbeatAt: now,
    startedAt: now,
    attempts: opts.attempts ?? 0,
    deadlineAt: now + (opts.deadlineMs ?? AGENT_TOTAL_DEADLINE_MS),
  });

  await ctx.db.patch(thread._id, {
    streamingMessageId: assistantMessageId,
    updatedAt: now,
  });

  await ctx.scheduler.runAfter(0, internal.chat.stream.dispatch, { streamId });
  return { assistantMessageId, streamId };
}

export const send = mutation({
  args: {
    threadId: v.id("chatThreads"),
    content: v.string(),
    clientId: v.string(),
    model: v.optional(v.string()),
    attachmentIds: v.optional(v.array(v.id("chatAttachments"))),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const thread = await requireThreadAccess(ctx, userId, args.threadId);

    // Idempotency: a network retry, a double-Enter, or React StrictMode's
    // double-invoke must not produce two turns.
    const dup = await ctx.db
      .query("chatMessages")
      .withIndex("by_client_id", (q) =>
        q.eq("userId", userId).eq("clientId", args.clientId),
      )
      .first();
    if (dup) {
      const stream = thread.streamingMessageId
        ? await ctx.db
            .query("chatStreams")
            .withIndex("by_message", (q) =>
              q.eq(
                "messageId",
                thread.streamingMessageId as Id<"chatMessages">,
              ),
            )
            .unique()
        : null;
      return {
        userMessageId: dup._id,
        assistantMessageId: thread.streamingMessageId ?? null,
        streamId: stream?.streamId ?? null,
        deduped: true,
      };
    }

    const content = args.content.trim();
    const attachmentIds = args.attachmentIds ?? [];
    if (!content && attachmentIds.length === 0) {
      throw new ConvexError("Message cannot be empty");
    }
    if (content.length > MAX_CONTENT) {
      throw new ConvexError("Message too long");
    }
    if (attachmentIds.length > MAX_ATTACHMENTS) {
      throw new ConvexError(
        `At most ${MAX_ATTACHMENTS} attachments per message`,
      );
    }

    await assertCanGenerate(ctx, userId, thread);
    const attachments = await bindAttachments(
      ctx,
      userId,
      thread._id,
      attachmentIds,
    );

    const model = await assertAllowedModel(ctx, args.model ?? thread.model, {
      // A re-sent, UNCHANGED stored model (e.g. a legacy OpenRouter id on a
      // pre-migration thread) is treated as non-explicit, so it re-homes to
      // DEFAULT_MODEL instead of throwing "Unsupported model". A genuine new
      // pick (args.model !== thread.model) stays strict.
      explicit: args.model !== undefined && args.model !== thread.model,
    });
    const now = Date.now();
    const userSeq = thread.nextSeq;
    const assistantSeq = userSeq + 1;

    const userMessageId = await ctx.db.insert("chatMessages", {
      threadId: thread._id,
      workspaceId: thread.workspaceId,
      userId,
      role: "user",
      seq: userSeq,
      content,
      status: "complete",
      clientId: args.clientId,
      attachmentIds: attachmentIds.length ? attachmentIds : undefined,
      variantCount: 1,
      activeVariantIndex: 0,
      createdAt: now,
      updatedAt: now,
    });

    for (const a of attachments) {
      await ctx.db.patch(a._id, {
        messageId: userMessageId,
        threadId: thread._id,
      });
    }

    await ctx.db.patch(thread._id, {
      nextSeq: assistantSeq + 1,
      messageCount: thread.messageCount + 2,
      lastMessageAt: now,
      model,
      // First real message names the thread until the auto-titler improves it.
      ...(thread.titleSource === "auto" && thread.messageCount === 0 && content
        ? { title: titleFromText(content) }
        : {}),
    });

    const { assistantMessageId, streamId } = await startAssistantTurn(
      ctx,
      { ...thread, model },
      userId,
      { seq: assistantSeq, model, parentId: userMessageId, variantIndex: 0 },
    );

    await recordUsage(ctx, thread.workspaceId, "chat.messages");
    await bump(ctx, thread.workspaceId, "chatMessages", 2);

    return { userMessageId, assistantMessageId, streamId, deduped: false };
  },
});

/**
 * Regenerate the last assistant reply as a sibling variant.
 *
 * Tail-only by design: mid-thread regenerate would turn the message list into a
 * DAG. To change something earlier, the client uses editUserMessage, which
 * truncates and resends.
 */
export const regenerate = mutation({
  args: { messageId: v.id("chatMessages"), model: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const { message, thread } = await requireMessageAccess(
      ctx,
      userId,
      args.messageId,
    );
    if (message.role !== "assistant") {
      throw new ConvexError("Only assistant replies can be regenerated");
    }
    if (message.seq !== thread.nextSeq - 1) {
      throw new ConvexError("Only the latest reply can be regenerated");
    }
    await assertCanGenerate(ctx, userId, thread);

    const model = await assertAllowedModel(ctx, args.model ?? thread.model, {
      // A re-sent, UNCHANGED stored model (e.g. a legacy OpenRouter id on a
      // pre-migration thread) is treated as non-explicit, so it re-homes to
      // DEFAULT_MODEL instead of throwing "Unsupported model". A genuine new
      // pick (args.model !== thread.model) stays strict.
      explicit: args.model !== undefined && args.model !== thread.model,
    });
    const parentId = message.parentId;
    let variantIndex = 0;
    if (parentId) {
      const parent = await ctx.db.get(parentId);
      if (parent) {
        variantIndex = parent.variantCount ?? 1;
        await ctx.db.patch(parentId, {
          variantCount: variantIndex + 1,
          activeVariantIndex: variantIndex,
        });
      }
    }

    const { assistantMessageId, streamId } = await startAssistantTurn(
      ctx,
      thread,
      userId,
      { seq: thread.nextSeq, model, parentId, variantIndex },
    );
    await ctx.db.patch(thread._id, { nextSeq: thread.nextSeq + 1 });
    return { assistantMessageId, streamId };
  },
});

/** Retry a failed or aborted reply in place — no new variant. */
export const retry = mutation({
  args: { messageId: v.id("chatMessages"), model: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const { message, thread } = await requireMessageAccess(
      ctx,
      userId,
      args.messageId,
    );
    if (message.status !== "error" && message.status !== "aborted") {
      throw new ConvexError("Only failed replies can be retried");
    }
    await assertCanGenerate(ctx, userId, thread);
    const model = await assertAllowedModel(ctx, args.model ?? thread.model, {
      // A re-sent, UNCHANGED stored model (e.g. a legacy OpenRouter id on a
      // pre-migration thread) is treated as non-explicit, so it re-homes to
      // DEFAULT_MODEL instead of throwing "Unsupported model". A genuine new
      // pick (args.model !== thread.model) stays strict.
      explicit: args.model !== undefined && args.model !== thread.model,
    });
    // Seed `attempts` so dispatchPayload's `doResume` is true and the retry
    // REPLAYS the surviving toolExecutions checkpoint instead of re-running every
    // completed call from zero. Without it a retry after a timeout paid for the
    // same research twice and hit the same wall. (The scheduled path already
    // passes this, for exactly this reason — see the note on `attempts` above.)
    const prior = await ctx.db
      .query("chatStreams")
      .withIndex("by_message", (q) => q.eq("messageId", message._id))
      .unique();
    const { streamId } = await startAssistantTurn(ctx, thread, userId, {
      seq: message.seq,
      model,
      reuseMessageId: message._id,
      attempts: (prior?.attempts ?? 0) + 1,
    });
    return { assistantMessageId: message._id, streamId };
  },
});

export const setActiveVariant = mutation({
  args: { userMessageId: v.id("chatMessages"), variantIndex: v.number() },
  handler: async (ctx, { userMessageId, variantIndex }) => {
    const userId = await requireUserId(ctx);
    const { message } = await requireMessageAccess(ctx, userId, userMessageId);
    const count = message.variantCount ?? 1;
    if (variantIndex < 0 || variantIndex >= count) {
      throw new ConvexError("No such variant");
    }
    await ctx.db.patch(userMessageId, { activeVariantIndex: variantIndex });
  },
});

/**
 * Edit a user message: truncate everything from that point and resend.
 * The truncate is bounded and continues in purgeTail if the thread is long.
 */
export const editUserMessage = mutation({
  args: {
    messageId: v.id("chatMessages"),
    content: v.string(),
    clientId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const { message, thread } = await requireMessageAccess(
      ctx,
      userId,
      args.messageId,
    );
    if (message.role !== "user") {
      throw new ConvexError("Only your own messages can be edited");
    }
    const content = args.content.trim();
    if (!content) throw new ConvexError("Message cannot be empty");
    if (content.length > MAX_CONTENT) throw new ConvexError("Message too long");
    await assertCanGenerate(ctx, userId, thread);

    const removed = await deleteFromSeq(ctx, thread._id, message.seq);
    if (removed === TAIL_BATCH) {
      await ctx.scheduler.runAfter(0, internal.chat.messages.purgeTail, {
        threadId: thread._id,
        fromSeq: message.seq,
      });
    }

    const now = Date.now();
    const userSeq = message.seq;
    const assistantSeq = userSeq + 1;
    const userMessageId = await ctx.db.insert("chatMessages", {
      threadId: thread._id,
      workspaceId: thread.workspaceId,
      userId,
      role: "user",
      seq: userSeq,
      content,
      status: "complete",
      clientId: args.clientId,
      variantCount: 1,
      activeVariantIndex: 0,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.patch(thread._id, {
      nextSeq: assistantSeq + 1,
      messageCount: Math.max(0, userSeq + 2),
      lastMessageAt: now,
    });

    const { assistantMessageId, streamId } = await startAssistantTurn(
      ctx,
      thread,
      userId,
      {
        seq: assistantSeq,
        // Not explicit: an edit re-uses whatever the thread already stores,
        // and that id may have left the catalogue since. Re-home rather than
        // refuse — otherwise editing strands the user in their own thread.
        model: await assertAllowedModel(ctx, thread.model),
        parentId: userMessageId,
        variantIndex: 0,
      },
    );
    return { userMessageId, assistantMessageId, streamId };
  },
});

/** Delete messages with seq >= fromSeq, plus their stream rows and chunks. */
async function deleteFromSeq(
  ctx: MutationCtx,
  threadId: Id<"chatThreads">,
  fromSeq: number,
): Promise<number> {
  const doomed = await ctx.db
    .query("chatMessages")
    .withIndex("by_thread_seq", (q) =>
      q.eq("threadId", threadId).gte("seq", fromSeq),
    )
    .take(TAIL_BATCH);
  for (const m of doomed) {
    const chunks = await ctx.db
      .query("chatStreamChunks")
      .withIndex("by_message_seq", (q) => q.eq("messageId", m._id))
      .collect();
    for (const c of chunks) await ctx.db.delete(c._id);
    const stream = await ctx.db
      .query("chatStreams")
      .withIndex("by_message", (q) => q.eq("messageId", m._id))
      .unique();
    if (stream) await ctx.db.delete(stream._id);
    if (m.attachmentIds) {
      for (const aid of m.attachmentIds) {
        const a = await ctx.db.get(aid);
        if (a) {
          await ctx.storage.delete(a.storageId);
          await ctx.db.delete(a._id);
        }
      }
    }
    // Reclaim this message's generated artifacts (blobs). Regenerate/edit
    // previously left these until thread deletion; clean them here.
    await deleteArtifactsForMessage(ctx, m._id);
    await ctx.db.delete(m._id);
  }
  return doomed.length;
}

export const purgeTail = internalMutation({
  args: { threadId: v.id("chatThreads"), fromSeq: v.number() },
  handler: async (ctx, { threadId, fromSeq }) => {
    const n = await deleteFromSeq(ctx, threadId, fromSeq);
    if (n === TAIL_BATCH) {
      await ctx.scheduler.runAfter(0, internal.chat.messages.purgeTail, {
        threadId,
        fromSeq,
      });
    }
  },
});

export const remove = mutation({
  args: { messageId: v.id("chatMessages") },
  handler: async (ctx, { messageId }) => {
    const userId = await requireUserId(ctx);
    const { message, thread } = await requireMessageAccess(
      ctx,
      userId,
      messageId,
    );
    if (thread.streamingMessageId === messageId) {
      throw new ConvexError("Stop the generation before deleting this message");
    }
    // deleteFromSeq removes EVERYTHING from this seq onward, which can include
    // an in-flight assistant message at a higher seq. Leaving
    // streamingMessageId pointing at a deleted row bricks the thread:
    // assertCanGenerate throws "already generating" forever, and stop/retry
    // both fail with "Not found" because the row is gone.
    const streaming = thread.streamingMessageId
      ? await ctx.db.get(thread.streamingMessageId)
      : null;
    const clearsStream = !streaming || streaming.seq >= message.seq;

    await deleteFromSeq(ctx, thread._id, message.seq);
    await ctx.db.patch(thread._id, {
      messageCount: Math.max(0, message.seq),
      ...(clearsStream ? { streamingMessageId: undefined } : {}),
      updatedAt: Date.now(),
    });
  },
});

/**
 * The bounded context window handed to the Python service.
 *
 * A plain helper, not an internalQuery: its only caller is stream.dispatchPayload,
 * which is itself an internalQuery, and a nested ctx.runQuery would just add a
 * round trip. Never reachable from the browser.
 */
export async function buildHistory(
  ctx: QueryCtx,
  threadId: Id<"chatThreads">,
  beforeSeq: number,
  // Phase 2: a scheduled execution thread passes 1 so the turn carries EXACTLY
  // its own prompt. It cannot pass zero — `history` is also how the current
  // turn's user message reaches the model (runner.py pops the last entry as
  // `latest`), so an empty history would send no prompt at all.
  maxMessages: number = HISTORY_MAX_MESSAGES,
) {
  const recent = await ctx.db
    .query("chatMessages")
    .withIndex("by_thread_seq", (q) =>
      q.eq("threadId", threadId).lt("seq", beforeSeq),
    )
    .order("desc")
    .take(Math.max(1, maxMessages));

  // Eligibility first, so the budget walk below reasons about a clean list.
  const eligible: Doc<"chatMessages">[] = [];
  for (const m of recent) {
    if (isInFlight(m) || m.status === "error") continue;
    // Only the active variant of a branched reply belongs in the context.
    if (m.role === "assistant" && m.parentId) {
      const parent = await ctx.db.get(m.parentId);
      const active = parent?.activeVariantIndex ?? 0;
      if ((m.variantIndex ?? 0) !== active) continue;
    }
    eligible.push(m);
  }

  // PIN the newest message and the newest assistant message.
  //
  // The newest assistant message is the artifact a follow-up almost always
  // refers to — "expand the above blog", "make it more detailed". It is also
  // the largest message in the thread, which is exactly why the old budget
  // walk discarded it. Pinning is what makes "the better the answer, the more
  // certain it is erased from its own next turn" impossible.
  const pinned = new Set<string>();
  if (eligible[0]) pinned.add(eligible[0]._id);
  const newestAssistant = eligible.find((m) => m.role === "assistant");
  if (newestAssistant) pinned.add(newestAssistant._id);

  // Walk newest→oldest against the transport bound, then flip to chronological.
  //
  // The old loop did `chars += len; if (chars > MAX) break;` — three faults in
  // one line. It counted a message BEFORE testing it, so anything larger than
  // the remaining budget could never be admitted. It BROKE rather than
  // continued, so one oversized message discarded every older message too. And
  // it dropped rather than clipped, leaving no trace that the content existed.
  const picked: { m: Doc<"chatMessages">; content: string }[] = [];
  let budget = HISTORY_MAX_CHARS;
  for (const m of eligible) {
    const isPinned = pinned.has(m._id);
    if (m.content.length <= budget) {
      picked.push({ m, content: m.content });
      budget -= m.content.length;
      continue;
    }
    // Too big for what is left. Clip it — but to a SHARE of the remaining
    // budget, never all of it, so the messages behind it keep room. A pinned
    // message additionally gets a floor, because absent is worse than clipped
    // for the one message the turn is actually about.
    const share = Math.floor(budget * MAX_SINGLE_CLIP_SHARE);
    const room = isPinned ? Math.max(share, PINNED_MIN_CHARS) : share;
    if (room >= MIN_CLIP_CHARS) {
      picked.push({ m, content: clipForContext(m.content, room) });
      budget = Math.max(0, budget - room);
    }
    // No useful room for THIS message — skip it and keep walking. Older
    // messages are usually smaller and still carry the thread's subject, so
    // they must not be discarded on account of one large neighbour.
  }
  picked.reverse();

  return await Promise.all(
    picked.map(async ({ m, content }) => ({
      role: m.role,
      // `content`, not `m.content`: a clipped message carries its marker.
      content,
      seq: m.seq,
      attachments: (
        await Promise.all(
          (m.attachmentIds ?? []).map(async (id) => {
            const a = await ctx.db.get(id);
            if (!a) return null;
            return {
              // storageId is safe here: the only consumer is the trusted
              // server-side dispatch path, and Python fetches the bytes via
              // /ai/file with the ingress secret rather than a bearer URL.
              storageId: a.storageId,
              name: a.name,
              contentType: a.contentType,
              kind: a.kind,
              size: a.size,
              extractedText: a.extractedText ?? null,
            };
          }),
        )
      ).flatMap((x) => (x ? [x] : [])),
    })),
  );
}
