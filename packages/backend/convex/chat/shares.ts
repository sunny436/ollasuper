import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from "../_generated/server";
import { requireMember } from "../orgs";
import {
  getUserIdOrNull,
  requireMessageAccess,
  requireThreadAccess,
  requireUserId,
} from "./authz";

/**
 * Chat sharing — snapshot-based public links with server-side expiry + revocation.
 *
 * Two share types: `full_chat` (the whole conversation) and `single_turn` (one
 * user message + its assistant reply). At creation the content is FROZEN into a
 * JSON snapshot, so the public page never reads live chat rows and later edits
 * never change an existing share. The token is 192-bit, unguessable, stored
 * plaintext + indexed (see schema note). `getByToken` runs UNAUTHENTICATED and
 * returns a sanitized payload (no PII / internal ids / storageId). Attachment
 * bytes are served by the revocable /share/file proxy (http.ts), which is the
 * only thing that ever sees a snapshot storageId.
 */

const SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SHARE_RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_SHARES_PER_HOUR = 30;
const MAX_SNAPSHOT_BYTES = 700_000; // the "very large conversation" guard

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
/** 192-bit unguessable, URL-safe token (hex — no btoa dependency). */
function genToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

type SnapAttachment = {
  name: string;
  contentType: string;
  kind: "image" | "document" | "text";
  size: number;
  storageId: string; // server-only; stripped by getByToken
};
type SnapMessage = {
  role: "user" | "assistant";
  content: string;
  attachments: SnapAttachment[];
};

async function snapAttachments(
  ctx: QueryCtx,
  m: Doc<"chatMessages">,
): Promise<SnapAttachment[]> {
  if (!m.attachmentIds?.length) return [];
  const out: SnapAttachment[] = [];
  for (const id of m.attachmentIds) {
    const a = await ctx.db.get(id);
    if (!a) continue;
    out.push({
      name: a.name,
      contentType: a.contentType,
      kind: a.kind,
      size: a.size,
      storageId: a.storageId,
    });
  }
  return out;
}

async function snapMessage(
  ctx: QueryCtx,
  m: Doc<"chatMessages">,
): Promise<SnapMessage> {
  return {
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
    attachments: await snapAttachments(ctx, m),
  };
}

/** Full-chat snapshot: settled messages in seq order, active variant only. */
async function buildFullSnapshot(
  ctx: QueryCtx,
  threadId: Id<"chatThreads">,
): Promise<SnapMessage[]> {
  const all = await ctx.db
    .query("chatMessages")
    .withIndex("by_thread_seq", (q) => q.eq("threadId", threadId))
    .order("asc")
    .collect();
  const settled = all.filter(
    (m) =>
      m.status !== "pending" && m.status !== "streaming" && m.role !== "system",
  );
  // The active variant is recorded on the USER row; assistant siblings share a
  // parentId and carry variantIndex.
  const activeByUser = new Map<string, number>();
  for (const m of settled) {
    if (m.role === "user") activeByUser.set(m._id, m.activeVariantIndex ?? 0);
  }
  const chosen = settled.filter((m) => {
    if (m.role === "user") return true;
    if (!m.parentId) return true;
    return (m.variantIndex ?? 0) === (activeByUser.get(m.parentId) ?? 0);
  });
  return Promise.all(chosen.map((m) => snapMessage(ctx, m)));
}

function packSnapshot(
  shareType: "full_chat" | "single_turn",
  title: string,
  messages: SnapMessage[],
): string {
  const json = JSON.stringify({
    type: shareType,
    title,
    createdAt: Date.now(),
    messages,
  });
  if (json.length > MAX_SNAPSHOT_BYTES) {
    throw new ConvexError("This conversation is too large to share.");
  }
  return json;
}

async function assertShareRate(
  ctx: MutationCtx,
  userId: Id<"users">,
  workspaceId: Id<"workspaces">,
) {
  const since = Date.now() - SHARE_RATE_WINDOW_MS;
  const recent = await ctx.db
    .query("chatShares")
    .withIndex("by_user_ws_created", (q) =>
      q.eq("userId", userId).eq("workspaceId", workspaceId).gt("createdAt", since),
    )
    .collect();
  if (recent.length >= MAX_SHARES_PER_HOUR) {
    throw new ConvexError("You're creating share links too quickly. Try again later.");
  }
}

