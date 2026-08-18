import { ChatShell } from "./_components/chat-shell";

/**
 * The chat route owns the whole viewport.
 *
 * It used to subtract the dashboard chrome via .h-chat-shell (topbar 3rem, plus
 * the mobile app header below md). Under (workspace) there is no chrome above
 * it, so the height comes from .h-dvh-safe on the group layout and this element
 * simply fills it.
 *
 * Every ancestor of the scroller still needs min-h-0, or flexbox's
 * min-height:auto default lets the transcript push the container taller instead
 * of scrolling.
 *
 * This layout also keeps the conversation rail mounted across thread
 * navigations, so its scroll position survives.
 */
export default function ChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 w-full flex-1 overflow-hidden">
      <ChatShell>{children}</ChatShell>
    </div>
  );
}
