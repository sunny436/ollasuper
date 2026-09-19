// qa-skills-fix.js — production acceptance for the 18.09.2026 skills bug-fix pass.
//   source /tmp/qa-env.sh && node qa-skills-fix.js
//
// Headed Chrome, the QA account, real generations (6). What is asserted is what
// the user sees and what the DOWNLOADED files contain — never the spec:
//   R1/R3  a "this week" question shows a web search in the activity timeline
//          BEFORE the answer (the code-initiated prefetch) and the answer either
//          cites dated sources inside the window or carries the explicit notice;
//   R2     with the provider failing, the failure is stated, not hidden;
//   ctrl   a historical question is not forced to retrieve and carries no notice;
//   D1/D2  a deck with a line chart and a DOUGHNUT arrives on the first call, and
//          the downloaded .pptx really contains a donut (hole at the centre);
//   D4     a PDF with page numbers + TOC: the downloaded file has "Page X of Y",
//          an outline, and every TOC entry lands on its page (pypdf, offline);
//   D4     a DOCX with page numbers + TOC has PAGE/NUMPAGES fields and a static
//          TOC with real numbers (the LibreOffice two-pass ran on prod);
//   zero console errors.
// The search provider was returning 502 on 18-09: any success-path check that the
// outage blocks is reported as VERIFICATION PENDING, never as a pass.
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.QA_EMAIL || "";
const PASSWORD = process.env.QA_PASSWORD || "";
const OUT = path.join(__dirname, "out", "skills-fix");
fs.mkdirSync(OUT, { recursive: true });
const PY = path.join(__dirname, "..", "services", "ai", ".venv", "Scripts", "python.exe");

const results = [];
const pending = [];
const errs = [];
const step = async (n, f) => {
  try {
    const r = await f();
    results.push(true);
    console.log(`PASS  ${n}${r ? ` — ${r}` : ""}`);
  } catch (e) {
    if (String(e.message).startsWith("PENDING:")) {
      pending.push(`${n}: ${e.message.slice(8).trim()}`);
      console.log(`PEND  ${n} — ${e.message.slice(8).trim()}`);
      return;
    }
    results.push(false);
    console.log(`FAIL  ${n} — ${String(e.message || e).split("\n")[0].slice(0, 300)}`);
  }
};
const need = (c, m) => {
  if (!c) throw new Error(m);
};
const gen = (page) => page.getByRole("button", { name: "Stop generating" });
const settle = async (page, ms = 240000) => {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    if ((await gen(page).count()) === 0) return true;
    await page.waitForTimeout(300);
  }
  return false;
};

async function ask(page, prompt) {
  await settle(page);
  await page.goto(`${BASE}/en/chat`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 60000 });
  await page.waitForTimeout(800);
  await page.locator("#chat-composer").fill(prompt);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 20000 }).catch(() => {});
  await gen(page).waitFor({ timeout: 30000 }).catch(() => {});
  await settle(page);
  await page.waitForTimeout(2500);
  const r = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("div.my-5")];
    const last = rows[rows.length - 1];
    const activity = last ? [...last.querySelectorAll("[data-agent-activity] summary, [data-agent-activity] span")].map((e) => e.textContent.trim()).filter(Boolean) : [];
    return {
      text: last?.innerText || "",
      activity: [...new Set(activity)],
      downloads: document.querySelectorAll("[data-artifact-download]").length,
      url: location.href,
    };
  });
  fs.writeFileSync(path.join(OUT, `answer-${++answerN}.txt`), `${prompt}\n\n${r.url}\n\n${r.activity.join(" | ")}\n\n${r.text}`);
  return r;
}
let answerN = 0;

// Dates as the model writes them: ISO, "12 September 2026", "Sep 12, 2026".
const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec";
function datesIn(text) {
  const out = [];
  for (const m of text.matchAll(/\b(20\d\d)-(\d\d)-(\d\d)\b/g)) out.push(new Date(`${m[1]}-${m[2]}-${m[3]}`));
  const re1 = new RegExp(`\\b(\\d{1,2})\\s+(${MONTHS})[a-z]*\\.?,?\\s+(20\\d\\d)\\b`, "gi");
  const re2 = new RegExp(`\\b(${MONTHS})[a-z]*\\.?\\s+(\\d{1,2}),?\\s+(20\\d\\d)\\b`, "gi");
  const mi = (s) => "jan feb mar apr may jun jul aug sep oct nov dec".split(" ").indexOf(s.slice(0, 3).toLowerCase());
  for (const m of text.matchAll(re1)) out.push(new Date(Number(m[3]), mi(m[2]), Number(m[1])));
  for (const m of text.matchAll(re2)) out.push(new Date(Number(m[3]), mi(m[1]), Number(m[2])));
  return out.filter((d) => !Number.isNaN(d.getTime()));
}

