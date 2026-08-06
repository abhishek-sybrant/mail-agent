/**
 * Looks at what QuickMail's signed-in app actually shows, so the reply capture
 * aims at the right screen instead of guessing URLs.
 *
 *   npx tsx scripts/explore-quickmail.ts [url]
 *
 * Read-only: it reads the DOM and screenshots. It clicks nothing.
 */
import { chromium } from "playwright";
import { CDP_PORT } from "../src/lib/quickmail/ui-automation";

const TARGET = process.argv[2] ?? "https://next.quickmail.com/";

async function main() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const ctx = browser.contexts()[0];
  const page =
    ctx.pages().find((p) => p.url().includes("quickmail")) ?? (await ctx.newPage());

  const seen: string[] = [];
  ctx.on("request", (r) => {
    if (/graphql|\/api\/|\.json/i.test(r.url())) seen.push(`${r.method()} ${r.url()}`);
  });

  await page.goto(TARGET, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(5000);

  console.log("url:   ", page.url());
  console.log("title: ", await page.title());

  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]"))
      .map((a) => `${(a.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40)} → ${a.getAttribute("href")}`)
      .filter((s) => s.length > 3),
  );
  console.log(`\nlinks (${links.length}):`);
  for (const l of Array.from(new Set(links)).slice(0, 60)) console.log("  " + l);

  const text = await page.evaluate(() => document.body.innerText.slice(0, 1500));
  console.log("\n--- visible text ---\n" + text);

  console.log(`\n--- network (${seen.length}) ---`);
  for (const s of Array.from(new Set(seen)).slice(0, 40)) console.log("  " + s);

  await page.screenshot({ path: "_quickmail.png", fullPage: false });
  console.log("\nscreenshot → _quickmail.png");
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
