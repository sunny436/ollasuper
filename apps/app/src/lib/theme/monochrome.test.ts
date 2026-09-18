/**
 * The monochrome design system, asserted against its own stylesheet.
 *
 * This replaces `lib/ambience/contrast.check.ts`, which checked that the old
 * colour ramp stayed legible at every phase of the day. There is no ramp any
 * more, so the thing worth defending changed shape: the palette is now a short
 * list of literals, and the failure mode is not "a phase goes illegible", it is
 * "a hue creeps back in".
 *
 * It fails if someone reintroduces brand colour, a gradient, glass or glow —
 * which is the whole point, since none of those produce a visible error at
 * runtime. They just quietly undo the design.
 *
 * WHAT IS DELIBERATELY ALLOWED, and why each one is not a loophole:
 *  - `--chart-*` keep their hues. Five series in one greyscale ramp cannot be
 *    told apart and a pie chart becomes unreadable. Charts are CONTENT.
 *  - status tokens keep exactly three hues, pinned to exact values below. They
 *    are the one semantic signal that cannot survive greyscaling.
 *  - shiki and mermaid colour lives in their own themes, not in these files.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..");
const CSS = join(REPO, "packages", "ui", "src", "globals.css");
const SOURCE_ROOTS = [
  join(REPO, "apps", "app", "src"),
  join(REPO, "packages", "ui", "src"),
];

/** The §7 allowlist, as lightness values on a zero-saturation scale. */
const LIGHT_L = new Set(["100", "0", "96.1", "42", "94.1", "89.8"]);
const DARK_L = new Set(["0", "100", "4.3", "7.8", "63.1", "10.2", "14.9"]);

/** Tokens that are content or semantics, not chrome. Everything else must be grey. */
const CHART = /^--chart-\d$/;
const STATUS = new Set([
  "--destructive",
  "--destructive-foreground",
  "--warning",
  "--success",
]);
const NON_COLOUR = new Set(["--radius"]);

/** Exact status values, both modes. A drift here is a real design change. */
const STATUS_HEX: Record<"light" | "dark", Record<string, string>> = {
  light: {
    "--destructive": "#dc2626",
    "--destructive-foreground": "#ffffff",
    "--warning": "#b45309",
    "--success": "#15803d",
  },
  dark: {
    "--destructive": "#f87171",
    "--destructive-foreground": "#000000",
    "--warning": "#fbbf24",
    "--success": "#4ade80",
  },
};

// ---------------------------------------------------------------- colour maths

type Rgb = [number, number, number];

function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const seg = Math.floor(h / 60) % 6;
  const [r, g, b] = (
    [
      [c, x, 0],
      [x, c, 0],
      [0, c, x],
      [0, x, c],
      [x, 0, c],
      [c, 0, x],
    ] as Rgb[]
  )[seg];
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

function parseTriple(
  v: string,
): { h: number; s: number; l: number; lRaw: string } | null {
  const m = v.trim().match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
  if (!m) return null;
  // lRaw is the lightness EXACTLY as authored. Round-tripping it through a
  // number and back turns "14.9" into "14.899999999999999", which then fails an
  // allowlist that literally contains 14.9 — a false failure worth avoiding.
  return {
    h: Number(m[1]),
    s: Number(m[2]) / 100,
    l: Number(m[3]) / 100,
    lRaw: m[3],
  };
}

