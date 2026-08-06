/**
 * Extracts QuickMail's GraphQL mutations from their own JS bundle, and records
 * the exact headers their front end sends.
 *
 *   npx tsx scripts/capture-quickmail-mutations.ts [filter]
 *
 * Reading the bundle is deliberate. The alternative — opening the reply box and
 * pressing send to watch what fires — would put a real email in front of a real
 * prospect. The bundle contains every operation the app can issue, so the reply
 * mutation can be found without sending anything.
 *
 * Read-only.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { CDP_PORT } from "../src/lib/quickmail/ui-automation";

const WORKSPACE = process.env.QUICKMAIL_WORKSPACE_ID ?? "54552";
const FILTER = new RegExp(
  process.argv[2] ?? "repl|send|todo|draft|message|opportunit|snooze|note",
  "i",
);
const OUT_DIR = path.join(process.cwd(), ".quickmail-capture");

/** Pulls `mutation Name(...) { ... }` blocks out of a bundle by brace matching. */
function extractOperations(src: string): { kind: string; name: string; body: string }[] {
  const out: { kind: string; name: string; body: string }[] = [];
  const re = /\b(mutation|query)\s+([A-Za-z][A-Za-z0-9_]*)\s*[({]/g;

  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index;
    // Walk to the opening brace of the selection set, then match braces.
    let i = src.indexOf("{", m.index + m[0].length - 1);
    if (i === -1) continue;
    let depth = 0;
    let end = -1;
    for (; i < src.length && i - start < 20000; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end === -1) continue;
    out.push({ kind: m[1], name: m[2], body: src.slice(start, end) });
  }
  return out;
}

async function main() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const ctx = browser.contexts()[0];
  const page =
    ctx.pages().find((p) => p.url().includes("quickmail")) ?? (await ctx.newPage());

  const scripts = new Set<string>();
  let graphqlHeaders: Record<string, string> | null = null;

  ctx.on("request", (r) => {
    const u = r.url();
    if (/\.js(\?|$)/.test(u)) scripts.add(u);
    if (u.endsWith("/graphql") && r.method() === "POST" && !graphqlHeaders) {
      graphqlHeaders = r.headers();
    }
  });

  await page
    .goto(`https://next.quickmail.com/workspace/${WORKSPACE}/opportunities`, {
      waitUntil: "networkidle",
    })
    .catch(() => {});
  await page.waitForTimeout(8000);

  console.log(`scripts seen: ${scripts.size}`);
  console.log("\n=== headers on a real /graphql POST ===");
  for (const [k, v] of Object.entries<string>(graphqlHeaders ?? {})) {
    const redact = /cookie|authorization|token|csrf/i.test(k);
    console.log(`  ${k}: ${redact ? `<${v.length} chars>` : v}`);
  }

  // Fetch each bundle through the page so cookies and referer apply.
  const found: { kind: string; name: string; body: string }[] = [];
  for (const url of scripts) {
    const src = await page
      .evaluate(async (u) => (await fetch(u)).text(), url)
      .catch(() => "");
    if (!src) continue;
    for (const op of extractOperations(src)) {
      if (FILTER.test(op.name)) found.push(op);
    }
  }

  const unique = new Map<string, { kind: string; name: string; body: string }>();
  for (const op of found) if (!unique.has(op.name)) unique.set(op.name, op);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "operations.json"),
    JSON.stringify([...unique.values()], null, 2),
  );

  console.log(`\n=== ${unique.size} matching operations ===`);
  for (const op of unique.values()) console.log(`  ${op.kind} ${op.name}`);

  const mutations = [...unique.values()].filter((o) => o.kind === "mutation");
  console.log(`\n=== mutation bodies (${mutations.length}) ===`);
  for (const op of mutations) console.log("\n" + op.body.slice(0, 900));

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
