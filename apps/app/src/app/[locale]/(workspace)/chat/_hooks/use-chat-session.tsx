"use client";

import type { Id } from "@v1/backend/convex/_generated/dataModel";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

/**
 * State shared between the transcript and the composer, which are no longer in
 * the same subtree.
 *
 * The composer had to move up to ChatShell so the centred->bottom spring could
 * survive the first send: useSendMessage does router.replace(`/chat/${id}`),
 * and /chat and /chat/[threadId] are different route segments, so the page
 * subtree remounts — and a layout animation cannot cross an unmount, it just
 * snaps. ChatShell persists across that navigation; the pane does not.
 *
 * That split means two things have to travel up here.
 *
 * `threadStatus` is the important one. chat-pane.tsx used to render the
 * composer INSIDE its not-found guard on purpose: use-send-message.ts casts
 * `tid as Id<"chatThreads">`, so sending with a bad URL id reaches a v.id()
 * validator, throws ArgumentValidationError, and the Convex client logs it via
 * console.error — which fails every e2e script's zero-console-error assertion.
 * The pane already queries threads.get, so it publishes the outcome here
 * rather than the shell running a second copy of the same query.
 *
 * `streamingId` is what lets the composer swap Send for Stop; it used to be
 * reported upward from MessageList via an onStreamingChange callback.
 */

export type ThreadStatus =
  /** /chat with no thread yet — sending is allowed and creates one. */
  | "none"
  /** threads.get has not resolved. Sending is allowed: this is the normal path. */
  | "loading"
  /** Resolved and real. */
  | "ok"
  /** Resolved to null: a typo'd, deleted or foreign id. Sending must be impossible. */
  | "notfound";

interface ChatSessionApi {
  threadId: string | null;
  threadStatus: ThreadStatus;
  setThreadStatus: (s: ThreadStatus) => void;
  streamingId: Id<"chatMessages"> | null;
  setStreamingId: (id: Id<"chatMessages"> | null) => void;
  model: string;
  setModel: (m: string) => void;
}

const ChatSessionCtx = createContext<ChatSessionApi | null>(null);

export function ChatSessionProvider({
  threadId,
  defaultModel,
  children,
}: {
  threadId: string | null;
  defaultModel: string;
  children: ReactNode;
}) {
  const [threadStatus, setThreadStatus] = useState<ThreadStatus>(
    threadId ? "loading" : "none",
  );
  const [streamingId, setStreamingIdState] =
    useState<Id<"chatMessages"> | null>(null);
  const [model, setModel] = useState(defaultModel);

  const setStreamingId = useCallback(
    (id: Id<"chatMessages"> | null) => setStreamingIdState(id),
    [],
  );

  const value = useMemo(
    () => ({
      threadId,
      threadStatus,
      setThreadStatus,
      streamingId,
      setStreamingId,
      model,
      setModel,
    }),
    [threadId, threadStatus, streamingId, setStreamingId, model],
  );

  return (
    <ChatSessionCtx.Provider value={value}>{children}</ChatSessionCtx.Provider>
  );
}

export function useChatSession(): ChatSessionApi {
  const ctx = useContext(ChatSessionCtx);
  if (!ctx) {
    throw new Error("useChatSession must be used inside ChatSessionProvider");
  }
  return ctx;
}
