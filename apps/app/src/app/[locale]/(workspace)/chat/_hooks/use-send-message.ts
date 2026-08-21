"use client";

import { useWorkspace } from "@/lib/useWorkspace";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { useChatSession } from "./use-chat-session";

/**
 * The single send path — used by the composer, the prompt cards and the empty
 * state, so there is exactly one idempotency key, one error handler and one
 * thread-creation path.
 */
export function useSendMessage(threadId: string | null) {
  const router = useRouter();
  const { current } = useWorkspace();
  const { setPendingUsers } = useChatSession();
  const createThread = useMutation(api.chat.threads.create);
  const sendMessage = useMutation(api.chat.messages.send);
  const [sending, setSending] = useState(false);
  // Checked SYNCHRONOUSLY: React state loses to two Enter keydowns batched
  // into one render, so state alone cannot prevent a double submit.
  const inFlight = useRef(false);

  const send = useCallback(
    async (
      text: string,
      opts?: { attachmentIds?: Id<"chatAttachments">[]; model?: string },
    ): Promise<boolean> => {
      const content = text.trim();
      const attachmentIds = opts?.attachmentIds ?? [];
      if (!content && attachmentIds.length === 0) return false;
      if (inFlight.current) return false;
      if (!current) return false;

      inFlight.current = true;
      setSending(true);
      // Survives network retries and React StrictMode's double-invoke; the
      // backend upserts on it AND the optimistic row dedupes against it.
      const clientId = crypto.randomUUID();
      // Optimistic echo: render the user's message immediately, before the
      // mutation commits and listPaged re-pushes it. Scoped to its target
      // thread so it never flashes into another. Text-only sends — an
      // attachment-only send would otherwise flash an empty bubble.
      const echo = (tid: string) => {
        if (content) {
          setPendingUsers((prev) => [
            ...prev,
            { clientId, text: content, createdAt: Date.now(), threadId: tid },
          ]);
        }
      };
      try {
        let tid = threadId;
        if (tid) {
          // Existing thread: echo instantly, before any round-trip.
          echo(tid);
        } else {
          tid = await createThread({ workspaceId: current });
          // New thread: echo the moment it exists, then navigate BEFORE the send
          // resolves — the optimistic row is only VISIBLE once the docked
          // transcript replaces the centred hero (which overlays an empty list).
          // replace, not push: Back from the first message leaves chat.
          echo(tid);
          router.replace(`/chat/${tid}`);
        }
        await sendMessage({
          threadId: tid as Id<"chatThreads">,
          content,
          clientId,
          ...(attachmentIds.length ? { attachmentIds } : {}),
          ...(opts?.model ? { model: opts.model } : {}),
        });
        return true;
      } catch (e) {
        // The optimistic row can never settle — drop it so it doesn't linger.
        setPendingUsers((prev) => prev.filter((p) => p.clientId !== clientId));
        // Never console.error: the Convex client already logs rejections and
        // every e2e script asserts zero console errors.
        const message =
          e instanceof Error && e.message ? cleanError(e.message) : "Please try again";
        toast.error(message);
        return false;
      } finally {
        inFlight.current = false;
        setSending(false);
      }
    },
    [threadId, current, createThread, sendMessage, router, setPendingUsers],
  );

  return { send, sending, canSend: Boolean(current) };
}

/** Convex wraps thrown ConvexErrors with framing noise; show just the message. */
function cleanError(raw: string): string {
  const m = /Uncaught ConvexError:\s*(.+?)(\n|$)/.exec(raw);
  if (m?.[1]) return m[1];
  return raw.split("\n")[0]?.slice(0, 160) ?? "Please try again";
}
