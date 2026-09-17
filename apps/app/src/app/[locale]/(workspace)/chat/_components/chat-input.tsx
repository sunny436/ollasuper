"use client";

import { api } from "@v1/backend/convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { ArrowUp, Loader2, Mic, Paperclip, Square } from "lucide-react";
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
import { useAttachments } from "../_hooks/use-attachments";
import { useChatSession } from "../_hooks/use-chat-session";
import { useComposer } from "../_hooks/use-composer";
import { useConnectionStatus } from "../_hooks/use-connection-status";
import { useDictation } from "../_hooks/use-dictation";
import { useMediaQuery } from "../_hooks/use-media-query";
import { useSendMessage } from "../_hooks/use-send-message";
import { preloadMarkdown } from "./lazy-markdown";
import { AttachmentChip } from "./attachment-chip";
import { ExploreMenu } from "./explore-menu";

/**
 * MODULE SCOPE, and it must stay that way.
 *
 * components/auth/auth-panel.tsx documents this exact bug: defining a sub-component
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

/**
 * MODULE SCOPE — same reason as ComposerTextarea above.
 *
 * Follow-up actions for the turn that just finished. They are composer UI, not
 * conversation: clicking one only fills the draft, and nothing here is ever
 * written to the transcript.
 */
function SuggestionChips({
  items,
  onPick,
}: {
  items: string[];
  onPick: (text: string) => void;
}) {
  return (
    <div
      data-suggestions
      // Scrolls rather than wraps: on a narrow viewport three chips would
      // otherwise stack and shove the composer up off the keyboard.
      className="mb-2 flex gap-1.5 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {items.map((text, i) => (
        <button
          key={text}
          type="button"
          onClick={() => onPick(text)}
          // Staggered so three chips read as one gesture rather than a flash.
          style={{ animationDelay: `${i * 60}ms`, animationFillMode: "backwards" }}
          className="animate-in fade-in slide-in-from-bottom-1 zoom-in-95 shrink-0 whitespace-nowrap rounded-full border border-border bg-card/70 px-3 py-1.5 text-xs text-primary/70 shadow-sm backdrop-blur-xl duration-200 transition-colors hover:border-brand/40 hover:bg-brand/5 hover:text-primary motion-reduce:animate-none"
        >
          {text}
        </button>
      ))}
    </div>
  );
}

