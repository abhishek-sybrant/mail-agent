/**
 * Records how QuickMail's own web app fetches inbound replies.
 *
 *   npx tsx scripts/capture-quickmail-inbox.ts
 *
 * The public APIs cannot supply reply content — verified against the live
 * account by scripts/probe-replies.ts:
 *
 *   v2 GraphQL  13 query fields, none carrying a message body. Replies exist
 *               only as counts on CampaignStats (replies / positive / negative).
 *   v1 REST     every reply-shaped path 404s.
 *
 * QuickMail's own front end obviously has the data, so this attaches to the
 * signed-in browser, opens the inbox, and writes down the exact GraphQL
 * operations it fires. Nothing is guessed: the captured operation is what the
 * sync will replay.
 *
 * Read-only. It clicks navigation, never a send or delete control.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { CDP_PORT } from "../src/lib/quickmail/ui-automation";

const OUT_DIR = path.join(process.cwd(), ".quickmail-capture");

/**
 * QuickMail calls the reply inbox "Opportunities". /inbox and /unibox 404 —
 * the nav on the signed-in dashboard is what identified the real route.
 */
const WORKSPACE = process.env.QUICKMAIL_WORKSPACE_ID ?? "54552";
const INBOX_PATHS = [`/workspace/${WORKSPACE}/opportunities`];

type Captured = {
  url: string;
  operationName: string | null;
  query: string | null;
  variables: unknown;
  status: number;
  /** Response, truncated — enough to see the shape without dumping the mail. */
  responsePreview: string;
  responseKeys: string[];
};

function summarise(value: unknown, depth = 0): string[] {
  if (depth > 3 || value === null || typeof value !== "object") return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out.push(k);
    if (Array.isArray(v)) {
      if (v.length > 0) out.push(...summarise(v[0], depth + 1).map((c) => `${k}[].${c}`));
    } else if (v && typeof v === "object") {
      out.push(...summarise(v, depth + 1).map((c) => `${k}.${c}`));
    }
  }
  return out;
}

async function main() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).catch(
    () => null,
  );
  if (!res?.ok) {
    console.error(
      [
        `No debuggable browser on port ${CDP_PORT}.`,
        "",
        "Close every Edge window (Edge ignores the flag if an instance is already",
        "running), then start it with:",
        "",
        `  & "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --remote-debugging-port=${CDP_PORT} --user-data-dir="D:\\MAIL_AGENT\\.edge-automation"`,
        "",
        "Sign in to QuickMail in that window, then run this again.",
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const ctx = browser.contexts()[0];
  const captured: Captured[] = [];

  const page: Page =
    ctx.pages().find((p) => p.url().includes("quickmail.com")) ??
    (await ctx.newPage());

  ctx.on("response", async (response) => {
    const url = response.url();
    if (!/graphql|\/api\//i.test(url)) return;

    const req = response.request();
    if (req.method() !== "POST") return;

    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(req.postData() ?? "{}");
    } catch {
      /* not JSON — skip */
    }

    let json: unknown = null;
    let preview = "";
    try {
      const text = await response.text();
      preview = text.slice(0, 1200);
      json = JSON.parse(text);
    } catch {
      /* binary or streamed */
    }

    captured.push({
      url,
      operationName: (body.operationName as string) ?? null,
      query: (body.query as string) ?? null,
      variables: body.variables ?? null,
      status: response.status(),
      responsePreview: preview,
      responseKeys: json ? Array.from(new Set(summarise(json))).slice(0, 120) : [],
    });
  });

  for (const p of INBOX_PATHS) {
    const target = `https://next.quickmail.com${p}`;
    console.log(`→ ${target}`);
    await page.goto(target, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(8000);
    console.log(`   landed on ${page.url()}`);
    console.log(
      "   visible:\n" +
        (await page.evaluate(() => document.body.innerText.slice(0, 900)))
          .split("\n")
          .map((l) => "     " + l)
          .join("\n"),
    );

    // Opening a conversation is what fetches the message body, so try hard to
    // land on a real row rather than a nav item.
    for (const sel of [
      '[class*="opportunit"]:visible',
      '[class*="conversation"]:visible',
      '[class*="thread"]:visible',
      "table tbody tr:visible",
      '[role="row"]:visible',
      "li:visible",
    ]) {
      const rows = page.locator(sel);
      const n = await rows.count().catch(() => 0);
      if (n === 0) continue;
      console.log(`   clicking first of ${n} × ${sel}`);
      await rows.first().click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(5000);
      break;
    }
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, "capture.json");
  await fs.writeFile(file, JSON.stringify(captured, null, 2));

  console.log(`\n${captured.length} POSTs captured → ${file}\n`);
  for (const c of captured) {
    console.log(
      `  ${c.status} ${c.operationName ?? "(anonymous)"}  ${new URL(c.url).pathname}`,
    );
    const interesting = c.responseKeys.filter((k) =>
      /repl|message|body|subject|thread|conversation|from|sender|received/i.test(k),
    );
    if (interesting.length) console.log(`      → ${interesting.slice(0, 15).join(", ")}`);
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
