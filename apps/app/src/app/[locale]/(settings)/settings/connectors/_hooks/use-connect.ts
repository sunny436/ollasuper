"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { ConnectorView } from "../_lib/dto";
import { type UiError, fromReport } from "../_lib/errors";

/**
 * Connect, reconnect, refresh and disconnect — and the OAuth popup.
 *
 * CONNECT-FIRST, AND NOTHING BRANCHES ON `authKind`. The catalogue cannot know
 * whether a server speaks OAuth: the public registry publishes no auth-scheme
 * field, `registry/parse.py` refuses to infer one, and the curated column
 * defaults to "unknown". OAuth is discovered at RUNTIME, from the server's 401
 * and its `WWW-Authenticate` challenge. So this calls `connect` and reads what
 * came back; a UI that branched on `authKind` up front would simply never start
 * an authorization for most servers.
 *
 * A POPUP, BECAUSE THE BACKEND ALREADY CHOSE ONE. The Convex callback route
 * renders a self-contained page saying "You can close this window." — that is
 * popup-shaped, not redirect-shaped. It also means the opener never navigates,
 * so a browser refresh, a Back press and a duplicated callback all leave this
 * page's state untouched: there is nothing to restore because nothing was lost,
 * and no UI state ever enters a URL.
 *
 * NOTHING IS OPTIMISTIC (§99). No call here writes "connected" locally. Every
 * outcome is recorded server-side by `recordOutcome` and arrives back through
 * the live `listWithAuth` query, so what the page shows is what the backend
 * believes — including when a disconnect lands after a connect (§85).
 */

/** How often to ask whether the authorization finished, while a popup is open.
 *  Deliberately slow: the popup closing and the window regaining focus are the
 *  signals that actually matter, and this is only the backstop for a user who
 *  finishes in another tab. §56 — no hammering. */
const POLL_MS = 2500;
/** Give up the backstop after this long. The connection row still holds
 *  AUTHORIZING, so the page is correct; it just stops asking. */
const POLL_CEILING_MS = 5 * 60 * 1000;

export type ConnectHandlers = {
  connect: (view: ConnectorView) => Promise<void>;
  reconnect: (view: ConnectorView) => Promise<void>;
  refresh: (view: ConnectorView) => Promise<void>;
  disconnect: (view: ConnectorView) => Promise<void>;
  /** Set when a popup was blocked: the URL to offer as a plain link instead. */
  pendingAuthUrl: string | null;
  dismissAuthUrl: () => void;
  lastError: UiError | null;
};

