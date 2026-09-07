import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";

/**
 * Server-owned, PER-USER rate windows.
 *
 * These counters used to live on the `chatSettings` row, which was wrong twice
 * over and both ways were exploitable by any ordinary user:
 *
 *  1. THAT ROW IS PER-USER-PER-WORKSPACE. A limit documented as per-user reset
 *     itself every time the user created another workspace, and creating one is
 *     unprivileged (`orgs.createWorkspace`). The allowance multiplied by however
 *     many workspaces someone cared to make.
 *
 *  2. `chat.settings.reset` DELETES that row. Hitting a limit and then clearing
 *     your own preferences returned a full fresh allowance, immediately, with
 *     one mutation call and no side effects a user would notice.
 *
 * A quota is not a preference. It lives in its own table now, keyed on the user
 * alone, and no user-callable mutation deletes it. The old `chatSettings` fields
 * are left in the schema — removing a field that live rows still carry fails
 * schema validation — but nothing reads them any more.
 */

/** One window per user per kind, so kinds can never spend each other's budget. */
export type QuotaKind = "chat" | "parse" | "schedRun" | "seoRun";

export type WindowResult =
  | { ok: true }
  | { ok: false; retryInMs: number };

/**
 * Take one unit from a fixed window, creating it on first use.
 *
 * Fixed window, not sliding: the 2x-across-a-boundary failure mode is
 * irrelevant at this scale and a sliding window costs a scan. Same tradeoff the
 * original code made — only the STORAGE moved.
 */
export async function consumeWindow(
  ctx: MutationCtx,
  userId: Id<"users">,
  kind: QuotaKind,
  limit: number,
  windowMs: number,
): Promise<WindowResult> {
  const now = Date.now();
  const row = await ctx.db
    .query("userQuotas")
    .withIndex("by_user_kind", (q) => q.eq("userId", userId).eq("kind", kind))
    .unique();

  const start = row?.windowStart ?? 0;
  const fresh = now - start >= windowMs;
  const count = fresh ? 0 : (row?.windowCount ?? 0);

  if (count >= limit) {
    return { ok: false, retryInMs: Math.max(0, start + windowMs - now) };
  }

  const next = { windowStart: fresh ? now : start, windowCount: count + 1 };
  if (row) {
    await ctx.db.patch(row._id, next);
  } else {
    await ctx.db.insert("userQuotas", { userId, kind, ...next });
  }
  return { ok: true };
}

/**
 * Move consumed usage off `chatSettings` and onto the per-user rows.
 *
 * Without this, deploying the new store hands every user a fresh allowance at
 * the moment of the switch — a smaller version of the bug being fixed. For each
 * user the LARGEST live window across their workspaces is carried over, which is
 * the conservative choice: it preserves the most usage actually consumed rather
 * than averaging it away.
 *
 * Idempotent (an existing row is never lowered) and batched, so re-running it is
 * safe and a large table cannot blow the transaction budget.
 */
export const backfillFromChatSettings = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query("chatSettings")
      .paginate({ numItems: 200, cursor: cursor ?? null });

    const now = Date.now();
    const KINDS: Array<[QuotaKind, "rateWindow" | "parseWindow" | "schedRunWindow" | "seoRunWindow", number]> = [
      ["chat", "rateWindow", 60 * 60 * 1000],
      ["parse", "parseWindow", 60 * 60 * 1000],
      ["schedRun", "schedRunWindow", 60 * 60 * 1000],
      ["seoRun", "seoRunWindow", 60 * 60 * 1000],
    ];

    for (const row of page.page) {
      for (const [kind, prefix, windowMs] of KINDS) {
        const start = (row as Record<string, unknown>)[`${prefix}Start`] as
          | number
          | undefined;
        const count = (row as Record<string, unknown>)[`${prefix}Count`] as
          | number
          | undefined;
        // Only a window that is still live is worth carrying over.
        if (!start || !count || now - start >= windowMs) continue;

        const existing = await ctx.db
          .query("userQuotas")
          .withIndex("by_user_kind", (q) =>
            q.eq("userId", row.userId).eq("kind", kind),
          )
          .unique();

        if (!existing) {
          await ctx.db.insert("userQuotas", {
            userId: row.userId,
            kind,
            windowStart: start,
            windowCount: count,
          });
        } else if (count > existing.windowCount) {
          // Never LOWER a count: re-running must not hand back allowance.
          await ctx.db.patch(existing._id, {
            windowStart: start,
            windowCount: count,
          });
        }
      }
    }

    // Operator-driven rather than self-scheduling: a security migration should
    // be observable and resumable, and the caller can see exactly how far it
    // got. Re-invoke with the returned cursor until done is true.
    return {
      scanned: page.page.length,
      done: page.isDone,
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});
