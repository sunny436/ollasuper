import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  type QueryCtx,
  mutation,
  query,
} from "./_generated/server";
import { activeUserId } from "./accountState";
import { normalizeEmail } from "./authPolicy";
import { enforceSessionLimit, recordAuthEvent } from "./authEvents";
import { consumeWindow } from "./quotas";

/**
 * Session-limit enforcement (MAX_ACTIVE_SESSIONS) and activity tracking.
 *
 * WHY THIS EXISTS AS A SEPARATE ENTRY POINT, and not only in the
 * afterUserCreatedOrUpdated callback in auth.ts:
 *
 * That callback fires from `upsertUserAndAccount`, which a plain password
 * sign-in never calls — `mutations/signIn.js` goes straight to
 * `createNewAndDeleteExistingSession` with no user upsert at all. So the
 * callback covers sign-up, OTP, email verification, password reset and OAuth,
 * but silently misses the single most common path. Live testing caught this:
 * three sequential logins produced three live sessions and zero
 * `session_replaced` events, while every unit test passed.
 *
 * The library gives no hook that spans all flows, so enforcement also runs from
 * the authenticated client on mount. That is deliberately NOT frontend security:
 * the decision and the writes happen here, in one Convex mutation, so two
 * concurrent calls serialise and the limit holds. The client only supplies the
 * trigger.
 *
 * It also matches the requirement's own wording — "the previous device is forced
 * to login again on its next request". A displaced device keeps its access token
 * until it expires (≤1h, a property of stateless JWTs that no server-side design
 * removes), but its refresh token is gone, so it cannot continue past that —
 * and `sessionState` below tells its open tab at once, instead of leaving it
 * signed in to an app where every query now answers "signed out".
 */
/**
 * Is THIS browser's session still alive? Reactive, and that is the point.
 *
 * A session revoked from elsewhere — a newer sign-in past the session limit, a
 * password reset or change, suspension, deletion — leaves the tab holding a JWT
 * that stays valid for up to an hour, while every query answers as if signed
 * out (activeUserId checks the session row). heartbeat only runs on mount, so
 * such a tab sat in an empty app. This query reads the same session row, so it
 * re-runs the moment the row is deleted and the client can sign out cleanly.
 *
 *   anonymous  no identity at all: signed out, or auth still being attached
 *   live       identity, a live session and an active account
 *   ended      identity, but the session or the account is gone
 *
 * Only `ended` means "you were signed out": `anonymous` is also what a page
 * sees while its token is still being attached, so it must never trigger one.
 */
export const sessionState = query({
  args: {},
  handler: async (ctx): Promise<"anonymous" | "live" | "ended"> => {
    if ((await getAuthUserId(ctx)) === null) return "anonymous";
    return (await activeUserId(ctx)) === null ? "ended" : "live";
  },
});

/** How often `users.lastActivityAt` is written by heartbeat (see below). */
export const ACTIVITY_WRITE_INTERVAL_MS = 5 * 60_000;

export const heartbeat = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await activeUserId(ctx);
    if (!userId) return { ok: false as const };
    const current = await getAuthSessionId(ctx);

    // The caller's session was revoked by a newer login elsewhere. Report it so
    // the client can show "signed out because your account was used elsewhere"
    // rather than a bare login screen.
    if (current === null) return { ok: false as const };
    const session = await ctx.db.get(current);
    if (session === null) return { ok: false as const, displaced: true as const };

    const revoked = await enforceSessionLimit(ctx, userId, current);
    if (revoked > 0) {
      await recordAuthEvent(ctx, {
        type: "session_replaced",
        userId,
        meta: { revoked },
      });
    }

    // Sliding-window bookkeeping. Enforcement is the refresh token's own
    // inactivity budget; this column is for display and anomaly review.
    // Activity is recorded at most once per ACTIVITY_WRITE_INTERVAL_MS, not on
    // every mount. Every authenticated query reads the caller's `users` row
    // (isActiveUser), so a patch here re-executes all of that user's live
    // subscriptions at the exact moment they are being set up — measured on
    // production as ~14 query executions in the second after a heartbeat.
    // Nothing reads `lastActivityAt` at minute granularity (nothing reads it at
    // all today), and session revocation above is unchanged.
    const now = Date.now();
    const user = await ctx.db.get(userId);
    const last = user?.lastActivityAt ?? 0;
    if (now - last >= ACTIVITY_WRITE_INTERVAL_MS) {
      await ctx.db.patch(userId, { lastActivityAt: now });
    }
    return { ok: true as const, revoked };
  },
});

/**
 * A password reset COMPLETED: the new credential is stored and every other
 * session is gone. Called only from the reset-verification branch of
 * passwordProvider, after both. Internal, so no client can stamp it.
 */
export const recordPasswordReset = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<null> => {
    const user = await ctx.db.get(userId);
    if (user === null) return null;
    await ctx.db.patch(userId, { passwordChangedAt: Date.now() });
    await recordAuthEvent(ctx, { type: "password_reset", userId });
    return null;
  },
});

/**
 * Legacy rows only — those predating emailNormalized. The set shrinks on every
 * sign-in, so this ceiling exists to bound a pathological case, not a normal one.
 */
const LEGACY_SCAN_LIMIT = 2000;

/**
 * The user id for an address, or null.
 *
 * A plain helper rather than a Convex function because BOTH `accountExists`
 * (an internalQuery) and `queuePasswordReset` (a mutation) need it, and a
 * mutation cannot call an internalQuery.
 */
