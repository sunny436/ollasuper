import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { requireMember } from "../orgs";

/**
 * Authorization for the chat plane.
 *
 * This file exists separately from orgs.ts for the same reason auditLog.ts and
 * counters.ts do: threads/messages/stream/attachments all need these helpers,
 * and these helpers need orgs.requireMember — a cycle otherwise.
 *
 * IMPORTANT — chat inverts this codebase's trust model. Everywhere else the
 * WORKSPACE is the boundary (any member reads any job/file/audit log). Chat
 * conversations are PRIVATE TO THE CREATING USER: people paste credentials,
 * salaries and medical questions into them. A legitimate same-workspace peer
 * must be refused. security.test.ts asserts exactly that.
 */

/** The userId is always derived from the session, never accepted as an argument. */
export async function requireUserId(ctx: QueryCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError("Not authenticated");
  return userId;
}

/**
 * Soft variant for queries. Matches files.listPaged's convention: a signed-out
 * read returns an empty result rather than throwing, so a logged-out render
 * never logs a console error (which every e2e script asserts against).
 */
export async function getUserIdOrNull(
  ctx: QueryCtx,
): Promise<Id<"users"> | null> {
  return await getAuthUserId(ctx);
}

/**
 * Ownership is checked BEFORE workspace membership, deliberately.
 *
 * EVERY non-owner gets "Not found" — same-workspace peer and complete outsider
 * alike — so the error is never an existence oracle for someone else's
 * threadId. The requireMember call below is therefore unreachable for
 * outsiders; it exists to catch the owner who has since been removed from the
 * workspace, and only ever throws "Forbidden" for that case.
 */
export async function requireThreadAccess(
  ctx: QueryCtx,
  userId: Id<"users">,
  threadId: Id<"chatThreads">,
): Promise<Doc<"chatThreads">> {
  const thread = await ctx.db.get(threadId);
  if (!thread || thread.userId !== userId || thread.status === "trashed") {
    throw new ConvexError("Not found");
  }
  // Defense in depth: the owner must STILL be a member of the thread's
  // workspace. Covers a user removed from the workspace after creating it —
  // orgs.removeMember does not (and should not) know about chat.
  await requireMember(ctx, userId, thread.workspaceId);
  return thread;
}

/** Same as requireThreadAccess but tolerates trashed threads (restore/purge). */
export async function requireThreadAccessIncludingTrashed(
  ctx: QueryCtx,
  userId: Id<"users">,
  threadId: Id<"chatThreads">,
): Promise<Doc<"chatThreads">> {
  const thread = await ctx.db.get(threadId);
  if (!thread || thread.userId !== userId) throw new ConvexError("Not found");
  await requireMember(ctx, userId, thread.workspaceId);
  return thread;
}

export async function requireMessageAccess(
  ctx: QueryCtx,
  userId: Id<"users">,
  messageId: Id<"chatMessages">,
): Promise<{ message: Doc<"chatMessages">; thread: Doc<"chatThreads"> }> {
  const message = await ctx.db.get(messageId);
  if (!message || message.userId !== userId) throw new ConvexError("Not found");
  // Re-derive from the thread — never trust the denormalised userId alone.
  const thread = await requireThreadAccess(ctx, userId, message.threadId);
  return { message, thread };
}

export async function requireAttachmentAccess(
  ctx: QueryCtx,
  userId: Id<"users">,
  attachmentId: Id<"chatAttachments">,
): Promise<Doc<"chatAttachments">> {
  const attachment = await ctx.db.get(attachmentId);
  if (!attachment || attachment.userId !== userId) {
    throw new ConvexError("Not found");
  }
  await requireMember(ctx, userId, attachment.workspaceId);
  return attachment;
}

export async function requireStreamAccess(
  ctx: QueryCtx,
  userId: Id<"users">,
  messageId: Id<"chatMessages">,
): Promise<Doc<"chatStreams">> {
  await requireMessageAccess(ctx, userId, messageId);
  const stream = await ctx.db
    .query("chatStreams")
    .withIndex("by_message", (q) => q.eq("messageId", messageId))
    .unique();
  if (!stream) throw new ConvexError("Not found");
  return stream;
}

/**
 * Constant-time string comparison for the server-to-server ingress secret.
 *
 * The existing /backend/webhook handler uses a plain `!==`, which short-circuits
 * on the first differing byte. Over a network that channel is weak either way,
 * but this is eight lines and this repo maintains a security suite.
 *
 * Note: like hmac.compare_digest, this still leaks length. Acceptable for a
 * fixed-length hex secret.
 */
export function timingSafeEqualStr(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * The model the plane falls back to whenever no valid choice is available:
 * a fresh deployment with an unrefreshed catalogue, or a thread pinned to a
 * model no longer in the Ollima catalogue. MUST be an id Ollima actually
 * serves — some catalogue ids are advertised but unserved ("not found in
 * model table"); this one is verified working.
 */
// glm-5.2, not gpt-5.6-luna.
//
// The provider serves 11 of its 13 models; the two exceptions are exactly the
// OpenAI-backed pair (gpt-5.6-luna and gpt-5.5), both returning 502 wrapping
// `sidecar: Error 401 Unauthorized ... Provided authentication token is
// expired` — an expired upstream credential on THEIR side, which we cannot fix
// and should not depend on. The default was one of those two, so every new
// user and every scheduled run failed while the rest of the catalogue was fine.
export const DEFAULT_MODEL = "glm-5.2";

/**
 * Validate a model against the cached OpenRouter catalogue.
 *
 * This used to be a pure function over a 3-element constant. It now reads the
 * database, because the allow-list is fetched from OpenRouter and Convex
 * mutations cannot fetch — see chat/models.ts.
 *
 * Two failure modes are handled deliberately rather than by throwing:
 *
 *  - `explicit: false` means the caller supplied no model and we are falling
 *    back to whatever the thread already stores. If that stored id has since
 *    left the catalogue, throwing would make the user unable to continue their
 *    OWN conversation, with no way to fix it from the UI. Silently re-home
 *    them onto the default instead.
 *  - `explicit: true` means the user picked this model in the picker. A bad id
 *    there is a real error and must surface.
 */
export async function assertAllowedModel(
  ctx: QueryCtx,
  model: string,
  opts?: { explicit?: boolean },
): Promise<string> {
  if (await isKnownModel(ctx, model)) return model;
  if (opts?.explicit) throw new ConvexError("Unsupported model");
  return DEFAULT_MODEL;
}

/**
 * Catalogue membership.
 *
 * Deliberately defined HERE and not in chat/models.ts, even though that is
 * where the table is owned: models.ts imports DEFAULT_MODEL from this file, so
 * importing back would reintroduce exactly the cycle this module exists to
 * avoid (see the header comment).
 *
 * Bootstrap rule: an empty catalogue allows DEFAULT_MODEL and nothing else.
 * Never allow-everything (a failed refresh would become a spend incident) and
 * never allow-nothing (that bricks chat). It is also what keeps the backend
 * tests green: convex-test has no network, so the table is always empty there.
 */
export async function isKnownModel(
  ctx: QueryCtx,
  model: string,
): Promise<boolean> {
  const row = await ctx.db
    .query("chatModels")
    .withIndex("by_model_id", (q) => q.eq("modelId", model))
    .unique();
  if (row) return true;

  const any = await ctx.db.query("chatModels").first();
  return any === null && model === DEFAULT_MODEL;
}
