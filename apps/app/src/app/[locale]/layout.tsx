import "@v1/ui/globals.css";
import { ConvexAuthNextjsServerProvider } from "@convex-dev/auth/nextjs/server";
import { TooltipProvider } from "@v1/ui/tooltip";
import { cn } from "@v1/ui/utils";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import { AmbienceProvider } from "@/lib/ambience/ambience-provider";
import { AmbienceScript } from "@/lib/ambience/ambience-script";
import { ConvexClientProvider } from "../convex-client-provider";

export const metadata: Metadata = {
  title: "Create v1",
  description: "Production ready Next.js app",
};

export const viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)" },
    { media: "(prefers-color-scheme: dark)" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ConvexAuthNextjsServerProvider>
      <html lang="en" suppressHydrationWarning>
        <body
          className={cn(
            `${GeistSans.variable} ${GeistMono.variable}`,
            "antialiased",
          )}
        >
          {/* Stamps ambience vars + .dark on <html> before first paint (no
              flash). Must be the first thing in <body> so it runs before the
              app content is styled. */}
          <AmbienceScript />
          <AmbienceProvider>
            <TooltipProvider delayDuration={0}>
              <ConvexClientProvider>{children}</ConvexClientProvider>
            </TooltipProvider>
          </AmbienceProvider>
        </body>
      </html>
    </ConvexAuthNextjsServerProvider>
  );
}
