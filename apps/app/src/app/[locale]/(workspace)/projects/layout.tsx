import { WorkspaceRail } from "../_components/workspace-rail";

/**
 * The Projects route owns the whole viewport, beside the shared rail.
 *
 * Deliberately NOT wrapped in ChatShell — that shell owns the composer and the
 * chat session, and a Project page has no send path of its own. It mirrors
 * scheduled/layout.tsx for exactly that reason: the rail is shared, so moving
 * between /chat, /scheduled and /projects keeps its scroll position and
 * collapse state.
 *
 * Every ancestor of a scroller still needs min-h-0, or flexbox's
 * min-height:auto default lets content push the container taller instead of
 * scrolling.
 */
export default function ProjectsLayout({
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
