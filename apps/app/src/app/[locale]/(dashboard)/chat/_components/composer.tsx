"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { ArrowUp, Loader2, Square } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { useComposer } from "../_hooks/use-composer";
import { useMediaQuery } from "../_hooks/use-media-query";
import { useSendMessage } from "../_hooks/use-send-message";
import { ModelPicker } from "./model-picker";

/**
 * MODULE SCOPE, and it must stay that way.
 *
 * auth-form.tsx:11-12 documents this exact bug: defining a sub-component
 * inside its parent gives it a new identity every render, so React unmounts
 * and remounts the input on every keystroke — stealing focus after one
 * character. In a chat composer that also resets the caret and breaks IME
 * composition entirely.
 */
const ComposerTextarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>((props, ref) => (
  <textarea
    ref={ref}
    rows={1}
    // text-base (16px) on mobile prevents iOS auto-zooming the whole page on
    // focus. This one class saves the entire mobile layout.
    className="max-h-[40vh] w-full resize-none bg-transparent px-1 py-1 text-base leading-6 text-primary outline-none placeholder:text-primary/35 md:text-sm"
    autoComplete="off"
    autoCorrect="on"
    autoCapitalize="sentences"
    spellCheck
    enterKeyHint="enter"
    {...props}
  />
));
ComposerTextarea.displayName = "ComposerTextarea";

const MIN_HEIGHT = 24;

export function Composer({
  threadId,
  streamingMessageId,
  model,
  onModelChange,
}: {
  threadId: string | null;
  streamingMessageId: Id<"chatMessages"> | null;
  model: string;
  onModelChange: (m: string) => void;
}) {
  const { draft, setDraft } = useComposer();
  const [value, setValue] = useState("");
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const { registerTextarea } = useComposer();
  const { send, sending, canSend } = useSendMessage(threadId);
  const stop = useMutation(api.chat.stream.stop);
  const coarsePointer = useMediaQuery("(pointer: coarse)");

  // IME state. isComposing alone is NOT enough — see onKeyDown.
  const composing = useRef(false);
  const composedAt = useRef(0);

  useEffect(() => {
    registerTextarea(taRef.current);
  }, [registerTextarea]);

  // Draft pushed in from a prompt card / the library.
  useEffect(() => {
    if (draft) setValue(draft);
  }, [draft]);

  const autosize = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    const max = Math.min(320, Math.max(160, Math.round(window.innerHeight * 0.4)));
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, []);

  // Runs for programmatic fills too (setDraft), before paint so there is no
  // visible jump between the text landing and the box growing.
  useLayoutEffect(() => {
    autosize();
  }, [autosize]);

  const doSend = useCallback(async () => {
    const text = value;
    if (!text.trim()) return;
    // Optimistic clear before the await; restored on failure.
    setValue("");
    setDraft("");
    requestAnimationFrame(autosize);
    const ok = await send(text, { model });
    if (!ok) {
      setValue(text);
      requestAnimationFrame(autosize);
    }
  }, [value, send, model, setDraft, autosize]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter") return;
    // Modern browsers.
    if (e.nativeEvent.isComposing) return;
    // Legacy Safari / Android IME.
    if (e.keyCode === 229) return;
    if (composing.current) return;
    // The part that is easy to get wrong: on Chrome/Windows, committing a
    // CJK candidate with Enter fires compositionend and THEN a keydown with
    // isComposing === false. Checking isComposing alone therefore sends a
    // message the user only meant to commit. React <=18 does not guarantee
    // compositionend ordering across browsers, so the boolean latch alone is
    // also insufficient; the timestamp closes the gap.
    if (performance.now() - composedAt.current < 40) return;
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    // On touch keyboards Enter means newline, not send.
    if (coarsePointer) return;
    e.preventDefault();
    void doSend();
  };

  const isStreaming = Boolean(streamingMessageId);
  const hasContent = value.trim().length > 0;

  const onStop = async () => {
    if (!streamingMessageId) return;
    try {
      await stop({ messageId: streamingMessageId });
    } catch {
      toast.error("Couldn't stop the response");
    }
  };

  return (
    <div className="shrink-0 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-6">
      <div className="mx-auto w-full max-w-3xl">
        <label htmlFor="chat-composer" className="sr-only">
          Message
        </label>
        <div className="rounded-2xl border border-border bg-card px-3 py-2 shadow-sm transition focus-within:border-brand/40 focus-within:ring-1 focus-within:ring-brand/25">
          <ComposerTextarea
            id="chat-composer"
            ref={taRef}
            value={value}
            placeholder={
              canSend ? "Ask anything…" : "Preparing your workspace…"
            }
            disabled={!canSend}
            aria-describedby="chat-composer-hint"
            aria-keyshortcuts="Enter"
            onChange={(e) => setValue(e.target.value)}
            onInput={autosize}
            onKeyDown={onKeyDown}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
              composedAt.current = performance.now();
            }}
          />
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <ModelPicker value={model} onChange={onModelChange} disabled={isStreaming} />
            <div className="flex items-center gap-2">
              <span
                id="chat-composer-hint"
                className="hidden text-[11px] text-primary/30 sm:inline"
              >
                Enter to send · Shift+Enter for a new line
              </span>
              {isStreaming ? (
                <button
                  type="button"
                  onClick={onStop}
                  aria-label="Stop generating"
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-border transition hover:bg-primary/15"
                >
                  <Square className="h-3.5 w-3.5 fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void doSend()}
                  disabled={!hasContent || sending || !canSend}
                  aria-label={sending ? "Sending" : "Send message"}
                  className={`flex h-8 w-8 items-center justify-center rounded-full transition ${
                    hasContent && !sending && canSend
                      ? "bg-brand text-brand-foreground hover:brightness-110 active:brightness-95"
                      : "bg-primary/10 text-primary/30"
                  }`}
                >
                  {sending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ArrowUp className="h-4 w-4" />
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
