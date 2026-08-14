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
 * A same-workspace peer therefore gets "Not found" rather than "Forbidden", so
 * the error is never an existence oracle for someone else's threadId. A true
 * outsider falls through to requireMember and gets "Forbidden".
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

export async function requireFolderAccess(
  ctx: QueryCtx,
  userId: Id<"users">,
  folderId: Id<"chatFolders">,
): Promise<Doc<"chatFolders">> {
  const folder = await ctx.db.get(folderId);
  if (!folder || folder.userId !== userId) throw new ConvexError("Not found");
  await requireMember(ctx, userId, folder.workspaceId);
  return folder;
}

/**
 * Prompts are the one chat entity that can be workspace-shared, so read access
 * is "mine, or shared within a workspace I belong to". Writes always require
 * ownership — use requireOwnedPrompt for those.
 */
export async function requirePromptReadAccess(
  ctx: QueryCtx,
  userId: Id<"users">,
  promptId: Id<"chatPrompts">,
): Promise<Doc<"chatPrompts">> {
  const prompt = await ctx.db.get(promptId);
  if (!prompt) throw new ConvexError("Not found");
  if (prompt.userId !== userId && !prompt.shared) {
    throw new ConvexError("Not found");
  }
  await requireMember(ctx, userId, prompt.workspaceId);
  return prompt;
}

export async function requireOwnedPrompt(
  ctx: QueryCtx,
  userId: Id<"users">,
  promptId: Id<"chatPrompts">,
): Promise<Doc<"chatPrompts">> {
  const prompt = await ctx.db.get(promptId);
  if (!prompt || prompt.userId !== userId) throw new ConvexError("Not found");
  await requireMember(ctx, userId, prompt.workspaceId);
  return prompt;
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

/** Models the chat plane is allowed to request. Enforced server-side. */
export const ALLOWED_MODELS = [
  "anthropic/claude-opus-5",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-haiku-4.5",
] as const;

export const DEFAULT_MODEL = "anthropic/claude-opus-5";

export function assertAllowedModel(model: string): string {
  if (!(ALLOWED_MODELS as readonly string[]).includes(model)) {
    throw new ConvexError("Unsupported model");
  }
  return model;
}
