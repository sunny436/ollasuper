/**
 * The branding system, asserted at the source level.
 *
 * Two failure modes this exists for, neither of which produces a runtime error:
 *  1. the favicon and the component drift apart, so the tab shows a different
 *     mark from the app;
 *  2. a raster brand asset creeps back in — which is how the previous identity
 *     ended up shipping a 1.6 MB PNG to render a 26px icon.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { OLLA_MARK_PATH, OLLA_MARK_VIEWBOX } from "./olla-super-logo";

const APP = join(import.meta.dir, "..", "..", "..");
const SRC = join(APP, "src");
const ICON = join(SRC, "app", "icon.svg");
const SOURCE = join(import.meta.dir, "olla-super-mark.source.svg");

/** The `d` of the single path in an SVG file. */
function pathData(file: string): string {
  const m = readFileSync(file, "utf8").match(/<path[^>]*\sd="([^"]*)"/s);
  if (!m) throw new Error(`no <path d="..."> in ${file}`);
  return m[1].trim();
}

describe("the mark matches the supplied artwork", () => {
  // olla-super-mark.source.svg is the artwork of record, committed unmodified.
  // Nothing imports it; it exists so "matches the logo exactly" is a thing the
  // suite can CHECK rather than something a commit message claims.
  const source = pathData(SOURCE);

  test("the component carries the source geometry, character for character", () => {
    expect(OLLA_MARK_PATH).toBe(source);
  });

  test("the favicon carries it too", () => {
    expect(pathData(ICON)).toBe(source);
  });

  test("the viewBox is the source viewBox, unscaled", () => {
    const vb = readFileSync(SOURCE, "utf8").match(/viewBox="([^"]*)"/);
    expect(OLLA_MARK_VIEWBOX).toBe(vb?.[1]);
  });
});

describe("the mark", () => {
  test("is vector geometry, not an embedded image", () => {
    // Move/line/cubic/close only. Anything else in here means someone pasted
    // markup rather than path data.
    expect(OLLA_MARK_PATH).toMatch(/^M[\d.\-\s MLCZ]+Z$/);
    expect(OLLA_MARK_PATH).not.toContain("base64");
    expect(OLLA_MARK_PATH.length).toBeGreaterThan(2000);
  });

  test("is the supplied artwork, unscaled", () => {
    // Six subpaths and the source viewBox, exactly as delivered. A redraw or a
    // "tidy up" rescale to a rounder viewBox would change both, and both trade
    // fidelity for neatness — which is how the wrong mark shipped once already.
    expect(OLLA_MARK_PATH.split("M").length - 1).toBe(6);
    expect(OLLA_MARK_VIEWBOX).toBe("0 0 1095 1095");
  });

  test("the component paints with currentColor and nothing else", () => {
    const src = readFileSync(join(import.meta.dir, "olla-super-logo.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).toContain('fill="currentColor"');
    for (const banned of ["<image", "base64", "url(", "linearGradient", "filter="]) {
      expect(src).not.toContain(banned);
    }
    // No literal colour may be baked into the artwork — the source arrived with
    // fill="#020201" and stroke="#020201", and both had to become currentColor
    // or the mark would be invisible in dark mode.
    expect(src.match(/(?:fill|stroke)="#[0-9a-fA-F]{3,8}"/)).toBeNull();
    expect(src).toContain('stroke="currentColor"');
  });
});

describe("icon.svg", () => {
  const raw = readFileSync(ICON, "utf8");
  // The file EXPLAINS why it cannot use currentColor, so a naive scan finds the
  // word in the prose and fails on the documentation. Strip comments first.
  const svg = raw.replace(/<!--[\s\S]*?-->/g, "");

  test("carries EXACTLY the component's geometry", () => {
    // The one source of truth, enforced. A favicon cannot import React, so the
    // path is duplicated by necessity — this is what stops it drifting.
    expect(svg).toContain(OLLA_MARK_PATH);
    expect(svg).toContain(`viewBox="${OLLA_MARK_VIEWBOX}"`);
  });

  test("keeps the seam-closing hairline the source relies on", () => {
    // The artwork is six subpaths that abut; without a stroke matching the fill,
    // antialiasing leaves visible background hairlines along the joins.
    expect(svg).toContain("stroke-width=\"0.25\"");
  });

  test("resolves its own colour in both themes", () => {
    // currentColor is WRONG here: a favicon renders outside any document, so it
    // would fall back to black and vanish in dark browser chrome.
    expect(svg).not.toContain("currentColor");
    expect(svg).toContain("#000000");
    expect(svg).toContain("#FFFFFF");
    expect(svg).toContain("prefers-color-scheme: dark");
  });

  test("has no baked background and no raster", () => {
    expect(svg).not.toContain("<image");
    expect(svg).not.toContain("base64");
    expect(svg).not.toMatch(/<rect[^>]*fill/);
  });
});

describe("no raster brand assets", () => {
  test("public/ ships no brand image", () => {
    let entries: string[] = [];
    try {
      entries = readdirSync(join(APP, "public"));
    } catch {
      entries = []; // the directory is gone entirely, which is also correct
    }
    expect(entries.filter((e) => /\.(png|jpg|jpeg|webp|gif|ico)$/i.test(e))).toEqual([]);
  });

  test("no component references a raster brand file", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === ".next") continue;
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) {
          walk(p);
          continue;
        }
        if (!/\.tsx?$/.test(entry)) continue;
        // url-guard.test.ts uses "/logo.png" as a URL-parsing fixture, not an
        // asset; this file names the patterns it bans.
        if (entry === "url-guard.test.ts" || entry === "branding.test.ts") continue;
        const text = readFileSync(p, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");
        for (const re of [/["'][^"']*logo\.[a-z]+["']/, /\bBrandMark\b/, /brand-mark/]) {
          const m = text.match(re);
          if (m) hits.push(`${p.slice(SRC.length + 1)}: ${m[0]}`);
        }
      }
    };
    walk(SRC);
    expect(hits).toEqual([]);
  });
});

describe("the wordmark", () => {
  // Same reason as icon.svg above: the component documents that it does NOT use
  // innerWidth/useEffect, and a scan of the raw text would match that sentence.
  const brand = readFileSync(join(import.meta.dir, "olla-super-brand.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  test("is real DOM text in the brand face", () => {
    expect(brand).toContain(">\n        OllaSuper\n      </span>");
    expect(brand).toContain("font-brand");
    expect(brand).toContain("font-extrabold");
  });

  test("swaps responsively in CSS, never in JavaScript", () => {
    expect(brand).toContain("md:hidden");
    expect(brand).toContain("sr-only md:not-sr-only");
    for (const banned of ["innerWidth", "useEffect", "useState", "matchMedia"]) {
      expect(brand).not.toContain(banned);
    }
  });

  test("the mark is decorative, so the brand is announced once", () => {
    const logo = readFileSync(join(import.meta.dir, "olla-super-logo.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(logo).toContain('aria-hidden="true"');
    expect(brand).not.toContain("aria-label");
  });
});
