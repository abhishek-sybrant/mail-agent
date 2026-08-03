import "dotenv/config";
import { chromium } from "playwright";
import {
  CDP_PORT,
  cdpAvailable,
  finishCampaignInUi,
  uiAutomationEnabled,
  uiAutomationStatus,
} from "../src/lib/quickmail/ui-automation";
import { query } from "../src/lib/quickmail/client";

/**
 * Sets a campaign's trigger and unpauses it by driving the QuickMail UI, then
 * verifies the result through the API.
 *
 *   npx tsx scripts/finish-campaign.ts <campaignUrl> [leadsPerDay]
 *   npx tsx scripts/finish-campaign.ts <campaignUrl> --headed     watch it run
 *   npx tsx scripts/finish-campaign.ts <campaignUrl> --inspect    dump the DOM
 *
 * `--inspect` exists because QuickMail's Automation tab is the one screen these
 * selectors were written blind against. It logs in, opens the tab and prints
 * every button, input and heading so the selectors can be fixed against reality
 * instead of guessed at twice.
 */

const args = process.argv.slice(2);
const campaignUrl = args.find((a) => a.startsWith("http"));
const headed = args.includes("--headed");
const inspect = args.includes("--inspect");
/** Drive the browser the user already has open and is signed into. */
const attach = args.includes("--attach") || process.env.QUICKMAIL_UI_MODE === "attach";
const leadsPerDay = Number(args.find((a) => /^\d+$/.test(a)) ?? 1);

if (!campaignUrl) {
  console.error(
    "usage: npx tsx scripts/finish-campaign.ts <campaignUrl> [leadsPerDay] [--attach|--headed|--inspect]",
  );
  process.exit(1);
}

/** Prints the interactive elements on both tabs so selectors can be corrected. */
async function inspectPages(url: string) {
  let browser;
  let page;

  if (attach) {
    // Reuse the signed-in browser rather than logging in again.
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const ctx = browser.contexts()[0];
    page =
      ctx.pages().find((p) => p.url().includes("quickmail.com")) ??
      (await ctx.newPage());
    console.log("attached to the running browser\n");
  } else {
    browser = await chromium.launch({ headless: !headed });
    page = await browser.newPage();
    await page.goto("https://next.quickmail.com/login", { waitUntil: "domcontentloaded" });
    await page.locator('input[type="email"], input[name="email"]').first()
      .fill(process.env.QUICKMAIL_UI_EMAIL!);
    await page.locator('input[type="password"]').first()
      .fill(process.env.QUICKMAIL_UI_PASSWORD!);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 30_000 });
    console.log("signed in\n");
  }
  page.setDefaultTimeout(20_000);

  for (const tab of ["automation", "dashboard"]) {
    await page.goto(`${url}/${tab}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500); // let the SPA settle
    console.log(`=== ${tab.toUpperCase()}`);

    const dump = await page.evaluate(() => {
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const describe = (el: Element) => {
        const a = el.getAttributeNames()
          .filter((n) => ["name", "type", "role", "placeholder", "aria-label", "id"].includes(n))
          .map((n) => `${n}="${el.getAttribute(n)}"`)
          .join(" ");
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
        return `<${el.tagName.toLowerCase()}${a ? " " + a : ""}>${text}`;
      };
      const grab = (sel: string) =>
        [...document.querySelectorAll(sel)].filter(visible).map(describe);
      return {
        buttons: grab('button, [role="button"]'),
        inputs: grab("input, select, textarea"),
        headings: grab("h1, h2, h3, h4"),
      };
    });

    for (const [kind, items] of Object.entries(dump)) {
      console.log(`  ${kind}:`);
      for (const i of items.slice(0, 40)) console.log(`    ${i}`);
    }
    await page.screenshot({ path: `_inspect-${tab}.png`, fullPage: true });
    console.log(`  screenshot -> _inspect-${tab}.png\n`);
  }
  await browser.close();
}

/** Reads campaign state back from the API — the UI's claim is not evidence. */
async function verify(url: string) {
  const numeric = url.match(/campaigns\/(\d+)/)?.[1];
  let cursor: string | null = null;

  for (let page = 0; page < 40; page++) {
    const after: string = cursor ? `, after: "${cursor}"` : "";
    const data = await query<{
      campaigns: {
        pageInfo: { hasNextPage: boolean; endCursor: string };
        nodes: {
          name: string;
          paused: boolean;
          appUrl: string;
          leadStatus: { total: number; active: number; available: number } | null;
          stats: { total: number } | null;
        }[];
      };
    }>(`{ campaigns(first: 10${after}) {
          pageInfo { hasNextPage endCursor }
          nodes { name paused appUrl
            leadStatus { total active available }
            stats { total } } } }`);

    const hit = data.campaigns.nodes.find(
      (n) => numeric && (n.appUrl ?? "").includes(numeric),
    );
    if (hit) {
      console.log("\n--- verified through the API");
      console.log(`  name   : ${hit.name}`);
      console.log(`  paused : ${hit.paused}${hit.paused ? "  <-- STILL PAUSED" : "  OK"}`);
      console.log(`  leads  : ${JSON.stringify(hit.leadStatus)}`);
      console.log(`  stats  : ${JSON.stringify(hit.stats)}`);
      // active>0 means the trigger admitted a lead; that is the real signal.
      if ((hit.leadStatus?.active ?? 0) > 0) {
        console.log("  trigger: appears to be working (a lead is active)");
      } else if ((hit.leadStatus?.available ?? 0) > 0) {
        console.log("  trigger: no lead admitted yet — may not be set");
      }
      return;
    }
    if (!data.campaigns.pageInfo.hasNextPage) break;
    cursor = data.campaigns.pageInfo.endCursor;
  }
  console.log("\ncould not find the campaign to verify");
}

async function main() {
  if (!uiAutomationEnabled()) {
    console.error(`UI automation is off: ${uiAutomationStatus()}`);
    console.error(
      "Set QUICKMAIL_UI_AUTOMATION=true, then either QUICKMAIL_UI_MODE=attach " +
        "(drive your own signed-in browser) or QUICKMAIL_UI_EMAIL/PASSWORD.",
    );
    process.exit(1);
  }

  if (attach && !(await cdpAvailable())) {
    console.error(`No debuggable browser on port ${CDP_PORT}.`);
    console.error("Close Edge, then relaunch it with:");
    console.error(
      `  & "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --remote-debugging-port=${CDP_PORT}`,
    );
    console.error("Sign in to QuickMail in that window, then re-run this.");
    process.exit(1);
  }

  if (inspect) {
    await inspectPages(campaignUrl!);
    return;
  }

  console.log(`finishing ${campaignUrl} (leads/day ${leadsPerDay})`);
  const r = await finishCampaignInUi({ campaignUrl: campaignUrl!, leadsPerDay, headed, attach });
  for (const line of r.log) console.log(`  ${line}`);
  if (r.error) console.error(`  error: ${r.error}`);
  console.log(`  trigger set: ${r.triggerSet} | unpaused: ${r.unpaused}`);

  await verify(campaignUrl!);
}

main();
