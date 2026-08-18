/**
 * Incremental markdown block splitter.
 *
 * Handing a growing string to one <ReactMarkdown> re-parses O(n) text and
 * reconciles the whole subtree on every token. Splitting into blocks means
 * every block but the last is frozen forever, so React.memo can skip them and
 * exactly one block re-renders per tick regardless of transcript length.
 *
 * This is a line scanner, not a markdown parser. It only needs to know where
 * blocks begin and end, and — critically — to stabilise the two constructs
 * that visibly snap while streaming:
 *
 *   1. An opening ``` renders as a paragraph of literal backticks until the
 *      closing fence arrives, then snaps into a full-width dark <pre>. Fix:
 *      detect the open fence and SYNTHESISE the closing one, so the <pre>
 *      exists from the first token and only ever grows downward.
 *
 *   2. A table header renders as a paragraph until the |---| delimiter row
 *      lands, then reflows into a <table> with entirely different column
 *      widths. Fix: emit it as "table-pending" so it can be rendered with
 *      identical line metrics until the delimiter row completes.
 *
 * Unbalanced ** and _ are left alone: inline emphasis toggling does not change
 * block geometry, so it costs nothing visually.
 */

export type BlockKind = "text" | "code" | "table-pending";

export interface Block {
  source: string;
  complete: boolean;
  kind: BlockKind;
  lang?: string;
}

const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const TABLE_DELIM = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

function isTableRow(line: string): boolean {
  return line.trimStart().startsWith("|");
}

export function splitBlocks(src: string, streaming: boolean): Block[] {
  if (!src) return [];
  const lines = src.split("\n");
  const blocks: Block[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Blank lines between blocks.
    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[2] ?? "```";
      const lang = (fence[3] ?? "").trim().split(/\s+/)[0] || undefined;
      const body: string[] = [line];
      i++;
      let closed = false;
      while (i < lines.length) {
        const l = lines[i] ?? "";
        body.push(l);
        i++;
        // Closes only on a fence of at least the same length.
        const closing = FENCE.exec(l);
        if (closing && (closing[2] ?? "").length >= marker.length && !closing[3]?.trim()) {
          closed = true;
          break;
        }
      }
      blocks.push({
        // Synthesising the closing fence is what stops the block snapping from
        // paragraph to <pre> when the real fence finally arrives.
        source: closed ? body.join("\n") : `${body.join("\n")}\n${marker}`,
        complete: closed,
        kind: "code",
        lang,
      });
      continue;
    }

    // Table: a run of |-leading lines.
    if (isTableRow(line)) {
      const body: string[] = [];
      while (i < lines.length && isTableRow(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i++;
      }
      const hasDelimiter = body.some((l) => TABLE_DELIM.test(l));
      const atEnd = i >= lines.length;
      blocks.push({
        source: body.join("\n"),
        complete: !streaming || !atEnd,
        // Until the delimiter row lands this is not yet a table; render it with
        // matching line metrics so the eventual switch does not reflow.
        kind: hasDelimiter ? "text" : "table-pending",
      });
      continue;
    }

    // Ordinary paragraph / list / quote: consume to the next blank line.
    const body: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() !== "") {
      const l = lines[i] ?? "";
      if (FENCE.test(l) || isTableRow(l)) break;
      body.push(l);
      i++;
    }
    if (body.length === 0) {
      i++;
      continue;
    }
    const atEnd = i >= lines.length;
    blocks.push({
      source: trimDanglingInlineCode(body.join("\n"), streaming && atEnd),
      complete: !streaming || !atEnd,
      kind: "text",
    });
  }

  return blocks;
}

/**
 * A single trailing unmatched backtick flickers between literal text and
 * <code> as the closing one arrives. Inline-only, so no layout consequence —
 * but it is a visible twitch on every code mention.
 */
function trimDanglingInlineCode(text: string, isTail: boolean): string {
  if (!isTail) return text;
  const ticks = (text.match(/`/g) ?? []).length;
  if (ticks % 2 === 1 && text.endsWith("`")) return text.slice(0, -1);
  return text;
}
