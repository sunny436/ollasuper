"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useAction } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Resources and prompts for ONE connection, loaded on demand.
 *
 * LAZY IS A REQUIREMENT HERE, NOT A PREFERENCE. `_capability_index` in the
 * Python plane calls `pool.acquire(spec)`, so a cold call opens a real MCP
 * session and performs a handshake against a third-party server. Fetching this
 * for thirty catalogue cards would be thirty handshakes on a page load (§211),
 * and on mobile over a slow link it would be most of the page's cost. So
 * nothing here runs until a detail page asks (§119, §212).
 *
 * `error` IS SEPARATE FROM AN EMPTY LIST, and the backend hands both back for
 * exactly this reason: `/resources` returns `{resources: [...], error: null}`
 * where a failed list sets `error` instead. "This app has no resources" and
 * "we could not ask" are different facts with different recoveries, and
 * collapsing them is the bug §44/§45 describes.
 *
 * TOOLS ARE NOT FETCHED HERE. A tool reaches the model through the chat turn,
 * not through a browser, so there is no listing route for them by design — the
 * names ride on the connection row, written at connect time.
 */

export type ResourceItem = {
  name: string;
  uri: string;
  description?: string;
  mime_type?: string;
};

export type PromptArgument = {
  name: string;
  description?: string;
  required?: boolean;
};

export type PromptItem = {
  name: string;
  description?: string;
  arguments?: PromptArgument[];
};

type Section<T> = {
  items: T[];
  loading: boolean;
  /** A human sentence when the listing failed. Null when it succeeded, even if
   *  the result was empty. */
  error: string | null;
  /** Advertised but refused — over the count cap, oversized schema, malformed.
   *  Surfaced so a list never silently means "N of many". */
  dropped: number;
  reload: () => void;
};

function useSection<T>(
  connectionId: string | null,
  run: (args: { connectionId: Id<"mcpConnections"> }) => Promise<Record<string, unknown>>,
  key: string,
  enabled: boolean,
): Section<T> {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropped, setDropped] = useState(0);
  const started = useRef(false);

  const load = useCallback(async () => {
    if (!connectionId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await run({ connectionId: connectionId as Id<"mcpConnections"> });
      // `error` on the payload is the PLANE's classified message — a listing
      // that failed. It is not an exception and must not be rendered as one.
      if (typeof res?.error === "string" && res.error.length > 0) {
        setError(res.error);
        setItems([]);
      } else {
        const list = res?.[key];
        setItems(Array.isArray(list) ? (list as T[]) : []);
        setDropped(typeof res?.dropped === "number" ? res.dropped : 0);
      }
    } catch {
      // Never rethrow: an unhandled rejection is a console.error, and every e2e
      // script fails on one.
      setError("This app's capabilities could not be loaded.");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [connectionId, run, key]);

  useEffect(() => {
    if (!enabled || started.current || !connectionId) return;
    started.current = true;
    void load();
  }, [enabled, connectionId, load]);

  return { items, loading, error, dropped, reload: load };
}

export function useCapabilities(connectionId: string | null, enabled: boolean) {
  const listResources = useAction(api.mcp.capabilities.resources);
  const listPrompts = useAction(api.mcp.capabilities.prompts);

  return {
    resources: useSection<ResourceItem>(
      connectionId,
      listResources,
      "resources",
      enabled,
    ),
    prompts: useSection<PromptItem>(connectionId, listPrompts, "prompts", enabled),
  };
}
