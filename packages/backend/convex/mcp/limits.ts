import { ConvexError, v } from "convex/values";
import { internalMutation } from "../_generated/server";
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
};

export const consume = internalMutation({
  args: { kind: KIND },
  handler: async (ctx, args): Promise<null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) throw new ConvexError("Not authenticated");
    // `subject` is "<userId>|<sessionId>" — the same derivation getAuthUserId
    // uses, and the same one `mcp/connections.ts` already relies on.
    const userId = String(identity.subject).split("|")[0] as never;

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
