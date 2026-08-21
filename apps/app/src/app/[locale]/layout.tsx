import "@v1/ui/globals.css";
import { ConvexAuthNextjsServerProvider } from "@convex-dev/auth/nextjs/server";
import { TooltipProvider } from "@v1/ui/tooltip";
import { cn } from "@v1/ui/utils";
import { GeistMono } from "geist/font/mono";
import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";

// Plus Jakarta Sans is the app's primary UI face (mapped onto font-sans in the
// UI tailwind config). Variable font, self-hosted by next/font (one file, all
// weights). The variable must sit on <html>, not <body>: Tailwind preflight
// applies font-family to <html>, and CSS custom properties do not inherit
// upward, so a var defined only on <body> would resolve to nothing there.
const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-plus-jakarta-sans",
  display: "swap",
});
import { AmbienceProvider } from "@/lib/ambience/ambience-provider";
import { AmbienceScript } from "@/lib/ambience/ambience-script";
import { ConvexClientProvider } from "../convex-client-provider";

export const metadata: Metadata = {
  title: "Ollasuper",
  description: "Your private AI workspace.",
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
      <html lang="en" className={jakarta.variable} suppressHydrationWarning>
        <body
          className={cn(`${GeistMono.variable}`, "antialiased")}
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