/** Create a share link. One mutation, branching on shareType. Owner-only. */
/**
 * The one definition of "this user already has a live share for this target".
 *
 * `create` deduped with this inline; the dialog now needs the SAME question
 * answered without writing anything, and two copies of the predicate would
 * drift — at which point the dialog would offer to create a link that `create`
 * then refuses to mint, or vice versa.
 */
async function findActiveShare(
  ctx: QueryCtx,
  target: {
    userId: Id<"users">;
    chatId: Id<"chatThreads">;
    shareType: "full_chat" | "single_turn";
    messageId?: Id<"chatMessages">;
  },
): Promise<Doc<"chatShares"> | null> {
  const now = Date.now();
  const existing = await ctx.db
    .query("chatShares")
    .withIndex("by_chat", (q) => q.eq("chatId", target.chatId))
    .collect();
  return (
    existing.find(
      (s) =>
        s.userId === target.userId &&
        s.shareType === target.shareType &&
        (s.messageId ?? null) === (target.messageId ?? null) &&
        !s.revokedAt &&
        s.expiresAt > now,
    ) ?? null
  );
}

/**
 * Does a live share ALREADY exist for this target? Read-only, by design.
 *
 * The share dialog used to call `create` from a useEffect on open, so merely
 * opening it inserted a chatShares row — and `getByToken` is unauthenticated,
 * so the conversation became publicly readable for the full TTL without the
 * user ever confirming. Closing the dialog did not undo it. This query is what
 * lets the dialog show an existing link without publishing a new one; minting
 * now requires the explicit button, which calls `create` unchanged.
 *
 * RETURNS NULL RATHER THAN THROWING for a missing or someone else's target.
 * Two reasons: a rejected Convex call logs console.error and every e2e script
 * asserts zero console errors, and "throws" vs "returns null" would make this
 * an existence oracle for another user's threadId.
 */
export const activeForTarget = query({
  args: {
    shareType: v.union(v.literal("full_chat"), v.literal("single_turn")),
    threadId: v.optional(v.string()),
    messageId: v.optional(v.id("chatMessages")),
  },
  handler: async (ctx, args) => {
    const userId = await getUserIdOrNull(ctx);
    if (!userId) return null;

    let chatId: Id<"chatThreads">;
    let messageId: Id<"chatMessages"> | undefined;

    try {
      if (args.shareType === "full_chat") {
        if (!args.threadId) return null;
        const id = ctx.db.normalizeId("chatThreads", args.threadId);
        if (!id) return null;
        await requireThreadAccess(ctx, userId, id);
        chatId = id;
      } else {
        if (!args.messageId) return null;
        const { message, thread } = await requireMessageAccess(
          ctx,
          userId,
          args.messageId,
        );
        chatId = thread._id;
        messageId = message._id;
      }
    } catch {
      // Not yours, or gone. Indistinguishable on purpose.
      return null;
    }

    const match = await findActiveShare(ctx, {
      userId,
      chatId,
      shareType: args.shareType,
      messageId,
    });
    if (!match) return null;
    return {
      token: match.token,
      expiresAt: match.expiresAt,
      shareType: match.shareType,
    };
  },
});

export const create = mutation({
  args: {
    shareType: v.union(v.literal("full_chat"), v.literal("single_turn")),
    threadId: v.optional(v.string()),
    messageId: v.optional(v.id("chatMessages")),
    forceNew: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);

    let workspaceId: Id<"workspaces">;
    let chatId: Id<"chatThreads">;
    let messageId: Id<"chatMessages"> | undefined;
    let title: string;
    let messages: SnapMessage[];

    if (args.shareType === "full_chat") {
      if (!args.threadId) throw new ConvexError("Not found");
      const id = ctx.db.normalizeId("chatThreads", args.threadId);
      if (!id) throw new ConvexError("Not found");
      const thread = await requireThreadAccess(ctx, userId, id);
      if (thread.streamingMessageId) {
        throw new ConvexError("Wait for the response to finish before sharing.");
      }
      workspaceId = thread.workspaceId;
      chatId = id;
      title = thread.title;
      messages = await buildFullSnapshot(ctx, id);
    } else {
      if (!args.messageId) throw new ConvexError("Not found");
      const { message, thread } = await requireMessageAccess(
        ctx,
        userId,
        args.messageId,
      );
      if (message.role !== "assistant" || message.status !== "complete") {
        throw new ConvexError("Only a completed response can be shared.");
      }
      workspaceId = thread.workspaceId;
      chatId = thread._id;
      messageId = message._id;
      title = thread.title;
      const userMsg = message.parentId
        ? await ctx.db.get(message.parentId)
        : null;
      messages = [
        ...(userMsg ? [await snapMessage(ctx, userMsg)] : []),
        await snapMessage(ctx, message),
      ];
    }

    await assertShareRate(ctx, userId, workspaceId);

    // Dedup: reuse an existing active share for the same target unless forceNew.
    if (!args.forceNew) {
      const match = await findActiveShare(ctx, {
        userId,
        chatId,
        shareType: args.shareType,
        messageId,
      });
      if (match) {
        return {
          token: match.token,
          expiresAt: match.expiresAt,
          shareType: match.shareType,
          reused: true,
        };
      }
    }

    const snapshot = packSnapshot(args.shareType, title, messages);
    const now = Date.now();
    const expiresAt = now + SHARE_TTL_MS;
    const token = genToken();
    await ctx.db.insert("chatShares", {
      token,
      userId,
      workspaceId,
      chatId,
      messageId,
      shareType: args.shareType,
      title,
      snapshot,
      createdAt: now,
      expiresAt,
    });
    return { token, expiresAt, shareType: args.shareType, reused: false };
  },
});

