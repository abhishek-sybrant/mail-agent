/**
 * Renders docs/summary-2page.html to a two-page PDF.
 *
 *   npm run summary-pdf
 *
 * Fails if the result is not exactly two pages — the whole point of this
 * document is that it fits on two, and a silent third page would defeat it.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const SRC = path.join(process.cwd(), "docs", "summary-2page.html");
const OUT = path.join(process.cwd(), "docs", "AI-SDR-vs-QuickMail-2page.pdf");

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(pathToFileURL(SRC).href, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);

  await page.pdf({
    path: OUT,
    format: "A4",
    printBackground: true,
    margin: { top: "12mm", bottom: "10mm", left: "11mm", right: "11mm" },
  });
  await browser.close();

  const bytes = await fs.readFile(OUT);
  const pages = (bytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;

  console.log(`${OUT}\n${pages} pages · ${Math.round(bytes.length / 1024)} KB`);
  if (pages !== 2) {
    console.error(`Expected exactly 2 pages, got ${pages}. Tighten the content.`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
