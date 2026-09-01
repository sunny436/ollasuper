import { internalMutation } from "./_generated/server";

/**
 * Expire abandoned sign-ups.
 *
 * WHY THIS IS SECURITY, not housekeeping. A sign-up creates the account before
 * the code is verified, and nothing ever removed the never-verified ones. Two
 * consequences followed:
 *
 *  - REGISTRATION SQUATTING. Sign up with someone else's address and never
 *    verify, and they can never register with a password: the provider finds the
 *    squatter's account and refuses. Permanently, with no recovery path. This
 *    purge IS that recovery path.
 *  - It is the exact state that made cross-provider duplicates possible, because
 *    an unverified row is invisible to the library's linking lookup.
 *
 * Deleting a user is irreversible, so every guard here is deliberate.
 */

/**
 * Well beyond the code's own 15-minute validity. A TTL anywhere near that would
 * delete accounts out from under people who are still typing the code they were
 * just sent.
 */
export const UNVERIFIED_TTL_MS = 24 * 60 * 60 * 1000;
/** Bound on one pass, in the shape of the other reapers in crons.ts. */
const SCAN = 100;

export const purgeUnverified = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ scanned: number; purged: number }> => {
    const now = Date.now();
    const cutoff = now - UNVERIFIED_TTL_MS;

    // by_verification selects exactly the unverified rows, so this reads a set
    // that is normally tiny rather than the whole users table.
    const candidates = await ctx.db
      .query("users")
      .withIndex("by_verification", (q) => q.eq("emailVerificationTime", undefined))
      .take(SCAN);

    let purged = 0;
    for (const user of candidates) {
      if (user._creationTime > cutoff) continue;

      // Belt and braces. An unverified account should never have a session —
      // the provider hands out a code instead of tokens — but if one somehow
      // does, that is a live user and this must not touch them.
      const session = await ctx.db
        .query("authSessions")
        .withIndex("userId", (q) => q.eq("userId", user._id))
        .first();
      if (session) continue;

      const accounts = await ctx.db
        .query("authAccounts")
        .withIndex("userIdAndProvider", (q) => q.eq("userId", user._id))
        .collect();

      // A code still in flight means someone is mid-verification right now.
      const codes = [];
      let live = false;
      for (const account of accounts) {
        const forAccount = await ctx.db
          .query("authVerificationCodes")
          .withIndex("accountId", (q) => q.eq("accountId", account._id))
          .collect();
        for (const code of forAccount) {
          if (code.expirationTime > now) live = true;
          codes.push(code);
        }
      }
      if (live) continue;

      // Delete the WHOLE account, in dependency order. Removing only the user
      // row would leave the authAccounts row behind, and its
      // (provider, providerAccountId) pair would still collide — which would
      // recreate the squatting lockout in a new form rather than fixing it.
      for (const code of codes) await ctx.db.delete(code._id);
      for (const account of accounts) await ctx.db.delete(account._id);
      await ctx.db.delete(user._id);
      purged += 1;
    }

    return { scanned: candidates.length, purged };
  },
});
