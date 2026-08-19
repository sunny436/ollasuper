import type { ReactNode } from "react";

/**
 * Lazy shiki singleton with an LRU cache.
 *
 * shiki over prism/highlight.js because those return an HTML *string* and so
 * mandate dangerouslySetInnerHTML; codeToHast() returns a hast tree that goes
 * through hast-util-to-jsx-runtime into real React elements. No string ever
 * reaches the DOM.
 *
 * The async cost is fine because highlighting happens exactly ONCE, when a
 * fence closes — never per token. The whole engine is behind a dynamic import,
 * so /chat's first paint carries none of it.
 *
 * Languages are loaded ON DEMAND (hl.loadLanguage) the first time each one is
 * used, not all up front: a single grammar can be hundreds of KB (cpp is
 * ~530KB of source), so eager-loading the whole catalogue would defeat the
 * lazy-import. Any language shiki bundles is therefore supported, plus the
 * aliases below; anything unknown falls back to a plain <pre>.
 */

// Loaded on demand. `unknown` avoids importing shiki's types eagerly.
let highlighterPromise: Promise<unknown> | null = null;
// Grammar ids already registered on the singleton, so we call loadLanguage once.
const loaded = new Set<string>();
// Resolves once to shiki's bundled-language id map (for membership checks).
let bundledPromise: Promise<Record<string, unknown>> | null = null;

const CACHE_MAX = 60;
const cache = new Map<string, ReactNode>();

// The small set registered when the highlighter is created — the common ones,
// so the very first highlight needs no extra grammar fetch. Everything else is
// loaded lazily on first use.
const BASE_LANGS = [
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "json",
  "python",
  "bash",
  "sql",
  "html",
  "css",
  "yaml",
  "markdown",
  "rust",
  "go",
  "diff",
];

// Aliases shiki does not already resolve, or that map onto a near neighbour
// when there is no dedicated grammar (svg→xml, mysql→sql, gitignore→ini, …).
const ALIASES: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  py: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  rs: "rust",
  golang: "go",
  postgres: "sql",
  postgresql: "sql",
  psql: "sql",
  mysql: "sql",
  "c#": "csharp",
  cs: "csharp",
  kt: "kotlin",
  rb: "ruby",
  pl: "perl",
  assembly: "asm",
  ps: "powershell",
  ps1: "powershell",
  pwsh: "powershell",
  cmd: "batch",
  bat: "batch",
  dockerfile: "docker",
  svg: "xml",
  tsv: "csv",
  gitignore: "ini",
  env: "dotenv",
  dotenv: "dotenv",
  conf: "ini",
  makefile: "make",
  gql: "graphql",
  patch: "diff",
};

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

async function getBundled(): Promise<Record<string, unknown>> {
  if (!bundledPromise) {
    bundledPromise = import("shiki").then(
      // biome-ignore lint/suspicious/noExplicitAny: shiki types are loaded lazily
      (shiki) => (shiki as any).bundledLanguages as Record<string, unknown>,
    );
  }
  return bundledPromise;
}

/** Alias-resolve; returns null only for an empty/whitespace lang. */
function normaliseLang(lang?: string): string | null {
  if (!lang) return null;
  const l = lang.toLowerCase().trim();
  if (!l) return null;
  return ALIASES[l] ?? l;
}

async function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then((shiki) => {
      for (const l of BASE_LANGS) loaded.add(l);
      return shiki.createHighlighter({
        // Dual theme emitted as CSS variables, so a next-themes toggle flips
        // colours with zero re-highlighting (see .shiki span in globals.css).
        themes: ["github-light", "github-dark-default"],
        langs: BASE_LANGS,
      });
    });
  }
  return highlighterPromise;
}

/**
 * Returns highlighted React nodes, or null to keep the plain <pre> render.
 * Never throws and never logs — a shiki failure must not reach the console,
 * because every e2e script asserts zero console errors.
 */
export async function highlight(
  code: string,
  lang?: string,
): Promise<ReactNode | null> {
  const resolved = normaliseLang(lang);
  if (!resolved || !code) return null;

  const key = `${resolved}:${code.length}:${djb2(code)}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    // Refresh recency.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  try {
    const [hl, { toJsxRuntime }, runtime] = await Promise.all([
      getHighlighter(),
      import("hast-util-to-jsx-runtime"),
      import("react/jsx-runtime"),
    ]);

    // Register the grammar on first use. Unknown ids (no bundled grammar) fall
    // through to a plain <pre> rather than throwing.
    if (!loaded.has(resolved)) {
      const bundled = await getBundled();
      if (!(resolved in bundled)) return null;
      // biome-ignore lint/suspicious/noExplicitAny: shiki types are loaded lazily
      await (hl as any).loadLanguage(resolved);
      loaded.add(resolved);
    }

    // biome-ignore lint/suspicious/noExplicitAny: shiki types are loaded lazily
    const hast = (hl as any).codeToHast(code, {
      lang: resolved,
      themes: { light: "github-light", dark: "github-dark-default" },
      defaultColor: false,
      cssVariablePrefix: "--s-",
    });

    const nodes = toJsxRuntime(hast, {
      // biome-ignore lint/suspicious/noExplicitAny: jsx-runtime shape
      Fragment: (runtime as any).Fragment,
      // biome-ignore lint/suspicious/noExplicitAny: jsx-runtime shape
      jsx: (runtime as any).jsx,
      // biome-ignore lint/suspicious/noExplicitAny: jsx-runtime shape
      jsxs: (runtime as any).jsxs,
    }) as ReactNode;

    cache.set(key, nodes);
    if (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return nodes;
  } catch {
    return null;
  }
}
