"use client";

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * Shared composer draft.
 *
 * Exists so the empty state's prompt cards and the prompt library can fill the
 * composer without prop-drilling through MessageList. Deliberately NOT nuqs /
 * URL state: that re-renders the route segment and would remount the
 * transcript, losing scroll position mid-conversation.
 */
interface ComposerApi {
  draft: string;
  setDraft: (text: string) => void;
  appendDraft: (text: string) => void;
  focus: () => void;
  registerTextarea: (el: HTMLTextAreaElement | null) => void;
}

const ComposerCtx = createContext<ComposerApi | null>(null);

export function ComposerProvider({ children }: { children: ReactNode }) {
  const [draft, setDraftState] = useState("");
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const focus = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Caret at the end, so a filled-in suggestion is immediately editable.
    const len = el.value.length;
    el.setSelectionRange(len, len);
  }, []);

  const setDraft = useCallback(
    (text: string) => {
      setDraftState(text);
      // After paint, so the autosize layout effect has already run.
      requestAnimationFrame(focus);
    },
    [focus],
  );

  const appendDraft = useCallback(
    (text: string) => {
      setDraftState((prev) => (prev ? `${prev.trimEnd()}\n\n${text}` : text));
      requestAnimationFrame(focus);
    },
    [focus],
  );

  const registerTextarea = useCallback((el: HTMLTextAreaElement | null) => {
    ref.current = el;
  }, []);

  const value = useMemo(
    () => ({ draft, setDraft, appendDraft, focus, registerTextarea }),
    [draft, setDraft, appendDraft, focus, registerTextarea],
  );

  return <ComposerCtx.Provider value={value}>{children}</ComposerCtx.Provider>;
}

export function useComposer(): ComposerApi {
  const ctx = useContext(ComposerCtx);
  if (!ctx) throw new Error("useComposer must be used inside ComposerProvider");
  return ctx;
}
