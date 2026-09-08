import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/**
 * The public shape of one chat message.
 *
 * DELIBERATELY IN ITS OWN MODULE, importing only the data model and the server
 * types — never `_generated/api`. `chat/messages.ts` does import the api (for
 * `internal.chat.stream.dispatch`), and the generated api type in turn includes
 * every module in this codebase. So a module that both imports the api AND has
 * its inferred return type consumed by another Convex function closes a type
 * cycle, and TypeScript resolves the whole thing to `any` — which silently
 * degrades the typing of UNRELATED queries across the project. Keeping this
 * mapper cycle-free is what lets scheduled/tasks.ts render a scheduled run with
 * the exact same shape chat uses.
 */
export async function toPublic(ctx: QueryCtx, m: Doc<"chatMessages">) {
  const attachments = m.attachmentIds?.length
    ? await Promise.all(
        m.attachmentIds.map(async (id) => {
          const a = await ctx.db.get(id);
          if (!a) return null;
          return {
            _id: a._id,
            name: a.name,
            size: a.size,
            contentType: a.contentType,
            kind: a.kind,
            // blob-ok: this mapper is deliberately authz-free (cycle-free, imports
            // only the data model). Ownership is enforced by EVERY caller before
            // this runs — messages.listPaged/get (requireThreadAccess) and
            // scheduled.tasks (owner-scoped run). storageId is never exposed.
            url: await ctx.storage.getUrl(a.storageId),
          };
        }),
      )
    : [];
  return {
    _id: m._id,
    role: m.role,
    seq: m.seq,
    content: m.content,
    status: m.status,
    model: m.model ?? null,
    reasoning: m.reasoning ?? null,
    error: m.error ?? null,
    errorCode: m.errorCode ?? null,
    parentId: m.parentId ?? null,
    variantIndex: m.variantIndex ?? null,
    variantCount: m.variantCount ?? null,
    activeVariantIndex: m.activeVariantIndex ?? null,
    tokensIn: m.tokensIn ?? null,
    tokensOut: m.tokensOut ?? null,
    // Typed events (Phase 3). Empty for text-only / pre-Phase-3 messages, so
    // the client renders them exactly as before.
    events: m.events ?? [],
    createdAt: m.createdAt,
    // Exposed so the client can dedupe its optimistic user row against the
    // settled one (the browser minted this id; returning it to its own author
    // is not a capability leak). storageId, by contrast, is never exposed.
    clientId: m.clientId ?? null,
    attachments: attachments.filter(Boolean),
  };
}
