import { CommandPalette } from "@/components/command-palette";
import { AmbienceSync } from "@/lib/ambience/ambience-sync";
import { WorkspaceProvider } from "@/lib/workspace-provider";
import { Toaster } from "sonner";
import { AmbientBackdrop } from "./_components/ambient-backdrop";

/**
 * The full-bleed workspace shell.
 *
 * A sibling route group to (dashboard), which is the idiomatic Next answer to
 * "one route needs different chrome": route groups do not affect URLs, so /chat
 * is still /chat, but it no longer inherits the app sidebar and topbar. That
 * matters because the chat route carries its own conversation rail — under the
 * dashboard shell two rails ate 528px at 1280px before a word of transcript.
 *
 * WorkspaceProvider is NOT optional here. Every chat query is scoped by the
 * workspaceId it supplies, and it is also what fires api.authSessions.heartbeat,
 * which is where single-active-session enforcement actually happens for plain
 * password sign-ins.
 *
 * CommandPalette is mounted here rather than left behind in (dashboard) so ⌘K
 * still works on the app's landing route.
 *
 * No auth check: middleware.ts enforces it, exactly as in (dashboard)/layout.
 */
export default function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <WorkspaceProvider>
      <AmbienceSync />
      {/*
        `workspace` re-points the existing design tokens (--card, --border,
        --background …) to the glass palette for this subtree only, so every
        component below re-skins without a single className change and the
        routes that kept the dashboard shell are untouched. See
        packages/ui/src/globals.css.

        overscroll-none stops the body's own --background showing through when
        a trackpad rubber-bands past the top of the transcript.
      */}
      <div className="workspace relative isolate flex h-dvh-safe w-full overflow-hidden overscroll-none bg-background text-foreground">
        <AmbientBackdrop />
        {children}
      </div>
      <Toaster richColors position="top-right" />
      <CommandPalette />
    </WorkspaceProvider>
  );
}
