import { ChatShell } from "./_components/chat-shell";

/**
 * The chat route owns its own height.
 *
 * (dashboard)/layout.tsx is min-h-screen with no definite height, so `h-full`
 * on today's pages already resolves to auto. Changing the shell to h-screen
 * would clip or force overflow on every other page and interact badly with the
 * sticky h-screen <aside>. Instead .h-chat-shell (see packages/ui globals.css)
 * is used by exactly this subtree.
 *
 * Every ancestor of the scroller needs min-h-0, or flexbox's min-height:auto
 * default lets the transcript push the container taller instead of scrolling.
 *
 * This layout also keeps the conversation sidebar mounted across thread
 * navigations, so its scroll position survives.
 */
export default function ChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="h-chat-shell flex w-full overflow-hidden bg-secondary dark:bg-black">
      <ChatShell>{children}</ChatShell>
    </div>
  );
}
