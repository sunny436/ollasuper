import { action } from "../_generated/server";
import { clamp } from "./connections";

/**
 * The catalogue a browser may read — the ~30 servers this deployment will dial.
 *
 * WHY THIS FILE HAD TO EXIST. The curated set lives in Postgres, in the Python
 * plane, behind `require_service_key` on loopback. `routers/mcp.py`'s own
 * docstring says Phase 7's UI reaches it "through a Convex action, the pattern
 * `convex/chat/capabilities.ts` already uses" — and until now that action did
 * not exist, so the browser could not list a single server. This is it.
 *
 * A PROXY, NOT A CACHE, exactly like `chat/capabilities.ts`. No table, no cron,
 * no schema change: the curated set changes when an operator changes it, and a
 * cache would add machinery that can go stale in the one direction that matters
 * — advertising a server this deployment will refuse to dial.
 *
 * SIGNED-IN CALLERS ONLY, and that is a security control rather than a nicety.
 * This action spends `AI_SERVICE_KEY` against the internal plane on behalf of
 * whoever calls it. Anonymously that is a confused deputy: an unauthenticated
 * caller would make the deployment present its own credential and hand back
 * which servers are enabled here. `chat/capabilities.ts` carries the same
 * comment for the same reason.
 *
 * NOT `"use node"`, DELIBERATELY, matching `mcp/connections.ts` and unlike
 * `chat/capabilities.ts`. The default V8 runtime has `fetch`, which is all this
 * needs, and it keeps the whole `mcp/` directory on one runtime — the one where
 * `ctx.runQuery` also works, so a later change here cannot hit the measured
 * self-hosted-1.19 "Transient error while running query" failure.
 *
 * NULL ON ANY FAILURE, never a throw. A signed-out render and an unreachable AI
 * plane both return null, and the page shows "catalogue unavailable" rather
 * than logging a `console.error` — which would fail every e2e script.
 */

/** Bounded because it is THIRD-PARTY TEXT from the public MCP registry, not
 *  ours. `clamp` is `connections.ts`'s, shared rather than copied: it strips
 *  control characters as well as truncating, and one implementation of a
 *  rendering-safety control beats two that can drift. */
const MAX_NAME = 120;
const MAX_DESCRIPTION = 400;
const MAX_CATEGORY = 64;

/** The safe shape a card and a detail page render. Note what is NOT here:
 *  `endpoint_url`, operator `notes` and the `trusted` flag are dropped in
 *  PYTHON (`curated._SAFE_FIELDS`), so they never cross the process boundary
 *  and cannot be re-exposed by a change on this side of it. */
export type McpServerSummary = {
  serverName: string;
  slug: string;
  displayName: string;
  category: string;
  description: string | null;
  authKind: string;
  transport: string;
  catalogueStatus: string;
};

export type McpLocalSummary = {
  slug: string;
  displayName: string;
  /** "available" | "blocked" — the verdict, recomputed per call by the
   *  validator, never a stored flag. */
  state: string;
  network: string;
  trust: string;
};

type Plane = Record<string, unknown>;

/** GET one internal route. Returns null for every failure mode so the caller
 *  has exactly one thing to check. */
async function readPlane(path: string): Promise<Plane | null> {
  const base = process.env.AI_BASE_URL;
  const key = process.env.AI_SERVICE_KEY;
  if (!base || !key) return null;
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
      method: "GET",
      headers: { "x-service-key": key },
    });
    if (!res.ok) return null;
    return (await res.json()) as Plane;
  } catch {
    // Never echo the exception: it can carry an internal hostname.
    return null;
  }
}

function str(value: unknown, max: number): string {
  return clamp(typeof value === "string" ? value : "", max) ?? "";
}

export const list = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ enabled: boolean; servers: McpServerSummary[] } | null> => {
    // See the module docstring: this spends AI_SERVICE_KEY on the caller's
    // behalf, so an anonymous caller is a confused deputy.
    if ((await ctx.auth.getUserIdentity()) === null) return null;

    const payload = await readPlane("/v1/mcp/curated");
    if (payload === null) return null;

    // OFF is a deployment state, not an error — the same distinction
    // `catalogue.local` already makes. Returning null here would make the UI
    // offer a Retry for something no retry can change.
    if (payload.enabled === false) return { enabled: false, servers: [] };

    const rows = Array.isArray(payload.servers) ? payload.servers : [];
    const servers: McpServerSummary[] = [];
    for (const raw of rows) {
      if (typeof raw !== "object" || raw === null) continue;
      const r = raw as Record<string, unknown>;
      const slug = str(r.slug, MAX_NAME);
      const serverName = str(r.server_name, MAX_NAME);
      // A row with no identity cannot be rendered or connected, and silently
      // dropping it beats rendering a card whose Connect button cannot work.
      if (!slug || !serverName) continue;
      const description = clamp(
        typeof r.description === "string" ? r.description : undefined,
        MAX_DESCRIPTION,
      );
      servers.push({
        serverName,
        slug,
        // Falls back to the slug rather than to an empty heading: a curated row
        // always has a display name, but this is third-party-adjacent data and
        // a blank card title is the one outcome worth ruling out.
        displayName: str(r.display_name, MAX_NAME) || slug,
        category: str(r.category, MAX_CATEGORY) || "other",
        description: description ? description : null,
        // REPORTED, NOT ACTED ON. The catalogue cannot know whether a server
        // speaks OAuth — the registry publishes no auth-scheme field, so it is
        // discovered at runtime from a 401. The UI shows this as a detail and
        // never branches its connect flow on it.
        authKind: str(r.auth_kind, MAX_CATEGORY) || "unknown",
        transport: str(r.transport, MAX_CATEGORY),
        catalogueStatus: str(r.catalogue_status, MAX_CATEGORY) || "active",
      });
    }
    return { enabled: true, servers };
  },
});

export const local = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ enabled: boolean; servers: McpLocalSummary[] } | null> => {
    if ((await ctx.auth.getUserIdentity()) === null) return null;

    const payload = await readPlane("/v1/mcp/local");
    if (payload === null) return null;

    // OFF is a deployment state, not an error. Saying so plainly is what stops
    // the UI rendering "no local servers" for a feature nobody turned on.
    if (payload.enabled !== true) return { enabled: false, servers: [] };

    const rows = Array.isArray(payload.servers) ? payload.servers : [];
    const servers: McpLocalSummary[] = [];
    for (const raw of rows) {
      if (typeof raw !== "object" || raw === null) continue;
      const r = raw as Record<string, unknown>;
      const slug = str(r.slug, MAX_NAME);
      if (!slug) continue;
      servers.push({
        slug,
        displayName: str(r.display_name, MAX_NAME) || slug,
        state: r.state === "available" ? "available" : "blocked",
        network: str(r.network, MAX_CATEGORY) || "none",
        trust: str(r.trust, MAX_CATEGORY) || "blocked",
      });
    }
    // `reasons` and `gateway` are DELIBERATELY NOT FORWARDED. They are operator
    // diagnostics — which policy field refused a row, whether the gateway URL
    // parses, whether a token is configured — and §36 asks for a human state,
    // not the security policy behind it.
    return { enabled: true, servers };
  },
});
