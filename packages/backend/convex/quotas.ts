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
export type QuotaKind =
  | "chat"
  | "parse"
  | "schedRun"
  | "seoRun"
  // Authenticated password-change attempts. Bounds the password oracle that
  // verifying `currentPassword` necessarily creates for a session holder.
  | "passwordChange"
  // Account-deletion re-auth attempts. The emailed-code path already caps at 5;
  // the PASSWORD path had no bound at all, so a stolen session could brute-force
  // the password through an endpoint nobody thinks of as a login.
  | "accountDelete"
  // Password-reset EMAILS SENT for one account. Unauthenticated callers cannot
  // be limited by this helper at all — it is keyed on a userId — but the branch
  // that actually costs anything is the one where the address resolves to a
  // user, and there a userId exists. So the expensive half is bounded even
  // though the probe half cannot be. Outbound mail is metered (~1500/month) and
  // the SAME transport carries OTP, verification and reset codes, so draining it
  // is a denial of service against authentication itself, not just spam.
  | "passwordReset"
  // --- MCP (Phase 8) -------------------------------------------------------
  // Each of these makes a REAL network call to a third party on the user's
  // behalf, which is what separates them from ordinary reads. None of them
  // existed before Phase 8: the whole MCP surface shipped with no rate limit of
  // any kind, so a loop in a client — or a user holding a key down — spent
  // somebody else's API quota and our outbound bandwidth without bound.
  //
  // The numbers are SCALED FROM `MAX_GENERATIONS_PER_HOUR` (120) and from what
  // one person plausibly does, NOT from load testing. Said plainly because a
  // limit presented as measured, when it was reasoned, is the kind of claim
  // that stops anyone ever measuring it.
  //
  // Opening a session: handshake + capability discovery against a third party.
  // 60/hr covers connecting every server in a curated set twice over.
  | "mcpConnect"
  // Starting an authorization: mints `state`, may trigger dynamic client
  // registration, and puts a consent screen in front of a human. Deliberately
  // the tightest of the three — a loop here is visible to the PROVIDER as
  // abuse, and their response is to block the client for every user.
  | "mcpAuth"
  // Listing or reading resources and prompts. Each acquires a pooled session,
  // so it is the same order of cost as a chat turn and carries the same limit.
  | "mcpCapability"
  // ONE TOOL CALL on a connected server, charged by the Python plane before the
  // wire is touched (audit H-09; `app/mcp/quota.py`). The per-turn ceilings
  // live in Python; this is the DURABLE per-user hour, the one bound that
  // survives a restart and a fresh turn. 600/hr = 5 turns' worth of the
  // per-turn cap, or ~10 calls a minute sustained — an order of magnitude above
  // measured use, an order of magnitude below a loop.
  | "mcpToolCall"
  // File Library (libraryCore.ts / library.ts). Upload sessions per hour; manual
  // processing retries per hour; access-token mints and file GETs per hour; and
  // BYTES served per hour (weighted — see `amount`), so a valid account cannot
  // turn download links into unbounded bandwidth.
  | "libraryUpload"
  | "libraryRetry"
  | "libraryAccess"
  | "libraryBytes"
  | "libraryUploadBytes"
  // Bytes of GENERATED files stored per day (chat artifacts and their preview
  // pages). Generated files sit outside the 100 MB upload quota, so without
  // this a user generating at the turn limit grew the disk without bound.
  | "libraryGenBytes";

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
  amount = 1,
): Promise<WindowResult> {
  const { result, commit } = await peekWindow(ctx, userId, kind, limit, windowMs, amount);
  if (result.ok) await commit();
  return result;
}

/**
 * The same check WITHOUT the write, plus a `commit` that performs it.
 *
 * For a mutation that must keep other writes when a LATER check fails (see
 * chat/messages.ts createAndSend), the window increment has to wait until every
 * check has passed — a mutation cannot roll back one write while keeping
 * another. Peek-then-commit inside one mutation is equivalent to
 * consumeWindow: Convex mutations are serialisable, so nothing can change the
 * row in between.
 */
export async function peekWindow(
  ctx: MutationCtx,
  userId: Id<"users">,
  kind: QuotaKind,
  limit: number,
  windowMs: number,
  // Units this call consumes (1 for a request; the byte count for a transfer).
  // `count + amount > limit` is exactly the old `count >= limit` when it is 1.
  amount = 1,
): Promise<{ result: WindowResult; commit: () => Promise<void> }> {
  const now = Date.now();
  const row = await ctx.db
    .query("userQuotas")
    .withIndex("by_user_kind", (q) => q.eq("userId", userId).eq("kind", kind))
    .unique();

  const start = row?.windowStart ?? 0;
  const fresh = now - start >= windowMs;
  const count = fresh ? 0 : (row?.windowCount ?? 0);

  if (count + amount > limit) {
    return {
      result: { ok: false, retryInMs: Math.max(0, start + windowMs - now) },
      commit: async () => {},
    };
  }

  const next = { windowStart: fresh ? now : start, windowCount: count + amount };
  return {
    result: { ok: true },
    commit: async () => {
      if (row) {
        await ctx.db.patch(row._id, next);
      } else {
        await ctx.db.insert("userQuotas", { userId, kind, ...next });
      }
    },
  };
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
