"use client";

import { useEffect } from "react";
import { useTheme } from "@/lib/theme/theme-provider";

/**
 * The light/dark control. The only theme affordance in the product.
 *
 * IT HOLDS NO STATE. `useTheme` owns the mode; the pre-paint script stamps the
 * class before first paint, so the icons below are driven purely by the `dark`
 * class through Tailwind variants — there is nothing here to hydrate, and no
 * first-frame flicker of the wrong icon.
 *
 * Both icons are `currentColor` and the button uses surface tokens, so it is one
 * ink on one surface in either theme — no amber sun, no indigo moon.
 */
export function ThemeToggle() {
  const { toggle } = useTheme();

  useEffect(() => {
    // No centralized shortcut system exists in this app — every other keydown
    // handler is component-local — so there is nothing to register with. Only
    // one instance mounts at a time: the chat, settings and dashboard shells are
    // separate route groups and never render together.
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle dark and light theme"
      title="Toggle Theme (Ctrl+Shift+L)"
      className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition-colors duration-200 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      {/* Sun — visible in light, rotated away in dark. Absolute so the two icons
          share one centre and the swap reflows nothing. */}
      <svg
        aria-hidden="true"
        className="theme-icon-spring absolute h-4 w-4 rotate-0 scale-100 opacity-100 dark:-rotate-90 dark:scale-50 dark:opacity-0"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <circle cx="12" cy="12" r="4" fill="currentColor" />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          d="M12 2v2m0 16v2m10-10h-2M4 10H2m15.364-6.364l-1.414 1.414M6.05 17.95l-1.414 1.414M17.95 17.95l-1.414-1.414M6.05 6.05L4.636 7.464"
        />
      </svg>

      {/* Moon — the mirror image of the Sun's state. */}
      <svg
        aria-hidden="true"
        className="theme-icon-spring absolute h-4 w-4 rotate-90 scale-50 opacity-0 dark:rotate-0 dark:scale-100 dark:opacity-100"
        fill="currentColor"
        viewBox="0 0 24 24"
      >
        <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
      </svg>
    </button>
  );
}
