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
  const { setPendingUsers, pendingProjectId } = useChatSession();
  const createAndSend = useMutation(api.chat.messages.createAndSend);
  const sendMessage = useMutation(api.chat.messages.send);
  const [sending, setSending] = useState(false);
  // Checked SYNCHRONOUSLY: React state loses to two Enter keydowns batched
  // into one render, so state alone cannot prevent a double submit.
  const inFlight = useRef(false);

  const send = useCallback(
    async (
      text: string,
      opts?: { attachmentIds?: Id<"chatAttachments">[] },
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
        if (threadId) {
          // Existing thread: echo instantly, before any round-trip.
          echo(threadId);
          await sendMessage({
            threadId: threadId as Id<"chatThreads">,
            content,
            clientId,
            ...(attachmentIds.length ? { attachmentIds } : {}),
          });
          return true;
        }
        // New chat: ONE mutation creates the thread and sends the first
        // message (this used to be threads.create, then send — two sequential
        // round trips before the turn could be dispatched).
        //
        // projectId is forwarded UNVALIDATED on purpose: the mutation declares
        // it as v.string() and resolves it server-side, so a bad or foreign id
        // is refused there rather than silently producing a chat outside the
        // Project the user asked for.
        const r = await createAndSend({
          workspaceId: current,
          ...(pendingProjectId ? { projectId: pendingProjectId } : {}),
          content,
          clientId,
          ...(attachmentIds.length ? { attachmentIds } : {}),
        });
        // Echo the moment the thread exists, then navigate — the optimistic row
        // is only VISIBLE once the docked transcript replaces the centred hero
        // (which overlays an empty list). replace, not push: Back from the
        // first message leaves chat.
        echo(r.threadId);
        router.replace(`/chat/${r.threadId}`);
        // A rejected first send (limit, running generation, bad attachment…)
        // still created the thread and lands the user in it with a toast —
        // exactly what create-then-send did when send threw.
        if (r.sendError !== undefined) throw new Error(r.sendError);
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
    [
      threadId,
      current,
      createAndSend,
      sendMessage,
      router,
      setPendingUsers,
      pendingProjectId,
    ],
  );

  return { send, sending, canSend: Boolean(current) };
}

/** Convex wraps thrown ConvexErrors with framing noise; show just the message. */
function cleanError(raw: string): string {
  const m = /Uncaught ConvexError:\s*(.+?)(\n|$)/.exec(raw);
  if (m?.[1]) return m[1];
  return raw.split("\n")[0]?.slice(0, 160) ?? "Please try again";
}
