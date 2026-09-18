import "@v1/ui/globals.css";
import { ConvexAuthNextjsServerProvider } from "@convex-dev/auth/nextjs/server";
import { cn } from "@v1/ui/utils";
import { GeistMono } from "geist/font/mono";
import type { Metadata } from "next";
import { Poppins } from "next/font/google";

// Poppins is the app's ONE UI face (mapped onto font-sans and font-brand in the
// UI tailwind config). It is a static family — one file per weight and style —
// so the list below IS the preload list; a weight nobody uses is a file nobody
// needs. 400/500/600/700 are the census of the source, 800 is the wordmark.
// Italic is loaded because markdown emits <em> from model output; a family
// without an italic face gets fake-slanted, and next/font/google only takes the
// weight × style product, so the price of a real italic is four italic files
// nothing uses (~30 KB, immutable-cached).
//
// `subsets` decides what is PRELOADED, not what exists: next/font declares every
// subset Google ships for the family — Devanagari and Latin-Extended included —
// each behind a unicode-range, so the browser fetches those files only when a
// glyph in range is actually on screen. Zero cost on an English page, real
// Poppins the moment someone writes Hindi. Do NOT add a second Poppins() call
// for the other scripts: it re-declares the same faces at duplicate URLs and the
// browser can end up downloading the un-preloaded copy beside the preloaded one
// (seen in the build output while this was written).
//
// The variable must sit on <html>, not <body>: Tailwind preflight applies
// font-family to <html>, and CSS custom properties do not inherit upward, so a
// var defined only on <body> would resolve to nothing there.
const poppins = Poppins({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  style: ["normal", "italic"],
  variable: "--font-poppins",
  display: "swap",
});

import { ThemeProvider } from "@/lib/theme/theme-provider";
import { ThemeScript } from "@/lib/theme/theme-script";
import { PerfProbeLoader } from "@/lib/perf-probe/perf-probe-loader";
import { ConvexClientProvider } from "../convex-client-provider";

export const metadata: Metadata = {
  // metadataBase is load-bearing, not decoration: without it Next resolves
  // og:image against localhost, so every generated social card is a dead link.
  metadataBase: new URL("https://app.ollasuper.com"),
  title: "OllaSuper",
  description: "Your private AI workspace.",
};

// Both entries previously carried a `media` key and NO `color`, which emits
// nothing — the browser chrome on mobile never matched the app. Pure white and
// pitch black, the same two ends as the design system.
export const viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FFFFFF" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ConvexAuthNextjsServerProvider>
      <html
        lang="en"
        className={poppins.variable}
        suppressHydrationWarning
      >
        <body
          className={cn(`${GeistMono.variable}`, "antialiased")}
        >
          {/* Stamps the `dark` class on <html> before first paint (no flash).
              Must be the first thing in <body> so it runs before the app
              content is styled. */}
          <ThemeScript />
          <ThemeProvider>
            {/* No TooltipProvider: the app renders no Radix Tooltip (only the
                unused ui/tooltip component exists), so mounting its context added
                a small client chunk for nothing. Re-add if a Tooltip is used. */}
            <ConvexClientProvider>{children}</ConvexClientProvider>
          </ThemeProvider>
          {/* Opt-in (?perf=1) real-device perf probe; a no-op unless enabled. */}
          <PerfProbeLoader />
        </body>
      </html>
    </ConvexAuthNextjsServerProvider>
  );
}
