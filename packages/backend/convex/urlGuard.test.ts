import { describe, expect, test } from "vitest";
import { normalise, safeUrl } from "./urlGuard";

/**
 * The URL allowlist, which had NO tests while it lived in the app despite being
 * the only thing standing between model output and a `javascript:` href.
 *
 * Control characters are built with String.fromCharCode rather than escape
 * sequences, so no test fixture can be silently turned into a literal control
 * byte in the source — which is invisible in a diff and would quietly stop
 * testing the bypass it is named after.
 */

const NUL = String.fromCharCode(0);
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const DEL = String.fromCharCode(127);

describe("safe protocols pass through unchanged", () => {
  test.each([
    "https://example.com",
    "http://example.com/path",
    "mailto:someone@example.com",
    "https://example.com/a?b=1&c=2#frag",
  ])("%s", (url) => {
    expect(safeUrl(url)).toBe(url);
  });

  /** The report renderer relies on this: an ampersand must survive intact. */
  test("query strings are not mangled", () => {
    const u = "https://x.test/search?a=1&b=2&utm=z";
    expect(safeUrl(u)).toBe(u);
    expect(safeUrl(u)).toContain("&b=2");
  });

  test("relative URLs resolve safely and are returned as given", () => {
    expect(safeUrl("/docs/page")).toBe("/docs/page");
  });
});

describe("dangerous protocols are refused", () => {
  test.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "file:///etc/passwd",
  ])("%s is dropped", (url) => {
    expect(safeUrl(url)).toBe("");
  });
});

describe("the control-character bypass this guard exists for", () => {
  /**
   * A NUL inside the scheme makes `new URL` treat the whole string as a
   * relative path, so a guard that checks the PARSED protocol but returns the
   * ORIGINAL string emits href="javascript<NUL>:alert(1)" — which a browser may
   * strip back to javascript:. Normalising BEFORE parsing is what closes it.
   */
  test.each([
    ["NUL", NUL],
    ["tab", TAB],
    ["newline", LF],
    ["carriage return", CR],
    ["DEL", DEL],
  ])("javascript: with an embedded %s is still refused", (_name, ch) => {
    expect(safeUrl(`javascript${ch}:alert(1)`)).toBe("");
  });

  test("the returned string is the normalised one, never the caller's original", () => {
    // If this ever returns the input verbatim, the bypass above is live again.
    const sneaky = `https://example.com/${NUL}path`;
    expect(safeUrl(sneaky)).not.toContain(NUL);
  });

  test("normalise strips control characters and trims", () => {
    expect(normalise(`  https://x.test${TAB}  `)).toBe("https://x.test");
    expect(normalise(`a${NUL}b${DEL}c`)).toBe("abc");
  });
});

describe("degenerate input", () => {
  test.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["control characters only", NUL + TAB],
  ])("%s yields no URL", (_name, url) => {
    expect(safeUrl(url)).toBe("");
  });

  test("an unparseable URL yields no URL rather than throwing", () => {
    expect(safeUrl("http://[")).toBe("");
  });
});