async function download(page, tag, ext) {
  const btn = page.locator("[data-artifact-download]").last();
  await btn.waitFor({ timeout: 20000 });
  const dlPromise = page.waitForEvent("download", { timeout: 60000 });
  await btn.click();
  const download = await dlPromise;
  const dest = path.join(OUT, `${tag}.${ext}`);
  await download.saveAs(dest);
  need(fs.statSync(dest).size > 0, "downloaded file is empty");
  return dest;
}

function py(code) {
  return execFileSync(PY, ["-c", code], { cwd: path.join(__dirname, "..", "services", "ai"), encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }).trim();
}

const NOTICE_SEARCH_FAILED = /web search failed \(provider error\)/i;
const NOTICE_NO_SEARCH = /no search was run/i;
const NOTICE_RECENCY = /Recency (check|not verified)/i;

(async () => {
  const b = await chromium.launch({ headless: false });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(`${page.url().replace(BASE, "")} ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => errs.push(`pageerror ${e.message.slice(0, 200)}`));

  await page.goto(`${BASE}/en/login`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/chat/, { timeout: 60000, waitUntil: "commit" });
  await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 60000 });

  // ---------------------------------------------------------- R1 / R2 / R3
  let providerDown = false;
  await step("[R3] a 'this week' question searches the web by code before answering", async () => {
    const r = await ask(page, "What changed this week in Indian fintech regulation?");
    const searched = r.activity.some((a) => /search/i.test(a));
    need(searched, `no web search in the activity timeline: ${JSON.stringify(r.activity).slice(0, 200)}`);
    if (NOTICE_SEARCH_FAILED.test(r.text)) {
      providerDown = true;
      return `search attempted; provider failed and the answer SAYS so (${r.activity.join(" · ")})`;
    }
    need(!NOTICE_NO_SEARCH.test(r.text), "the notice says no search ran although one is in the timeline");
    return `searched (${r.activity.join(" · ")}); ${NOTICE_RECENCY.test(r.text) ? "recency notice present" : "no recency notice (compliant)"}`;
  });

  await step("[R1] a 'past 30 days' question cites dated sources inside the window, or says it cannot", async () => {
    const r = await ask(page, "Give me the past 30 days of news on UPI transaction volumes.");
    const searched = r.activity.some((a) => /search/i.test(a));
    need(searched, "no web search in the activity timeline");
    if (NOTICE_SEARCH_FAILED.test(r.text)) {
      providerDown = true;
      throw new Error("PENDING: provider 502 on every search today — the compliant-source path could not be exercised; the failure was stated in the answer");
    }
    const cutoff = new Date(Date.now() - 31 * 86400000);
    const datesInText = datesIn(r.text);
    const anyFresh = datesInText.some((d) => d >= cutoff);
    const noticed = NOTICE_RECENCY.test(r.text) || /could not be verified/i.test(r.text);
    need(anyFresh || noticed, "no dated source inside the window and no recency notice");
    return anyFresh ? `dated sources inside the window (${datesInText.length} dates seen)` : "no compliant source — the answer says so";
  });

  await step("[ctrl] a historical question is not forced to retrieve and carries no freshness notice", async () => {
    // The model MAY still choose to search a fact (its orientation allows it);
    // what must not happen is a temporal directive/prefetch or a recency notice.
    const r = await ask(page, "When was UPI launched, and by whom?");
    need(!NOTICE_RECENCY.test(r.text) && !NOTICE_NO_SEARCH.test(r.text) && !NOTICE_SEARCH_FAILED.test(r.text), "a freshness notice on a historical answer");
    need(/2016/.test(r.text), "the answer does not even carry the launch year");
    const searched = r.activity.some((a) => /search/i.test(a));
    return `no freshness notice; answer carries 2016; ${searched ? "the model chose to search (allowed)" : "no search"}`;
  });

  // ------------------------------------------------------------- D1 / D2
  let pptxPath = null;
  await step("[D1/D2] a deck with a line chart and a DOUGHNUT arrives on the first call", async () => {
    const r = await ask(
      page,
      "Create a 3-slide PowerPoint: slide 1 title 'Q3 Business Review'; slide 2 a line chart of revenue Q1 10, Q2 12, Q3 15 (title 'Revenue'); slide 3 a doughnut chart of segment mix: Enterprise 60, SMB 40 (title 'Segment mix'). Keep text minimal.",
    );
    need(r.downloads >= 1, `no download card: ${r.text.slice(0, 200)}`);
    const fileCalls = r.activity.filter((a) => /generat|creat|file|deck|slide/i.test(a));
    pptxPath = await download(page, "deck", "pptx");
    return `download card present; activity: ${fileCalls.join(" · ") || r.activity.join(" · ")}`;
  });

  await step("[D2] the downloaded .pptx contains a real donut (hole at the centre) and the line chart", async () => {
    need(pptxPath, "no deck downloaded");
    // A donut: white centre AND a coloured ring around it. A pie: coloured centre.
    // A line chart: white centre, no ring. Centre alone cannot tell donut from line.
    const out = py(`
import zipfile, io, math
from PIL import Image
z = zipfile.ZipFile(r"${pptxPath.replace(/\\/g, "\\\\")}")
slides = [n for n in z.namelist() if n.startswith("ppt/slides/slide") and n.endswith(".xml")]
kinds = []
for n in [n for n in z.namelist() if n.startswith("ppt/media/") and n.lower().endswith(".png")]:
    im = Image.open(io.BytesIO(z.read(n))).convert("RGB"); w, h = im.size
    cx, cy = w // 2, h // 2
    centre = im.getpixel((cx, cy))
    R = int(min(w, h) * 0.36)
    ring = [im.getpixel((int(cx + R * math.cos(a)), int(cy + R * math.sin(a)))) for a in [i * math.pi / 8 for i in range(16)]]
    coloured = sum(1 for p in ring if max(p) - min(p) > 40)
    kinds.append("donut" if centre == (255, 255, 255) and coloured >= 10 else "pie" if coloured >= 10 else "line/bar")
print(len(slides), kinds)
`);
    const nSlides = Number(out.split(" ")[0]);
    const kinds = out.slice(out.indexOf("["));
    need(nSlides >= 3, `slides = ${nSlides}, wanted >= 3 (a title slide may be added)`);
    need(/donut/.test(kinds), `no donut among the embedded charts: ${kinds}`);
    need(!/pie/.test(kinds), `a PIE was delivered where a doughnut was asked: ${kinds}`);
    need(/line\/bar/.test(kinds), `no line chart among the embedded charts: ${kinds}`);
    return `slides=${nSlides} charts=${kinds}`;
  });

  // ------------------------------------------------------------------ D4
  let pdfPath = null;
  await step("[D4] a PDF with page numbers and a table of contents is delivered", async () => {
    const r = await ask(
      page,
      "Write a PDF report titled 'Fintech Outlook' with page numbers and a table of contents. Five sections: Introduction, Market size, Competitors, Risks, Recommendations — about 150 words each, illustrative numbers clearly labelled as such.",
    );
    need(r.downloads >= 1, `no download card: ${r.text.slice(0, 200)}`);
    pdfPath = await download(page, "report", "pdf");
    return `downloaded ${path.basename(pdfPath)}`;
  });

  await step("[D4] the downloaded PDF has 'Page X of Y', an outline, and a TOC that matches the pages", async () => {
    need(pdfPath, "no PDF downloaded");
    const out = py(`
from app.filegen.verify import pdf_outline, verify_toc, page_numbers_ok, page_texts
raw = open(r"${pdfPath.replace(/\\/g, "\\\\")}", "rb").read()
ol = pdf_outline(raw)
entries = [(d + 1, t) for d, t, p in ol]
print("pages", len(page_texts(raw)), "numbers", page_numbers_ok(raw), "outline", len(ol), "toc", verify_toc(raw, entries))
`);
    need(/numbers True/.test(out), `page numbers not verified: ${out}`);
    need(/outline [1-9]/.test(out), `no outline: ${out}`);
    need(/'toc_verified': True/.test(out), `TOC mismatch: ${out}`);
    return out;
  });

  let docxPath = null;
  await step("[D4] a DOCX with page numbers and TOC has real fields and a static TOC with numbers", async () => {
    const r = await ask(
      page,
      "Now create the same 'Fintech Outlook' report as a Word document (DOCX) with page numbers and a table of contents, same five sections.",
    );
    need(r.downloads >= 1, `no download card: ${r.text.slice(0, 200)}`);
    docxPath = await download(page, "report", "docx");
    const out = py(`
import io
from docx import Document
d = Document(r"${docxPath.replace(/\\/g, "\\\\")}")
foot = d.sections[0].footer._element.xml
paras = [p.text for p in d.paragraphs]
toc = [p for p in paras if "\\t" in p]
nums = [ln.rsplit("\\t", 1)[1] for ln in toc]
print("PAGE" , " PAGE " in foot, "NUMPAGES", " NUMPAGES " in foot, "contents", "Contents" in paras, "toc_lines", len(toc), "numbers", nums)
`);
    need(/PAGE True NUMPAGES True/.test(out), `footer fields missing: ${out}`);
    need(/contents True/.test(out), `no Contents heading: ${out}`);
    need(/toc_lines [1-9]/.test(out), `no TOC lines: ${out}`);
    need(!/…/.test(out) && /numbers \['\d/.test(out), `TOC has no real page numbers (LibreOffice pass did not run?): ${out}`);
    return out;
  });

  // ----------------------------------------------------------------- done
  await ctx.close();
  await b.close();
  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} passed · ${pending.length} verification pending · console errors: ${errs.length}`);
  for (const e of errs.slice(0, 10)) console.log(`  ERR ${e}`);
  for (const p of pending) console.log(`  PENDING ${p}`);
  if (providerDown) console.log("  NOTE the search provider was failing during this run; success-path recency checks are pending, the failure path is verified");
  process.exit(pass === results.length && errs.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(2);
});
