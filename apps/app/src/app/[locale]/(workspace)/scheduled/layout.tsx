/**
 * The Scheduled Tasks route owns the whole viewport beside the rail.
 *
 * Deliberately NOT wrapped in ChatShell: that shell owns the composer and the
 * chat session, and a scheduled execution thread must never be given a send
 * path. The rail itself is mounted once by (workspace)/layout.tsx, so moving
 * between /chat, /scheduled and /projects keeps its scroll position, collapse
 * state and subscriptions — it used to be mounted here too, which rebuilt it on
 * every switch.
 *
 * Every ancestor of a scroller still needs min-h-0, or flexbox's
 * min-height:auto default lets content push the container taller instead of
 * scrolling.
 */
export default function ScheduledLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 w-full flex-1 overflow-hidden">{children}</div>
  );
}
