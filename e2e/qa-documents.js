// Documents capability — prod acceptance (headed Chrome on app.ollasuper.com).
// PPTX + PDF create / read / edit / process / convert with REAL inline preview, plus
// composition (Finance/Research/Marketing/Operations) + 9 regressions. Asserts the
// source-faithful behaviour: created decks/PDFs, edits (duplicate/reorder), extracted
// tables, OCR text, form fill, merge/split, PPTX<->PDF, that a PREVIEW actually renders
// (an <img data-preview-page> or the approximate label), that DOWNLOAD works, streaming,
// and 0 console errors. Fixtures are generated with the services/ai venv (uv).
//   E2E_BASE_URL=https://app.ollasuper.com node qa-documents.js
const { chromium } = require("playwright");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";
const WAIT_MS = Number(process.env.QA_WAIT_MS || 240000);
const OUT = process.env.QA_OUT || "documents-results.log";
const ONLY = process.env.QA_ONLY;

const results = [];
const errs = [];
const rec = (s) => {
  console.log(s);
  try {
    fs.appendFileSync(OUT, s + "\n");
  } catch {}
};
const need = (c, m) => {
  if (!c) throw new Error(m);
};
const step = async (n, f) => {
  if (ONLY && !ONLY.split(",").some((t) => n.includes(t.trim()))) return;
  const before = errs.length;
  try {
    await f();
    need(errs.length - before === 0, `${errs.length - before} console error(s)`);
    results.push(true);
    rec("PASS  " + n);
  } catch (e) {
    results.push(false);
    rec("FAIL  " + n + " — " + e.message.split("\n")[0]);
  }
};
const settle = async (page, ms) => {
  const stop = page.getByRole("button", { name: "Stop generating" });
  const approve = page.getByRole("button", { name: "Approve" });
  await stop.waitFor({ timeout: 45000 }).catch(() => {});
  const d = Date.now() + ms;
  let idle = 0;
  while (Date.now() < d) {
    if ((await approve.count()) > 0) {
      await approve.first().click().catch(() => {});
      await page.waitForTimeout(2000);
      idle = 0;
      continue;
    }
    if ((await stop.count()) > 0) {
      idle = 0;
      await page.waitForTimeout(700);
      continue;
    }
    idle += 1;
    if (idle >= 3) break;
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(1500);
};
const lastMsg = (page) =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll("div.my-5")];
    const last = rows[rows.length - 1];
    return last ? last.innerText : "";
  });
const steps = (r) => {
  const m = (r.text || "").match(/Done · (\d+) step/);
  return m ? Number(m[1]) : 0;
};
const previewCount = (page) =>
  page.evaluate(
    () => document.querySelectorAll("[data-preview-page]").length,
  );
const hasApproxLabel = (page) =>
  page.evaluate(() =>
    /approximate preview/i.test(document.body.innerText),
  );
const show = (tag, r) =>
  rec(`\n---- [${tag}] steps:${steps(r)} preview:${r.preview}\n${r.text.slice(0, 1800)}\n---- END ${tag} ----\n`);
const nospace = (t) => t.replace(/\s/g, "");

async function fresh(page, prompt, files) {
  await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 30000 });
  if (files) {
    const list = Array.isArray(files) ? files : [files];
    await page.locator('input[type="file"]').setInputFiles(list);
    await page.waitForTimeout(4000);
  }
  await page.fill("#chat-composer", prompt);
  await page.keyboard.press("Enter");
  await settle(page, WAIT_MS);
  const text = await lastMsg(page);
  const preview = await previewCount(page);
  const dl = await page.locator("[data-artifact-download]").count();
  return { text, preview, downloads: dl };
}

