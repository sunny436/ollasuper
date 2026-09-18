import type { Config } from "tailwindcss";

const config = {
  darkMode: ["class"],
  content: [
    "./pages/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./app/**/*.{ts,tsx}",
    "./src/**/*.{ts,tsx}",
  ],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        departure: ["var(--font-departure-mono)"],
        // Poppins is the app-wide UI face — every route, portal, dialog and form
        // control, because Tailwind preflight puts `sans` on <html> and
        // `font-family: inherit` on every control. `--font-poppins` is defined on
        // <html> (apps/app layout) and already expands to `Poppins, Poppins
        // Fallback` (metric-matched); the Devanagari and Latin-Extended faces
        // are further @font-face rules of the SAME family, so nothing else
        // belongs in this stack but the generic fallback.
        sans: ["var(--font-poppins)", "sans-serif"],
        // The wordmark lockup. Same face as the UI now, kept as its own key so
        // the brand component and its test name what they mean.
        brand: ["var(--font-poppins)", "sans-serif"],
        // Opt-in ONLY. The Geist vars are set on <body>; used only in code
        // blocks via font-geist-mono.
        "geist-mono": [
          "var(--font-geist-mono)",
          "ui-monospace",
          "SFMono-Regular",
          "monospace",
        ],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        // Status. Ink and 1px borders only — the monochrome system has no room
        // for a coloured fill, and a status banner reads fine as muted surface +
        // coloured ink.
        warning: "hsl(var(--warning))",
        success: "hsl(var(--success))",
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // See globals.css for the role of each. brand = fills/borders/rings,
        // brand-ink = text, brand-foreground = text on a brand fill.
        brand: {
          DEFAULT: "hsl(var(--brand))",
          foreground: "hsl(var(--brand-foreground))",
          ink: "hsl(var(--brand-ink))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "caret-blink": {
          "0%,70%,100%": { opacity: "1" },
          "20%,50%": { opacity: "0" },
        },
        "fade-in-up": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "none" },
        },
        "dot-bounce": {
          "0%,80%,100%": { transform: "translateY(0)", opacity: ".45" },
          "40%": { transform: "translateY(-3px)", opacity: "1" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "caret-blink": "caret-blink 1.2s ease-out infinite",
        "fade-in-up": "fade-in-up 150ms ease-out",
        "dot-bounce": "dot-bounce 1.2s ease-in-out infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;

export default config;
