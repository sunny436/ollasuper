/**
 * Poppins is the app's one UI face, asserted against the files that decide it.
 *
 * There is no per-component font work in this codebase — Tailwind preflight puts
 * `theme(fontFamily.sans)` on <html> and `font-family: inherit` on every form
 * control, so ONE config entry is the whole app. That is also the risk: a
 * `font-mono` on a heading, a `fontFamily:` in a library option, a stray
 * `system-ui` in a canvas call all silently opt a surface back out, and nothing
 * at runtime says so. This test names every site that is allowed to name a
 * font, with its count; anything new fails with its path.
 *
 * It is deliberately a SOURCE test. `e2e/qa-font.js` is the other half and is not
 * redundant: only a real browser can read the platform font a glyph was drawn
 * with, see Sonner's runtime stylesheet, or check a canvas.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..");
const LAYOUT = join(REPO, "apps", "app", "src", "app", "[locale]", "layout.tsx");
const TAILWIND = join(REPO, "packages", "ui", "tailwind.config.ts");
const CSS = join(REPO, "packages", "ui", "src", "globals.css");
const CHART = join(
  REPO,
  "apps",
  "app",
  "src",
  "app",
  "[locale]",
  "(workspace)",
  "chat",
  "_components",
  "chart-block.tsx",
);
const SOURCE_ROOTS = [
  join(REPO, "apps", "app", "src"),
  join(REPO, "packages", "ui", "src"),
  TAILWIND,
];

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * Every token that names a font or a font stack. `sans-serif` is not here: it
 * is the intended generic fallback, not a face.
 */
const FONT_TOKEN =
  /\bfont-mono\b|\bfont-geist-mono\b|\bfontFamily\b|font-family|Jakarta|\bInter\b|\bArial\b|\bHelvetica\b|\bRoboto\b|system-ui|ui-sans-serif|ui-monospace|\bmonospace\b/g;

/**
 * The allowlist. Each entry is a file that may name a font, and exactly how
 * many times. The reasons are the design, not decoration:
 *  - code / diagram / chart bodies and their SOURCE fallbacks are monospace;
 *  - OAuth scope strings and capability ids are identifiers, shown as such;
 *  - mermaid and Chart.js are handed the inherited stack because neither
 *    reads CSS on its own (a canvas has no cascade at all);
 *  - the perf probe is a dev-only canvas overlay behind `?perf=1`;
 *  - globals.css carries the ONE rule that overrides Sonner's injected font;
 *  - the tailwind config defines the stacks themselves.
 */
const ALLOWED: Record<string, Record<string, number>> = {
  "apps/app/src/app/[locale]/(public)/slack/page.tsx": { "font-mono": 1 },
  "apps/app/src/app/[locale]/(settings)/settings/skills/_components/capability-picker.tsx":
    { "font-mono": 1 },
  "apps/app/src/app/[locale]/(workspace)/chat/_components/chart-block.tsx": {
    fontFamily: 1,
    "font-geist-mono": 1,
  },
  "apps/app/src/app/[locale]/(workspace)/chat/_components/code-block.tsx": {
    "font-geist-mono": 1,
  },
  "apps/app/src/app/[locale]/(workspace)/chat/_components/markdown.tsx": {
    "font-geist-mono": 2,
  },
  "apps/app/src/app/[locale]/(workspace)/chat/_components/mermaid.tsx": {
    fontFamily: 1,
    "font-geist-mono": 1,
  },
  "apps/app/src/lib/perf-probe/probe.ts": { "system-ui": 1, monospace: 1 },
  "packages/ui/src/globals.css": { "font-family": 1 },
  "packages/ui/tailwind.config.ts": {
    fontFamily: 1,
    "font-geist-mono": 1,
    "ui-monospace": 1,
    monospace: 1,
  },
};

function scan(): Record<string, Record<string, number>> {
  const found: Record<string, Record<string, number>> = {};
  const visit = (p: string) => {
    if (statSync(p).isDirectory()) {
      for (const entry of readdirSync(p)) {
        if (entry === "node_modules" || entry === ".next") continue;
        visit(join(p, entry));
      }
      return;
    }
    if (!/\.(tsx?|css)$/.test(p)) return;
    // This file names the tokens it polices; it would match itself.
    if (p.endsWith("font.test.ts")) return;
    const hits = stripComments(readFileSync(p, "utf8")).match(FONT_TOKEN);
    if (!hits) return;
    const rel = p.slice(REPO.length + 1).split("\\").join("/");
    found[rel] = {};
    for (const h of hits) found[rel][h] = (found[rel][h] ?? 0) + 1;
  };
  for (const r of SOURCE_ROOTS) visit(r);
  return found;
}

