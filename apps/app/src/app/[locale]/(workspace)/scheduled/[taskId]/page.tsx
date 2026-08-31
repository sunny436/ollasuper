import { ScheduledPane } from "../_components/scheduled-pane";

/**
 * Same pane, with the detail panel open. A distinct route (rather than local
 * state) so the panel is deep-linkable and survives a refresh — the taskId is
 * read from the URL inside the pane, never cast to a v.id() at the boundary.
 */
export default function ScheduledTaskPage() {
  return <ScheduledPane />;
}
