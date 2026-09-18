import "@v1/ui/globals.css";
import { ConvexAuthNextjsServerProvider } from "@convex-dev/auth/nextjs/server";
import { cn } from "@v1/ui/utils";
import { GeistMono } from "geist/font/mono";
import type { Metadata } from "next";
import { Plus_Jakarta_Sans, Poppins } from "next/font/google";

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

// The wordmark face, and ONLY the wordmark: one weight, one subset, so this adds
// a single woff2 rather than a second font system. Loaded through the same
// next/font/google mechanism as the UI face above, so it is self-hosted with no
// new dependency and no request to Google at runtime.
const poppins = Poppins({
  subsets: ["latin"],
  weight: ["800"],
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
        className={cn(jakarta.variable, poppins.variable)}
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