/** The argument object of a `Poppins({ ... })` call, by its `variable` name. */
function fontCall(src: string, variable: string): string {
  const at = src.indexOf(`variable: "${variable}"`);
  expect(at).toBeGreaterThan(0);
  const start = src.lastIndexOf("Poppins({", at);
  const end = src.indexOf("});", at);
  expect(start).toBeGreaterThan(0);
  return src.slice(start, end);
}

const list = (call: string, key: string): string[] => {
  const m = call.match(new RegExp(`${key}: \\[([^\\]]*)\\]`));
  expect(m).not.toBeNull();
  return (m as RegExpMatchArray)[1].match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)) ?? [];
};

describe("loading — app/[locale]/layout.tsx", () => {
  const src = stripComments(readFileSync(LAYOUT, "utf8"));

  test("the old face is gone", () => {
    expect(src).not.toMatch(/Jakarta/);
    expect(src).not.toMatch(/--font-plus-jakarta-sans/);
  });

  test("the Latin face loads exactly the weights the source uses, upright and italic", () => {
    const call = fontCall(src, "--font-poppins");
    expect(list(call, "subsets")).toEqual(["latin"]);
    expect(list(call, "weight")).toEqual(["400", "500", "600", "700", "800"]);
    expect(list(call, "style")).toEqual(["normal", "italic"]);
    expect(call).toMatch(/display: "swap"/);
    expect(call).not.toMatch(/preload: false/);
  });

  test("ONE Poppins() call — a second re-declares the same faces at duplicate URLs", () => {
    // `subsets` only decides what is preloaded; every subset Google ships
    // (Devanagari, Latin-Extended) is declared by this one call behind a
    // unicode-range. A second call was tried and produced four duplicate latin
    // @font-face rules at un-preloaded URLs — see the layout comment.
    expect(src.match(/Poppins\(\{/g)?.length).toBe(1);
    expect(src).not.toMatch(/preload: false/);
  });

  test("the variable sits on <html>, where preflight reads it", () => {
    const open = src.indexOf("<html");
    const html = src.slice(open, src.indexOf(">", open));
    expect(html).toMatch(/className=\{poppins\.variable\}/);
  });
});

describe("the global switch — packages/ui/tailwind.config.ts", () => {
  const src = stripComments(readFileSync(TAILWIND, "utf8"));
  const stack = (key: string) => list(src, key);

  test("sans is Poppins then the generic fallback — nothing else", () => {
    expect(stack("sans")).toEqual(["var(--font-poppins)", "sans-serif"]);
  });

  test("brand is the same face; the wordmark keeps its class", () => {
    expect(stack("brand")).toEqual(["var(--font-poppins)", "sans-serif"]);
  });

  test("the mono stack is untouched", () => {
    expect(stack('"geist-mono"')).toEqual([
      "var(--font-geist-mono)",
      "ui-monospace",
      "SFMono-Regular",
      "monospace",
    ]);
  });
});

describe("the renderers that cannot inherit", () => {
  test("Sonner's injected font is overridden OUTSIDE every @layer, one specificity step up", () => {
    const css = stripComments(readFileSync(CSS, "utf8"));
    const at = css.indexOf("html [data-sonner-toaster]");
    expect(at).toBeGreaterThan(0);
    // Brace-track from the top: at the rule's position no @layer block may be open.
    let depth = 0;
    let layerDepth = -1;
    for (let i = 0; i < at; i++) {
      if (css.startsWith("@layer", i) && layerDepth < 0) layerDepth = depth;
      if (css[i] === "{") depth++;
      if (css[i] === "}") {
        depth--;
        if (layerDepth === depth) layerDepth = -1;
      }
    }
    expect(layerDepth).toBe(-1);
    expect(depth).toBe(0);
    const rule = css.slice(at, css.indexOf("}", at));
    expect(rule).toMatch(/font-family:\s*inherit/);
  });

  test('Chart.js is handed the resolved stack, not the word "inherit"', () => {
    const src = stripComments(readFileSync(CHART, "utf8"));
    expect(src).toMatch(
      /Chart\.defaults\.font\.family = getComputedStyle\(document\.documentElement\)\.fontFamily/,
    );
    expect(src).not.toMatch(/font\.family = "inherit"/);
  });
});

describe("the monospace allowlist", () => {
  const found = scan();

  test("every site that names a font is on the list, at exactly its count", () => {
    expect(found).toEqual(ALLOWED);
  });

  test("the list is not vacuous — the code surfaces are still monospace", () => {
    const files = Object.keys(found);
    expect(files.some((f) => f.endsWith("code-block.tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith("markdown.tsx"))).toBe(true);
    expect(Object.values(found).reduce((n, m) => n + (m["font-geist-mono"] ?? 0), 0)).toBe(6);
  });

  test("no heading, label or button reaches for the system mono stack", () => {
    // `font-mono` survives on exactly two identifier surfaces; a third is a regression.
    expect(Object.values(found).reduce((n, m) => n + (m["font-mono"] ?? 0), 0)).toBe(2);
  });
});
