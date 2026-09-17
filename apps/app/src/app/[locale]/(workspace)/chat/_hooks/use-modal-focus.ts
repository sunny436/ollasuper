"use client";

import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Keyboard focus for the hand-built (non-Radix) modal dialogs.
 *
 * WHY: e2e/qa-responsive.js on production — Tab moved focus out of Move to project,
 * Chat instructions and New project into the page behind them, and closing one
 * left focus nowhere. Radix dialogs do this themselves; these do not use Radix.
 *
 * While `open`: focus moves into the dialog (unless something inside, e.g. an
 * autofocused input, already has it), Tab and Shift+Tab cycle within it, and on
 * close focus goes back to whatever had it before — if that element still exists
 * (a menu item that opened the dialog and then unmounted does not).
 */
export function useModalFocus<T extends HTMLElement>(
  open: boolean,
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  // Layout effect: runs before a dialog's own autofocus effect moves focus into
  // it, so this records the control that opened the dialog, not its first input.
  useLayoutEffect(() => {
    if (open) returnTo.current = document.activeElement as HTMLElement | null;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const el = ref.current;
      if (el && !el.contains(document.activeElement)) {
        (el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus();
      }
    });
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current;
      if (e.key !== "Tab" || !el) return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (n) => n.getClientRects().length > 0,
      );
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        e.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !el.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !el.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey);
      const back = returnTo.current;
      if (back?.isConnected && back !== document.body) back.focus();
    };
  }, [open]);

  return ref;
}
