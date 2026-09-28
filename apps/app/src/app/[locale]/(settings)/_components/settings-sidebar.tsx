"use client";

import {
  Archive,
  Brain,
  FolderClosed,
  Palette,
  Link2,
  Plug,
  Sparkles,
  User,
  Wand2,
  X,
} from "lucide-react";
import { OllaSuperBrand } from "@/components/branding";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

/**
 * The five Settings sections. Billing is deliberately NOT here — it stays at
 * /settings/billing, reachable via ⌘K and the chat account menu, matching the
 * approved plan.
 */
const NAV = [
  { href: "/settings", label: "Profile", icon: User },
  { href: "/settings/appearance", label: "Appearance", icon: Palette },
  { href: "/settings/personalization", label: "Personalization", icon: Sparkles },
  { href: "/settings/memories", label: "Memories", icon: Brain },
  { href: "/settings/skills", label: "My Skills", icon: Wand2 },
  // Connectors sits with Skills and Memories rather than in the workspace rail:
  // a connection is owner-scoped (`mcpConnections` is indexed by_user) and
  // follows the person across workspaces, which is the same reason skills live
  // here. The rail holds what you operate INSIDE one workspace.
  { href: "/settings/connectors", label: "Connectors", icon: Plug },
  { href: "/settings/shared", label: "Shared Links", icon: Link2 },
  { href: "/settings/archived", label: "Archived Chats", icon: Archive },
  // Files are managed in the File Library (a workspace surface, not a setting).
  { href: "/library", label: "Library", icon: FolderClosed },
] as const;

// Strip an optional /<locale> prefix so active-state matching works under
// either next-international URL strategy (bare or locale-prefixed).
function stripLocale(p: string) {
  return p.replace(/^\/[a-z]{2}(?=\/|$)/, "") || "/";
}

export function SettingsSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = stripLocale(usePathname());
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const items = NAV.filter((n) => n.label.toLowerCase().includes(needle));

  // Profile owns the bare /settings path, so it must match exactly or it would
  // light up on every sub-route; the others match exact-or-nested.
  const isActive = (href: string) =>
    href === "/settings"
      ? pathname === "/settings"
      : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div className="flex h-full flex-col">
      {/* Header: brand lockup + close. The wrapper is flex so the brand sits in
          no text line box — as a plain block it grew 7px of empty space under
          the logo on a phone (71px header vs the chat rail's 64px). */}
      <div className="flex items-center gap-3 px-4 py-4">
        <div className="flex min-w-0 flex-1 items-center text-foreground">
          <OllaSuperBrand variant="app" />
        </div>
        <Link
          href="/chat"
          prefetch={true}
          onClick={onNavigate}
          aria-label="Close settings"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground transition hover:bg-accent hover:text-primary"
        >
          <X className="h-4 w-4" />
        </Link>
      </div>

      {/* Search */}
      <div className="px-3 pb-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search settings"
          aria-label="Search settings"
          className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-primary/80 outline-none transition placeholder:text-muted-foreground focus:border-brand/40"
        />
      </div>

      {/* Nav */}
      <nav className="scrollbar-quiet min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {items.length === 0 ? (
          <p className="px-3 py-4 text-xs text-primary/60">
            No settings match “{q}”.
          </p>
        ) : (
          items.map(({ href, label, icon: Icon }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                // FULL prefetch, not the default partial one. Every section lives
                // under the dynamic [locale] segment with no loading boundary, so
                // the default prefetch fetched nothing useful and each click paid
                // a fresh RSC round trip through the middleware before the URL
                // even changed — 230-600 ms from the US, 1-2 s from India
                // (measured, e2e/perf-settings.js), while the server renders the
                // payload in 5 ms. With prefetch the shell comes from the router
                // cache and a click waits only for the section's own query.
                prefetch={true}
                onClick={onNavigate}
                className={`mb-1 flex items-center gap-3 rounded-xl border px-3 py-2.5 text-sm transition-colors ${
                  active
                    ? "border-border bg-card font-medium text-primary"
                    : "border-transparent text-primary/60 hover:bg-card hover:text-primary/90"
                }`}
              >
                <Icon
                  className={`h-4 w-4 shrink-0 ${
                    active ? "text-brand-ink" : "text-primary/60"
                  }`}
                />
                {label}
              </Link>
            );
          })
        )}
      </nav>
    </div>
  );
}
