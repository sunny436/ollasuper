"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { Check, Copy, Pencil, RefreshCw, RotateCcw, Share2, Sparkles } from "lucide-react";
import { memo, useRef, useState } from "react";
import { toast } from "sonner";
import type { TypedEvent } from "../_lib/agent-events";
import { modelLabel } from "../_lib/models";
import { AgentActivity } from "./agent-activity";
import { AgentSources } from "./agent-sources";
import { ErrorNotice } from "./error-notice";
import { IntelligenceCore } from "./intelligence-core";
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
  orb,
}: {
  who: string;
  at: number;
  assistant?: boolean;
  /** Swap the flat glyph for the live WebGL orb. One instance per page. */
  orb?: boolean;
}) {
  return (
    <div
      className={`mb-1.5 flex items-center gap-1.5 px-1 text-[11px] text-primary/40 ${
        assistant ? "" : "justify-end"
      }`}
    >
      {assistant &&
        (orb ? (
          <IntelligenceCore className="h-6 w-6" />
        ) : (
          <Sparkles className="h-3 w-3 text-brand-ink" aria-hidden="true" />
        ))}
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
function ChatMessageImpl({
  message,
  isStreaming,
  liveText,
  showOrb,
  onEdit,
  onShare,
}: {
  message: ChatMessageDoc;
  isStreaming: boolean;
  liveText?: string;
  showOrb?: boolean;
  onEdit?: (m: ChatMessageDoc) => void;
  onShare?: (id: Id<"chatMessages">) => void;
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
            The user bubble rides the --brand token so it warms with the ambience
            theme (sky-blue → bronze at amber → sky at midnight); brand-foreground
            is contrast-picked against the fill, so the text stays legible at every
            phase without a fixed white.
          */}
          <div className="rounded-2xl rounded-br-md bg-brand px-4 py-2.5 text-[15.5px] leading-[1.7] text-brand-foreground shadow-sm">
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

  return (
    <div className="group my-5">
      <MessageMeta
        assistant
        orb={showOrb}
        who={modelLabel(message.model)}
        at={message.createdAt}
      />
      <AgentActivity events={message.events} isStreaming={isStreaming} />
      <StreamingText text={text} isStreaming={isStreaming} />
      <AgentSources events={message.events} />

      {message.status === "error" && (
        <ErrorNotice
          code={message.errorCode}
          message={message.error}
          onRetry={() =>
            guard(() => retry({ messageId: message._id }), "Retry failed")
          }
        />
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
export const ChatMessage = memo(
  ChatMessageImpl,
  (a, b) =>
    a.message._id === b.message._id &&
    a.message.content === b.message.content &&
    a.message.status === b.message.status &&
    a.isStreaming === b.isStreaming &&
    a.liveText === b.liveText &&
    a.showOrb === b.showOrb &&
    // Typed events change independently of text — without this, streamed
    // structured events would not repaint (Convex hands back fresh identities).
    (a.message.events?.length ?? 0) === (b.message.events?.length ?? 0) &&
    a.message.events?.at(-1)?.eventId === b.message.events?.at(-1)?.eventId,
);