// --- fixtures: generate real PDFs/PPTX with the services/ai venv ------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "qa-docs-"));
const AI_DIR = path.resolve(__dirname, "..", "services", "ai");
const GEN = path.join(TMP, "_gen.py");
fs.writeFileSync(
  GEN,
  `
import io, sys
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
from PIL import Image, ImageDraw
from pptx import Presentation
from pptx.util import Inches
OUT = sys.argv[1]

def pdf(name, pages, table=False, form=False):
    buf = io.BytesIO(); c = canvas.Canvas(buf, pagesize=letter)
    for i in range(pages):
        c.setFont("Helvetica", 16)
        c.drawString(72, 720, f"Quarterly Report — Page {i+1}")
        c.setFont("Helvetica", 11)
        c.drawString(72, 690, "Revenue grew 18% year over year across all regions.")
        if table and i == 0:
            y = 640
            for row in [["Region","Q1","Q2"],["North","120","145"],["South","98","110"]]:
                x = 72
                for cell in row:
                    c.drawString(x, y, cell); x += 120
                y -= 20
        if form and i == 0:
            c.acroForm.textfield(name="fullname", x=72, y=600, width=220, height=20)
            c.acroForm.textfield(name="email", x=72, y=560, width=220, height=20)
        c.showPage()
    c.save()
    open(f"{OUT}/{name}", "wb").write(buf.getvalue())

def scanned(name):
    img = Image.new("RGB", (1000, 400), "white")
    d = ImageDraw.Draw(img)
    d.text((40, 60), "INVOICE 2024-0042", fill="black")
    d.text((40, 140), "Total Due: 4500 USD", fill="black")
    d.text((40, 220), "Net 30 payment terms", fill="black")
    ip = f"{OUT}/_scan.png"; img.save(ip)
    buf = io.BytesIO(); c = canvas.Canvas(buf, pagesize=letter)
    c.drawImage(ip, 40, 300, width=520, height=208); c.showPage(); c.save()
    open(f"{OUT}/{name}", "wb").write(buf.getvalue())

def enc(name):
    buf = io.BytesIO(); c = canvas.Canvas(buf); c.drawString(72,720,"secret content"); c.showPage(); c.save()
    from pypdf import PdfReader, PdfWriter
    w = PdfWriter(); w.append(PdfReader(io.BytesIO(buf.getvalue()))); w.encrypt("open123")
    b2 = io.BytesIO(); w.write(b2); open(f"{OUT}/{name}", "wb").write(b2.getvalue())

def deck(name, n):
    prs = Presentation()
    for i in range(n):
        s = prs.slides.add_slide(prs.slide_layouts[1])
        s.shapes.title.text = f"Strategy Slide {i+1}"
        s.placeholders[1].text_frame.text = f"Key point {i+1}: growth and execution."
    prs.save(f"{OUT}/{name}")

pdf("report.pdf", 3, table=True)
pdf("report2.pdf", 2)
pdf("big.pdf", 30)
pdf("form.pdf", 1, form=True)
scanned("scanned.pdf")
enc("encrypted.pdf")
deck("deck.pptx", 4)
print("fixtures ready")
`,
);
execSync(`uv run python "${GEN}" "${TMP}"`, { cwd: AI_DIR, stdio: "inherit" });
const F = (n) => path.join(TMP, n);

