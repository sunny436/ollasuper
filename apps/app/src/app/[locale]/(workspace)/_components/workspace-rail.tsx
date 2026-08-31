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
import { ChatSidebar } from "../chat/_components/chat-sidebar";

/**
 * The workspace conversation rail.
 *
 * MOVED HERE FROM chat-shell.tsx, unchanged in behaviour. It lived inside the
 * chat shell when /chat was the only workspace destination; Scheduled Tasks is
 * the second, and the rail carries the navigation between them. Duplicating it
 * would mean two copies of the collapse persistence, the Escape handler, the
 * focus restore and the body scroll-lock — four behaviours that would drift
 * apart the first time one of them changed.
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

export function useWorkspaceRail() {
  return useContext(SidebarCtx);
}

export function WorkspaceRail({ children }: { children: ReactNode }) {
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
        Skip link — the FIRST focusable thing on the page.

        The rail lists every conversation, so on a real account it holds ~66
        focusable controls and a keyboard user had to press Tab 69 times to
        reach the composer. Measured on production, not guessed. That is not a
        long tab order, it is an unusable one, and it gets worse the longer
        someone uses the product.

        Visually hidden until focused, which is the standard shape: sighted
        mouse users never see it, and the first Tab reveals it.
      */}
      <a
        href="#workspace-main"
        className="sr-only rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50"
      >
        Skip to content
      </a>
      {/*
        Docked from md up, collapsible to zero width.

        <nav>, not <aside>: e2e/p-sidebar.js does page.locator("aside") and
        Playwright strict mode throws on multiple matches.

        Collapse is a width transition rather than a framer-motion spring.
        /chat is the landing route (/ redirects here), and framer-motion is
        ~40kB gz for something CSS composites for free.

        `invisible` rather than `inert` or aria-hidden: visibility:hidden
        already removes the subtree from the tab order AND the a11y tree, it
        needs no polyfill, and `inert` is not in React 18's prop types so it
        would not survive tsc.
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

      {/* tabIndex -1 so the skip link can move focus here; it is not a tab stop
          of its own. */}
      <div id="workspace-main" tabIndex={-1} className="contents outline-none">
        {children}
      </div>

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
    </SidebarCtx.Provider>
  );
}
