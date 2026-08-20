"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { ConfirmButton } from "@/components/confirm-button";
import { useWorkspace } from "@/lib/useWorkspace";
import { useMutation, usePaginatedQuery } from "convex/react";
import { ExternalLink, Link2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type Filter =
  | "all"
  | "active"
  | "expired"
  | "revoked"
  | "full_chat"
  | "single_turn";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "expired", label: "Expired" },
  { key: "revoked", label: "Revoked" },
  { key: "full_chat", label: "Full chats" },
  { key: "single_turn", label: "Responses" },
];

const STATUS_STYLE: Record<string, string> = {
  active: "text-emerald-600 dark:text-emerald-400",
  expired: "text-primary/40",
  revoked: "text-red-500",
};

export default function SharedChatsPage() {
  const { current } = useWorkspace();
  const revoke = useMutation(api.chat.shares.revoke);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const { results, status, loadMore } = usePaginatedQuery(
    api.chat.shares.listMine,
    current ? { workspaceId: current } : "skip",
    { initialNumItems: 20 },
  );

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return results.filter((r) => {
      if (filter === "active" || filter === "expired" || filter === "revoked") {
        if (r.status !== filter) return false;
      } else if (filter === "full_chat" || filter === "single_turn") {
        if (r.shareType !== filter) return false;
      }
      if (q && !r.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [results, filter, search]);

  function copyLink(token: string) {
    const link = `${origin}/share/${token}`;
    navigator.clipboard?.writeText(link).then(
      () => toast.success("Link copied"),
      () => toast.error("Couldn't copy the link"),
    );
  }

  async function onRevoke(shareId: Id<"chatShares">) {
    try {
      await revoke({ shareId });
      toast.success("Share link revoked");
    } catch {
      toast.error("Couldn't revoke the link");
    }
  }

  return (
    <div className="w-full">
      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border p-5">
          <h1 className="text-lg font-medium text-primary">Shared Chats</h1>
          <p className="mt-1 text-sm text-primary/60">
            Links you've created to share conversations or responses. Shared
            content is read-only and expires after 7 days.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-border p-4">
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  filter === f.key
                    ? "bg-primary/10 text-primary"
                    : "text-primary/55 hover:bg-primary/5 hover:text-primary/80"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by title…"
            className="ml-auto w-full max-w-56 rounded-lg border border-border bg-secondary px-3 py-1.5 text-sm text-primary/80 placeholder:text-primary/35"
          />
        </div>

        <div className="divide-y divide-border">
          {status === "LoadingFirstPage" && (
            <p className="p-5 text-sm text-primary/50">Loading…</p>
          )}
          {status !== "LoadingFirstPage" && rows.length === 0 && (
            <p className="p-8 text-center text-sm text-primary/50">
              No shared links yet. Use the Share button in a chat to create one.
            </p>
          )}
          {rows.map((r) => (
            <div
              key={r._id}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-primary/85">
                    {r.title || "Untitled"}
                  </span>
                  <span className="shrink-0 rounded border border-border px-1.5 py-px text-[10px] font-medium text-primary/50">
                    {r.shareType === "single_turn" ? "Response" : "Full chat"}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-primary/45">
                  Created {new Date(r.createdAt).toLocaleDateString()} · Expires{" "}
                  {new Date(r.expiresAt).toLocaleDateString()} ·{" "}
                  <span className={STATUS_STYLE[r.status] ?? ""}>
                    {r.status}
                  </span>
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {r.status === "active" && (
                  <>
                    <button
                      type="button"
                      onClick={() => copyLink(r.token)}
                      aria-label="Copy link"
                      title="Copy link"
                      className="rounded p-1.5 text-primary/45 transition hover:bg-primary/5 hover:text-primary/80"
                    >
                      <Link2 className="h-4 w-4" />
                    </button>
                    <a
                      href={`${origin}/share/${r.token}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="Open shared page"
                      title="Open shared page"
                      className="rounded p-1.5 text-primary/45 transition hover:bg-primary/5 hover:text-primary/80"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </a>
                    <ConfirmButton
                      label="Revoke"
                      title="Revoke this share link?"
                      description="Anyone with this link will lose access to this shared content. This cannot be undone."
                      confirmLabel="Revoke"
                      className="rounded px-2 py-1 text-xs text-red-500 hover:bg-red-500/10"
                      onConfirm={() => onRevoke(r._id)}
                    />
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        {status === "CanLoadMore" && (
          <div className="border-t border-border p-4 text-center">
            <button
              type="button"
              onClick={() => loadMore(20)}
              className="rounded-full border border-border px-4 py-1.5 text-xs text-primary/60 transition hover:bg-primary/5"
            >
              Load more
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
