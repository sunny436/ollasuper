"use client";

import { useWorkspace } from "@/lib/useWorkspace";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import {
  Archive,
  ArchiveRestore,
  ArrowUp,
  ChevronRight,
  FolderKanban,
  FolderMinus,
  MessageSquare,
  MoreHorizontal,
  PanelLeft,
  Settings,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { NotificationsBell } from "../../../(dashboard)/_components/notifications-bell";
import { useChatSidebar } from "../../chat/_components/chat-shell";
import { PROJECT_DRAFT_KEY } from "../../chat/_lib/project-draft";
import { ProjectSettingsDialog } from "./project-settings-dialog";
import { ProjectSources } from "./project-sources";

/**
 * A single Project: its identity, its chats, its sources, and the way into a new
 * conversation.
 *
 * The page is deliberately spare — a composer, two tabs, a list. Everything that
 * CONFIGURES the project (name, instructions, memory, deletion) lives behind the
 * overflow menu in Project settings, so this surface stays about the work rather
 * than becoming a settings sheet with a chat list at the bottom.
 *
 * `projectId` is a RAW STRING from the URL and stays one — projects.get and
 * projects.listThreads both declare v.string() and normalizeId it server-side,
 * because a typo'd URL reaching a v.id() validator throws
 * ArgumentValidationError, which the Convex client logs via console.error,
 * which fails every e2e script.
 *
 * No Share button and no Sources connectors: sharing does not exist in this
 * product, so the affordance would promise something it cannot do.
 */

const PAGE = 30;

export function ProjectDetail({ projectId }: { projectId: string }) {
  const { openSidebar, collapsed, toggleCollapsed } = useChatSidebar();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { current, select } = useWorkspace();

  const project = useQuery(api.projects.get, { projectId });
  const archiveProject = useMutation(api.projects.archive);
  const removeProject = useMutation(api.projects.remove);
  const restoreProject = useMutation(api.projects.restore);
  const moveThread = useMutation(api.projects.moveThread);

  // The tab lives in the URL so Sources is deep-linkable and Back works — the
  // same pattern scheduled/task-detail.tsx already uses for its run panel.
  const tab = searchParams.get("tab") === "sources" ? "sources" : "chats";
  const setTab = (next: "chats" | "sources") =>
    router.replace(
      next === "chats"
        ? `/projects/${projectId}`
        : `/projects/${projectId}?tab=sources`,
      { scroll: false },
    );

  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState("");

  const { results, status, loadMore } = usePaginatedQuery(
    api.projects.listThreads,
    { projectId },
    { initialNumItems: PAGE },
  );

  /**
   * Keep the selected workspace in step with the Project being viewed.
   *
   * A new chat is created with the CURRENTLY selected workspace, and
   * threads.create refuses to link a thread to a Project in a different one.
   * Reaching this page by direct URL while another workspace is selected would
   * otherwise make New chat fail every time.
   *
   * Guarded by a ref, not by comparing current to the target: select() is
   * recreated on every WorkspaceProvider render, so this effect re-runs
   * constantly, and if the two never converge an unguarded version would call
   * select() in a render loop.
   */
  const switchedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!project || !current) return;
    if (project.workspaceId === current) return;
    if (switchedFor.current === project._id) return;
    switchedFor.current = project._id;
    select(project.workspaceId);
  }, [project, current, select]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  // Resolved-and-null means a bad, deleted or foreign id. Rendered inline
  // rather than via notFound(), which would destroy the workspace shell.
  if (project === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8">
        <div className="text-center">
          <p className="text-sm text-primary/70">Project not found</p>
          <Link
            href="/projects"
            className="mt-2 inline-block text-xs text-brand-ink hover:underline"
          >
            ← All projects
          </Link>
        </div>
      </div>
    );
  }

  const archived = project?.status === "archived";
  const trashed = project?.status === "trashed";
  const readOnly = archived || trashed;

  /**
   * Start a chat in this project, carrying what was typed.
   *
   * The real composer lives above the chat route segment and owns sending; this
   * only hands it a draft across the navigation, through sessionStorage rather
   * than the URL so a long first message never lands in browser history.
   */
  const startChat = () => {
    if (!project || readOnly) return;
    const text = draft.trim();
    if (text) {
      try {
        sessionStorage.setItem(PROJECT_DRAFT_KEY, text);
      } catch {
        // Private mode / blocked storage: the chat still opens, just empty.
      }
    }
    router.push(`/chat?project=${project._id}`);
  };

  const onToggleArchive = async () => {
    if (!project) return;
    try {
      await archiveProject({ projectId: project._id, archived: !archived });
      toast.success(archived ? "Project restored" : "Project archived");
    } catch {
      // Never console.error — the Convex client already logs rejections and
      // every e2e script asserts zero console errors.
      toast.error("Couldn't update that project");
    }
  };

  const onDelete = async () => {
    if (!project) return;
    if (
      !window.confirm(
        `Delete "${project.name}"?

Its chats are kept and move back to your conversation list. You can restore the project for 30 days.`,
      )
    ) {
      return;
    }
    try {
      await removeProject({ projectId: project._id });
      toast.success("Project deleted");
      router.push("/projects");
    } catch {
      toast.error("Couldn't delete that project");
    }
  };

  const onRestore = async () => {
    if (!project) return;
    try {
      await restoreProject({ projectId: project._id });
      toast.success("Project restored");
    } catch {
      toast.error("Couldn't restore that project");
    }
  };

  const onRemoveChat = async (threadId: Id<"chatThreads">, title: string) => {
    try {
      await moveThread({ threadId, projectId: null });
      toast.success(`Removed "${title}" from this project`);
    } catch (e) {
      toast.error(
        e instanceof Error && /already generating/i.test(e.message)
          ? "That chat is still generating a reply"
          : "Couldn't remove that chat",
      );
    }
  };

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="flex shrink-0 items-center gap-1 px-3 py-3">
          <button
            type="button"
            onClick={openSidebar}
            aria-label="Open conversations"
            className="rounded-md p-1.5 text-primary/50 hover:bg-primary/5 hover:text-primary md:hidden"
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

        <div className="mx-auto w-full max-w-3xl px-5 pb-24">
          <div className="flex items-center gap-1 pt-4 text-sm">
            <Link
              href="/projects"
              className="rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-primary"
            >
              Projects
            </Link>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate px-1 font-medium text-primary">
              {project?.name ?? "…"}
            </span>
          </div>

          <header className="flex items-center justify-between gap-4 pt-4">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted-foreground">
                <FolderKanban className="h-6 w-6" />
              </span>
              <h1 className="truncate text-3xl font-semibold tracking-tight text-primary">
                {project?.name ?? "Loading…"}
              </h1>
            </div>

            {project && (
              <div className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => setMenuOpen((v) => !v)}
                  aria-expanded={menuOpen}
                  aria-label="Project actions"
                  className="rounded-full border border-border p-2 text-muted-foreground transition hover:bg-accent hover:text-primary"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
                {menuOpen && (
                  <>
                    {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled above */}
                    <div
                      className="fixed inset-0 z-40"
                      onClick={() => setMenuOpen(false)}
                      aria-hidden="true"
                    />
                    <div className="absolute right-0 z-50 mt-1 w-48 overflow-hidden rounded-xl border border-border bg-popover py-1 shadow-xl">
                      <MenuItem
                        onClick={() => {
                          setMenuOpen(false);
                          setSettingsOpen(true);
                        }}
                      >
                        <Settings className="h-3.5 w-3.5" /> Project settings
                      </MenuItem>
                      {trashed ? (
                        <MenuItem
                          onClick={() => {
                            setMenuOpen(false);
                            void onRestore();
                          }}
                        >
                          <ArchiveRestore className="h-3.5 w-3.5" /> Restore
                        </MenuItem>
                      ) : (
                        <>
                          <MenuItem
                            onClick={() => {
                              setMenuOpen(false);
                              void onToggleArchive();
                            }}
                          >
                            {archived ? (
                              <ArchiveRestore className="h-3.5 w-3.5" />
                            ) : (
                              <Archive className="h-3.5 w-3.5" />
                            )}
                            {archived ? "Unarchive" : "Archive"}
                          </MenuItem>
                          <MenuItem
                            destructive
                            onClick={() => {
                              setMenuOpen(false);
                              void onDelete();
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" /> Delete project
                          </MenuItem>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </header>

          {trashed && (
            <div className="mt-4 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-muted-foreground">
              This project is deleted. Its chats are safe — they have moved back
              to your conversation list. Restore it within 30 days or it is
              removed permanently.
            </div>
          )}

          {archived && (
            <div className="mt-4 rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
              This project is archived. Its chats stay readable, but no new chats
              can be started until you restore it.
            </div>
          )}

          {/* The composer sits above the tabs and stays visible on both: starting
              a conversation is the primary action wherever you are in a project. */}
          {project && !readOnly && (
            <div className="mt-5 flex items-center gap-2 rounded-2xl border border-border bg-card px-4 py-3 shadow-sm transition focus-within:border-brand/40">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    startChat();
                  }
                }}
                placeholder={`New chat in ${project.name}`}
                aria-label={`New chat in ${project.name}`}
                className="min-w-0 flex-1 bg-transparent text-sm text-primary outline-none placeholder:text-muted-foreground"
              />
              <button
                type="button"
                onClick={startChat}
                aria-label="Start chat"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand text-brand-foreground transition hover:brightness-110 active:scale-95"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            </div>
          )}

          <div className="mt-5 flex gap-1">
            {(["chats", "sources"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                aria-current={tab === value ? "page" : undefined}
                className={`rounded-full px-3.5 py-1.5 text-sm capitalize transition-colors ${
                  tab === value
                    ? "bg-accent font-medium text-primary"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-primary"
                }`}
              >
                {value}
              </button>
            ))}
          </div>

          {tab === "chats" ? (
            <div className="mt-4">
              {status === "LoadingFirstPage" && (
                <div className="space-y-2">
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      className="h-11 animate-pulse rounded-lg bg-primary/5"
                    />
                  ))}
                </div>
              )}

              {status !== "LoadingFirstPage" && results.length === 0 && (
                <div className="py-16 text-center">
                  <p className="text-sm font-medium text-primary">
                    No chats yet
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Chats in {project?.name ?? "this project"} will live here
                  </p>
                </div>
              )}

              {results.length > 0 && (
                <ul className="space-y-1">
                  {results.map((t) => (
                    <li
                      key={t._id}
                      className="group flex items-center gap-1 rounded-lg text-sm text-muted-foreground transition-colors hover:bg-accent"
                    >
                      <Link
                        href={`/chat/${t._id}`}
                        prefetch={false}
                        className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 hover:text-primary"
                      >
                        <MessageSquare className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{t.title}</span>
                        {t.isStreaming && (
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand animate-pulse motion-reduce:animate-none" />
                        )}
                      </Link>
                      {/* Removing leaves the chat completely intact — it simply
                          becomes an ordinary chat again and returns to the rail. */}
                      <button
                        type="button"
                        aria-label={`Remove ${t.title} from project`}
                        title="Removes it from this project. The chat is kept."
                        onClick={() => void onRemoveChat(t._id, t.title)}
                        className="mr-1.5 shrink-0 rounded p-1 text-primary/30 opacity-0 transition hover:bg-primary/10 hover:text-primary/70 focus:opacity-100 group-hover:opacity-100"
                      >
                        <FolderMinus className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {status === "CanLoadMore" && (
                <button
                  type="button"
                  onClick={() => loadMore(PAGE)}
                  className="mt-2 w-full rounded-md px-2 py-1.5 text-xs text-primary/50 transition hover:bg-primary/5"
                >
                  Load more
                </button>
              )}
            </div>
          ) : (
            project && (
              <ProjectSources
                projectId={project._id}
                workspaceId={project.workspaceId}
                archived={readOnly}
              />
            )
          )}
        </div>
      </div>

      {project && (
        <ProjectSettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          projectId={project._id}
          name={project.name}
          instructions={project.instructions}
          readOnly={readOnly}
          onDelete={() => void onDelete()}
        />
      )}
    </div>
  );
}

/** Mirrors the ThreadMenu item in chat-sidebar.tsx — one menu language. */
function MenuItem({
  children,
  onClick,
  destructive,
}: {
  children: React.ReactNode;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition hover:bg-primary/5 ${
        destructive ? "text-destructive" : "text-primary/75"
      }`}
    >
      {children}
    </button>
  );
}
