"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation, useQuery } from "convex/react";
import { DISPLACED_KEY } from "./displaced-session";
import { createContext, useContext, useEffect, useState } from "react";

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
  const [current, setCurrent] = useState<Id<"workspaces"> | null>(null);
  const [ensuring, setEnsuring] = useState(false);

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

  useEffect(() => {
    if (workspaces === undefined) return;
    if (workspaces.length === 0) {
      if (!ensuring) {
        setEnsuring(true);
        void ensure({}).finally(() => setEnsuring(false));
      }
      return;
    }
    setCurrent((prev) => {
      if (prev && workspaces.some((w) => w._id === prev)) return prev;
      const saved = typeof window !== "undefined" ? window.localStorage.getItem("ws") : null;
      const match = workspaces.find((w) => w._id === saved);
      return match?._id ?? workspaces[0]?._id ?? prev;
    });
  }, [workspaces, ensure, ensuring]);

  const select = (id: Id<"workspaces">) => {
    if (typeof window !== "undefined") window.localStorage.setItem("ws", id);
    setCurrent(id);
  };

  return (
    <WorkspaceCtx.Provider value={{ workspaces: workspaces ?? [], current, select }}>
      {children}
    </WorkspaceCtx.Provider>
  );
}
