"use client";

import { clearDisplayCaches } from "@/lib/display-cache";
import { markIntentionalSignOut } from "@/lib/displaced-session";
import { useWorkspace } from "@/lib/useWorkspace";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import {
  CreditCard,
  FolderOpen,
  LogOut,
  MessageSquare,
  Menu,
  Settings,
  X,
} from "lucide-react";
import Link from "next/link";
import { OllaSuperBrand } from "@/components/branding";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ThemeToggle } from "@/components/theme-toggle";

const NAV = [
  // prefix: /chat/<id> must keep this row highlighted. Opt-in per entry so
  // that /settings does not also light up on /settings/billing.
  { href: "/chat", label: "Chat", icon: MessageSquare, prefix: true },
  { href: "/files", label: "Files", icon: FolderOpen },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/settings/billing", label: "Billing", icon: CreditCard },
];

export function Sidebar() {
  const pathname = usePathname();
  const { signOut } = useAuthActions();
  const user = useQuery(api.users.getUser);
  const { workspaces, current, select } = useWorkspace();
  const [open, setOpen] = useState(false);

  const Body = (
    <div className="flex h-full w-60 flex-col border-r border-border bg-card">
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <span className="text-foreground">
          <OllaSuperBrand variant="app" />
        </span>
      </div>

      <div className="p-3">
        <span className="mb-1 block text-[10px] uppercase tracking-wide text-primary/60">
          Workspace
        </span>
        <select
          aria-label="Workspace"
          value={current ?? ""}
          onChange={(e) => select(e.target.value as Id<"workspaces">)}
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        >
          {workspaces.length === 0 && <option>…</option>}
          {workspaces.map((w) => (
            <option key={w._id} value={w._id}>
              {w.name} ({w.role})
            </option>
          ))}
        </select>
      </div>

      <nav className="scrollbar-quiet flex-1 space-y-1 overflow-y-auto px-3 py-1">
        {NAV.map((item) => {
          const active =
            "prefix" in item && item.prefix
              ? pathname === item.href || pathname.startsWith(`${item.href}/`)
              : pathname === item.href;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              prefetch={false}
              onClick={() => setOpen(false)}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm ${
                active
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-primary/70 hover:bg-primary/5"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border p-3">
        <div className="mb-2 flex items-center gap-2">
          {user?.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
          ) : (
            <span className="h-8 w-8 shrink-0 rounded-full border border-border bg-muted" />
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-primary/80">{user?.displayName || user?.name || "—"}</p>
            <p className="truncate text-xs text-primary/65">{user?.email}</p>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <ThemeToggle />
          <button
            type="button"
            onClick={() => {
              markIntentionalSignOut();
              clearDisplayCaches();
              signOut();
            }}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-primary/60 hover:bg-primary/5 hover:text-primary"
          >
            <LogOut className="h-4 w-4" /> Log out
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <div className="flex h-14 items-center gap-3 border-b border-border bg-card px-4 md:hidden">
        <button
          type="button"
          aria-label="Open menu"
          onClick={() => setOpen(true)}
          className="-ml-3 flex h-11 w-11 items-center justify-center"
        >
          <Menu className="h-5 w-5" />
        </button>
        <span className="text-foreground">
          <OllaSuperBrand variant="app" />
        </span>
      </div>

      <aside className="sticky top-0 hidden h-screen shrink-0 md:block">{Body}</aside>

      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 cursor-default bg-black/50"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-0 top-0 h-full shadow-md">
            <button
              type="button"
              aria-label="Close menu"
              className="absolute -right-9 top-3 text-white"
              onClick={() => setOpen(false)}
            >
              <X className="h-6 w-6" />
            </button>
            {Body}
          </div>
        </div>
      )}
    </>
  );
}
