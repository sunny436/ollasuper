"use node";

import { action } from "./_generated/server";

/**
 * The vocabulary a custom skill may declare in its `capabilities`.
 *
 * A PROXY, not a cache — same shape and same reasoning as
 * `chat/capabilities.ts`: read AI_BASE_URL + AI_SERVICE_KEY, ask the Python
 * plane, hand back the answer. The set changes only when a deployment flag
 * changes, so a table would be machinery for a problem that does not exist, and
 * machinery that goes stale in the one direction that matters (offering a
 * capability that has since been turned off).
 *
 * A DIFFERENT LIST FROM `chat.capabilities.list`, and the distinction is the
 * whole reason this is a separate file. That one returns product surfaces
 * ("seo", "blog") for the Explore menu. This returns capability INTENTS
 * (`page.fetch`, `blog.serp_research`) — the stable naming layer over provider
 * tool ids, and the only vocabulary the runtime will accept from a user skill.
 * Serving both from one function would guarantee somebody eventually shows the
 * wrong one in the wrong picker.
 *
 * RETURNS NULL ON ANY FAILURE. The form then renders no picker rather than an
 * empty one: "we cannot reach the list right now" and "your deployment has no
 * capabilities" look identical in an empty select, and only one of them is
 * usually true. A skill saves perfectly well without declaring any.
 */
export const list = action({
  args: {},
  handler: async (ctx): Promise<{ id: string; group: string }[] | null> => {
    // SIGNED-IN CALLERS ONLY — same confused-deputy reasoning as
    // chat/capabilities.ts, and the same use of `ctx.auth` rather than a
    // runQuery hop: a "use node" action cannot runQuery on this self-hosted
    // 1.19 backend (measured — "Transient error while running query"). Proves
    // authentication, not account status; see the fuller note in that file.
    // Null keeps the documented contract (the form renders no picker rather
    // than an empty one) and logs no console.error for a signed-out render.
    if ((await ctx.auth.getUserIdentity()) === null) return null;
    const base = process.env.AI_BASE_URL;
    const key = process.env.AI_SERVICE_KEY;
    if (!base || !key) return null;
    try {
      const res = await fetch(
        `${base.replace(/\/$/, "")}/v1/capabilities/skill`,
        { method: "GET", headers: { "x-service-key": key } },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as { capabilities?: unknown };
      if (!Array.isArray(body.capabilities)) return null;
      const out = body.capabilities.flatMap((c) => {
        if (typeof c !== "object" || c === null) return [];
        const { id, group } = c as { id?: unknown; group?: unknown };
        if (typeof id !== "string" || !id) return [];
        return [{ id, group: typeof group === "string" ? group : "general" }];
      });
      // Empty is a failure, not an answer: the four core intents (page.fetch,
      // page.render, crawl.run, search_performance.read) are ungated, so an
      // empty list means the shape was wrong rather than that the deployment
      // has nothing. Mirrors chat/capabilities.ts and chat/models.ts.
      return out.length > 0 ? out : null;
    } catch {
      return null;
    }
  },
});
