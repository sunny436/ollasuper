"use client";

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams } from "next/navigation";
import { ChatSessionProvider } from "../_hooks/use-chat-session";
import { ComposerProvider } from "../_hooks/use-composer";
import { DEFAULT_MODEL } from "../_lib/models";
import { ChatLayout } from "./chat-layout";
import { ChatSidebar } from "./chat-sidebar";

/**
 * Layout for the chat subtree.
 *
 * THE TWO-SIDEBAR PROBLEM IS GONE. This route used to sit inside the dashboard
 * shell, so a docked conversation rail meant two rails: 240px + 272px left
 * ~256px of transcript at md, which is why the rail only docked at xl (1280px).
 * Under (workspace) there is no app rail, so this one docks at md and the
 * transcript keeps ~480px at the narrowest docked width.
 *
 * Below md the rail is an overlay drawer. Above md it is docked but
 * collapsible, which is the ChatGPT/Gemini behaviour — and the two are
 * deliberately separate pieces of state:
 *
 *   `open`      — the mobile drawer. Ephemeral, always starts closed.
 *   `collapsed` — the desktop dock. Persisted, because a user who hides the
 *                 rail means it for the session after this one too.
 */

const RAIL_KEY = "chat:rail-collapsed";

interface SidebarApi {
  open: boolean;
  openSidebar: () => void;
  closeSidebar: () => void;
  collapsed: boolean;
  toggleCollapsed: () => void;
}

const SidebarCtx = createContext<SidebarApi>({
  open: false,
  openSidebar: () => undefined,
  closeSidebar: () => undefined,
  collapsed: false,
  toggleCollapsed: () => undefined,
});

export function useChatSidebar() {
  return useContext(SidebarCtx);
}

export function ChatShell({ children }: { children: ReactNode }) {
  // Read here rather than taking it as a prop from the page: the composer now
  // lives in this (persistent) subtree, and the page components below are what
  // get swapped on navigation. Stays a raw string — never cast to
  // Id<"chatThreads">, because a typo'd URL reaching a v.id() validator throws
  // ArgumentValidationError, which the Convex client logs via console.error.
  const params = useParams<{ threadId?: string }>();
  const threadId = params?.threadId ?? null;

  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  const openSidebar = useCallback(() => {
    restoreFocus.current = document.activeElement as HTMLElement | null;
    setOpen(true);
  }, []);
  const closeSidebar = useCallback(() => setOpen(false), []);

  /**
   * Restore the persisted dock state in an effect, never during render.
   *
   * Reading localStorage while rendering gives the server "expanded" and the
   * client "collapsed", which React reports as a hydration mismatch through
   * console.error — and every e2e script fails the run on a single one of
   * those. So the first paint is always expanded and this collapses it a frame
   * later; the width transition makes that read as deliberate rather than as a
   * flash.
   */
  useEffect(() => {
    try {
      if (window.localStorage.getItem(RAIL_KEY) === "1") setCollapsed(true);
    } catch {
      // Private mode / blocked storage. The default (expanded) is fine.
    }
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(RAIL_KEY, next ? "1" : "0");
      } catch {
        // Non-fatal: the toggle still works for this session.
      }
      return next;
    });
  }, []);

  // Escape closes the drawer. The dashboard sidebar lacks this; the command
  // palette has it, and it is what people expect from an overlay.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Lock the page behind the overlay; without this iOS scrolls the body under
  // the drawer.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Move focus in on open, restore it on close.
  useEffect(() => {
    if (open) {
      panelRef.current?.focus();
    } else {
      restoreFocus.current?.focus?.();
    }
  }, [open]);

  const api = useMemo(
    () => ({ open, openSidebar, closeSidebar, collapsed, toggleCollapsed }),
    [open, openSidebar, closeSidebar, collapsed, toggleCollapsed],
  );

  return (
    <SidebarCtx.Provider value={api}>
      {/*
        ComposerProvider lives HERE, not around ChatPane alone. The prompt
        library renders inside ChatSidebar — a sibling of {children} — and
        calls useComposer() to fill the draft, which is exactly what the
        provider exists for. Scoped to the pane it threw
        "useComposer must be used inside ComposerProvider" and took the whole
        chat route down with it. Both consumers must share one provider.
      */}
      <ComposerProvider>
        {/*
          Docked from md up, collapsible to zero width.

          <nav>, not <aside>: e2e/p-sidebar.js does page.locator("aside") and
          Playwright strict mode throws on multiple matches. That rail now lives
          on the routes that kept the dashboard shell, but keeping this a <nav>
          costs nothing and removes the whole class of problem.

          Collapse is a width transition rather than a framer-motion spring.
          /chat is the landing route (/ redirects here), and framer-motion is
          ~40kB gz for something CSS composites for free — the same trade
          components/auth/ambient-backdrop.tsx documents making.

          `invisible` rather than `inert` or aria-hidden: visibility:hidden
          already removes the subtree from the tab order AND the a11y tree, it
          needs no polyfill, and `inert` is not in React 18's prop types so it
          would not survive tsc. It is in the transition list because CSS keeps
          a disappearing element `visible` for the whole outgoing transition and
          only flips at the end — which is exactly the behaviour wanted here.
        */}
        <nav
          aria-label="Conversations"
          className={`hidden shrink-0 overflow-hidden border-r border-border bg-card/60 backdrop-blur-xl transition-[width,opacity,visibility] duration-300 ease-out motion-reduce:transition-none md:block ${
            collapsed ? "invisible w-0 opacity-0" : "visible w-[272px] opacity-100"
          }`}
        >
          <div className="h-full w-[272px]">
            <ChatSidebar />
          </div>
        </nav>

        {/*
          ChatLayout wraps the route segment rather than sitting beside it: it
          owns the composer, and the composer has to outlive the /chat ->
          /chat/[threadId] navigation for the centred->bottom spring to play.
        */}
        <ChatSessionProvider threadId={threadId} defaultModel={DEFAULT_MODEL}>
          <ChatLayout>{children}</ChatLayout>
        </ChatSessionProvider>

        {/* Drawer for everything below md. */}
        {open && (
          <>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled above */}
            <div
              className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm md:hidden"
              onClick={closeSidebar}
              aria-hidden="true"
            />
            <nav
              ref={panelRef}
              tabIndex={-1}
              aria-label="Conversations"
              className="fixed inset-y-0 left-0 z-40 w-[272px] border-r border-border bg-card outline-none md:hidden"
            >
              <ChatSidebar onNavigate={closeSidebar} />
            </nav>
          </>
        )}
      </ComposerProvider>
    </SidebarCtx.Provider>
  );
}
