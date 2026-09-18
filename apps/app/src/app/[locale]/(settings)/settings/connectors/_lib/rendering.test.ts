import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * A MECHANICAL invariant over this feature's own source.
 *
 * WHY A TEST AND NOT A COMMENT. Every string this feature renders — connector
 * descriptions, tool names, resource descriptions, prompt text — is authored by
 * a third-party MCP server. §70/§73/§74/§75 all reduce to one rule: it is React
 * children, never HTML. The codebase already relies on that rule globally
 * (`rehype-raw` is deliberately not installed, so model output cannot be parsed
 * into nodes either), and CLAUDE.md records the `rg dangerouslySetInnerHTML`
 * invariant — but records it in prose, where a future component can quietly
 * break it and nothing goes red.
 *
 * So this walks the directory and asserts it, the same way the Phase 4 vault
 * contract test parses `convex/http.ts` rather than trusting a comment.
 *
 * IT IS SCOPED TO THIS FEATURE on purpose. `mermaid.tsx` and the pre-paint
 * theme script are audited exceptions elsewhere, and widening this to the whole
 * app would either fail on them or need an allowlist that the next person would
 * add to.
 */

const ROOT = join(import.meta.dir, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

/** Comments explain the rule; only CODE can break it. Stripping them is what
 *  lets this file's own sibling modules document the invariant in prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("the connectors feature renders untrusted text as text", () => {
  const files = sourceFiles(ROOT);

  test("the directory is actually being scanned", () => {
    // Without this, a broken path would make every assertion below vacuously
    // true — the failure mode that makes an invariant test worthless.
    expect(files.length).toBeGreaterThan(8);
    expect(files.some((f) => f.endsWith("page.tsx"))).toBe(true);
  });

  test("no dangerouslySetInnerHTML anywhere in the feature", () => {
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      expect({ file, has: code.includes("dangerouslySetInnerHTML") }).toEqual({
        file,
        has: false,
      });
    }
  });

  test("no markdown renderer is applied to connector metadata", () => {
    // The app's markdown renderer is safe, but it is built for MODEL output.
    // Pointing it at a new untrusted source would extend its blast radius for a
    // cosmetic gain — resource bodies and prompt messages go in a <pre>.
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      expect({ file, has: /react-markdown|rehype-raw|<Markdown/.test(code) }).toEqual({
        file,
        has: false,
      });
    }
  });

  test("no raw innerHTML or document.write either", () => {
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      expect({ file, has: /\.innerHTML\s*=|document\.write/.test(code) }).toEqual({
        file,
        has: false,
      });
    }
  });

  test("no MCP token or credential field is read anywhere in the frontend", () => {
    // §62/§97: the browser must never receive or store one. There is no such
    // field in any DTO, and this asserts that no component invented a path to
    // one — including through localStorage, which §97 forbids for MCP.
    const FORBIDDEN = [
      "access_token",
      "refresh_token",
      "accessToken",
      "refreshToken",
      "client_secret",
      "clientSecret",
      "envelope",
      "keyVersion",
      "localStorage",
      "sessionStorage",
    ];
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const needle of FORBIDDEN) {
        expect({ file, needle, has: code.includes(needle) }).toEqual({
          file,
          needle,
          has: false,
        });
      }
    }
  });

  test("no gateway address or docker vocabulary reaches the UI", () => {
    // §96/§34: the browser never talks to the gateway, and a normal user is
    // never shown container terminology. "Runs locally" is the whole of it.
    const FORBIDDEN = ["8811", "docker", "Docker", "stdio", "127.0.0.1"];
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const needle of FORBIDDEN) {
        expect({ file, needle, has: code.includes(needle) }).toEqual({
          file,
          needle,
          has: false,
        });
      }
    }
  });
});
