"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { Check, Copy, Pencil, RefreshCw, RotateCcw, Share2 } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { TypedEvent } from "../_lib/agent-events";
import { AgentActivity } from "./agent-activity";
import { AgentSources } from "./agent-sources";
import { ErrorNotice } from "./error-notice";
import { StreamingText } from "./streaming-text";

export interface ChatMessageDoc {
  _id: Id<"chatMessages">;
  role: "user" | "assistant" | "system";
  seq: number;
  content: string;
  status: "pending" | "streaming" | "complete" | "error" | "aborted";
  model?: string | null;
  error?: string | null;
  // Structured failure code (deadline / not_configured / …). Mapped to friendly
  // copy + safe-retry gating by ErrorNotice; already surfaced by toPublic.
  errorCode?: string | null;
  // The browser-minted idempotency key, echoed back by listPaged so an
  // optimistic user row can be deduped against its settled twin. Absent on the
  // in-flight assistant row (which never carries one).
  clientId?: string | null;
  attachments?: {
    _id: string;
    name: string;
    size: number;
    contentType: string;
    kind: string;
    url: string | null;
  }[];
  // Typed events (Phase 3). Empty/absent for text-only turns → renders as before.
  events?: TypedEvent[];
  createdAt: number;
}


/**
 * The `You - 10:14 AM` line above a user turn, and the bare time above an
 * assistant one.
 *
 * toLocaleTimeString is locale- and timezone-dependent, which is normally a
 * hydration hazard: the server formats in the server's zone and the client in
 * the browser's, React reports the difference through console.error, and every
 * e2e script fails the run on one of those.
 *
 * It is safe HERE and only here because no message bubble is ever server
 * rendered: messages arrive through useQuery/usePaginatedQuery, which resolve
 * to undefined during SSR under ConvexAuthNextjsProvider, so MessageList paints
 * skeletons on the server and real turns exist on the client only. Do not lift
 * this into anything that renders with server-supplied data.
 */