export function ChatInput({
  onExploreOpenChange,
}: {
  /**
   * Lifted to chat-layout, which owns BOTH the greeting and this composer.
   * They are siblings inside one z-20 container that Framer Motion
   * transforms, so it is its own stacking context — a portalled dim overlay
   * would cover the composer too, and no z-index on a child can escape the
   * parent. The parent raising itself is the only way to keep the input
   * crisp while the page behind it dims.
   */
  onExploreOpenChange?: (open: boolean) => void;
} = {}) {
  // Pulled from context rather than props: this component is rendered by
  // chat-layout.tsx, which sits ABOVE the route segment so the centred->bottom
  // spring survives router.replace on the first send. The transcript that
  // knows about streaming, and the pane that resolves the thread, are no
  // longer its ancestors.
  const { threadId, streamingId } = useChatSession();
  const { draft, setDraft } = useComposer();
  const [value, setValue] = useState("");
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const { registerTextarea } = useComposer();
  const { send, sending, canSend } = useSendMessage(threadId);
  const connection = useConnectionStatus();
  const attachments = useAttachments(threadId);
  const fileInput = useRef<HTMLInputElement | null>(null);
  // The composer's horizontal extent — what the Skills panel is centred on and
  // sized to. This element (not the inner pill) because the pill is a `w-full`
  // child of it, so their left/right edges coincide and this one is stable
  // across the centred/docked class swap.
  const composerShell = useRef<HTMLDivElement | null>(null);
  // Byte-identical args to chat-pane's own subscription, so Convex dedupes it
  // and this costs no extra query. `suggestions` is the only field read here.
  const thread = useQuery(
    api.chat.threads.get,
    threadId ? { threadId } : "skip",
  );
  // Hidden while a generation is in flight, which also covers "cleared on
  // Send": sending sets streamingId, and the send mutation clears the stored
  // chips in the same patch. Clicking a chip does NEITHER, so the row survives
  // a click and stays visible while the user edits the filled-in text.
  // No `centred` guard is needed (and it would be a TDZ read here): the landing
  // screen has threadId === null, so the query skips and this is empty anyway.
  const suggestions = streamingId ? [] : (thread?.suggestions ?? []);
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave fire for EVERY child element, so a boolean makes the
  // overlay strobe as the pointer crosses message boundaries. A counter is the
  // only reliable way to know when the pointer has truly left.
  const dragDepth = useRef(0);
  const stop = useMutation(api.chat.stream.stop);
  const coarsePointer = useMediaQuery("(pointer: coarse)");

  // IME state. isComposing alone is NOT enough — see onKeyDown.
  const composing = useRef(false);
  const composedAt = useRef(0);

  // The centred (empty new-chat) state is the Gemini-style floating pill; once a
  // thread exists the SAME instance reflows to the docked multi-line composer.
  // This is the ONLY structural driver, and it matches chat-layout.tsx's
  // centred->docked morph exactly because both read the same threadId.
  const centred = threadId === null;

  // Length at the last autosize: only a shorter value can need a smaller box.
  const sizedLength = useRef(0);
  const autosize = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    const max = Math.min(320, Math.max(160, Math.round(window.innerHeight * 0.4)));
    const shrinking = el.value.length < sizedLength.current;
    sizedLength.current = el.value.length;
    // Collapsing to 0 and re-measuring forces a full-page layout, and it ran on
    // every keystroke — the hottest function on the typing path (measured on
    // prod). Text that only grew can never need a smaller box, so one
    // scrollHeight read decides; only a shrink (delete, clear, replace) collapses.
    if (shrinking) el.style.height = "0px";
    const h = el.scrollHeight;
    if (shrinking || h > el.clientHeight) el.style.height = `${Math.min(h, max)}px`;
    el.style.overflowY = h > max ? "auto" : "hidden";
  }, []);

  const appendDictation = useCallback(
    (chunk: string) => {
      setValue((v) => (v ? `${v.replace(/\s*$/, "")} ${chunk}` : chunk));
      requestAnimationFrame(autosize);
    },
    [autosize],
  );
  const dictation = useDictation(appendDictation);

  useEffect(() => {
    registerTextarea(taRef.current);
  }, [registerTextarea]);

  // Draft pushed in from a prompt card / the library.
  useEffect(() => {
    if (draft) setValue(draft);
  }, [draft]);

  // Runs for programmatic fills too (setDraft), before paint so there is no
  // visible jump between the text landing and the box growing.
  useLayoutEffect(() => {
    autosize();
  }, [autosize]);

  const doSend = useCallback(async () => {
    const text = value;
    // Attachment state is checked BEFORE the empty-content return. With the
    // order reversed, an attachment-only send while the upload is still
    // running matched `no text and no ready ids` and returned in silence, so
    // the "wait" message below was unreachable in the one case it exists for.
    if (attachments.uploading) {
      toast.error("Wait for the upload to finish");
      return;
    }
    // A failed attachment must never be dropped quietly. readyIds simply
    // omits it, so without this the message goes without the file and the
    // user is told nothing.
    if (attachments.failed.length > 0) {
      toast.error(
        attachments.failed.length === 1
          ? `${attachments.failed[0]} didn't upload — retry or remove it`
          : `${attachments.failed.length} attachments didn't upload — retry or remove them`,
      );
      return;
    }
    // Read AFTER the guards, so the ids reflect settled state.
    const ids = attachments.readyIds;
    if (!text.trim() && ids.length === 0) return;
    // Warm the markdown chunk the moment the user commits to a send (incl.
    // attachment-only) — the assistant reply renders markdown, and the empty-chat
    // transcript no longer idle-preloads it. Harmless if a guard below aborts.
    void preloadMarkdown();
    // A reply is still generating — Enter is a no-op here (the composer shows
    // Stop, not Send). Without this, an Enter while streaming reaches
    // messages.send, which rejects with "already generating" (a deliberate
    // cost-control guard); the Convex client then logs that rejection to the
    // console and the user's just-typed message is silently dropped. Keep the
    // text in the box so the user can send it once the reply finishes.
    if (streamingId) return;
    // Optimistic clear before the await; restored on failure.
    setValue("");
    setDraft("");
    requestAnimationFrame(autosize);
    const ok = await send(text, { attachmentIds: ids });
    if (ok) {
      attachments.clear();
    } else {
      setValue(text);
      requestAnimationFrame(autosize);
    }
  }, [value, send, setDraft, autosize, attachments, streamingId]);

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

  const isStreaming = Boolean(streamingId);
  // Any attachment counts, not just the ready ones. Keyed on readyIds this
  // was false for the whole upload, and the composer swapped Send for the
  // DICTATION button — so clicking where Send had been started recording,
  // while Enter silently did nothing. The guards in doSend decide the
  // outcome; this only decides which control the user is looking at.
  const hasContent = value.trim().length > 0 || attachments.items.length > 0;
  // Present but not usable yet. Disabled beats hidden: the control keeps its
  // place and its meaning while the upload finishes.
  const sendBlocked = attachments.uploading || attachments.failed.length > 0;

  const onStop = async () => {
    if (!streamingId) return;
    try {
      await stop({ messageId: streamingId });
    } catch {
      toast.error("Couldn't stop the response");
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.items)
      .filter((i) => i.kind === "file")
      .map((i) => i.getAsFile())
      .filter((f): f is File => f !== null)
      // Screenshot blobs have no filename.
      .map((f) =>
        f.name ? f : new File([f], `pasted-${Date.now()}.png`, { type: f.type }),
      );
    if (files.length) {
      e.preventDefault();
      attachments.add(files);
    }
  };

  // Centred = the Gemini pill, scaled ~1.8x; docked keeps today's sizes.
  const iconBtn = `shrink-0 rounded-full ${centred ? "p-2.5" : "p-2"} text-primary/45 transition hover:bg-primary/5 hover:text-primary/80`;
  const btnBox = `flex ${centred ? "h-12 w-12" : "h-9 w-9"} items-center justify-center rounded-full`;
  const bigIcon = centred ? "h-6 w-6" : "h-4 w-4";
  const stopIcon = centred ? "h-5 w-5" : "h-3.5 w-3.5";
  const micIcon = centred ? "h-6 w-6" : "h-[18px] w-[18px]";

  return (
    <div
      className="relative shrink-0 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-6"
      onDragEnter={(e) => {
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) setDragging(false);
      }}
      onDragOver={(e) => {
        // Without preventDefault + dropEffect the browser NAVIGATES to the file.
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) attachments.add(files);
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-xl border-2 border-dashed border-brand bg-brand/10 backdrop-blur-[1px]">
          <span className="text-sm font-medium text-brand-ink">Drop to attach</span>
        </div>
      )}
      {/* A send while disconnected is queued by Convex and goes out on reconnect;
          without this line nothing on screen said so (see use-connection-status). */}
      {connection !== "online" && (
        <p role="status" className="mb-2 text-center text-xs text-primary/60">
          {connection === "offline"
            ? "You're offline — messages will send when you're back online."
            : "Reconnecting…"}
        </p>
      )}
      <div
        ref={composerShell}
        data-composer-shell
        className={`mx-auto w-full [container-type:inline-size] ${centred ? "max-w-[58rem]" : "max-w-3xl"}`}
      >
        <label htmlFor="chat-composer" className="sr-only">
          Message
        </label>
        {suggestions.length > 0 && (
          <SuggestionChips items={suggestions} onPick={setDraft} />
        )}
        {/*
          ONE shell, two looks. Centred = the Gemini floating glass pill (single
          row); docked = today's multi-line composer. Only Tailwind classes and
          flex `order`/`basis` change between them — the textarea keeps the same
          position in the tree, so it never remounts and the draft/caret/IME
          survive the first-send morph.
        */}
        <div
          className={
            centred
              ? // nowrap keeps the empty pill a single row, but an attachment
                // chip is `basis-full` and would otherwise collapse the textarea
                // to ~0 width on this one line — wrap once a chip is present.
                `flex ${attachments.items.length > 0 ? "flex-wrap" : "flex-wrap [@container(min-width:32rem)]:flex-nowrap"} items-center gap-1.5 rounded-[32px] border border-white/60 bg-card/70 px-3.5 py-3 shadow-[0_10px_40px_rgba(0,0,0,0.12)] backdrop-blur-2xl transition focus-within:border-brand/40 focus-within:shadow-[0_14px_48px_rgba(0,0,0,0.16)] dark:border-white/10`
              : "flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-3xl border border-border bg-card/70 px-3 py-2.5 shadow-lg backdrop-blur-xl transition focus-within:border-brand/40 focus-within:ring-1 focus-within:ring-brand/25"
          }
        >
          {attachments.items.length > 0 && (
            <div className="order-0 mb-1 flex w-full basis-full flex-wrap gap-1.5">
              {attachments.items.map((item) => (
                <AttachmentChip
                  key={item.localId}
                  item={item}
                  onRemove={(id) => void attachments.remove(id)}
                  onRetry={attachments.retry}
                />
              ))}
            </div>
          )}

          {/* LEFT controls: attach */}
          <div
            className={`flex items-center gap-0.5 ${centred ? "order-1 gap-1.5 [&_button]:text-sm" : "order-2"}`}
          >
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/*,application/json,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.py,.js,.ts,.tsx,.jsx,.go,.java,.rb,.rs,.c,.cc,.cpp,.h,.hpp,.cs,.php,.swift,.kt,.scala,.sh,.sql,.yaml,.yml,.toml,.ini,.xml,.css,.scss,.log,.md,.csv,.html"
              onChange={(e) => {
                attachments.add(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              aria-label="Attach files"
              title="Attach files"
              className={iconBtn}
            >
              <Paperclip className={centred ? "h-6 w-6" : "h-[18px] w-[18px]"} />
            </button>
            {/*
              Landing screen only. The docked composer is a working surface,
              not a discovery one, and `centred` is already the empty-new-chat
              gate the whole two-look shell is built on.
            */}
            {centred && (
              <ExploreMenu
                disabled={isStreaming}
                anchorRef={composerShell}
                onOpenChange={(o) => onExploreOpenChange?.(o)}
                onSelect={(seed) => {
                  // Seeded, not sent, and not hidden behind a badge: the
                  // user can edit it, and what is in the box is exactly what
                  // will be sent.
                  setValue(seed);
                  requestAnimationFrame(() => {
                    const ta = taRef.current;
                    if (!ta) return;
                    ta.focus();
                    ta.setSelectionRange(seed.length, seed.length);
                    autosize();
                  });
                }}
              />
            )}
          </div>

          {/* TEXTAREA — same node in both layouts; only order/basis differ. */}
          <div
            className={
              centred
                ? // Below a 32rem composer the one-row pill left the textarea 43 px
                  // wide at 320 px and 98 px at 375 px (measured): give it its own
                  // full-width row there, controls underneath.
                  "order-first min-w-0 basis-full [&_textarea]:text-lg [&_textarea]:leading-8 [@container(min-width:32rem)]:order-2 [@container(min-width:32rem)]:flex-1 [@container(min-width:32rem)]:basis-auto"
                : "order-1 w-full basis-full"
            }
          >
            <ComposerTextarea
              onPaste={onPaste}
              id="chat-composer"
              ref={taRef}
              value={value}
              placeholder="Ask anything…"
              disabled={!canSend}
              aria-describedby="chat-composer-hint"
              aria-keyshortcuts="Enter"
              onChange={(e) => setValue(e.target.value)}
              onFocus={() => void preloadMarkdown()}
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
          </div>

          {/* Docked-only hint, pushed to the right of the controls row. */}
          <span
            id="chat-composer-hint"
            className={
              centred
                ? "hidden"
                : "order-3 ml-auto hidden text-[11px] text-primary/30 sm:inline"
            }
          >
            Enter to send · Shift+Enter for a new line
          </span>

          {/* RIGHT controls: mic / send / stop */}
          <div
            className={`flex items-center gap-1 ${
              centred ? "order-3 ml-auto [@container(min-width:32rem)]:ml-0" : "order-4 ml-auto"
            }`}
          >
            {isStreaming ? (
              <button
                type="button"
                onClick={onStop}
                aria-label="Stop generating"
                className={`${btnBox} bg-primary/10 text-primary ring-1 ring-border transition hover:bg-primary/15`}
              >
                <Square className={`${stopIcon} fill-current`} />
              </button>
            ) : hasContent ? (
              <button
                type="button"
                onClick={() => void doSend()}
                disabled={sending || !canSend || sendBlocked}
                aria-label={
                  sending
                    ? "Sending"
                    : attachments.uploading
                      ? "Waiting for upload"
                      : attachments.failed.length > 0
                        ? "Attachment failed to upload"
                        : "Send message"
                }
                // Brand accent — warms with the ambience theme (bronze at amber).
                className={`${btnBox} shadow-md transition ${
                  sending || !canSend || sendBlocked
                    ? "bg-primary/10 text-primary/30"
                    : "bg-brand text-brand-foreground hover:brightness-110 active:brightness-95"
                }`}
              >
                {sending ? (
                  <Loader2 className={`${bigIcon} animate-spin`} />
                ) : (
                  <ArrowUp className={bigIcon} />
                )}
              </button>
            ) : dictation.supported ? (
              <button
                type="button"
                onClick={dictation.toggle}
                aria-label={dictation.listening ? "Stop dictation" : "Dictate"}
                title={dictation.listening ? "Stop dictation" : "Dictate"}
                aria-pressed={dictation.listening}
                className={`${btnBox} transition ${
                  dictation.listening
                    ? "bg-brand text-brand-foreground"
                    : "text-primary/45 hover:bg-primary/5 hover:text-primary/80"
                }`}
              >
                <Mic
                  className={`${micIcon} ${dictation.listening ? "animate-pulse" : ""}`}
                />
              </button>
            ) : (
              // No speech support and nothing to send yet: a disabled send keeps
              // the control's footprint stable so the pill doesn't jump.
              <button
                type="button"
                disabled
                aria-label="Send message"
                className={`${btnBox} bg-primary/10 text-primary/30`}
              >
                <ArrowUp className={bigIcon} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
