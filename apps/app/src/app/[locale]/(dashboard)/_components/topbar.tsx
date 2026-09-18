"use client";

import { HelpCircle } from "lucide-react";
import { usePathname } from "next/navigation";
import { NotificationsBell } from "./notifications-bell";

const APP_VERSION = "0.1.0";
const TITLES: Record<string, string> = {
  "/chat": "Chat",
  "/files": "Files",
  "/settings": "Settings",
  "/settings/billing": "Billing",
};

export function Topbar() {
  const pathname = usePathname();
  // /chat/<id> is not a static key. Chat is also the fallback because "/" only
  // ever renders for the instant before it redirects there.
  const title = TITLES[pathname] ?? "Chat";
  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-card px-6">
      <nav className="flex items-center gap-1.5 text-sm">
        <span className="text-primary/60">myos</span>
        <span className="text-muted-foreground">/</span>
        <span className="font-medium text-primary/80">{title}</span>
      </nav>
      <div className="flex items-center gap-3 text-xs text-primary/60">
        <NotificationsBell />
        <span className="hidden sm:inline">v{APP_VERSION}</span>
        <a
          href="https://github.com/get-convex/v1/tree/main/docs"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 hover:text-primary"
        >
          <HelpCircle className="h-4 w-4" /> Help
        </a>
      </div>
    </header>
  );
}