function statusOf(s: Doc<"chatShares">): "active" | "expired" | "revoked" {
  if (s.revokedAt) return "revoked";
  if (s.expiresAt <= Date.now()) return "expired";
  return "active";
}

/**
 * PUBLIC read — never calls auth. Returns a sanitized snapshot; storageId and all
 * internal ids/PII are stripped. Attachment array positions (m, a) are what the
 * client passes to the /share/file proxy.
 */
export const getByToken = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const share = await ctx.db
      .query("chatShares")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!share) return { state: "invalid" as const };
    if (share.revokedAt) return { state: "revoked" as const };
    if (share.expiresAt <= Date.now()) return { state: "expired" as const };

    const snap = JSON.parse(share.snapshot) as {
      messages: SnapMessage[];
    };
    const messages = (snap.messages ?? []).map((m) => ({
      role: m.role,
      content: m.content,
      attachments: (m.attachments ?? []).map((a) => ({
        name: a.name,
        contentType: a.contentType,
        kind: a.kind,
        size: a.size,
      })),
    }));
    return {
      state: "ok" as const,
      share: {
        type: share.shareType,
        title: share.title,
        createdAt: share.createdAt,
        expiresAt: share.expiresAt,
        messages,
      },
    };
  },
});

/** Owner's shares, newest-first, paginated. The client filters/searches loaded
 *  pages (typical share counts are small). Returns the token so the owner can
 *  copy it. */
export const listMine = query({
  args: {
    workspaceId: v.id("workspaces"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const userId = await getUserIdOrNull(ctx);
    if (!userId) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    await requireMember(ctx, userId, args.workspaceId);
    const res = await ctx.db
      .query("chatShares")
      .withIndex("by_user_ws_created", (q) =>
        q.eq("userId", userId).eq("workspaceId", args.workspaceId),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    return {
      ...res,
      page: res.page.map((s) => ({
        _id: s._id,
        token: s.token,
        shareType: s.shareType,
        title: s.title,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        revokedAt: s.revokedAt ?? null,
        status: statusOf(s),
      })),
    };
  },
});

export const revoke = mutation({
  args: { shareId: v.id("chatShares") },
  handler: async (ctx, { shareId }) => {
    const userId = await requireUserId(ctx);
    const share = await ctx.db.get(shareId);
    // Same "Not found" for missing and not-yours — no existence oracle.
    if (!share || share.userId !== userId) throw new ConvexError("Not found");
    if (!share.revokedAt) await ctx.db.patch(shareId, { revokedAt: Date.now() });
    return { ok: true };
  },
});

/**
 * INTERNAL — for the /share/file proxy only. Resolves a snapshot attachment's
 * storageId, but only while the share is live. Revoked/expired → null (the proxy
 * 404s with no existence oracle).
 */
export const resolveAttachment = internalQuery({
  args: { token: v.string(), m: v.number(), a: v.number() },
  handler: async (ctx, { token, m, a }) => {
    const share = await ctx.db
      .query("chatShares")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!share || share.revokedAt || share.expiresAt <= Date.now()) return null;
    const snap = JSON.parse(share.snapshot) as { messages: SnapMessage[] };
    const att = snap.messages?.[m]?.attachments?.[a];
    if (!att?.storageId) return null;
    const sid = ctx.db.system.normalizeId("_storage", att.storageId);
    if (!sid) return null;
    return { storageId: sid, contentType: att.contentType };
  },
});
