"use client";

import { CommandPalette } from "@/components/command-palette";
import { AmbienceSync } from "@/lib/ambience/ambience-sync";
import { WorkspaceProvider } from "@/lib/workspace-provider";
import { I18nProviderClient } from "@/locales/client";
import { Menu } from "lucide-react";
import { useState } from "react";
import { Toaster } from "sonner";
import { AmbientBackdrop } from "./_components/ambient-backdrop";
import { SettingsSidebar } from "./_components/settings-sidebar";
import { ThemeSlider } from "./_components/theme-slider";

/**
 * Dedicated full-screen Settings shell — a sibling route group so it escapes
 * the (dashboard) shell (Workspace/Chat/Files/Billing rail + topbar) entirely,
 * exactly how (workspace) was created for chat. Route groups don't affect URLs,
 * so /settings, /settings/shared, /settings/billing keep their paths.
 *
 * A client layout (like the sub-nav it replaces) so it can read params.locale
 * synchronously for I18nProviderClient — the Profile page uses
 * useScopedI18n("settings"), and deleting the old settings/layout.tsx removed
 * the only provider that supplied it. App-level providers (Convex, Ambience,
 * Tooltip) come from [locale]/layout.tsx; this layout re-supplies the ones the
 * dashboard shell used to give the settings pages: WorkspaceProvider (the
 * pages call useWorkspace()), AmbienceSync, Toaster (sections toast) and
 * CommandPalette (⌘K → Billing).
 */
export default function SettingsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { locale: string };
}) {
  const [drawer, setDrawer] = useState(false);

  return (
    <I18nProviderClient locale={params.locale}>
      <WorkspaceProvider>
        <AmbienceSync />
        {/* .workspace re-points the surface tokens to the deep-space glass
            palette so every child re-skins with no className churn; relative +
            isolate keep the backdrop under the shell (globals.css:96-137). */}
        <div className="workspace relative isolate flex h-dvh-safe w-full overflow-hidden bg-background text-foreground">
          <AmbientBackdrop />

          {/* Desktop sidebar */}
          <aside className="relative z-10 hidden w-72 shrink-0 border-r border-border bg-card/30 backdrop-blur-xl md:flex md:flex-col">
            <SettingsSidebar />
          </aside>

          {/* Mobile drawer */}
          {drawer && (
            <div className="fixed inset-0 z-40 md:hidden">
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss */}
              <div
                className="absolute inset-0 bg-black/50"
                onClick={() => setDrawer(false)}
                aria-hidden="true"
              />
              <div className="workspace absolute left-0 top-0 h-full w-72 border-r border-border bg-popover shadow-2xl">
                <SettingsSidebar onNavigate={() => setDrawer(false)} />
              </div>
            </div>
          )}

          {/* Content */}
          <main className="relative z-10 flex min-w-0 flex-1 flex-col">
            <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border px-4 sm:px-6">
              <button
                type="button"
                onClick={() => setDrawer(true)}
                aria-label="Open settings menu"
                className="grid h-9 w-9 place-items-center rounded-lg border border-border text-muted-foreground transition hover:bg-accent hover:text-primary md:hidden"
              >
                <Menu className="h-4 w-4" />
              </button>
              {/* Theme slider — always top-right. */}
              <div className="ml-auto">
                <ThemeSlider />
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
                {children}
              </div>
            </div>
          </main>
        </div>

        <Toaster richColors position="top-right" />
        <CommandPalette />
      </WorkspaceProvider>
    </I18nProviderClient>
  );
}
