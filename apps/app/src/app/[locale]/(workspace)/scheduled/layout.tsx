import { WorkspaceRail } from "../_components/workspace-rail";

/**
 * The Scheduled Tasks route owns the whole viewport, beside the shared rail.
 *
 * Deliberately NOT wrapped in ChatShell: that shell owns the composer and the
 * chat session, and a scheduled execution thread must never be given a send
 * path. The rail is shared so navigating between /chat and /scheduled keeps its
 * scroll position and collapse state.
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
    <div className="flex min-h-0 w-full flex-1 overflow-hidden">
      <WorkspaceRail>{children}</WorkspaceRail>
    </div>
  );
}
