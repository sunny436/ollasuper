"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useAuthActions, useAuthToken } from "@convex-dev/auth/react";
import { useMutation, useQuery } from "convex/react";
import {
  CACHE_KEYS,
  clearDisplayCaches,
  ownerFromToken,
  readOwnedCache,
  writeOwnedCache,
} from "./display-cache";
import { DISPLACED_KEY, isIntentionalSignOut } from "./displaced-session";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

type WS = { _id: Id<"workspaces">; name: string; role: string };
type Ctx = {
  workspaces: WS[];
  current: Id<"workspaces"> | null;
  select: (id: Id<"workspaces">) => void;
};

const WorkspaceCtx = createContext<Ctx>({ workspaces: [], current: null, select: () => {} });
export const useWorkspace = () => useContext(WorkspaceCtx);

/**
 * Holds the current workspace in React context (persisted to localStorage) so the sidebar
 * switcher and every page share it reactively — switching updates all consumers at once.
 */
export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const workspaces = useQuery(api.orgs.myWorkspaces) as WS[] | undefined;
  const ensure = useMutation(api.orgs.ensureWorkspace);
  // Single-active-session enforcement + lastActivityAt. The decision and the
  // writes happen server-side in one mutation; this only supplies the trigger,
  // because @convex-dev/auth has no callback that spans every sign-in path.
  const heartbeat = useMutation(api.authSessions.heartbeat);
  const { signOut } = useAuthActions();
  // Whose browser state this is: the verified user id in the session JWT. The
  // cached workspace is only ever read back for that same account (F-09).
  const owner = ownerFromToken(useAuthToken());
  const session = useQuery(api.authSessions.sessionState);
  const [selected, setSelected] = useState<Id<"workspaces"> | null>(null);
  // Optimistic workspace from the last session, hydrated in an EFFECT (not during
  // render → no hydration mismatch). Lets the composer become usable at hydration
  // on a reload instead of waiting for myWorkspaces to land over the WebSocket —
  // i.e. no "Preparing your workspace…" flash for a returning user. Read only
  // once the owner is known: readOwnedCache drops an entry it cannot attribute.
  const [optimistic, setOptimistic] = useState<Id<"workspaces"> | null>(null);
  useEffect(() => {
    if (!owner) return;
    setOptimistic(readOwnedCache<Id<"workspaces">>(CACHE_KEYS.workspace, owner));
  }, [owner]);

  // Enforces the per-account session limit and records activity. It no longer
  // decides anything for the client: `{ok:false}` also means "no identity yet",
  // and the question it was used to answer is now asked reactively below.
  useEffect(() => {
    void heartbeat({}).catch(() => {});
  }, []);

  // This session was ended from elsewhere (a newer device past the limit, a
  // password reset or change, suspension). The token still works for up to an
  // hour while every query answers "signed out", which used to leave an empty
  // app behind. End it here and leave a note for the login page — unless the
  // user just signed out on purpose, which reads the same for a moment.
  const ended = useRef(false);
  useEffect(() => {
    if (session !== "ended" || ended.current || isIntentionalSignOut()) return;
    ended.current = true;
    try {
      window.sessionStorage.setItem(DISPLACED_KEY, "1");
    } catch {}
    clearDisplayCaches();
    void signOut();
  }, [session, signOut]);

  // Creating a workspace is a write, so it stays in an effect. ONCE per mount,
  // and only for a live session: myWorkspaces is also empty for a session that
  // has ended, where ensureWorkspace answers null — and re-firing on every null
  // was measured on production at ~30 calls a second from a single tab.
  const ensured = useRef(false);
  useEffect(() => {
    if (session !== "live" || ensured.current) return;
    if (workspaces === undefined || workspaces.length > 0) return;
    ensured.current = true;
    void ensure({}).catch(() => {
      ensured.current = false;
    });
  }, [session, workspaces, ensure]);

  /**
   * Derived during render, not committed by a post-paint effect.
   *
   * Everything workspace-scoped is gated on this: chat-sidebar passes "skip" to
   * chat.threads.list until it is set, and the composer renders disabled with
   * "Preparing your workspace…" (use-send-message reports canSend: false). While
   * this lived in an effect, the thread query could not even be issued until a
   * whole extra React commit after myWorkspaces resolved.
   *
   * SSR-safe: `workspaces` is undefined on the server, so this is null on the
   * server and on the first client render alike — no hydration mismatch.
   */
  const resolved = useMemo<Id<"workspaces"> | null>(() => {
    if (workspaces === undefined || workspaces.length === 0) return null;
    if (selected && workspaces.some((w) => w._id === selected)) return selected;
    const saved = owner ? readOwnedCache<string>(CACHE_KEYS.workspace, owner) : null;
    const match = workspaces.find((w) => w._id === saved);
    return match?._id ?? workspaces[0]?._id ?? null;
  }, [workspaces, selected, owner]);

  // Persist the resolved id so the NEXT reload can seed `optimistic` before the
  // query returns. (Previously only select() wrote it, so a user who never
  // switched workspaces had nothing cached.)
  useEffect(() => {
    if (resolved) writeOwnedCache(CACHE_KEYS.workspace, owner, resolved);
  }, [resolved, owner]);

  // Preserves the previous effect's `?? prev` behaviour: once a workspace has
  // resolved, a transiently empty or in-flight list never clears it back to null.
  // Falls back to the optimistic (cached) id while myWorkspaces is still loading.
  const sticky = useRef<Id<"workspaces"> | null>(null);
  if (resolved !== null) sticky.current = resolved;
  const current = resolved ?? sticky.current ?? optimistic;

  const select = (id: Id<"workspaces">) => {
    writeOwnedCache(CACHE_KEYS.workspace, owner, id);
    setSelected(id);
  };

  return (
    <WorkspaceCtx.Provider value={{ workspaces: workspaces ?? [], current, select }}>
      {children}
    </WorkspaceCtx.Provider>
  );
}
