// Verifies the synchronous markdown features by server-rendering the REAL
// <Markdown> component and asserting the HTML. Effect-driven renders (shiki
// colours, mermaid SVG) run only in a browser, so those are covered by
// md-render.js (headed); here we prove the pipeline: math, headings, task
// checkboxes, footnotes, single line breaks, indented code routing, fenced
// diff/mermaid routing, and that raw HTML is still escaped.
//
//   cd e2e && bun run md-features.mjs
//
// The component does `import "katex/dist/katex.min.css"`; stub CSS as empty so
// a non-bundler run can import it.
import { plugin } from "bun";
plugin({
  name: "css-stub",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
  },
});

const React = (await import("react")).default;
const { renderToStaticMarkup } = await import("react-dom/server");
const { Markdown } = await import(
  "../apps/app/src/app/[locale]/(workspace)/chat/_components/markdown.tsx"
);

const render = (content) =>
  renderToStaticMarkup(
    React.createElement(Markdown, { content, streaming: false }),
  );

let failed = 0;
const check = (name, html, cond) => {
  const ok = typeof cond === "function" ? cond(html) : cond;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failed++;
    console.log("       html: " + html.replace(/\n/g, " ").slice(0, 220));
  }
};

// Math is parsed by remark-math: the $ delimiters are consumed and the tex is
// tagged `language-math`. katex FORMATTING is client-only (lazy-loaded), so it
// is asserted in the headed browser test, not in this static render.
check("inline LaTeX $E=mc^2$ parsed", render("Energy is $E=mc^2$ here."), (h) =>
  /language-math/.test(h) && h.includes("E=mc^2") && !h.includes("$E=mc"),
);
check("display LaTeX $$...$$ parsed", render("Area: $$a^2+b^2$$"), (h) =>
  /language-math/.test(h) && h.includes("a^2+b^2") && !h.includes("$$"),
);

// Headings h4/h5/h6.
check("#### h4", render("#### Four"), (h) => /<h4[ >]/.test(h));
check("##### h5", render("##### Five"), (h) => /<h5[ >]/.test(h));
check("###### h6", render("###### Six"), (h) => /<h6[ >]/.test(h));

// Task checkboxes.
const tasks = render("- [x] done\n- [ ] todo");
check("task checkbox rendered", tasks, (h) =>
  /type="checkbox"/.test(h) && /disabled/.test(h),
);
check("checked task is checked", tasks, (h) => /checked/.test(h));

// Footnotes (whole-document parse path).
const fn = render("A claim[^1].\n\n[^1]: The source.");
check("footnote section", fn, (h) => /class="footnotes"|data-footnotes/.test(h));
check("footnote ref link", fn, (h) => /href="#user-content-fn-1"|#fn-1/.test(h));

// Single line breaks preserved.
check("single line break → <br>", render("line one\nline two"), (h) =>
  /<br\s*\/?>/.test(h),
);

// 4-space indented code block → a real code box (pre + code), not inline pill.
const indented = render("text\n\n    const x = 1;\n    const y = 2;\n");
check("indented code → <pre><code>", indented, (h) =>
  /<pre[\s>][\s\S]*<code/.test(h) && h.includes("const x = 1;"),
);

// Fenced diff / mermaid are routed (diff → code box; mermaid → its component's
// streaming fallback <pre> in SSR since the render effect is client-only).
check("```diff routed to code box", render("```diff\n- a\n+ b\n```"), (h) =>
  /<pre[\s>]/.test(h) && h.includes("+ b"),
);
check("```mermaid routed (source preserved)", render("```mermaid\ngraph TD;A-->B;\n```"), (h) =>
  h.includes("A--&gt;B") || h.includes("A-->B"),
);

// SECURITY: raw HTML in model output must remain escaped literal text.
const xss = render('Before <img src=x onerror="alert(1)"> after');
check("raw HTML stays escaped (no live <img>)", xss, (h) =>
  !/<img[^>]+onerror/i.test(h) && h.includes("&lt;img"),
);
check("no <script> injected", render("<script>alert(1)</script>"), (h) =>
  !/<script>alert/i.test(h),
);

console.log(failed ? `\n${failed} FAILED` : "\nFEATURES OK");
process.exit(failed ? 1 : 0);
