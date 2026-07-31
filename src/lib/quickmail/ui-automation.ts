import { chromium, type Browser, type Page } from "playwright";

/**
 * Drives the QuickMail web UI for the two things its API cannot do.
 *
 * Both APIs were checked exhaustively before resorting to this:
 *   v2 GraphQL — 23 mutations, 28 input objects, every enum. No trigger, and
 *                `paused` is writable only on steps, never on a campaign.
 *   v1 REST    — /v1/accounts/{id}/campaigns is a read-only list; /triggers,
 *                /automation, /pause, /resume, /start and PUT/PATCH all 404.
 *
 * So this clicks the UI. That is a deliberate trade, and a fragile one: it holds
 * a real login rather than an API key, and QuickMail can break it at any time by
 * changing their front-end. Three rules follow from that:
 *
 *   1. Off unless QUICKMAIL_UI_AUTOMATION=true. Never the default path.
 *   2. Never throw into campaign creation. A failure here must degrade to the
 *      manual instructions, not lose a campaign that was created successfully.
 *   3. Always verify through the API afterwards. A half-completed run that
 *      *looks* fine is the exact failure mode this project has been fighting —
 *      a campaign that reports success and silently sends nothing.
 */

const LOGIN_URL = "https://next.quickmail.com/login";

export type UiResult = {
  ok: boolean;
  unpaused: boolean;
  triggerSet: boolean;
  /** Human-readable trail, for surfacing in the API response. */
  log: string[];
  error?: string;
};

export function uiAutomationEnabled(): boolean {
  return (
    process.env.QUICKMAIL_UI_AUTOMATION === "true" &&
    Boolean(process.env.QUICKMAIL_UI_EMAIL) &&
    Boolean(process.env.QUICKMAIL_UI_PASSWORD)
  );
}

/** Why it is off, phrased for the person reading the response. */
export function uiAutomationStatus(): string {
  if (process.env.QUICKMAIL_UI_AUTOMATION !== "true") {
    return "QUICKMAIL_UI_AUTOMATION is not 'true'";
  }
  if (!process.env.QUICKMAIL_UI_EMAIL || !process.env.QUICKMAIL_UI_PASSWORD) {
    return "QUICKMAIL_UI_EMAIL / QUICKMAIL_UI_PASSWORD are not set";
  }
  return "enabled";
}

/**
 * Tries several ways to find one control.
 *
 * QuickMail ships no stable test ids, so a single selector would be one
 * redesign away from breaking. Each candidate is tried in turn and the first
 * visible match wins.
 */
async function firstVisible(page: Page, candidates: string[], timeoutMs = 4000) {
  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: "visible", timeout: timeoutMs });
      return locator;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

async function login(page: Page, log: string[]) {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  const email = await firstVisible(page, [
    'input[type="email"]',
    'input[name="email"]',
    'input[autocomplete="username"]',
  ]);
  const password = await firstVisible(page, [
    'input[type="password"]',
    'input[name="password"]',
  ]);
  if (!email || !password) throw new Error("Could not find the login form");

  await email.fill(process.env.QUICKMAIL_UI_EMAIL!);
  await password.fill(process.env.QUICKMAIL_UI_PASSWORD!);

  const submit = await firstVisible(page, [
    'button[type="submit"]',
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
  ]);
  if (!submit) throw new Error("Could not find the sign-in button");
  await submit.click();

  // Landing anywhere other than /login means the credentials were accepted.
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 30_000 });
  log.push("signed in");
}

/**
 * Unpauses a campaign from the status control in the page header, which reads
 * "Paused" with a dropdown next to it.
 */
async function unpause(page: Page, campaignUrl: string, log: string[]): Promise<boolean> {
  await page.goto(`${campaignUrl}/dashboard`, { waitUntil: "domcontentloaded" });

  const badge = await firstVisible(page, [
    'button:has-text("Paused")',
    '[role="button"]:has-text("Paused")',
    'text=Paused',
  ]);
  if (!badge) {
    log.push("no 'Paused' control found — assuming already running");
    return true;
  }

  await badge.click();
  const active = await firstVisible(page, [
    '[role="menuitem"]:has-text("Active")',
    '[role="option"]:has-text("Active")',
    'button:has-text("Active")',
    '[role="menuitem"]:has-text("Running")',
    'text=Active',
  ]);
  if (!active) {
    log.push("opened the status menu but found no 'Active' option");
    return false;
  }
  await active.click();
  log.push("clicked Active");
  return true;
}

/**
 * Adds a "start N leads per day" trigger on the Automation tab.
 *
 * This is the least predictable part of the flow — the form is the one piece of
 * QuickMail's UI we have never seen, so it is written to fail loudly rather than
 * guess. `--inspect` on the CLI dumps the real DOM so the selectors can be
 * corrected against it.
 */
async function setTrigger(
  page: Page,
  campaignUrl: string,
  leadsPerDay: number,
  log: string[],
): Promise<boolean> {
  await page.goto(`${campaignUrl}/automation`, { waitUntil: "domcontentloaded" });

  const add = await firstVisible(page, [
    'button:has-text("Add trigger")',
    'button:has-text("Add a trigger")',
    'button:has-text("New trigger")',
    'button:has-text("Add")',
  ]);
  if (!add) {
    log.push("no 'Add trigger' button found on the Automation tab");
    return false;
  }
  await add.click();

  const count = await firstVisible(page, [
    'input[type="number"]',
    'input[name*="lead" i]',
    'input[name*="count" i]',
  ]);
  if (count) {
    await count.fill(String(leadsPerDay));
    log.push(`set leads/day to ${leadsPerDay}`);
  } else {
    log.push("could not find the leads-per-day input");
  }

  const save = await firstVisible(page, [
    'button:has-text("Save")',
    'button:has-text("Create")',
    'button:has-text("Add")',
    'button[type="submit"]',
  ]);
  if (!save) {
    log.push("could not find a Save button for the trigger");
    return false;
  }
  await save.click();
  log.push("saved the trigger");
  return true;
}

/**
 * Runs both steps. Never throws — a caller mid-campaign-creation must not lose
 * a campaign because a button moved.
 */
export async function finishCampaignInUi(opts: {
  campaignUrl: string;
  leadsPerDay: number;
  /** Set true to watch it happen, for debugging selectors. */
  headed?: boolean;
}): Promise<UiResult> {
  const log: string[] = [];
  if (!uiAutomationEnabled()) {
    return { ok: false, unpaused: false, triggerSet: false, log, error: uiAutomationStatus() };
  }

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: opts.headed !== true });
    const page = await browser.newPage();
    page.setDefaultTimeout(15_000);

    await login(page, log);
    const triggerSet = await setTrigger(page, opts.campaignUrl, opts.leadsPerDay, log);
    const unpaused = await unpause(page, opts.campaignUrl, log);

    return { ok: triggerSet && unpaused, unpaused, triggerSet, log };
  } catch (error) {
    return {
      ok: false,
      unpaused: false,
      triggerSet: false,
      log,
      error: (error as Error).message,
    };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
