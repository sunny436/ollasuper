import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { normalizeEmail } from "./authPolicy";

/**
 * Per-normalized-email send throttle for emailed one-time codes.
 *
 * Every verification / password-reset / OTP email funnels through
 * authCodes.deliverCode, which calls this before sending. It bounds
 * resend/verification/reset email-bombing at the source with an hourly cap per
 * address. Returns whether the send is allowed; the caller SKIPS the send when
 * false (never throws), so constant-response flows like requestPasswordReset
 * stay constant.
 *
 * Cap-only (no inter-send cooldown): a couple of rapid legitimate resends must
 * still go through; it is sustained volume to one address that is the abuse.
 * Keyed on the normalized email so `User@Gmail.com` cannot mint a fresh bucket
 * against `user@gmail.com`.
 */
const HOUR_MS = 60 * 60 * 1000;
const HOURLY_CAP = 6;

/**
 * Consume one code-send from `email`'s hourly budget; false when exhausted.
 *
 * MUST run in the SAME transaction that would replace the address's current
 * code (audit F-07). It used to run later, at delivery, after the library had
 * already swapped the code: an exhausted budget then suppressed the email but
 * not the swap, so every throttled request silently invalidated the code the
 * user was holding. Called from the auth callback at code issuance (which
 * aborts the issuance when this is false) and ahead of the deletion code.
 */
export async function consumeCodeSendBudget(
  ctx: MutationCtx,
  email: string,
): Promise<boolean> {
  const emailNormalized = normalizeEmail(email);
  const now = Date.now();
  const row = await ctx.db
    .query("authProbeLimits")
    .withIndex("by_email", (q) => q.eq("emailNormalized", emailNormalized))
    .unique();

  if (!row) {
    await ctx.db.insert("authProbeLimits", {
      emailNormalized,
      windowStart: now,
      count: 1,
      lastSentAt: now,
    });
    return true;
  }

  // Window elapsed → start a fresh hour.
  if (now - row.windowStart >= HOUR_MS) {
    await ctx.db.patch(row._id, { windowStart: now, count: 1, lastSentAt: now });
    return true;
  }

  // Within the hour: enforce the cap.
  if (row.count >= HOURLY_CAP) return false;

  await ctx.db.patch(row._id, { count: row.count + 1, lastSentAt: now });
  return true;
}

/** The same budget, for callers outside a mutation (actions). */
export const recordSend = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }): Promise<boolean> =>
    consumeCodeSendBudget(ctx, email),
});