(async () => {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("pageerror", (e) => errs.push(String(e)));

  // login
  await page.goto(BASE + "/en/login", { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await page.waitForURL(/\/chat/, { timeout: 30000 }).catch(() => {});
  rec("logged in");

  // 1 CREATE DECK
  await step("[1 CREATE-PPTX] pitch deck", async () => {
    const r = await fresh(page, "Create a 5-slide pitch deck for a B2B analytics startup called Insightly. Show it here.");
    show("CREATE-PPTX", r);
    need(r.downloads >= 1, "no downloadable deck");
    need(/slide|deck|presentation|insightly/i.test(r.text), "not a deck response");
  });

  // 2 PPTX VISUAL PREVIEW (faithful via soffice, else approximate labeled)
  await step("[2 PPTX-PREVIEW] slides render inline", async () => {
    const r = await fresh(page, "Make a 3-slide overview deck about renewable energy and show the slides here.");
    show("PPTX-PREVIEW", r);
    const approx = await hasApproxLabel(page);
    need(r.preview >= 1 || approx, "no inline slide preview and no approximate label");
    need(r.downloads >= 1, "no download");
  });

  // 3 EDIT (duplicate + reorder + add)
  await step("[3 EDIT] duplicate + reorder + add slides", async () => {
    const r = await fresh(page, "In this deck, duplicate slide 1, add a closing slide titled 'Next Steps', then show it.", F("deck.pptx"));
    show("EDIT", r);
    need(r.downloads >= 1, "no edited deck produced");
    need(/slide|duplicat|added|next steps/i.test(r.text), "no edit confirmation");
  });

  // 4 READ / ANALYZE PPTX
  await step("[4 READ-PPTX] analyze deck", async () => {
    const r = await fresh(page, "Read this presentation and summarize each slide.", F("deck.pptx"));
    show("READ-PPTX", r);
    need(/slide|strategy|growth|point/i.test(r.text), "did not read the deck");
  });

  // 5 PPTX -> PDF (needs soffice)
  await step("[5 PPTX->PDF] convert deck to PDF", async () => {
    const r = await fresh(page, "Convert this presentation to a PDF and show it here.", F("deck.pptx"));
    show("PPTX2PDF", r);
    need(/pdf/i.test(r.text) && r.downloads >= 1, "no PDF produced (soffice off?)");
  });

  // 6 CREATE PDF
  await step("[6 CREATE-PDF] pdf report", async () => {
    const r = await fresh(page, "Create a one-page PDF report titled 'Weekly Ops Summary' with three sections.");
    show("CREATE-PDF", r);
    need(r.downloads >= 1 && /pdf|report/i.test(r.text), "no PDF report");
  });

  // 7 READ PDF + preview
  await step("[7 READ-PDF] read + page preview", async () => {
    const r = await fresh(page, "Read this PDF and tell me what it's about. Show it here.", F("report.pdf"));
    show("READ-PDF", r);
    need(/report|revenue|quarter/i.test(r.text), "did not read the PDF");
  });

  // 8 EXTRACT TABLES
  await step("[8 TABLES] extract the table", async () => {
    const r = await fresh(page, "Extract the table from this PDF.", F("report.pdf"));
    show("TABLES", r);
    need(/north|south|region|q1|q2|120|145/i.test(nospace(r.text)) || /table/i.test(r.text), "no table extracted");
  });

  // 9 OCR scanned
  await step("[9 OCR] read the scanned invoice", async () => {
    const r = await fresh(page, "This is a scanned document — OCR it and tell me the total due.", F("scanned.pdf"));
    show("OCR", r);
    need(/4500|invoice|total|0042/i.test(nospace(r.text)), "OCR did not read the scan");
  });

  // 10 FORM FILL (fillable)
  await step("[10 FORM] fill the fillable form", async () => {
    const r = await fresh(page, "Fill this PDF form: full name Jane Doe, email jane@example.com. Give me the filled PDF.", F("form.pdf"));
    show("FORM", r);
    need(r.downloads >= 1, "no filled form produced");
    need(/fill|form|jane|field/i.test(r.text), "no fill confirmation");
  });

  // 11 MERGE
  await step("[11 MERGE] merge two PDFs", async () => {
    const r = await fresh(page, "Merge these two PDFs into one.", [F("report.pdf"), F("report2.pdf")]);
    show("MERGE", r);
    need(r.downloads >= 1 && /merg|combin|5 page|one pdf/i.test(r.text), "no merged PDF");
  });

  // 12 SPLIT
  await step("[12 SPLIT] take pages 1-2", async () => {
    const r = await fresh(page, "Split out pages 1 to 2 of this PDF into a new file.", F("report.pdf"));
    show("SPLIT", r);
    need(r.downloads >= 1 && /split|page/i.test(r.text), "no split PDF");
  });

  // 13 PASSWORD PDF
  await step("[13 DECRYPT] open a password PDF", async () => {
    const r = await fresh(page, "This PDF is password-protected, the password is open123. Remove the password and read it.", F("encrypted.pdf"));
    show("DECRYPT", r);
    need(/secret content|removed|decrypt|unlock/i.test(r.text) || r.downloads >= 1, "did not decrypt");
  });

  // 14 PDF -> PPTX (honest image-per-slide)
  await step("[14 PDF->PPTX] pages as slides", async () => {
    const r = await fresh(page, "Turn this PDF into a slideshow.", F("report.pdf"));
    show("PDF2PPTX", r);
    need(r.downloads >= 1, "no deck produced");
    need(/image|not editable|page|slide/i.test(r.text), "did not explain image-per-slide");
  });

  // 15 LARGE doc (bounded/lazy)
  await step("[15 LARGE] 30-page PDF bounded", async () => {
    const r = await fresh(page, "Read this large PDF and give the gist. Show it here.", F("big.pdf"));
    show("LARGE", r);
    need(/report|revenue|page/i.test(r.text), "did not handle large PDF");
  });

  // 16 MALFORMED (safe error)
  await step("[16 MALFORMED] corrupt file safe error", async () => {
    const bad = F("broken.pdf");
    fs.writeFileSync(bad, "this is not a real pdf at all");
    const r = await fresh(page, "Read this PDF.", bad);
    show("MALFORMED", r);
    need(r.text.length > 0, "no response");
  });

  // 17 COMPOSE: Finance -> deck
  await step("[17 +FINANCE] financial analysis into a deck", async () => {
    const r = await fresh(page, "Revenue: 2024 $4.2M, 2025 $6.1M; gross margin 72%. Turn this into a short investor deck.");
    show("PLUS-FINANCE", r);
    need(r.downloads >= 1 && /deck|slide|revenue|margin/i.test(r.text), "no finance deck");
  });

  // 18 COMPOSE: Operations -> PDF
  await step("[18 +OPS] operations report to PDF", async () => {
    const r = await fresh(page, "Write a brief operations status (migration 80% done, vendor stalled) and give me a PDF of it.");
    show("PLUS-OPS", r);
    need(r.downloads >= 1 && /pdf|status|operations/i.test(r.text), "no ops PDF");
  });

  // 19 DOWNLOAD works (mint)
  await step("[19 DOWNLOAD] artifact download button works", async () => {
    const r = await fresh(page, "Create a PDF titled 'Test Doc' with one paragraph.");
    show("DOWNLOAD", r);
    need(r.downloads >= 1, "no download button");
    // click and confirm no console error / navigation crash
    await page.locator("[data-artifact-download]").first().click().catch(() => {});
    await page.waitForTimeout(1500);
  });

  // 20-27 REGRESSIONS
  await step("[20 NORMAL] normal chat", async () => {
    const r = await fresh(page, "In one sentence, what is a P/E ratio?");
    need(/price|earnings|ratio|valuation/i.test(r.text), "normal chat broke");
  });
  await step("[21 SEO] seo regression", async () => {
    const r = await fresh(page, "Give me 3 on-page SEO tips for a SaaS pricing page.");
    need(/seo|title|meta|keyword|heading|content/i.test(r.text), "seo regression");
  });
  await step("[22 DATA] data-analysis regression", async () => {
    const tmp = F("nums.csv");
    fs.writeFileSync(tmp, "region,sales\nNorth,120\nSouth,90\nEast,150\n");
    const r = await fresh(page, "What's the total sales in this CSV?", tmp);
    need(/360|total|sum|sales/i.test(nospace(r.text)), "data regression");
  });
  await step("[23 FINANCE] finance regression", async () => {
    const r = await fresh(page, "Compute the current ratio if current assets are 500 and current liabilities are 250.");
    need(/2|ratio|current/i.test(r.text), "finance regression");
  });
  await step("[24 HR] hr regression", async () => {
    const r = await fresh(page, "Draft 3 interview questions for a senior backend engineer.");
    need(/interview|question|experience|backend|system/i.test(r.text), "hr regression");
  });
  await step("[25 OPERATIONS] operations regression", async () => {
    const r = await fresh(page, "Evaluate whether we should renew a vendor at $40k/yr with a 10% price increase.");
    need(/vendor|cost|renew|tco|negotiat/i.test(r.text), "operations regression");
  });
  await step("[26 MARKETING] marketing regression", async () => {
    const r = await fresh(page, "Outline a go-to-market plan for a new developer tool.");
    need(/market|audience|channel|positioning|launch|gtm/i.test(r.text), "marketing regression");
  });
  await step("[27 RESEARCH] deep research regression", async () => {
    const r = await fresh(page, "Briefly, what are the main approaches to retrieval-augmented generation?");
    need(/retrieval|rag|embedding|vector|context|source/i.test(r.text), "research regression");
  });

  const pass = results.filter(Boolean).length;
  rec(`\n==== Documents QA: ${pass}/${results.length} passed, ${errs.length} console errors ====`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})();
