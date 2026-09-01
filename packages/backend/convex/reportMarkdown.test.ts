import { describe, expect, test } from "vitest";
import { renderReportHtml } from "./reportMarkdown";

/**
 * The scheduled-report markdown renderer.
 *
 * Pure, so no Convex and no network. Two things are under test: that meaningful
 * report structure survives into real HTML, and that model output can never
 * become markup. A real production email showed literal `**`, literal backticks
 * and flattened numbered lists — those regressions are asserted against here.
 */

const r = (md: string) => renderReportHtml(md).html;

describe("headings", () => {
  test.each([1, 2, 3, 4, 5, 6])("h%i renders as a real heading", (n) => {
    const html = r(`${"#".repeat(n)} Title ${n}`);
    expect(html).toContain(`<h${n}`);
    expect(html).toContain(`Title ${n}`);
    expect(html).not.toContain(`${"#".repeat(n)} Title`);
  });
});

describe("inline emphasis — the defect seen in production", () => {
  test("bold becomes <strong>, not literal asterisks", () => {
    const html = r("This is **very** important.");
    expect(html).toContain("<strong");
    expect(html).toContain("very");
    expect(html).not.toContain("**");
  });

  test("italic becomes <em>", () => {
    const html = r("This is *subtle* emphasis.");
    expect(html).toContain("<em>subtle</em>");
  });

  test("inline code becomes <code>, not literal backticks", () => {
    const html = r("Call `scheduler.yield()` to yield.");
    expect(html).toContain("<code");
    expect(html).toContain("scheduler.yield()");
    expect(html).not.toContain("`");
  });

  test("underscore forms work too", () => {
    expect(r("__bold__ and _italic_")).toContain("<strong");
    expect(r("__bold__ and _italic_")).toContain("<em>");
  });
});

describe("lists", () => {
  test("bullets render as a real <ul>", () => {
    const html = r("- alpha\n- beta");
    expect(html).toContain("<ul");
    expect((html.match(/<li/g) ?? []).length).toBe(2);
  });

  test("numbered items render as <ol>, not paragraphs", () => {
    const html = r("1. first\n2. second\n3. third");
    expect(html).toContain("<ol");
    expect((html.match(/<li/g) ?? []).length).toBe(3);
    // The production defect: "1." surviving as body text.
    expect(html).not.toContain("<p style=\"margin:0 0 14px;font-family:-apple-system");
  });

  /** A report continuing "4." must not silently renumber to 1. */
  test("an ordered list that does not start at 1 keeps its start", () => {
    expect(r("4. four\n5. five")).toContain('start="4"');
    expect(r("1. one\n2. two")).not.toContain("start=");
  });

  test("one level of nesting is preserved", () => {
    const html = r("- top\n  - nested\n- back");
    expect((html.match(/<ul/g) ?? []).length).toBe(2);
    expect((html.match(/<\/ul>/g) ?? []).length).toBe(2);
    // Valid nesting: the inner list is a CHILD of the parent <li>, never a
    // sibling of it. A <ul> directly inside a <ul> is invalid, and Outlook's
    // Word engine renders it as a stray extra bullet.
    expect(html).not.toMatch(/<\/li><ul/);
    expect(html).toMatch(/top<ul/);
  });

  /**
   * `[^)]+` stops at the FIRST paren, which truncates a real URL and leaves a
   * stray ")" sitting in the prose. Wikipedia links hit this constantly.
   */
  test("a URL containing balanced parentheses survives whole", () => {
    const html = r("See [Foo](https://en.wikipedia.org/wiki/Foo_(bar)).");
    expect(html).toContain('href="https://en.wikipedia.org/wiki/Foo_(bar)"');
    expect(html).toContain(">Foo</a>");
  });

  test("an unsafe paren URL leaves no stray bracket behind", () => {
    const html = r("Click [bad](javascript:alert(1)) now.");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("bad");
    // The whole construct is consumed, so no orphaned ")" is emitted.
    expect(html).not.toMatch(/bad\)/);
  });

  test("switching from bullets to numbers starts a new list", () => {
    const html = r("- a\n- b\n\n1. c\n2. d");
    expect(html).toContain("<ul");
    expect(html).toContain("<ol");
  });
});

describe("links", () => {
  /**
   * THE ordering bug this renderer was rewritten to avoid: escaping the
   * document before extracting the href turns `&b=2` into `&amp;b=2` and the
   * link points somewhere else.
   */
  test("a query string survives with its ampersands intact", () => {
    const html = r("See [the docs](https://x.test/s?a=1&b=2).");
    expect(html).toContain('href="https://x.test/s?a=1&amp;b=2"');
    // Escaped for the attribute, but NOT double-escaped into &amp;amp;
    expect(html).not.toContain("&amp;amp;");
  });

  test("link text is rendered, not the raw markdown", () => {
    const html = r("See [the docs](https://x.test).");
    expect(html).toContain(">the docs</a>");
    expect(html).not.toContain("](");
  });

  test("a javascript: href loses the LINK but keeps the TEXT", () => {
    const html = r("Click [here](javascript:alert(1)) now.");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<a ");
    // Content is never silently deleted.
    expect(html).toContain("here");
  });

  test("a data:text/html href is refused", () => {
    const html = r("[x](data:text/html;base64,PHNjcmlwdD4=)");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("data:text/html");
  });
});