function toHex(v: string): string {
  const t = parseTriple(v);
  if (!t) return "";
  const [r, g, b] = hslToRgb(t.h, t.s, t.l);
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/** WCAG 2.1 relative luminance + contrast ratio. */
function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((n) => {
    const c = n / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const ta = parseTriple(a);
  const tb = parseTriple(b);
  if (!ta || !tb) return 0;
  const la = luminance(hslToRgb(ta.h, ta.s, ta.l));
  const lb = luminance(hslToRgb(tb.h, tb.s, tb.l));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// ------------------------------------------------------------------ css parsing

const css = readFileSync(CSS, "utf8");

/** Pull one selector's declarations out of the stylesheet, by exact selector. */
function block(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`selector not found in globals.css: ${selector}`);
  const out: Record<string, string> = {};
  for (const line of m[2].split("\n")) {
    const d = line.replace(/\/\*.*?\*\//g, "").match(/^\s*(--[\w-]+)\s*:\s*([^;]+);/);
    if (d) out[d[1]] = d[2].trim();
  }
  return out;
}

const root = block(":root");
const dark = block(".dark");
const workspace = block(".workspace");
const darkWorkspace = block(".dark .workspace");

const MODES: Array<[string, Record<string, string>, Set<string>]> = [
  [":root", root, LIGHT_L],
  [".dark", dark, DARK_L],
  [".workspace", workspace, LIGHT_L],
  [".dark .workspace", darkWorkspace, DARK_L],
];

// ------------------------------------------------------------------------ tests

describe("palette", () => {
  for (const [name, tokens, allowed] of MODES) {
    test(`${name}: every chrome token is grey and on the allowlist`, () => {
      const offenders: string[] = [];
      for (const [token, value] of Object.entries(tokens)) {
        if (NON_COLOUR.has(token) || STATUS.has(token) || CHART.test(token)) continue;
        const t = parseTriple(value);
        if (!t) {
          offenders.push(`${token}: ${value} (not an HSL triple)`);
          continue;
        }
        if (t.s !== 0) offenders.push(`${token}: ${value} (saturation ${t.s * 100}%)`);
        if (!allowed.has(t.lRaw)) {
          offenders.push(`${token}: ${value} (lightness off-allowlist)`);
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  test("the two modes are true inversions at the extremes", () => {
    expect(root["--background"]).toBe("0 0% 100%");
    expect(root["--foreground"]).toBe("0 0% 0%");
    expect(dark["--background"]).toBe("0 0% 0%");
    expect(dark["--foreground"]).toBe("0 0% 100%");
  });

  test("brand is ink, not a hue", () => {
    for (const [name, tokens] of [
      ["light", root],
      ["dark", dark],
    ] as const) {
      for (const t of ["--brand", "--brand-ink", "--brand-foreground"]) {
        const v = parseTriple(tokens[t]);
        expect(`${name} ${t} saturation`).toBe(`${name} ${t} saturation`);
        expect(v?.s).toBe(0);
      }
    }
  });

  test("status colour is exactly the three agreed hues", () => {
    for (const [mode, tokens] of [
      ["light", root],
      ["dark", dark],
    ] as const) {
      for (const [token, hex] of Object.entries(STATUS_HEX[mode])) {
        expect(`${mode} ${token} = ${toHex(tokens[token])}`).toBe(
          `${mode} ${token} = ${hex}`,
        );
      }
    }
  });

  test("chart series keep their colour (content, not chrome)", () => {
    // The inverse assertion: if someone "helpfully" greyscales these, the charts
    // silently become unreadable, so guard the exception too.
    for (const tokens of [root, dark]) {
      for (let i = 1; i <= 5; i++) {
        const t = parseTriple(tokens[`--chart-${i}`]);
        expect(t?.s ?? 0).toBeGreaterThan(0.2);
      }
    }
  });
});

describe("contrast", () => {
  const PAIRS: Array<[string, string]> = [
    ["--foreground", "--background"],
    ["--card-foreground", "--card"],
    ["--popover-foreground", "--popover"],
    ["--primary-foreground", "--primary"],
    ["--secondary-foreground", "--secondary"],
    ["--accent-foreground", "--accent"],
    ["--brand-foreground", "--brand"],
    ["--muted-foreground", "--background"],
    ["--muted-foreground", "--muted"],
    ["--destructive-foreground", "--destructive"],
  ];

  for (const [name, tokens] of [
    ["light", root],
    ["dark", dark],
  ] as const) {
    for (const [fg, bg] of PAIRS) {
      test(`${name}: ${fg} on ${bg} >= 4.5:1`, () => {
        const ratio = contrast(tokens[fg], tokens[bg]);
        expect(`${fg}/${bg} = ${ratio.toFixed(2)}:1`).toBe(
          `${fg}/${bg} = ${ratio.toFixed(2)}:1`,
        );
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      });
    }

    // Status ink is read as text on the page background, so it carries the same
    // 4.5:1 bar as body copy — that is why light warning is #B45309 and not a
    // brighter amber.
    for (const t of ["--destructive", "--warning", "--success"]) {
      test(`${name}: ${t} as text on the page >= 4.5:1`, () => {
        expect(contrast(tokens[t], tokens["--background"])).toBeGreaterThanOrEqual(4.5);
      });
    }

    // Borders and focus rings are non-text UI: WCAG 1.4.11 asks 3:1. A 1px
    // border IS the separation now that shadows are gone, so this is load-bearing.
    test(`${name}: ring against the page >= 3:1`, () => {
      expect(contrast(tokens["--ring"] ?? root["--ring"], tokens["--background"]))
        .toBeGreaterThanOrEqual(3);
    });
  }
});

describe("no decorative effects", () => {
  test("globals.css has no gradient, backdrop-filter or glow", () => {
    const banned = [
      "linear-gradient",
      "radial-gradient",
      "conic-gradient",
      "backdrop-filter",
      "-webkit-backdrop-filter",
      "glow-orb",
    ];
    expect(banned.filter((b) => css.includes(b))).toEqual([]);
  });

  test("no component reintroduces gradients, glass or glow", () => {
    // Source-level half of the net. The runtime half is e2e/qa-monochrome.js,
    // which catches what a class name cannot express (inline styles, SVG defs,
    // pseudo-elements).
    const BANNED = [
      /\bbg-gradient-to-/,
      /\bbg-\[(?:linear|radial|conic)-gradient/,
      /\bbackdrop-blur\b/,
      /\bbackdrop-filter\b/,
      /\b(?:from|via|to)-\[#/,
      /\bglow-orb\b/,
      /\bshadow-(?:lg|xl|2xl)\b/,
      /\bhover:brightness-/,
    ];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === ".next") continue;
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) {
          walk(p);
          continue;
        }
        if (!/\.(tsx?|css)$/.test(entry)) continue;
        // This file names the patterns it bans; it would match itself.
        if (entry === "monochrome.test.ts") continue;
        // Strip comments first. Half this repo's comments EXPLAIN why glass and
        // gradients were removed, and a scanner that cannot tell prose from code
        // fails on its own documentation.
        const text = readFileSync(p, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");
        for (const re of BANNED) {
          const m = text.match(re);
          if (m) hits.push(`${p.slice(REPO.length + 1)}: ${m[0]}`);
        }
      }
    };
    for (const r of SOURCE_ROOTS) walk(r);
    expect(hits).toEqual([]);
  });
});
