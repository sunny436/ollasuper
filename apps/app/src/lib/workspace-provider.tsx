"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation, useQuery } from "convex/react";
import { DISPLACED_KEY } from "./displaced-session";
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
  const [selected, setSelected] = useState<Id<"workspaces"> | null>(null);
  const [ensuring, setEnsuring] = useState(false);
  // Optimistic workspace from the last session, hydrated in an EFFECT (not during
  // render → no hydration mismatch). Lets the composer become usable at hydration
  // on a reload instead of waiting for myWorkspaces to land over the WebSocket —
  // i.e. no "Preparing your workspace…" flash for a returning user.
  const [optimistic, setOptimistic] = useState<Id<"workspaces"> | null>(null);
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("ws");
      if (saved) setOptimistic(saved as Id<"workspaces">);
    } catch {}
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: run once per mount
  useEffect(() => {
    void heartbeat({})
      .then((r) => {
        // The server revoked this session because the account signed in
        // elsewhere. The access token still works until it expires, so end the
        // session here rather than leaving the user in a half-valid state, and
        // leave a note for the login page to explain why they landed there.
        if (r && r.ok === false) {
          try {
            window.sessionStorage.setItem(DISPLACED_KEY, "1");
          } catch {}
          void signOut();
        }
      })
      .catch(() => {});
  }, []);

  // Creating a workspace is a write, so it stays in an effect. Resolving which
  // existing workspace is current does not, and used to — see below.
  useEffect(() => {
    if (workspaces === undefined || workspaces.length > 0 || ensuring) return;
    setEnsuring(true);
    void ensure({}).finally(() => setEnsuring(false));
  }, [workspaces, ensure, ensuring]);

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
    const saved = typeof window !== "undefined" ? window.localStorage.getItem("ws") : null;
    const match = workspaces.find((w) => w._id === saved);
    return match?._id ?? workspaces[0]?._id ?? null;
  }, [workspaces, selected]);

  // Persist the resolved id so the NEXT reload can seed `optimistic` before the
  // query returns. (Previously only select() wrote it, so a user who never
  // switched workspaces had nothing cached.)
  useEffect(() => {
    if (resolved && typeof window !== "undefined") {
      try {
        window.localStorage.setItem("ws", resolved);
      } catch {}
    }
  }, [resolved]);

  // Preserves the previous effect's `?? prev` behaviour: once a workspace has
  // resolved, a transiently empty or in-flight list never clears it back to null.
  // Falls back to the optimistic (cached) id while myWorkspaces is still loading.
  const sticky = useRef<Id<"workspaces"> | null>(null);
  if (resolved !== null) sticky.current = resolved;
  const current = resolved ?? sticky.current ?? optimistic;

  const select = (id: Id<"workspaces">) => {
    if (typeof window !== "undefined") window.localStorage.setItem("ws", id);
    setSelected(id);
  };

  return (
    <WorkspaceCtx.Provider value={{ workspaces: workspaces ?? [], current, select }}>
      {children}
    </WorkspaceCtx.Provider>
  );
}
