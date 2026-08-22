"use client";

import { Archive, FolderClosed, Link2, Sparkles, User, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { SettingsOrb } from "./settings-orb";

/**
 * The five Settings sections. Billing is deliberately NOT here — it stays at
 * /settings/billing, reachable via ⌘K and the chat account menu, matching the
 * approved plan.
 */
const NAV = [
  { href: "/settings", label: "Profile", icon: User },
  { href: "/settings/personalization", label: "Personalization", icon: Sparkles },
  { href: "/settings/shared", label: "Shared Links", icon: Link2 },
  { href: "/settings/archived", label: "Archived Chats", icon: Archive },
  { href: "/settings/files", label: "Files", icon: FolderClosed },
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
      {/* Header: brand orb + title + close */}
      <div className="flex items-center gap-3 px-4 py-4">
        <SettingsOrb className="h-9 w-9" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold tracking-tight text-primary">
            Settings
          </p>
          <p className="truncate text-[11px] font-medium text-muted-foreground">
            Ollasuper
          </p>
        </div>
        <Link
          href="/chat"
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
          className="w-full rounded-lg border border-border bg-card/60 px-3 py-2 text-sm text-primary/80 outline-none transition placeholder:text-primary/35 focus:border-brand/40"
        />
      </div>

      {/* Nav */}
      <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {items.length === 0 ? (
          <p className="px-3 py-4 text-xs text-primary/45">
            No settings match “{q}”.
          </p>
        ) : (
          items.map(({ href, label, icon: Icon }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                onClick={onNavigate}
                className={`mb-1 flex items-center gap-3 rounded-xl border px-3 py-2.5 text-sm transition-colors ${
                  active
                    ? "border-border bg-card/70 font-medium text-primary backdrop-blur-sm"
                    : "border-transparent text-primary/60 hover:bg-card/40 hover:text-primary/90"
                }`}
              >
                <Icon
                  className={`h-4 w-4 shrink-0 ${
                    active ? "text-brand-ink" : "text-primary/45"
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
