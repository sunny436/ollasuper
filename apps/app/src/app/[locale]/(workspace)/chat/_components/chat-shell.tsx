"use client";

import type { ReactNode } from "react";
import { useParams } from "next/navigation";
import { WorkspaceRail, useWorkspaceRail } from "../../_components/workspace-rail";
import { ChatSessionProvider } from "../_hooks/use-chat-session";
import { ComposerProvider } from "../_hooks/use-composer";
import { DEFAULT_MODEL } from "../_lib/models";
import { ChatLayout } from "./chat-layout";

/**
 * Layout for the chat subtree.
 *
 * THE RAIL NOW LIVES IN (workspace)/_components/workspace-rail.tsx. It moved
 * there when Scheduled Tasks became the second workspace destination: the rail
 * carries the navigation between them, so it belongs to the workspace rather
 * than to chat. Behaviour is unchanged — the docked/drawer split, the persisted
 * collapse, Escape, focus restore and the body scroll-lock all moved verbatim.
 *
 * What is left here is what is genuinely chat's: the composer and the chat
 * session. ChatLayout wraps the route segment rather than sitting beside it
 * because it owns the composer, and the composer has to outlive the /chat ->
 * /chat/[threadId] navigation for the centred->bottom spring to play.
 */

/** Re-exported so chat-pane keeps its import; the rail state is shared now. */
export const useChatSidebar = useWorkspaceRail;

export function ChatShell({ children }: { children: ReactNode }) {
  // Read here rather than taking it as a prop from the page: the composer now
  // lives in this (persistent) subtree, and the page components below are what
  // get swapped on navigation. Stays a raw string — never cast to
  // Id<"chatThreads">, because a typo'd URL reaching a v.id() validator throws
  // ArgumentValidationError, which the Convex client logs via console.error.
  const params = useParams<{ threadId?: string }>();
  const threadId = params?.threadId ?? null;

  return (
    <WorkspaceRail>
      <ComposerProvider>
        <ChatSessionProvider threadId={threadId} defaultModel={DEFAULT_MODEL}>
          <ChatLayout>{children}</ChatLayout>
        </ChatSessionProvider>
      </ComposerProvider>
    </WorkspaceRail>
  );
}
