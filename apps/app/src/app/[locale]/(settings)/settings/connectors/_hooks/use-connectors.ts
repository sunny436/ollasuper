"use client";

import { useWorkspace } from "@/lib/useWorkspace";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import type {
  McpLocalSummary,
  McpServerSummary,
} from "@v1/backend/convex/mcp/catalogue";
import { useAction, useQuery } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ConnectionRow, type ConnectorView, joinConnectors } from "../_lib/dto";

/**
 * The catalogue, this user's connections, and the join between them.
 *
 * TWO DIFFERENT KINDS OF DATA, ON PURPOSE.
 *
 *   catalogue   an ACTION. It proxies the Python plane, which owns the curated
 *               table in Postgres. Actions are not reactive and not cached, so
 *               it is fetched once per mount behind a guard — the pattern
 *               `explore-menu.tsx` already uses for `chat.capabilities.list`.
 *   connections a QUERY. Live. When a connect finishes, a token expires, or
 *               another tab disconnects, this re-fires on its own and the page
 *               re-renders with no polling and no second socket (§59, §190).
 *
 * That split is why nothing here polls. The one thing that genuinely cannot
 * push — the catalogue — changes only when an operator changes it.
 *
 * `busy` LIVES HERE AND IS A SET, keyed by serverName. One membership per row
 * means a slow connect cannot disable the whole page, and two rows can be
 * worked on independently — the shape `skills/page.tsx` uses for its per-row
 * toggles. It is also the whole of §84: a second Connect click on a row already
 * in flight is ignored.
 */
export type ConnectorsState = {
  views: ConnectorView[];
  workspaceId: Id<"workspaces"> | null;
  /** True only while the FIRST catalogue fetch is outstanding. A refetch must
   *  not blank a list the user is already reading. */
  loading: boolean;
  /** The catalogue could not be read. Connections may still render. */
  catalogueError: boolean;
  /** null until asked; `enabled:false` is a deployment state, not an error. */
  localEnabled: boolean;
  /** False when MCP is turned off for the whole deployment (§87). */
  remoteEnabled: boolean;
  busy: ReadonlySet<string>;
  setBusy: (serverName: string, on: boolean) => void;
  reloadCatalogue: () => void;
};

export function useConnectors(): ConnectorsState {
  const { current } = useWorkspace();
  const listCatalogue = useAction(api.mcp.catalogue.list);
  const listLocal = useAction(api.mcp.catalogue.local);

  const [servers, setServers] = useState<McpServerSummary[] | null>(null);
  const [local, setLocal] = useState<McpLocalSummary[] | null>(null);
  const [localEnabled, setLocalEnabled] = useState(false);
  const [remoteEnabled, setRemoteEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [catalogueError, setCatalogueError] = useState(false);
  const [busy, setBusyState] = useState<Set<string>>(new Set());
  // Guards StrictMode's double-effect in development and any re-render that
  // would otherwise re-issue the same fetch.
  const started = useRef(false);

  const load = useCallback(async () => {
    setCatalogueError(false);
    try {
      const [cat, loc] = await Promise.all([listCatalogue({}), listLocal({})]);
      // null means "signed out" or "could not ask" — the action never throws for
      // either, precisely so this does not log a console.error.
      if (cat === null) {
        setCatalogueError(true);
      } else {
        // `enabled:false` is the global kill switch, not a failure. It gets its
        // own state so the page says "not available on this deployment" rather
        // than offering a Retry that cannot help.
        setRemoteEnabled(cat.enabled);
        setServers(cat.servers);
      }
      // A local failure must NOT blank the remote catalogue: local is an
      // optional layer on top, and treating its absence as a page error would
      // make a deployment with the flag off look broken.
      setLocalEnabled(loc?.enabled ?? false);
      setLocal(loc?.servers ?? null);
    } catch {
      setCatalogueError(true);
    } finally {
      setLoading(false);
    }
  }, [listCatalogue, listLocal]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void load();
  }, [load]);

  const rows = useQuery(
    api.mcp.connections.listWithAuth,
    current ? { workspaceId: current } : "skip",
  ) as ConnectionRow[] | undefined;

  const setBusy = useCallback((serverName: string, on: boolean) => {
    setBusyState((prev) => {
      const next = new Set(prev);
      if (on) next.add(serverName);
      else next.delete(serverName);
      return next;
    });
  }, []);

  const reloadCatalogue = useCallback(() => {
    setLoading(true);
    void load();
  }, [load]);

  return {
    views: joinConnectors(servers, rows, { busy, local }),
    workspaceId: current,
    loading,
    catalogueError,
    localEnabled,
    remoteEnabled,
    busy,
    setBusy,
    reloadCatalogue,
  };
}
