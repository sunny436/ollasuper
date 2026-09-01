/**
 * Model-authored markdown → email-safe HTML, for scheduled report emails.
 *
 * WHY NOT THE CHAT RENDERER. Chat renders with react-markdown + remark-gfm.
 * Those are React components and browser CSS; an email needs a string of
 * table-based HTML with inline styles. Nothing there is reusable, so this is
 * the smallest correct renderer for the subset a report actually contains.
 *
 * THE SECURITY INVARIANT — read this before changing anything:
 *
 *   Every text node is emitted through `esc()`.
 *   Every href is emitted through `safeUrl()` FIRST, then `esc()` for the
 *   attribute context.
 *
 * That is deliberately NOT the "escape the whole document, then look for block
 * shapes in the escaped text" trick the old report renderer used. That trick
 * works only while the markers are characters `esc` leaves alone (`#`, `-`).
 * It CORRUPTS the moment a URL is involved: escaping first turns
 * `https://x.com?a=1&b=2` into `…?a=1&amp;b=2`, and the href extracted from it
 * points somewhere else. So the structure is parsed on the RAW text and every
 * leaf is escaped at the moment it is emitted.
 *
 * Raw HTML in the source is never parsed as markup — it falls through to a text
 * node and is escaped — which is the same "safe by construction" stance that
 * keeps `rehype-raw` out of the chat renderer.
 */

import { esc } from "./emailTemplates";
import { safeUrl } from "./urlGuard";

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const MONO = "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace";
const TEXT = "#12141A";
const TEXT_SOFT = "#33384A";
const BORDER = "#E6E8EF";
const CODE_BG = "#F7F9FC";
const BRAND = "#4F8BF0";

/** Long code, long URLs and wide cells cannot scroll in a mail client. */
const WRAP = "word-break:break-word;overflow-wrap:anywhere;";
const P = `margin:0 0 14px;font-family:${FONT};font-size:15px;line-height:23px;color:${TEXT_SOFT};${WRAP}`;
const LI = `margin:0 0 6px;font-family:${FONT};font-size:15px;line-height:23px;color:${TEXT_SOFT};${WRAP}`;

const H_SIZE: Record<number, string> = {
  1: "font-size:21px;line-height:28px;margin:26px 0 12px;",
  2: "font-size:18px;line-height:25px;margin:24px 0 10px;",
  3: "font-size:16px;line-height:23px;margin:20px 0 8px;",
  4: "font-size:15px;line-height:22px;margin:18px 0 8px;",
  5: "font-size:14px;line-height:21px;margin:16px 0 6px;",
  6: "font-size:13px;line-height:20px;margin:16px 0 6px;",
};

/** Bounds recursion through nested emphasis / link text. */
const MAX_INLINE_DEPTH = 6;

/**
 * Inline markdown, parsed on RAW text and escaped at emit.
 *
 * Order is load-bearing: code spans win first, so `**` inside a code span stays
 * literal, exactly as it does in the chat renderer.
 */
function inline(raw: string, depth = 0): string {
  if (depth > MAX_INLINE_DEPTH) return esc(raw);
  const out: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf) {
      out.push(esc(buf));
      buf = "";
    }
  };

  let i = 0;
  while (i < raw.length) {
    const rest = raw.slice(i);

    const code = /^(`+)(\s*[\s\S]*?\s*)\1(?!`)/.exec(rest);
    if (code?.[2]) {
      flush();
      out.push(
        `<code style="font-family:${MONO};font-size:13px;background:${CODE_BG};border:1px solid ${BORDER};border-radius:4px;padding:1px 5px;${WRAP}">${esc(code[2].trim())}</code>`,
      );
      i += code[0].length;
      continue;
    }

    // The URL may itself contain balanced parentheses — Wikipedia links do, and
    // so does `javascript:alert(1)`. Matching `[^)]+` would stop at the first
    // one, truncating a real URL and leaving a stray ")" in the prose.
    const link =
      /^\[([^\]]*)\]\(\s*((?:[^()\s]|\((?:[^()\s])*\))+)(?:\s+"[^"]*")?\s*\)/.exec(
        rest,
      );
    if (link) {
      flush();
      // safeUrl on the RAW value, THEN esc for the attribute. Reversing these
      // is the corruption described at the top of this file.
      const href = safeUrl(link[2] ?? "");
      const label = inline(link[1] ?? "", depth + 1);
      // An unsafe href loses the LINK, never the TEXT — dropping the whole
      // thing would silently delete report content.
      out.push(
        href
          ? `<a href="${esc(href)}" style="color:${BRAND};text-decoration:underline;${WRAP}">${label}</a>`
          : label,
      );
      i += link[0].length;
      continue;
    }

    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (strong?.[2]) {
      flush();
      out.push(
        `<strong style="color:${TEXT};font-weight:600;">${inline(strong[2], depth + 1)}</strong>`,
      );
      i += strong[0].length;
      continue;
    }

    const em = /^([*_])(?=\S)([^*_]*?\S)\1/.exec(rest);
    if (em?.[2]) {
      flush();
      out.push(`<em>${inline(em[2], depth + 1)}</em>`);
      i += em[0].length;
      continue;
    }

    buf += raw[i];
    i += 1;
  }
  flush();
  return out.join("");
}