describe("code blocks", () => {
  test("a fence renders as a preformatted block", () => {
    const html = r("```\nconst a = 1;\n```");
    expect(html).toContain("<pre");
    expect(html).toContain("const a = 1;");
  });

  /** Without a fence state machine, this line becomes an <h1>. */
  test("markdown INSIDE a fence is not parsed", () => {
    const html = r("```\n# define X\n- not a list\n**not bold**\n```");
    expect(html).not.toContain("<h1");
    expect(html).not.toContain("<li");
    expect(html).not.toContain("<strong");
    expect(html).toContain("# define X");
    expect(html).toContain("**not bold**");
  });

  test("a table-looking line inside a fence is not a table", () => {
    const html = r("```\n| a | b |\n|---|---|\n```");
    // <th> is emitted only by a REAL table; this code block's own wrapper is
    // a presentation table, so <td> alone would prove nothing.
    expect(html).not.toContain("<th");
    expect(html).toContain("| a | b |");
  });

  test("code content is escaped, never emitted as markup", () => {
    const html = r("```\n<script>alert(1)</script>\n```");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("an unclosed fence still terminates", () => {
    const html = r("```\ndangling");
    expect(html).toContain("dangling");
    expect(html).toContain("<pre");
  });
});

describe("tables", () => {
  const md = "| Metric | Value |\n|---|---|\n| INP | 200ms |\n| LCP | 2.5s |";

  test("a GFM table renders as a real HTML table", () => {
    const html = r(md);
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect((html.match(/<tr>/g) ?? []).length).toBe(3); // header + 2 rows
    expect(html).toContain("INP");
    expect(html).toContain("2.5s");
    expect(html).not.toContain("|---|");
  });

  test("cells carry borders so Outlook renders a grid", () => {
    expect(r(md)).toContain("border:1px solid");
    expect(r(md)).toContain("border-collapse:collapse");
  });

  test("a hostile cell is inert", () => {
    const html = r("| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | ok |");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  test("a short row does not break the table", () => {
    const html = r("| a | b | c |\n|---|---|---|\n| only-one |");
    expect(html).toContain("<table");
    expect(html).toContain("only-one");
  });
});

describe("blockquotes, rules and paragraphs", () => {
  test("a blockquote renders as one", () => {
    expect(r("> quoted wisdom")).toContain("<blockquote");
    expect(r("> quoted wisdom")).toContain("quoted wisdom");
  });

  test.each(["---", "***", "___"])("%s becomes a rule", (rule) => {
    expect(r(`a\n\n${rule}\n\nb`)).toContain("<hr");
  });

  test("consecutive lines join with a line break, not a lost newline", () => {
    const html = r("line one\nline two");
    expect(html).toContain("<br>");
    expect(html).toContain("line one");
    expect(html).toContain("line two");
  });
});

describe("model output can never become markup", () => {
  test.each([
    ["script tag", "<script>alert(1)</script>"],
    ["img onerror", '<img src=x onerror="alert(1)">'],
    ["iframe", '<iframe src="https://evil.test"></iframe>'],
    ["svg onload", "<svg onload=alert(1)>"],
    ["malformed", "<<>>><p unclosed"],
    ["event attribute", '<div onclick="steal()">x</div>'],
  ])("%s is inert", (_name, hostile) => {
    const html = r(hostile);
    // The precise property is that no TAG survives. Asserting on substrings
    // like "onerror=" would be wrong: escaped inside &lt;img …&gt; that text is
    // inert, and the user should still see what the model actually wrote.
    expect(html).not.toMatch(/<script|<iframe|<svg|<img|<div/i);
    expect(html).toContain("&lt;");
  });

  test("hostile content inside emphasis is still escaped", () => {
    const html = r("**<script>alert(1)</script>**");
    expect(html).toContain("<strong");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("after removing OUR tags, no markup is left", () => {
    const html = r(
      "# Head\n\n<img src=x onerror=alert(1)>\n\n- <b>bold?</b>\n\n| <script> | y |\n|---|---|\n| a | b |",
    );
    const withoutOurs = html.replace(
      /<\/?(?:h[1-6]|p|ul|ol|li|em|strong|code|pre|a|br|hr|table|thead|tbody|tr|th|td|blockquote)(?:\s[^>]*)?>/g,
      "",
    );
    expect(withoutOurs).not.toContain("<");
  });
});

describe("long reports are cut between blocks, never inside one", () => {
  const big = Array.from({ length: 400 }, (_, i) => `## Section ${i}\n\nBody ${i}.`).join("\n\n");

  test("a normal report is not clipped", () => {
    const out = renderReportHtml("# Small\n\nJust a bit.");
    expect(out.clipped).toBe(false);
  });

  test("an oversized report reports that it was clipped", () => {
    const out = renderReportHtml(big);
    expect(out.clipped).toBe(true);
    expect(Buffer.byteLength(out.html, "utf8")).toBeLessThanOrEqual(60_000);
  });

  test("the cut lands on a tag boundary, leaving valid HTML", () => {
    const out = renderReportHtml(big);
    // Balanced angle brackets: a cut inside a tag would leave a stray "<".
    expect((out.html.match(/</g) ?? []).length).toBe(
      (out.html.match(/>/g) ?? []).length,
    );
    expect(out.html.trim().endsWith(">")).toBe(true);
  });

  test("a single huge block is still emitted rather than dropping everything", () => {
    const out = renderReportHtml("x".repeat(120_000));
    expect(out.html.length).toBeGreaterThan(0);
  });
});
