"use client";

import { useWorkspace } from "@/lib/useWorkspace";
import { api } from "@v1/backend/convex/_generated/api";
import { usePaginatedQuery } from "convex/react";
import { FolderKanban, PanelLeft, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { NotificationsBell } from "../../../(dashboard)/_components/notifications-bell";
import { useChatSidebar } from "../../chat/_components/chat-shell";
import { CreateProjectDialog } from "./create-project-dialog";

/**
 * The Projects home.
 *
 * Laid out as a NAME / MODIFIED table rather than cards: a project list is an
 * index you scan, not a set of objects you browse, and the reference product
 * treats it that way too.
 *
 * The list comes from the AUTHORIZED backend query — there is no client-side
 * filtering of who may see what, because hiding a row in React is not access
 * control (the query only ever returns the caller's own projects).
 *
 * Tabs are Active / Archived / Deleted — the REAL lifecycle states. The
 * reference splits by ownership instead ("Created by you" / "Shared with you"),
 * which would be a lie here: projects are private to their creator and sharing
 * does not exist.
 */

const PAGE = 30;

type Tab = "active" | "archived" | "trashed";

const TAB_LABEL: Record<Tab, string> = {
  active: "Active",
  archived: "Archived",
  trashed: "Deleted",
};

export function ProjectsPane() {
  const { current } = useWorkspace();
  const { openSidebar, collapsed, toggleCollapsed } = useChatSidebar();
  const [tab, setTab] = useState<Tab>("active");
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const { results, status, loadMore } = usePaginatedQuery(
    api.projects.list,
    current ? { workspaceId: current, status: tab } : "skip",
    { initialNumItems: PAGE },
  );

  const searching = query.trim().length > 0;

  /**
   * Search over EVERY project, not just the loaded page.
   *
   * There is no search index on `projects` (adding one is backend work), so the
   * filter runs client-side. Filtering only the first page would make a search
   * for the 31st project answer "No projects match" — a wrong answer wearing an
   * empty state, which is worse than having no search at all. So while a query
   * is active, page the rest in first. Projects are per-user and few, so this is
   * bounded by how many the person actually has.
   */
  useEffect(() => {
    if (searching && status === "CanLoadMore") loadMore(PAGE);
  }, [searching, status, loadMore]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return results;
    return results.filter((p) => p.name.toLowerCase().includes(q));
  }, [results, query]);

  const loading = status === "LoadingFirstPage";
  // Still paging the rest in for a search: showing "no matches" now would be
  // premature.
  const settling = searching && status === "LoadingMore";

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="flex shrink-0 items-center gap-1 px-3 py-3">
          <button
            type="button"
            onClick={openSidebar}
            aria-label="Open conversations"
            className="rounded-md p-1.5 text-primary/50 hover:bg-primary/5 hover:text-primary md:hidden [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Show conversations" : "Hide conversations"}
            className="hidden rounded-md p-1.5 text-primary/50 hover:bg-primary/5 hover:text-primary md:block"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
          <div className="ml-auto">
            <NotificationsBell />
          </div>
        </div>

        {/* max-w-3xl, matching every other workspace surface (chat transcript,
            scheduled). The reference column is wider, but breaking the app's own
            content rhythm for one page would be the more visible inconsistency. */}
        <div className="mx-auto w-full max-w-3xl px-5 pb-24">
          <header className="flex flex-wrap items-center justify-between gap-3 pt-6">
            <h1 className="text-3xl font-semibold tracking-tight text-primary">
              Projects
            </h1>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search projects"
                  aria-label="Search projects"
                  className="w-52 rounded-full border border-border bg-card py-2 pl-9 pr-3 text-sm text-primary outline-none transition placeholder:text-muted-foreground focus:border-brand"
                />
              </div>
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                disabled={!current}
                className="flex shrink-0 items-center gap-1.5 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground shadow-sm transition hover:brightness-110 active:scale-95 disabled:opacity-40"
              >
                <Plus className="h-4 w-4" /> New
              </button>
            </div>
          </header>

          <div className="mt-6 flex gap-1">
            {(Object.keys(TAB_LABEL) as Tab[]).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                aria-current={tab === value ? "page" : undefined}
                className={`rounded-full px-3.5 py-1.5 text-sm transition-colors ${
                  tab === value
                    ? "bg-accent font-medium text-primary"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-primary"
                }`}
              >
                {TAB_LABEL[value]}
              </button>
            ))}
          </div>

          {tab === "trashed" && (
            <p className="mt-4 text-xs text-muted-foreground">
              Deleted projects are removed permanently after 30 days. Their chats
              were kept and are back in your conversation list.
            </p>
          )}

          {loading && (
            <div className="mt-6 space-y-1">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-14 animate-pulse rounded-lg bg-primary/5"
                />
              ))}
            </div>
          )}

          {!loading && visible.length > 0 && (
            <div className="mt-6">
              <div className="flex items-center gap-3 border-b border-border px-2 pb-2 text-xs font-medium text-muted-foreground">
                <span className="flex-1">Name</span>
                <span className="w-28 shrink-0">Modified</span>
              </div>
              <ul>
                {visible.map((p) => (
                  <li key={p._id}>
                    <Link
                      href={`/projects/${p._id}`}
                      className="flex items-center gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-accent"
                    >
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/5 text-muted-foreground">
                        <FolderKanban className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-primary">
                        {p.name}
                      </span>
                      <span className="w-28 shrink-0 text-xs text-muted-foreground">
                        {new Date(p.updatedAt).toLocaleDateString()}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!loading && visible.length === 0 && !settling && (
            <div className="mt-12 flex flex-col items-center text-center">
              <span className="grid h-12 w-12 place-items-center rounded-xl bg-brand/10 text-brand-ink">
                <FolderKanban className="h-5 w-5" />
              </span>
              <p className="mt-3 text-sm font-medium text-primary">
                {searching
                  ? "No projects match"
                  : tab === "active"
                    ? "No projects yet"
                    : tab === "archived"
                      ? "No archived projects"
                      : "Nothing deleted"}
              </p>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                {searching
                  ? `Nothing here is called “${query.trim()}”.`
                  : tab === "active"
                    ? "Create a project to keep a set of related conversations together."
                    : tab === "archived"
                      ? "Projects you archive will appear here."
                      : "Deleted projects stay here for 30 days, then go for good."}
              </p>
            </div>
          )}

          {/* Only offered when NOT searching — a search has already paged
              everything in, so a Load more there would be meaningless. */}
          {!searching && status === "CanLoadMore" && (
            <button
              type="button"
              onClick={() => loadMore(PAGE)}
              className="mt-3 w-full rounded-md px-2 py-2 text-xs text-primary/50 transition hover:bg-primary/5"
            >
              Load more
            </button>
          )}
        </div>
      </div>

      <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