export function useConnect(
  workspaceId: Id<"workspaces"> | null,
  setBusy: (serverName: string, on: boolean) => void,
): ConnectHandlers {
  const create = useMutation(api.mcp.connections.create);
  const connectAction = useAction(api.mcp.connections.connect);
  const refreshAction = useAction(api.mcp.connections.refresh);
  const disconnectAction = useAction(api.mcp.connections.disconnect);
  const oauthStart = useAction(api.mcp.oauth.start);
  const oauthStatus = useAction(api.mcp.oauth.status);
  const oauthDisconnect = useAction(api.mcp.oauth.disconnect);

  const [pendingAuthUrl, setPendingAuthUrl] = useState<string | null>(null);
  const [lastError, setLastError] = useState<UiError | null>(null);
  /** Connections with an authorization in flight. Prevents §86: a second
   *  Reconnect while a popup is open would mint a second `state` and orphan the
   *  first. */
  const authorizing = useRef<Set<string>>(new Set());
  const timers = useRef<Array<ReturnType<typeof setInterval>>>([]);

  useEffect(
    () => () => {
      for (const t of timers.current) clearInterval(t);
      timers.current = [];
    },
    [],
  );

  /** Ensure a connection row exists, and return its id.
   *
   *  `create` is idempotent per `(user, serverName)` and returns the existing
   *  id, so this is safe to call on every attempt and is the backend half of
   *  §84's duplicate-click protection. */
  const ensureRow = useCallback(
    async (view: ConnectorView): Promise<Id<"mcpConnections"> | null> => {
      if (view.connectionId) return view.connectionId as Id<"mcpConnections">;
      if (!workspaceId) return null;
      return await create({
        workspaceId,
        serverName: view.serverName,
        slug: view.slug,
        // EMPTY, and that is honest rather than lazy: the version in play is
        // whatever the catalogue resolves at connect time, and `recordOutcome`
        // writes the one actually used back to the row. Inventing a value here
        // would record a version this connection never ran against.
        version: "",
        versionMode: "latest_at_connect",
        transport: view.transport === "sse" ? "sse" : "streamable-http",
        authKind: view.authKind,
      });
    },
    [create, workspaceId],
  );

  /** Watch an in-flight authorization until it resolves, the popup closes, or
   *  the ceiling is reached. */
  const watchAuthorization = useCallback(
    (connectionId: Id<"mcpConnections">, popup: Window | null, serverName: string) => {
      const started = Date.now();
      const timer = setInterval(async () => {
        const expired = Date.now() - started > POLL_CEILING_MS;
        const closed = !!popup?.closed;
        if (expired) {
          clearInterval(timer);
          authorizing.current.delete(serverName);
          return;
        }
        try {
          const status = await oauthStatus({ connectionId });
          if (status?.auth_state === "CONNECTED") {
            clearInterval(timer);
            authorizing.current.delete(serverName);
            // Authorized is not the same as connected: the token exists, and
            // the session still has to be opened and its capabilities read.
            await connectAction({ connectionId });
            toast.success("Connected");
            return;
          }
        } catch {
          // A transient failure here is not worth a toast: the live query is
          // still authoritative and the next tick will ask again.
        }
        if (closed) {
          // The window is gone and the status is still not CONNECTED. Stop
          // asking; the row stays AUTHORIZING and the page offers the action
          // again, which is the honest outcome for a cancelled authorization.
          clearInterval(timer);
          authorizing.current.delete(serverName);
        }
      }, POLL_MS);
      timers.current.push(timer);
    },
    [connectAction, oauthStatus],
  );

  const beginAuthorization = useCallback(
    async (connectionId: Id<"mcpConnections">, serverName: string) => {
      if (authorizing.current.has(serverName)) return;
      authorizing.current.add(serverName);

      const report = await oauthStart({ connectionId });
      const url =
        typeof report?.authorization_url === "string"
          ? report.authorization_url
          : null;
      if (!url) {
        authorizing.current.delete(serverName);
        setLastError(fromReport(report));
        return;
      }

      // `noopener` deliberately omitted: the opener needs `popup.closed` to
      // know a cancelled authorization has ended. Nothing is read FROM the
      // popup — it is cross-origin and its page carries no token, no code and
      // no state — so this grants the provider's page nothing.
      const popup = window.open(url, "mcp-authorize", "width=520,height=720");
      if (!popup) {
        // §55: a blocked popup is its own state with its own recovery, not a
        // failed connection.
        setPendingAuthUrl(url);
        authorizing.current.delete(serverName);
        return;
      }
      watchAuthorization(connectionId, popup, serverName);
    },
    [oauthStart, watchAuthorization],
  );

  /** The one path both Connect and Reconnect take. */
  const run = useCallback(
    async (view: ConnectorView) => {
      setLastError(null);
      setBusy(view.serverName, true);
      try {
        const connectionId = await ensureRow(view);
        if (!connectionId) return;

        // A connection already waiting on a provider skips the dial and goes
        // straight back to the authorization — re-dialling would only earn the
        // same 401.
        if (view.state === "AUTHORIZING" || view.state === "AUTH_REQUIRED") {
          await beginAuthorization(connectionId, view.serverName);
          return;
        }

        const report = await connectAction({ connectionId });
        if (report?.state === "ready") {
          toast.success("Connected");
          return;
        }
        // THE RUNTIME ANSWER, not a catalogue guess. `user_action_required` is
        // true exactly for `auth_required` and `auth_failed`.
        if (report?.user_action_required === true) {
          await beginAuthorization(connectionId, view.serverName);
          return;
        }
        const err = fromReport(report);
        if (err) {
          setLastError(err);
          toast.error(err.message);
        }
      } catch {
        // A thrown action is a Convex-level failure (not signed in, row gone).
        // Never rethrow: an unhandled rejection logs a console.error, and every
        // e2e script fails on one.
        const err = fromReport(null);
        setLastError(err);
        toast.error(err?.message ?? "Something went wrong. Try again.");
      } finally {
        setBusy(view.serverName, false);
      }
    },
    [beginAuthorization, connectAction, ensureRow, setBusy],
  );

  const refresh = useCallback(
    async (view: ConnectorView) => {
      if (!view.connectionId) return;
      setBusy(view.serverName, true);
      try {
        const report = await refreshAction({
          connectionId: view.connectionId as Id<"mcpConnections">,
        });
        const err = fromReport(report);
        if (err) toast.error(err.message);
      } catch {
        toast.error("Couldn't refresh this connector");
      } finally {
        setBusy(view.serverName, false);
      }
    },
    [refreshAction, setBusy],
  );

  const disconnect = useCallback(
    async (view: ConnectorView) => {
      if (!view.connectionId) return;
      const connectionId = view.connectionId as Id<"mcpConnections">;
      setBusy(view.serverName, true);
      try {
        // OAuth FIRST WHENEVER A CREDENTIAL EXISTS, and the test is
        // `hasCredential`, not `scope`. Only `oauth.disconnect` attempts
        // revocation at the provider and deletes the stored credential;
        // `connections.disconnect` merely closes the live session. A provider
        // that issues a token and returns NO scope is ordinary, so choosing on
        // `scope` would silently leave that credential in the vault — a secret
        // outliving the thing it authorizes.
        if (view.hasCredential) {
          await oauthDisconnect({ connectionId });
        } else {
          await disconnectAction({ connectionId });
        }
        toast.success("Disconnected");
      } catch {
        toast.error("Couldn't disconnect this connector");
      } finally {
        setBusy(view.serverName, false);
      }
    },
    [disconnectAction, oauthDisconnect, setBusy],
  );

  return {
    connect: run,
    reconnect: run,
    refresh,
    disconnect,
    pendingAuthUrl,
    dismissAuthUrl: () => setPendingAuthUrl(null),
    lastError,
  };
}