function MessageMeta({
  who,
  at,
  assistant,
}: {
  /** Rendered for the USER only. An assistant turn carries no visible name:
   *  OllaSuper is one assistant and the model behind it is an implementation
   *  detail, so a label there is either branding or a leak. */
  who?: string;
  at: number;
  assistant?: boolean;
}) {
  return (
    <div
      className={`mb-1.5 flex items-center gap-1.5 px-1 text-[11px] text-primary/60 ${
        assistant ? "" : "justify-end"
      }`}
    >
      {assistant ? (
        // Invisible, but in the accessibility tree. Without it the user's turn
        // announces "You" while the assistant's announces a bare time, so a
        // screen-reader listener cannot tell whose turn is whose — worse than
        // before the name was removed. Same pattern as agent-activity.tsx.
        <span className="sr-only">Assistant</span>
      ) : (
        <>
          <span className="text-primary/65">{who}</span>
          <span aria-hidden="true">·</span>
        </>
      )}
      <time dateTime={new Date(at).toISOString()}>
        {new Date(at).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </time>
    </div>
  );
}
/**
 * The user's turn. Accent-filled, and clamped when it is long.
 *
 * ACCENT FILL. The bubble was a muted surface through the monochrome work,
 * because under pure ink a solid slab on every user turn was the heaviest thing
 * on a page that is mostly reading. With an accent colour available that
 * argument no longer holds for six of the seven options, and the operator
 * chose the ChatGPT convention: the user's words sit on the accent. Under
 * Neutral this is deliberately a black (light) / white (dark) bubble.
 * `text-brand-foreground` is the per-accent on-fill text, already asserted at
 * >= 4.5:1 against `--brand` for every accent in both modes.
 *
 * CLAMP. Beyond 12 lines the bubble is cut with a fade and a "Show more"
 * affordance, so a pasted document does not push the reply off screen. The cut
 * is `max-h-[20.4em]` (12 lines x 1.7 line-height) with overflow hidden, NOT
 * -webkit-line-clamp: line-clamp draws an ellipsis on the final line, which is
 * wrong under a fade. The fade is a `mask-image` — an alpha ramp on the text
 * itself, so it needs no knowledge of the bubble colour and works on all seven
 * accents. It is not a painted gradient; the monochrome ban is on decorative
 * colour gradients, and this paints no colour at all.
 *
 * The affordance appears only when the content actually overflows, measured
 * while clamped: a short message gets no button and no fade.
 *
 * Module scope, never nested — see the note above MessageMeta.
 */
function UserBubble({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLParagraphElement | null>(null);

  // Re-measured on every size change, not once on mount. Whether 12 lines is
  // enough depends on the width the text wraps at, and that changes with the
  // window, the rail collapsing, and the drawer — a mount-only measurement left
  // "Show more" stale after any of those. ResizeObserver fires on observe(), so
  // it also covers the initial render. Only meaningful while clamped: expanded,
  // the box is its natural height and scrollHeight === clientHeight by
  // construction, so the value is left alone and re-taken on collapse.
  useEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [content, expanded]);

  const clamped = overflows && !expanded;
  return (
    <div className="rounded-2xl rounded-br-md bg-brand px-4 py-2.5 text-[15.5px] leading-[1.7] text-brand-foreground">
      <p
        ref={ref}
        className={`whitespace-pre-wrap break-words ${
          expanded ? "" : "max-h-[20.4em] overflow-hidden"
        } ${clamped ? "[mask-image:linear-gradient(to_bottom,black_78%,transparent)]" : ""}`}
      >
        {content}
      </p>
      {overflows && (
        // Full-strength on-fill ink, no opacity. At 80% the white text over
        // blue-600 composited to ~3.9:1 and over pink-600 to ~3.5:1 — under the
        // 4.5:1 bar for 12px text. Hover is carried by the underline thickness,
        // which costs nothing in contrast.
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mt-1.5 text-xs font-medium underline underline-offset-2 decoration-1 hover:decoration-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-brand"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function ChatMessageImpl({
  message,
  isStreaming,
  liveText,
  onEdit,
  onShare,
  pendingApproval,
  onResolveApproval,
  readOnly = false,
  hideExecutionMeta = false,
}: {
  message: ChatMessageDoc;
  isStreaming: boolean;
  liveText?: string;
  onEdit?: (m: ChatMessageDoc) => void;
  onShare?: (id: Id<"chatMessages">) => void;
  // Phase 8: the live turn's durable pending approval + resolver (live row only).
  // `_id` flows as a string through AgentActivity; message-list re-narrows it to
  // Id<"chatApprovals"> at the mutation call.
  pendingApproval?: { _id: string; approvalId: string } | null;
  onResolveApproval?: (
    approvalId: string,
    decision: "approve" | "reject",
  ) => void;
  /**
   * Render the turn WITHOUT any mutating affordance. Default false, so every
   * existing chat call site is byte-identical.
   *
   * Set by the Scheduled Tasks result viewer. Retry, Regenerate and Edit all
   * call chat mutations that `assertCanGenerate` REFUSES on a scheduled thread,
   * so without this the viewer would show three buttons that always throw
   * "Not found". ErrorNotice's own Retry is suppressed for the same reason —
   * and a failed run is exactly the state that renders it.
   */
  readOnly?: boolean;
  /**
   * Drop the EXECUTION chrome and render the answer only. Default false, so
   * every chat call site is byte-identical.
   *
   * Set by the Scheduled Tasks result modal. It suppresses exactly two things:
   * MessageMeta (the timestamp row) and AgentActivity (step count, tool
   * calls, the agent trace). Those are execution data, and a scheduled report
   * is supposed to read as the finished report the user asked for.
   *
   * AgentSources is deliberately NOT suppressed: citations are part of the
   * answer, not diagnostics, even though they are derived from the same
   * events. Nothing is deleted from the database either — the execution
   * record stays intact for observability, it is just not rendered here.
   */
  hideExecutionMeta?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  // Regenerate is idempotent server-side — assertCanGenerate refuses a second
  // turn while thread.streamingMessageId is set, and Convex mutations are
  // serializable — so a double-click cannot duplicate a reply. It only produces
  // an error toast, which this suppresses.
  const [regenerating, setRegenerating] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const regenerate = useMutation(api.chat.messages.regenerate);
  const retry = useMutation(api.chat.messages.retry);

  const text = isStreaming ? (liveText ?? "") : message.content;

  const copy = () => {
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1600);
      },
      () => undefined,
    );
  };

  const guard = async (fn: () => Promise<unknown>, failMsg: string) => {
    try {
      await fn();
    } catch {
      // Every mutation call site catches, because an unhandled Convex
      // rejection logs via console.error and fails the e2e zero-error gate.
      toast.error(failMsg);
    }
  };

  // --- user turn ---------------------------------------------------------
  if (message.role === "user") {
    return (
      <div className="group my-5 flex flex-col items-end">
        <div className="max-w-[85%] md:max-w-[75%]">
          <MessageMeta who="You" at={message.createdAt} />
          {message.attachments && message.attachments.length > 0 && (
            <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
              {message.attachments.map((a) =>
                a.kind === "image" && a.url ? (
                  <img
                    key={a._id}
                    src={a.url}
                    alt={a.name}
                    className="max-h-40 rounded-lg border border-border"
                  />
                ) : (
                  <span
                    key={a._id}
                    className="rounded-lg border border-border bg-card px-2 py-1 text-xs text-primary/70"
                  >
                    {a.name}
                  </span>
                ),
              )}
            </div>
          )}
          <UserBubble content={message.content} />
          <div className="mt-1 flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
            <IconButton label="Copy" onClick={copy}>
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </IconButton>
            {onEdit && (
              <IconButton label="Edit message" onClick={() => onEdit(message)}>
                <Pencil className="h-3.5 w-3.5" />
              </IconButton>
            )}
          </div>
        </div>
      </div>
    );
  }

  // --- assistant turn ----------------------------------------------------
  // Full width, no bubble: bubbles wreck code blocks and tables.

  return (
    <div className="group my-5">
      {!hideExecutionMeta && (
        // Timestamp only. No name, no glyph, no orb: the model is chosen per
        // turn by the Master Model Router and is an implementation detail, and
        // a substitute label is just branding in its place. `message.model`
        // stays on the row for observability — it is simply never rendered.
        //
        // The thinking dots are NOT here. StreamingText already renders one for
        // `isStreaming && !text`; a second copy in this row is what put two
        // indicators on screen at once.
        <MessageMeta assistant at={message.createdAt} />
      )}
      {!hideExecutionMeta && (
        <AgentActivity
          events={message.events}
          isStreaming={isStreaming}
          pendingApproval={pendingApproval}
          onResolveApproval={onResolveApproval}
        />
      )}
      <StreamingText text={text} isStreaming={isStreaming} />
      <AgentSources events={message.events} />

      {message.status === "error" && (
        <ErrorNotice
          code={message.errorCode}
          message={message.error}
          onRetry={
            readOnly
              ? undefined
              : () =>
                  guard(() => retry({ messageId: message._id }), "Retry failed")
          }
        />
      )}

      {message.status === "aborted" && (
        <div className="mt-2 flex items-center gap-2 text-xs text-primary/60">
          <span>Stopped</span>
          {!readOnly && (
          <button
            type="button"
            onClick={() => guard(() => retry({ messageId: message._id }), "Retry failed")}
            className="inline-flex items-center gap-1 text-brand-ink hover:underline"
          >
            <RotateCcw className="h-3 w-3" /> Continue
          </button>
          )}
        </div>
      )}

      {!isStreaming && message.status === "complete" && (
        <div className="mt-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
          <IconButton label="Copy response" onClick={copy}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </IconButton>
          {!readOnly && (
            <IconButton
              label="Regenerate"
              disabled={regenerating}
              onClick={async () => {
                if (regenerating) return;
                setRegenerating(true);
                await guard(
                  () => regenerate({ messageId: message._id }),
                  "Couldn't regenerate",
                );
                setRegenerating(false);
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </IconButton>
          )}
          {onShare && message.role === "assistant" && (
            <IconButton
              label="Share response"
              onClick={() => onShare(message._id)}
            >
              <Share2 className="h-3.5 w-3.5" />
            </IconButton>
          )}
        </div>
      )}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
  disabled,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="rounded p-1 text-primary/60 transition hover:bg-primary/5 hover:text-primary/70 disabled:pointer-events-none disabled:opacity-50 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
    >
      {children}
    </button>
  );
}

/**
 * A CUSTOM comparator is mandatory here.
 *
 * Convex hands back fresh object identities on every server push, so the
 * default shallow compare is always false and React.memo would silently do
 * nothing — the whole memoisation strategy would be a no-op.
 */
export const ChatMessage = memo(
  ChatMessageImpl,
  (a, b) =>
    a.message._id === b.message._id &&
    a.message.content === b.message.content &&
    a.message.status === b.message.status &&
    a.isStreaming === b.isStreaming &&
    a.liveText === b.liveText &&
    // Typed events change independently of text — without this, streamed
    // structured events would not repaint (Convex hands back fresh identities).
    (a.message.events?.length ?? 0) === (b.message.events?.length ?? 0) &&
    a.message.events?.at(-1)?.eventId === b.message.events?.at(-1)?.eventId &&
    // Phase 8: repaint when the pending approval appears/clears (Approve/Reject).
    (a.pendingApproval?.approvalId ?? null) ===
      (b.pendingApproval?.approvalId ?? null) &&
    // Without this a memoised bubble could keep its interactive affordances
    // after being re-rendered read-only — buttons that would then throw.
    a.readOnly === b.readOnly &&
    // Same reasoning as readOnly above: a memoised bubble must not keep
    // execution chrome after being re-rendered without it.
    a.hideExecutionMeta === b.hideExecutionMeta,
);
