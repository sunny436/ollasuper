import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action } from "../_generated/server";

/**
 * Which capabilities this deployment actually has, for the Explore menu.
 *
 * A PROXY, not a cache. Mirrors scheduled/parse.ts: read AI_BASE_URL +
 * AI_SERVICE_KEY, call the Python plane, hand back the answer. There is no
 * table, no cron and no schema change, because the thing being fetched changes
 * only when the deployment's flags change — a cache would be machinery for a
 * problem that does not exist, and machinery that can go stale in the one
 * direction that matters (advertising a capability that was turned off).
 *
 * IDS ONLY. Every label, description, icon, column and starter prompt lives in
 * explore-menu.tsx. The server says WHICH capabilities exist; the client says
 * how they read. Two sources of truth on the same user-facing string is how a
 * menu drifts from its design.
 *
 * RETURNS NULL ON ANY FAILURE, deliberately. The caller then shows the full
 * static list rather than an empty menu: an unreachable AI plane should degrade
 * discovery to "possibly offers something unavailable", never to "OllaSuper
 * appears to do nothing". Discovery is not worth an error state.
 */
export const list = action({
  args: {},
  handler: async (ctx): Promise<string[] | null> => {
    // SIGNED-IN CALLERS ONLY. This spends AI_SERVICE_KEY against the internal
    // plane on behalf of whoever calls it, which anonymously is a confused
    // deputy: an unauthenticated caller made this deployment present its own
    // credential and hand back which capabilities are enabled here, on an
    // unmetered action with no limit. The Python side is correctly guarded —
    // but by OUR key, which is the problem.
    //
    // A LIVE SESSION, not just a signed token (audit F-05): a signed-out,
    // displaced or suspended caller holding an unexpired JWT is refused like
    // an anonymous one. This module used to be "use node" and so read bare
    // ctx.auth — a Node-runtime action cannot runQuery on this self-hosted
    // 1.19 backend. It needs neither Node nor anything but fetch, so it runs in
    // the default runtime, which can (the pattern mcp/connections.ts uses).
    //
    // Null, not a throw, so the contract below is unchanged: a signed-out
    // render shows the full static menu rather than an empty one, and logs no
    // console.error.
    const userId: Id<"users"> | null = await ctx.runQuery(
      internal.accountState.activeCallerId,
      {},
    );
    if (!userId) return null;
    const base = process.env.AI_BASE_URL;
    const key = process.env.AI_SERVICE_KEY;
    if (!base || !key) return null;
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/v1/capabilities`, {
        method: "GET",
        headers: { "x-service-key": key },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { enabled?: unknown };
      if (!Array.isArray(body.enabled)) return null;
      const ids = body.enabled.filter((x): x is string => typeof x === "string");
      // An empty list is treated as a failure rather than as "nothing is
      // enabled": coding, writing, research and file analysis are ungated, so
      // an empty answer means the shape was wrong, not that the deployment is
      // bare. Same reasoning as chat/models.ts refusing an implausible
      // catalogue instead of emptying the picker.
      return ids.length > 0 ? ids : null;
    } catch {
      return null;
    }
  },
});