async function findUserIdByEmail(
  ctx: QueryCtx,
  email: string,
): Promise<Id<"users"> | null> {
  const normalized = normalizeEmail(email);
  // Fast path: by_email_normalized (schema.ts) exists precisely for this.
  const hit = await ctx.db
    .query("users")
    .withIndex("by_email_normalized", (q) => q.eq("emailNormalized", normalized))
    .first();
  if (hit) return hit._id;
  // Legacy path. Rows written before emailNormalized existed have it unset and
  // are invisible to that index, and their raw email may be any case, which no
  // index can match case-insensitively.
  //
  // This used to be `.collect()` over the WHOLE users table, so every probe
  // for an unknown address scanned every user — cheap to trigger, and it grows
  // until it hits Convex's per-query document limit and starts throwing. The
  // index range `emailNormalized === undefined` selects exactly the legacy
  // rows and nothing else, so the scan is bounded by the size of a set that
  // only ever shrinks: afterUserCreatedOrUpdated backfills emailNormalized on
  // every sign-in.
  const legacy = await ctx.db
    .query("users")
    .withIndex("by_email_normalized", (q) => q.eq("emailNormalized", undefined))
    .take(LEGACY_SCAN_LIMIT);
  return (
    legacy.find((u) => normalizeEmail(u.email ?? "") === normalized)?._id ?? null
  );
}

/**
 * Does an account exist for this address?
 *
 * `internalQuery`, and that is the whole point. This was declared `query` — i.e.
 * publicly callable as `api.authSessions.accountExists` — while its own comment
 * claimed it was never exposed. Anyone could ask it directly and get a yes/no,
 * which defeated `requestPasswordReset` below: that action goes to real trouble
 * to answer identically for known and unknown addresses, and this handed the
 * answer over for free.
 */
export const accountExists = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, { email }): Promise<boolean> =>
    (await findUserIdByEmail(ctx, email)) !== null,
});

/**
 * Password-reset request that does not leak whether the account exists.
 *
 * Calling signIn("password", { email, flow: "reset" }) directly is an
 * ENUMERATION ORACLE: for a known address it resolves, and for an unknown one
 * the provider throws InvalidAccountId. An attacker can therefore test an email
 * list against this endpoint and learn exactly who has an account. This was
 * caught by the flow tests, not by review.
 *
 * So the existence check happens server-side and the response is identical
 * either way. The email is only dispatched when there is somewhere to send it.
 */
/**
 * Look up, budget, and enqueue — in ONE transaction.
 *
 * All three steps belong together. Doing the lookup in the action and the
 * budget in a separate mutation leaves a window where two concurrent requests
 * both read a budget of 4/5 and both send, which is exactly the case the limit
 * exists for. A single mutation serialises them.
 *
 * It also has to be a mutation for a second reason: `ctx.scheduler` from an
 * ACTION is a different code path, and convex-test cannot model it — it runs the
 * job on a bare setTimeout with no transaction open and throws "Write outside of
 * transaction". Scheduling from a mutation is the supported path in both the
 * real runtime and the test harness.
 */
export const queuePasswordReset = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }): Promise<void> => {
    const userId = await findUserIdByEmail(ctx, email);
    // Nothing to send to. Note this branch does the SAME work as the other one
    // up to here — one indexed read — which is the point (see below).
    if (!userId) return;

    // Bounded per ACCOUNT. Outbound mail is metered and the same transport
    // carries OTP and verification codes, so an unbounded reset endpoint is a
    // denial of service against sign-in itself, not merely nuisance mail.
    const budget = await consumeWindow(
      ctx,
      userId,
      "passwordReset",
      MAX_RESETS_PER_HOUR,
      HOUR_MS,
    );
    if (!budget.ok) return;

    // ENQUEUED, NOT PERFORMED — this is what closes the timing oracle.
    //
    // The identical RESPONSE BODY was already deliberate, and it worked. What it
    // did not cover was the CLOCK: a known address ran a full signIn action plus
    // OTP generation plus an SMTP send, while an unknown one returned after a
    // single indexed query. The bodies matched and the durations did not, so the
    // endpoint still answered "does this account exist" — in milliseconds
    // instead of in words. Handing the send to the scheduler makes both branches
    // do the same thing on the request path.
    await ctx.scheduler.runAfter(
      0,
      internal.authSessions.deliverPasswordReset,
      { email },
    );
  },
});

/**
 * The actual send, off the request path.
 *
 * Scheduled rather than awaited, and that is the whole point — see the timing
 * note in requestPasswordReset below.
 */
export const deliverPasswordReset = internalAction({
  args: { email: v.string() },
  handler: async (ctx, { email }): Promise<null> => {
    try {
      await ctx.runAction(api.auth.signIn, {
        provider: "password",
        params: { email, flow: "reset" },
      });
    } catch {
      // Swallowed deliberately: nobody is waiting on this, and a thrown
      // scheduled action would only produce log noise.
    }
    return null;
  },
});

const MAX_RESETS_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;

export const requestPasswordReset = action({
  args: { email: v.string() },
  handler: async (ctx, { email }): Promise<{ ok: true }> => {
    // One mutation, whatever the address turns out to be. The action itself no
    // longer branches at all, so there is nothing here for a stopwatch to read.
    await ctx.runMutation(internal.authSessions.queuePasswordReset, { email });
    return { ok: true };
  },
});
