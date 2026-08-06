/**
 * Greps QuickMail's JS bundles for a token and prints surrounding context.
 *
 *   npx tsx scripts/grep-quickmail-bundle.ts replyToEmail 400
 *
 * Introspection is disabled on their internal endpoint, so the only way to learn
 * an input type's shape is to read the code that builds it.
 *
 * Read-only.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { CDP_PORT } from "../src/lib/quickmail/ui-automation";

const WORKSPACE = process.env.QUICKMAIL_WORKSPACE_ID ?? "54552";
const TOKEN = process.argv[2] ?? "replyToEmail";
const CONTEXT = Number(process.argv[3] ?? 400);
const CACHE = path.join(process.cwd(), ".quickmail-capture", "bundles");

async function main() {
  await fs.mkdir(CACHE, { recursive: true });

  // Reuse a previous download when there is one — the bundles are large.
  let files = (await fs.readdir(CACHE)).filter((f) => f.endsWith(".js"));

  if (files.length === 0) {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const ctx = browser.contexts()[0];
    const page =
      ctx.pages().find((p) => p.url().includes("quickmail")) ?? (await ctx.newPage());

    const scripts = new Set<string>();
    ctx.on("request", (r) => {
      if (/\.js(\?|$)/.test(r.url())) scripts.add(r.url());
    });

    await page
      .goto(`https://next.quickmail.com/workspace/${WORKSPACE}/opportunities`, {
        waitUntil: "networkidle",
      })
      .catch(() => {});
    await page.waitForTimeout(8000);

    console.log(`downloading ${scripts.size} bundles…`);
    let i = 0;
    for (const url of scripts) {
      const src = await page
        .evaluate(async (u) => (await fetch(u)).text(), url)
        .catch(() => "");
      if (src) await fs.writeFile(path.join(CACHE, `${i++}.js`), src);
    }
    await browser.close();
    files = (await fs.readdir(CACHE)).filter((f) => f.endsWith(".js"));
  }

  console.log(`searching ${files.length} cached bundles for "${TOKEN}"\n`);
  let hits = 0;
  for (const f of files) {
    const src = await fs.readFile(path.join(CACHE, f), "utf8");
    let idx = src.indexOf(TOKEN);
    while (idx !== -1 && hits < 25) {
      const from = Math.max(0, idx - CONTEXT);
      console.log(`--- ${f} @ ${idx} ---`);
      console.log(src.slice(from, idx + CONTEXT).replace(/\n{2,}/g, "\n"));
      console.log();
      hits++;
      idx = src.indexOf(TOKEN, idx + TOKEN.length);
    }
  }
  if (hits === 0) console.log("(no hits)");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
