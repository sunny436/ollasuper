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
import { ComposerProvider } from "../_hooks/use-composer";
import { ChatSidebar } from "./chat-sidebar";

/**
 * Layout for the chat subtree.
 *
 * THE TWO-SIDEBAR PROBLEM: at md (768px) the existing 240px app sidebar plus a
 * 272px conversation sidebar leaves ~256px of transcript, which is unusable.
 * So the conversation sidebar only DOCKS at xl (1280px). Between 768 and 1279
 * it is an overlay panel scoped to the chat pane — the app sidebar stays
 * reachable — and below 768 it is a drawer.
 *
 * Collapsing the *app* sidebar on /chat was rejected: it would mean changing
 * (dashboard)/layout.tsx behaviour for one route and its state would leak to
 * every other page.
 */

interface SidebarApi {
  open: boolean;
  openSidebar: () => void;
  closeSidebar: () => void;
}

const SidebarCtx = createContext<SidebarApi>({
  open: false,
  openSidebar: () => undefined,
  closeSidebar: () => undefined,
});

export function useChatSidebar() {
  return useContext(SidebarCtx);
}

export function ChatShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  const openSidebar = useCallback(() => {
    restoreFocus.current = document.activeElement as HTMLElement | null;
    setOpen(true);
  }, []);
  const closeSidebar = useCallback(() => setOpen(false), []);

  // Escape closes. The existing app sidebar lacks this; command-palette.tsx
  // has it, and it is the behaviour people expect from an overlay.
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
    () => ({ open, openSidebar, closeSidebar }),
    [open, openSidebar, closeSidebar],
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
        {/* Docked from xl up. <nav>, not a second <aside>: e2e/p-sidebar.js does
            page.locator("aside") and Playwright strict mode throws on multiple
            matches. */}
        <nav
          aria-label="Conversations"
          className="hidden w-72 shrink-0 border-r border-border bg-card xl:block"
        >
          <ChatSidebar />
        </nav>

        {children}

        {/* Overlay for everything below xl, scoped INSIDE the chat area so the
            app sidebar remains usable. */}
        {open && (
          <>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled above */}
            <div
              className="fixed inset-0 z-30 bg-black/50 xl:hidden"
              onClick={closeSidebar}
              aria-hidden="true"
            />
            <nav
              ref={panelRef}
              tabIndex={-1}
              aria-label="Conversations"
              className="fixed inset-y-0 left-0 z-40 w-72 border-r border-border bg-card outline-none xl:hidden"
            >
              <ChatSidebar onNavigate={closeSidebar} />
            </nav>
          </>
        )}
      </ComposerProvider>
    </SidebarCtx.Provider>
  );
}
