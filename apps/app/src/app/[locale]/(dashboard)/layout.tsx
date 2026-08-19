import { WorkspaceProvider } from "@/lib/workspace-provider";
import { Toaster } from "sonner";
import { AmbienceSync } from "@/lib/ambience/ambience-sync";
import { CommandPalette } from "@/components/command-palette";
import { Sidebar } from "./_components/sidebar";
import { Topbar } from "./_components/topbar";

/**
 * No user fetch here any more.
 *
 * This layout used to await getUser purely to gate on `username` and bounce to
 * /onboarding. Picking a username is no longer a precondition for using the app —
 * it is optional, and editable in Settings — so the gate and the route are gone,
 * and with them a blocking server round trip on every dashboard navigation.
 *
 * Authentication itself is enforced by middleware.ts, not here.
 */
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <WorkspaceProvider>
      <AmbienceSync />
      <div className="min-h-screen w-full bg-secondary dark:bg-black md:flex">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <Topbar />
          <div className="min-h-0 flex-1">{children}</div>
        </main>
      </div>
      <Toaster richColors position="top-right" />
      <CommandPalette />
    </WorkspaceProvider>
  );
}