const isFence = (l: string) => /^\s{0,3}(```|~~~)/.test(l);
const isHr = (l: string) => /^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(l);
const isTableSep = (l: string) =>
  /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(l) && l.includes("-");

function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split("|").map((c) => c.trim());
}

/**
 * A GFM table as a real HTML table.
 *
 * Explicit borders and cellpadding because Outlook's Word engine ignores CSS
 * border shorthand on `td`. It cannot scroll, so cells wrap instead — a wide
 * table squeezes rather than overflowing the card.
 */
function renderTable(header: string[], rows: string[][]): string {
  const th = header
    .map(
      (c) =>
        `<th align="left" style="font-family:${FONT};font-size:13px;font-weight:600;color:${TEXT};border:1px solid ${BORDER};padding:8px 10px;background:${CODE_BG};${WRAP}">${inline(c)}</th>`,
    )
    .join("");
  const body = rows
    .map(
      (r) =>
        `<tr>${header
          .map(
            (_, idx) =>
              `<td style="font-family:${FONT};font-size:13px;line-height:20px;color:${TEXT_SOFT};border:1px solid ${BORDER};padding:8px 10px;${WRAP}">${inline(r[idx] ?? "")}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;width:100%;margin:0 0 16px;"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderCode(body: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px;"><tr><td style="background:${CODE_BG};border:1px solid ${BORDER};border-radius:8px;padding:12px 14px;"><pre style="margin:0;font-family:${MONO};font-size:13px;line-height:20px;color:${TEXT};white-space:pre-wrap;${WRAP}">${esc(body)}</pre></td></tr></table>`;
}

/** One rendered top-level block, so truncation can cut between them. */
function toBlocks(markdown: string): string[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // FENCED CODE — consumed verbatim. Nothing inside is parsed, so a `#` or a
    // `|` in a code sample cannot become a heading or a table.
    if (isFence(line)) {
      const marker = line.trim().slice(0, 3);
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith(marker)) {
        buf.push(lines[i] ?? "");
        i += 1;
      }
      i += 1; // closing fence (or EOF)
      blocks.push(renderCode(buf.join("\n")));
      continue;
    }

    if (isHr(line)) {
      blocks.push(
        `<hr style="border:0;border-top:1px solid ${BORDER};margin:22px 0;">`,
      );
      i += 1;
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = (heading[1] ?? "#").length;
      blocks.push(
        `<h${level} style="font-family:${FONT};font-weight:700;color:${TEXT};${H_SIZE[level]}${WRAP}">${inline(heading[2] ?? "")}</h${level}>`,
      );
      i += 1;
      continue;
    }

    // TABLE — header row plus a separator row.
    if (line.includes("|") && isTableSep(lines[i + 1] ?? "")) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim()) {
        rows.push(splitRow(lines[i] ?? ""));
        i += 1;
      }
      blocks.push(renderTable(header, rows));
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i] ?? "")) {
        buf.push((lines[i] ?? "").replace(/^\s{0,3}>\s?/, ""));
        i += 1;
      }
      blocks.push(
        `<blockquote style="margin:0 0 16px;padding:2px 0 2px 14px;border-left:3px solid ${BORDER};"><p style="${P}margin:0;">${inline(buf.join(" "))}</p></blockquote>`,
      );
      continue;
    }

    const listItem = (l: string) =>
      /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(l);
    const first = listItem(line);
    if (first) {
      const ordered = /\d/.test(first[2] ?? "");
      // A report continuing "4." must not silently renumber to 1.
      const start = ordered ? Number.parseInt(first[2] ?? "1", 10) : 1;
      const items: { depth: number; text: string }[] = [];
      while (i < lines.length) {
        const m = listItem(lines[i] ?? "");
        if (!m) break;
        const isOrdered = /\d/.test(m[2] ?? "");
        if (isOrdered !== ordered) break;
        // One level of nesting; deeper indentation clamps rather than growing
        // the state machine.
        items.push({
          depth: Math.min(1, Math.floor((m[1] ?? "").length / 2)),
          text: m[3] ?? "",
        });
        i += 1;
      }
      const tag = ordered ? "ol" : "ul";
      const attr = ordered && start !== 1 ? ` start="${start}"` : "";
      const style = "margin:0 0 16px;padding-left:22px;";
      const html: string[] = [`<${tag}${attr} style="${style}">`];
      // A nested list belongs INSIDE the preceding <li>, not beside it. A <ul>
      // as a direct child of <ul> is invalid, and Outlook's Word engine is the
      // one client likely to render that as a stray extra bullet, so the
      // parent item is held open until the nested list closes.
      let nested = false;
      let openItem = false;
      const closeItem = () => {
        if (openItem) {
          html.push("</li>");
          openItem = false;
        }
      };
      for (const it of items) {
        if (it.depth === 1) {
          if (!nested) {
            html.push(`<${tag} style="margin:6px 0 6px;padding-left:20px;">`);
            nested = true;
          }
          html.push(`<li style="${LI}">${inline(it.text)}</li>`);
          continue;
        }
        if (nested) {
          html.push(`</${tag}>`);
          nested = false;
        }
        closeItem();
        html.push(`<li style="${LI}">${inline(it.text)}`);
        openItem = true;
      }
      if (nested) html.push(`</${tag}>`);
      closeItem();
      html.push(`</${tag}>`);
      blocks.push(html.join(""));
      continue;
    }

    // PARAGRAPH — consecutive non-blank lines. Single newlines become <br>,
    // matching remark-breaks in the chat renderer.
    const buf: string[] = [];
    while (i < lines.length) {
      const l = lines[i] ?? "";
      if (
        !l.trim() ||
        isFence(l) ||
        isHr(l) ||
        /^\s{0,3}#{1,6}\s/.test(l) ||
        /^\s{0,3}>/.test(l) ||
        listItem(l) ||
        (l.includes("|") && isTableSep(lines[i + 1] ?? ""))
      ) {
        break;
      }
      buf.push(l);
      i += 1;
    }
    blocks.push(`<p style="${P}">${buf.map((l) => inline(l)).join("<br>")}</p>`);
  }

  return blocks;
}

export type RenderedReport = { html: string; clipped: boolean };

/**
 * Render a report, bounded so the message cannot be clipped by the client.
 *
 * Gmail cuts a message near 102KB and hides everything after the cut with no
 * indication of what was lost. The budget is well under that because quoting,
 * headers and the surrounding shell all count toward the same limit.
 *
 * Cutting happens BETWEEN blocks, never inside a table or a code fence, and the
 * caller is told so it can say plainly that the report continues. Silent
 * truncation of someone's report is the thing to avoid.
 */
export function renderReportHtml(
  markdown: string,
  maxBytes = 60_000,
): RenderedReport {
  const blocks = toBlocks(markdown);
  const kept: string[] = [];
  let size = 0;
  let clipped = false;

  for (const blk of blocks) {
    // +1 for the newline join() will insert. Counting only the blocks
    // separators push the result past the budget it exists to enforce.
    const bytes = Buffer.byteLength(blk, "utf8") + (kept.length ? 1 : 0);
    if (size + bytes > maxBytes && kept.length > 0) {
      clipped = true;
      break;
    }
    kept.push(blk);
    size += bytes;
  }

  return { html: kept.join("\n"), clipped };
}
