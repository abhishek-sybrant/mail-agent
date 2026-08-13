/**
 * Renders a document in docs/ to a PDF beside it.
 *
 *   npm run pdf -- hosting-options
 *   npm run pdf -- summary-2page --pages 2
 *
 * One builder for every document — three near-identical scripts had started to
 * drift, and a rendering fix applied to one would not reach the others.
 *
 * `--pages N` fails the build when the output is not exactly N pages. The
 * two-page summary depends on that: a summary that quietly grows a third page
 * has stopped being a summary, and nothing else would catch it.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const NAMES: Record<string, string> = {
  "project-overview": "AI-SDR-Dashboard-Overview",
  "summary-2page": "AI-SDR-vs-QuickMail-2page",
  "hosting-options": "AI-SDR-Hosting-Options",
  "api-and-automation": "AI-SDR-API-and-Automation",
};

async function main() {
  const name = process.argv[2];
  if (!name) {
    console.error("Usage: npm run pdf -- <name-of-file-in-docs> [--pages N]");
    process.exitCode = 1;
    return;
  }

  const expect = process.argv.includes("--pages")
    ? Number(process.argv[process.argv.indexOf("--pages") + 1])
    : null;

  const src = path.join(process.cwd(), "docs", `${name}.html`);
  const out = path.join(process.cwd(), "docs", `${NAMES[name] ?? name}.pdf`);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(String(e)));

  await page.goto(pathToFileURL(src).href, { waitUntil: "networkidle" });
  // Fonts must settle before layout is measured, or headings reflow mid-render.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);

  await page.pdf({
    path: out,
    format: "A4",
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: "<div></div>",
    footerTemplate: `
      <div style="width:100%;font-size:7.5pt;color:#7a7975;
                  font-family:'Segoe UI',sans-serif;padding:0 13mm;
                  display:flex;justify-content:space-between;">
        <span>AI SDR Dashboard</span><span class="pageNumber"></span>
      </div>`,
    margin: { top: "14mm", bottom: "12mm", left: "13mm", right: "13mm" },
  });
  await browser.close();

  const bytes = await fs.readFile(out);
  const pages = (bytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  console.log(`${out}\n${pages} pages · ${Math.round(bytes.length / 1024)} KB`);
  if (problems.length) console.log("page errors:", problems.slice(0, 3));

  if (expect !== null && pages !== expect) {
    console.error(`Expected exactly ${expect} pages, got ${pages}. Tighten the content.`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
