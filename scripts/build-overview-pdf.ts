/**
 * Renders docs/project-overview.html to a PDF.
 *
 *   npm run overview-pdf
 *
 * Uses Playwright's bundled Chromium rather than the attached Edge — this is a
 * local file render with no QuickMail session involved, so it must not depend
 * on the browser being up.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const SRC = path.join(process.cwd(), "docs", "project-overview.html");
const OUT = path.join(process.cwd(), "docs", "AI-SDR-Dashboard-Overview.pdf");

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(String(e)));

  await page.goto(pathToFileURL(SRC).href, { waitUntil: "networkidle" });
  // Fonts must be settled before layout is measured, or headings reflow.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);

  await page.pdf({
    path: OUT,
    format: "A4",
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: `<div></div>`,
    footerTemplate: `
      <div style="width:100%;font-size:7.5pt;color:#7a7975;
                  font-family:'Segoe UI',sans-serif;padding:0 14mm;
                  display:flex;justify-content:space-between;">
        <span>AI SDR Dashboard — project overview</span>
        <span class="pageNumber"></span>
      </div>`,
    margin: { top: "16mm", bottom: "14mm", left: "14mm", right: "14mm" },
  });

  console.log(`PDF written to ${OUT}`);
  if (problems.length) console.log("page errors:", problems);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
