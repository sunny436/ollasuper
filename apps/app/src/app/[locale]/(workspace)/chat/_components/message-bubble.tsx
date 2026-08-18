"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { Check, Copy, Pencil, RefreshCw, RotateCcw, Sparkles } from "lucide-react";
import { memo, useRef, useState } from "react";
import { toast } from "sonner";
import { modelLabel } from "../_lib/models";
import { Markdown } from "./markdown";
import { TypingIndicator } from "./typing-indicator";

export interface ChatMessage {
  _id: Id<"chatMessages">;
  role: "user" | "assistant" | "system";
  seq: number;
  content: string;
  status: "pending" | "streaming" | "complete" | "error" | "aborted";
  model?: string | null;
  error?: string | null;
  attachments?: {
    _id: string;
    name: string;
    size: number;
    contentType: string;
    kind: string;
    url: string | null;
  }[];
  createdAt: number;
}


/**
 * The `You - 10:14 AM` / `Model - 10:14 AM` line above each turn.
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
  who: string;
  at: number;
  assistant?: boolean;
}) {
  return (
    <div
      className={`mb-1.5 flex items-center gap-1.5 px-1 text-[11px] text-primary/40 ${
        assistant ? "" : "justify-end"
      }`}
    >
      {assistant && (
        <Sparkles className="h-3 w-3 text-brand-ink" aria-hidden="true" />
      )}
      <span
        className={assistant ? "font-medium text-brand-ink" : "text-primary/50"}
      >
        {who}
      </span>
      <span aria-hidden="true">·</span>
      <time dateTime={new Date(at).toISOString()}>
        {new Date(at).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </time>
    </div>
  );
}
function MessageBubbleImpl({
  message,
  isStreaming,
  liveText,
  onEdit,
}: {
  message: ChatMessage;
  isStreaming: boolean;
  liveText?: string;
  onEdit?: (m: ChatMessage) => void;
}) {
  const [copied, setCopied] = useState(false);
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
          {/*
            The gradient is the one place the prototype's sky-indigo-purple ramp
            appears literally rather than through the brand tokens: it is a
            three-stop ramp and --brand is a single colour. Text is fixed white
            because every stop is dark enough for it (>= 4.5:1 across the ramp),
            in both themes -- so this block deliberately does NOT invert.
          */}
          <div className="rounded-2xl rounded-br-md bg-gradient-to-br from-sky-500 via-indigo-600 to-purple-600 px-4 py-2.5 text-[15px] leading-[1.7] text-white shadow-sm">
            <p className="whitespace-pre-wrap break-words">{message.content}</p>
          </div>
          <div className="mt-1 flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
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
  const showTyping = isStreaming && !text;

  return (
    <div className="group my-5">
      <MessageMeta
        assistant
        who={modelLabel(message.model)}
        at={message.createdAt}
      />
      {showTyping ? (
        <TypingIndicator />
      ) : (
        <div
          // polite + non-atomic so a screen reader announces increments as they
          // stream instead of re-reading the whole message per token.
          aria-live={isStreaming ? "polite" : "off"}
          aria-atomic="false"
          aria-busy={isStreaming}
        >
          <Markdown content={text} streaming={isStreaming} />
          {isStreaming && (
            <span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.15em] bg-brand animate-caret-blink motion-reduce:animate-none" />
          )}
        </div>
      )}

      {message.status === "error" && (
        <div className="mt-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <p className="text-primary/80">{message.error ?? "Something went wrong."}</p>
          <button
            type="button"
            onClick={() => guard(() => retry({ messageId: message._id }), "Retry failed")}
            className="mt-2 inline-flex items-center gap-1.5 text-xs text-brand-ink hover:underline"
          >
            <RotateCcw className="h-3 w-3" /> Retry
          </button>
        </div>
      )}

      {message.status === "aborted" && (
        <div className="mt-2 flex items-center gap-2 text-xs text-primary/45">
          <span>Stopped</span>
          <button
            type="button"
            onClick={() => guard(() => retry({ messageId: message._id }), "Retry failed")}
            className="inline-flex items-center gap-1 text-brand-ink hover:underline"
          >
            <RotateCcw className="h-3 w-3" /> Continue
          </button>
        </div>
      )}

      {!isStreaming && message.status === "complete" && (
        <div className="mt-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <IconButton label="Copy response" onClick={copy}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </IconButton>
          <IconButton
            label="Regenerate"
            onClick={() =>
              guard(
                () => regenerate({ messageId: message._id }),
                "Couldn't regenerate",
              )
            }
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      )}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="rounded p-1 text-primary/40 transition hover:bg-primary/5 hover:text-primary/70"
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
export const MessageBubble = memo(
  MessageBubbleImpl,
  (a, b) =>
    a.message._id === b.message._id &&
    a.message.content === b.message.content &&
    a.message.status === b.message.status &&
    a.isStreaming === b.isStreaming &&
    a.liveText === b.liveText,
);
