import { ConvexError, v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { activeUserId } from "../accountState";
import { type QuotaKind, consumeWindow } from "../quotas";

/**
 * Rate limits for the MCP surfaces, reusing the existing per-user windows.
 *
 * WHY THIS EXISTS. Every MCP surface shipped through Phase 7 with NO rate limit
 * of any kind. Each of them makes a real network call to a third party on the
 * user's behalf, so an unbounded loop spends somebody else's API quota, our
 * outbound bandwidth, and — for authorization — the provider's patience with
 * our client. `MAX_GENERATIONS_PER_HOUR` is described in `chat/messages.ts` as
 * "the only thing standing between one compromised session and an unbounded
 * bill"; MCP had no equivalent at all.
 *
 * NOTHING NEW IS BUILT. `quotas.ts::consumeWindow` is the existing per-user
 * fixed-window primitive, and `userQuotas.kind` is `v.string()` in the schema
 * with a TypeScript union on top — so adding MCP kinds is a TYPE change and
 * needs no migration. Reusing it also means MCP cannot accidentally get a
 * weaker window than chat, and that a future fix to the primitive fixes both.
 *
 * WHY AN internalMutation. The surfaces being limited are ACTIONS (they call
 * the Python plane over HTTP) and `consumeWindow` needs a `MutationCtx`. The
 * one caller that is already a mutation — `connections.create` — consumes its
 * window inline instead of coming through here.
 *
 * THE USER IS DERIVED, NEVER PASSED. An internal mutation is reachable by any
 * action in this deployment, so a caller-supplied `userId` would let the rate
 * limit be spent against somebody else — turning a quota into a denial of
 * service. It comes from `ctx.auth`, the same derivation `getAuthUserId` uses.
 *
 * FAIL CLOSED ON AN UNAUTHENTICATED CALLER. There is no window to charge, and
 * an anonymous caller has no business reaching a third-party server on
 * OllaSuper's credentials in the first place.
 */

const WINDOW_MS = 60 * 60 * 1000;

/** See `quotas.ts` for the rationale behind each number. Reasoned, not
 *  load-tested, and deliberately in one place so an operator changing them
 *  reads the reasoning rather than guessing. */
export const LIMITS: Record<string, number> = {
  mcpConnect: 60,
  mcpAuth: 20,
  mcpCapability: 120,
  mcpToolCall: 600,
};

const KIND = v.union(
  v.literal("mcpConnect"),
  v.literal("mcpAuth"),
  v.literal("mcpCapability"),
);

/** Human sentence per kind. A user who hits a limit should learn what to stop
 *  doing, not read the name of an internal counter. */
const MESSAGE: Record<string, string> = {
  mcpConnect: "Too many connection attempts",
  mcpAuth: "Too many authorization attempts",
  mcpCapability: "Too many connector requests",
  mcpToolCall: "Hourly connector call limit reached",
};

export const consume = internalMutation({
  args: { kind: KIND },
  handler: async (ctx, args): Promise<null> => {
    // Live session + active account (accountState.activeUserId).
    const userId = await activeUserId(ctx);
    if (userId === null) throw new ConvexError("Not authenticated");

    const kind = args.kind as QuotaKind;
    const res = await consumeWindow(
      ctx,
      userId,
      kind,
      LIMITS[args.kind] ?? 60,
      WINDOW_MS,
    );
    if (!res.ok) {
      const mins = Math.ceil(res.retryInMs / 60_000);
      throw new ConvexError(
        `${MESSAGE[args.kind] ?? "Too many requests"} — try again in ${mins} minute${
          mins === 1 ? "" : "s"
        }`,
      );
    }
    return null;
  },
});

/**
 * The plane-charged window (audit H-09). Reached from `/ai/ingress` with the
 * ingress secret, so — unlike `consume` above — the user is NAMED IN THE BODY:
 * the plane acts for the user whose turn it is running. That is the same trust
 * the credential ops extend to it, and it is bounded the same way: a user id
 * that does not resolve to an active account is refused, and the answer is a
 * plain `{ok, detail}` rather than a thrown error so the plane can refuse the
 * tool call with the reason in hand.
 */
export const consumeForPlane = internalMutation({
  args: { userId: v.id("users"), kind: v.literal("mcpToolCall") },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: boolean; detail?: string; retryInMs?: number }> => {
    const user = await ctx.db.get(args.userId);
    if (!user || (user.accountStatus && user.accountStatus !== "active")) {
      return { ok: false, detail: "account is not active" };
    }
    const res = await consumeWindow(
      ctx,
      args.userId,
      args.kind,
      LIMITS[args.kind] ?? 600,
      WINDOW_MS,
    );
    if (!res.ok) {
      const mins = Math.ceil(res.retryInMs / 60_000);
      return {
        ok: false,
        retryInMs: res.retryInMs,
        detail: `${MESSAGE[args.kind]} — try again in ${mins} minute${
          mins === 1 ? "" : "s"
        }`,
      };
    }
    return { ok: true };
  },
});
