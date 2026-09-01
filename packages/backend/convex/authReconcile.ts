import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { normalizeEmail } from "./authPolicy";

/**
 * One email, one user — repaired after the fact, because there is no hook
 * before it.
 *
 * THE BUG. `upsertUserAndAccount` links a new credential to an existing user
 * only via `uniqueUserWithVerifiedEmail`, which filters
 * `emailVerificationTime !== undefined`. An UNVERIFIED password sign-up is
 * therefore invisible to it, so a later Google sign-in for the same address
 * creates a SECOND `users` row. The password credential stays attached to the
 * first, orphaned row — so the person signs in with Google and sees their data,
 * signs in with their password and lands in an empty account with a different
 * workspace. Nothing reconciles the two.
 *
 * WHY REPAIR RATHER THAN PREVENT. The linking decision happens inside the
 * library's own mutation, which we do not control, and
 * `afterUserCreatedOrUpdated` is the only hook we have — it runs after the
 * second row already exists.
 *
 * WHY THAT IS SAFE, and this is the load-bearing part: an unverified account
 * CAN OWN NOTHING. It never receives a session (the provider returns a
 * verification code instead of tokens), nothing in auth.ts inserts a row on
 * user creation, and `createWorkspaceForUser` has no callers while
 * `ensureWorkspace` requires an authenticated identity. So this is not a data
 * migration across workspaces, tasks, threads and artifacts — there is nothing
 * to migrate. It is re-pointing the account rows and deleting an empty user.
 *
 * TWO VERIFIED USERS ARE NEVER MERGED. That is pre-existing data whose correct
 * resolution is a human decision, and deleting one would destroy real work.
 */
export async function reconcileDuplicateUsers(
  ctx: MutationCtx,
  survivorId: Id<"users">,
): Promise<number> {
  const survivor = await ctx.db.get(survivorId);
  const email = survivor?.email;
  if (!survivor || !email) return 0;

  const normalized = survivor.emailNormalized ?? normalizeEmail(email);
  if (!normalized) return 0;

  // The survivor must itself be verified before it can absorb anything —
  // otherwise an unverified newcomer could swallow an unverified incumbent and
  // we would just have moved the problem.
  if (survivor.emailVerificationTime === undefined) return 0;

  const sameEmail = await ctx.db
    .query("users")
    .withIndex("by_email_normalized", (q) =>
      q.eq("emailNormalized", normalized),
    )
    .take(10);

  let absorbed = 0;
  for (const other of sameEmail) {
    if (other._id === survivorId) continue;
    // Never touch a verified account.
    if (other.emailVerificationTime !== undefined) continue;

    // DELETE the twin's credentials. Never move them.
    //
    // This used to re-point them at the survivor "so the password chosen during
    // the abandoned sign-up keeps working". That is precisely the wrong outcome
    // when the abandoned sign-up was hostile: an unverified account is one
    // ANYONE can create for a stranger's address, so moving its credential
    // grafts an attacker-chosen password onto a real, verified account.
    //
    // Same invariant as the sign-up collision branch in passwordProvider.ts: a
    // credential may become live on an account only when the actor who supplied
    // it also proved inbox ownership. The twin's owner proved nothing.
    //
    // Nothing is lost. The survivor is verified and already has its own working
    // credential; someone who genuinely owns the address and wants the password
    // they typed during the abandoned sign-up can set it via password reset.
    const accounts = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", other._id))
      .collect();
    for (const account of accounts) {
      await ctx.db.delete(account._id);
    }

    // Keep a display name the survivor's own profile did not supply.
    if (!survivor.name && other.name) {
      await ctx.db.patch(survivorId, { name: other.name });
    }

    await ctx.db.delete(other._id);
    absorbed += 1;
  }

  return absorbed;
}
