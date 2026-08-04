import { chromium, type Browser, type Locator, type Page } from "playwright";

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
  /**
   * Why QuickMail refused, when it refused for a reason it told us about.
   *
   * Going Live raises a "Campaign warnings" dialog for problems like a
   * deauthorized mailbox, and choosing "Go live anyway" does not override the
   * server — the campaign simply stays paused. Without capturing this, the
   * failure reads as a broken automation when it is actually an account
   * problem the user has to fix in QuickMail.
   */
  blockedBy?: string;
};

/**
 * Port of an Edge/Chrome the user launched themselves with
 * `--remote-debugging-port`. Attaching to their signed-in browser avoids
 * storing a QuickMail password anywhere, and avoids a second login.
 */
export const CDP_PORT = Number(process.env.QUICKMAIL_UI_CDP_PORT ?? 9222);

/** Is a debuggable browser listening right now? */
export async function cdpAvailable(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export function uiAutomationEnabled(): boolean {
  if (process.env.QUICKMAIL_UI_AUTOMATION !== "true") return false;
  // Attach mode needs no credentials; headless mode does.
  if (process.env.QUICKMAIL_UI_MODE === "attach") return true;
  return (
    Boolean(process.env.QUICKMAIL_UI_EMAIL) &&
    Boolean(process.env.QUICKMAIL_UI_PASSWORD)
  );
}

/** Why it is off, phrased for the person reading the response. */
export function uiAutomationStatus(): string {
  if (process.env.QUICKMAIL_UI_AUTOMATION !== "true") {
    return "QUICKMAIL_UI_AUTOMATION is not 'true'";
  }
  if (process.env.QUICKMAIL_UI_MODE === "attach") return "enabled (attach mode)";
  if (!process.env.QUICKMAIL_UI_EMAIL || !process.env.QUICKMAIL_UI_PASSWORD) {
    return "QUICKMAIL_UI_EMAIL / QUICKMAIL_UI_PASSWORD are not set";
  }
  return "enabled";
}

/**
 * Clicks something that may sit outside the viewport.
 *
 * QuickMail's popovers scroll internally, so Apply can be visible and enabled
 * yet still "outside of the viewport" as far as Playwright's actionability
 * check is concerned — it scrolls, re-measures, and retries until it times out.
 * Falling back to a direct DOM click skips that check. Kept as a fallback
 * rather than the default, because a real click also exercises the pointer
 * handlers an Angular component may depend on.
 */
async function clickAnyway(locator: Locator): Promise<void> {
  try {
    await locator.click({ timeout: 4000 });
  } catch {
    await locator.evaluate((el) => (el as HTMLElement).click());
  }
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

/**
 * Completes QuickMail's sign-in when the attached browser has been signed out.
 *
 * QuickMail authenticates through Google OAuth, and the browser profile usually
 * still holds a valid Google session even after the QuickMail one expires — so
 * clicking "Continue with Google" round-trips and lands back signed in with no
 * typing at all. Without this the automation simply reported that it could not
 * find the trigger button, because it was sitting on a login page.
 *
 * If Google does ask for a password or 2FA, this gives up rather than trying to
 * fill anything: that genuinely needs the human.
 */
async function ensureSignedIn(page: Page, log: string[]): Promise<boolean> {
  const signedOut = () =>
    page.url().includes("/login") || page.url().includes("accounts.google.com");
  if (!signedOut()) return true;

  const google = await firstVisible(
    page,
    [
      'a:has-text("Continue with Google"):visible',
      'button:has-text("Continue with Google"):visible',
    ],
    6000,
  );
  if (!google) {
    log.push("signed out of QuickMail and no Google sign-in button found");
    return false;
  }

  log.push("signed out — completing Google sign-in");
  await clickAnyway(google);

  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1500);
    if (!signedOut()) {
      log.push("signed in");
      return true;
    }
    // A password box means the session really is gone; stop and say so.
    if (
      page.url().includes("accounts.google.com") &&
      (await page.locator('input[type="password"]:visible').count()) > 0
    ) {
      log.push("Google is asking for a password — sign in by hand once, then re-run");
      return false;
    }
  }
  log.push("Google sign-in did not complete");
  return false;
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
 * Flips the header status control from Paused to Live.
 *
 * The control is a pill in the page header reading "Paused" with a chevron; it
 * opens a two-item menu, "Live" and "Paused", the current one ticked. QuickMail
 * calls the running state "Live", not "Active".
 */
async function unpause(
  page: Page,
  campaignUrl: string,
  log: string[],
  /** Set when QuickMail names the reason it will not go Live. */
  onBlocked: (reason: string) => void,
): Promise<boolean> {
  await page.goto(`${campaignUrl}/automation`, { waitUntil: "domcontentloaded" });
  if (!(await ensureSignedIn(page, log))) return false;

  // Same cold-start problem as the trigger: wait for the pill rather than sleep.
  const badge = await firstVisible(
    page,
    ['button:has-text("Paused"):visible', '[role="button"]:has-text("Paused"):visible'],
    25_000,
  );
  if (!badge) {
    // Already Live, or the pill has not rendered. Distinguish the two.
    const live = await firstVisible(page, ['button:has-text("Live"):visible'], 4000);
    if (live) {
      log.push("already Live");
      return true;
    }
    log.push("no status pill found in the header");
    return false;
  }

  /**
   * Listen for QuickMail's own answer before touching anything.
   *
   * The activation goes through a `setCampaignsLive` mutation that returns
   * `{ error: "..." }` with HTTP 200 on refusal. That body is the authoritative
   * reason and it is worth far more than the toast it produces — the toast
   * auto-dismisses and was routinely gone before it could be read, and the
   * confirmation dialog's own warning is a different, often unrelated problem.
   * On this account the dialog blamed a deauthorized mailbox while the real
   * refusal was "your plan doesn't allow for more than 20 live campaigns".
   */
  let serverError: string | null = null;
  page.on("response", (res) => {
    if (!res.url().includes("/graphql") || res.request().method() !== "POST") return;
    if (!/setCampaignsLive/.test(res.request().postData() ?? "")) return;
    void res
      .json()
      .then((j: { data?: { setCampaignsLive?: { error?: string | null } } }) => {
        const err = j?.data?.setCampaignsLive?.error;
        if (err) serverError = err;
      })
      .catch(() => undefined);
  });

  await clickAnyway(badge);
  await page.waitForTimeout(1200);

  /**
   * The dropdown items are bare <span>Live</span> / <span>Paused</span> with no
   * menu role, so role-based selectors find nothing. `:text-is` is required
   * rather than `has-text`, because "Paused" would otherwise also match the
   * pill that opened the menu.
   */
  const live = await firstVisible(
    page,
    ['span:text-is("Live"):visible', 'button:has-text("Live"):visible'],
    5000,
  );
  if (!live) {
    log.push("opened the status menu but found no 'Live' option");
    return false;
  }
  await clickAnyway(live);
  await page.waitForTimeout(2500);

  /**
   * Going Live can raise a "Campaign warnings" confirmation before it commits —
   * most often "Email account lost permission". Without answering it the switch
   * silently never happens: the click fires a request, the dialog waits, and
   * the campaign stays paused. That is exactly what made this look broken.
   *
   * "Go live anyway" is the deliberate choice: the caller asked for Live, and a
   * deauthorized mailbox is reported separately rather than silently cancelling
   * what was requested.
   */
  const confirm = await firstVisible(
    page,
    ['button:has-text("Go live anyway"):visible'],
    3500,
  );
  if (confirm) {
    const warning = await page
      .locator('[class*="modal"], [role="dialog"]')
      .first()
      .innerText()
      .catch(() => "");
    const detail = warning
      .replace(/\s+/g, " ")
      .replace(/Campaign warnings|Go to emails|Go live anyway|Cancel/g, "")
      .trim();
    log.push(`confirmation shown: ${detail.slice(0, 140)}`);
    await clickAnyway(confirm);
    await page.waitForTimeout(3000);
  }

  /**
   * Read the error QuickMail surfaces after the attempt.
   *
   * The dialog's warning is NOT necessarily the reason activation fails. On this
   * account the dialog said "Email account lost permission" while the real
   * refusal, returned by the setCampaignsLive mutation and shown in a toast,
   * was "Your plan doesn't allow for more than 20 live campaigns". Reporting the
   * dialog text would have kept pointing at the wrong problem, so the toast wins.
   */
  // Give the mutation a moment to land, then use what the server actually said.
  await page.waitForTimeout(2000);
  if (serverError) {
    log.push(`QuickMail refused: ${String(serverError).slice(0, 180)}`);
    onBlocked(String(serverError).slice(0, 220));
    return false;
  }

  /**
   * Poll for the change rather than checking once.
   *
   * Two reasons. With the menu open both "Live" and "Paused" spans exist, so an
   * in-place read reports whichever it finds first — an earlier version claimed
   * success while the API still said paused. And the switch does not always
   * commit immediately after the confirmation dialog: the same code failed on
   * one campaign and succeeded on another, purely on timing. Reloading between
   * attempts leaves only the header pill to inspect.
   */
  for (let attempt = 0; attempt < 4; attempt++) {
    // A slow reload must not abort the check; the next attempt retries.
    await page
      .reload({ waitUntil: "domcontentloaded", timeout: 30_000 })
      .catch(() => undefined);
    await page.waitForTimeout(3000);

    const paused = await page
      .locator('button:has(span:text-is("Paused")):visible')
      .count();
    const isLive = await page.locator('button:has(span:text-is("Live")):visible').count();

    if (paused === 0 && isLive > 0) {
      log.push("set to Live");
      return true;
    }
  }

  log.push("clicked Live but the pill still reads Paused");
  return false;
}

const ALL_DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

/**
 * Adds a trigger on the Automation tab.
 *
 * The "+ Trigger" button opens a "New trigger" popover containing a checkbox per
 * weekday (MONDAY..SUNDAY, Monday pre-ticked), a TIME field, a LEADS TO START
 * field defaulting to 0, and an Apply button that stays disabled until the form
 * is valid. Selectors below follow that structure rather than guessing at it.
 *
 * Days and time come from the campaign the agent built, so the trigger matches
 * the schedule the user actually asked for instead of QuickMail's defaults.
 */
async function setTrigger(
  page: Page,
  campaignUrl: string,
  leadsPerDay: number,
  days: string[],
  time: string,
  log: string[],
): Promise<boolean> {
  await page.goto(`${campaignUrl}/automation`, { waitUntil: "domcontentloaded" });
  // Navigation can bounce to the login page if the session lapsed mid-run.
  if (!(await ensureSignedIn(page, log))) return false;

  /**
   * Wait for the control, do not sleep a fixed amount.
   *
   * This runs immediately after the campaign is created, and QuickMail needs a
   * moment before a brand-new campaign renders — a 2s sleep found nothing and
   * reported "no '+ Trigger' button", while the same page loaded fine when
   * opened by hand seconds later. 25s covers the cold case without stalling the
   * warm one, since firstVisible returns as soon as the element appears.
   */
  const add = await firstVisible(
    page,
    ['button:has-text("Trigger"):visible', '[role="button"]:has-text("Trigger"):visible'],
    25_000,
  );
  if (!add) {
    log.push("no '+ Trigger' button found on the Automation tab");
    return false;
  }
  await add.click();

  /**
   * Wait for the popover by counting *visible* day checkboxes.
   *
   * Angular renders every popover into the DOM up-front and hides them, so the
   * page already contains 14 checkboxes, 3 time inputs and 2 Apply buttons
   * before anything is clicked — belonging to the Business days and Send time
   * forms as well as this one. Every selector here is `:visible`-scoped for
   * that reason; without it they match hidden controls that never resolve, and
   * clicks hang for the full 30s timeout.
   */
  let opened = false;
  for (let i = 0; i < 12; i++) {
    if ((await page.locator("input.checkbox__element:visible").count()) === 7) {
      opened = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  if (!opened) {
    log.push("clicked Trigger but the 'New trigger' form did not open");
    return false;
  }

  /**
   * Tick exactly the campaign's send days.
   *
   * Every day is set explicitly, including the ones to clear — Monday arrives
   * pre-ticked, so only setting the wanted days would leave a stray Monday on a
   * Tue/Thu campaign.
   *
   * The labels render as MONDAY but the DOM text is "Monday" — the uppercase is
   * CSS text-transform. Matching the rendered case finds nothing, so these go
   * through the label's `for` association instead of a text match.
   *
   * `.checkbox__element` matters too: a plain input[type=checkbox] selector also
   * catches the "Start campaign immediately" toggle sitting above the form.
   */
  const wanted = new Set(days.map((d) => d.toLowerCase()));

  /**
   * The seven `.checkbox__element` inputs are the day boxes, in Monday-first
   * order — that class excludes the "Start campaign immediately" toggle, which
   * is also an input[type=checkbox]. They are visually hidden behind styled
   * spans, so `setChecked` on the input misses; clicking the paired label is
   * what actually toggles them, and a stray click landing outside dismisses the
   * whole popover, which is what truncated earlier runs.
   */
  const boxes = page.locator("input.checkbox__element:visible");
  const labels = page.locator("label.checkbox__label:visible");
  const count = await boxes.count();
  if (count < ALL_DAYS.length) {
    log.push(`expected 7 day checkboxes, found ${count}`);
    return false;
  }

  let dayErrors = 0;
  for (let i = 0; i < ALL_DAYS.length; i++) {
    const want = wanted.has(ALL_DAYS[i]);
    try {
      if ((await boxes.nth(i).isChecked()) !== want) {
        await labels.nth(i).click();
        await page.waitForTimeout(150);
      }
    } catch {
      dayErrors++;
    }
  }
  if (dayErrors > 0) log.push(`could not set ${dayErrors} day checkbox(es)`);
  else log.push(`days: ${[...wanted].join(", ")}`);

  // Exactly one of each is visible while the popover is open.
  const timeBox = await firstVisible(page, ['input[type="time"]:visible'], 3000);
  if (timeBox) {
    await timeBox.fill(time);
    log.push(`time: ${time}`);
  } else {
    log.push("could not find the Time field");
  }

  // Leads to start — defaults to 0, which is why Apply starts disabled.
  const leadsBox = await firstVisible(page, ['input[type="number"]:visible'], 3000);
  if (!leadsBox) {
    log.push("could not find the Leads to start field");
    return false;
  }
  await leadsBox.fill(String(Math.max(1, leadsPerDay)));
  log.push(`leads to start: ${Math.max(1, leadsPerDay)}`);

  const apply = await firstVisible(page, ['button:has-text("Apply"):visible']);
  if (!apply) {
    log.push("could not find the Apply button");
    return false;
  }
  if (await apply.isDisabled().catch(() => false)) {
    log.push("Apply is still disabled — the form rejected these values");
    return false;
  }
  /**
   * Watch the page's own GraphQL traffic to see whether Apply was accepted.
   *
   * Two earlier signals both lied. "The popover closed" is wrong because it
   * deliberately stays open so more triggers can be added. Counting "Clear
   * triggers" controls is wrong because there is one per weekday row — always
   * seven, before and after. The request the click produces is the only
   * evidence that does not depend on guessing at UI conventions.
   */
  const applied = page
    .waitForResponse(
      (r) =>
        r.url().includes("/graphql") &&
        r.request().method() === "POST" &&
        r.status() === 200,
      { timeout: 12_000 },
    )
    .then(() => true)
    .catch(() => false);

  await clickAnyway(apply);
  const sawRequest = await applied;
  await page.waitForTimeout(2000);

  if (!sawRequest) {
    log.push("clicked Apply but no request was sent — the form did not submit");
    return false;
  }
  log.push("trigger applied");
  return true;
}

/**
 * Runs both steps. Never throws — a caller mid-campaign-creation must not lose
 * a campaign because a button moved.
 */
export async function finishCampaignInUi(opts: {
  campaignUrl: string;
  leadsPerDay: number;
  /** Campaign send days, so the trigger matches the schedule that was asked for. */
  days?: string[];
  /** Trigger time, HH:MM. Defaults to the start of the sending window. */
  time?: string;
  /** Set true to watch it happen, for debugging selectors. */
  headed?: boolean;
  /** Drive the browser the user already has open, instead of launching one. */
  attach?: boolean;
}): Promise<UiResult> {
  const log: string[] = [];
  if (!uiAutomationEnabled()) {
    return { ok: false, unpaused: false, triggerSet: false, log, error: uiAutomationStatus() };
  }

  const attach =
    process.env.QUICKMAIL_UI_MODE === "attach" || opts.attach === true;

  let browser: Browser | null = null;
  // Set in attach mode; restores the user's real rendering on the way out.
  let restoreMetrics: (() => Promise<unknown>) | null = null;
  try {
    let page: Page;

    if (attach) {
      /**
       * Drive the browser the user is already in.
       *
       * They are signed into QuickMail there, so there is no login step and no
       * password to store. It also means they can watch it happen, which for a
       * flow this fragile is a feature — a wrong click is visible immediately
       * rather than discovered later via a campaign that never sent.
       */
      if (!(await cdpAvailable())) {
        return {
          ok: false,
          unpaused: false,
          triggerSet: false,
          log,
          error:
            `No debuggable browser on port ${CDP_PORT}. Start Edge with ` +
            `--remote-debugging-port=${CDP_PORT} (see README) and sign in to QuickMail.`,
        };
      }
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
      const ctx = browser.contexts()[0];
      if (!ctx) throw new Error("Attached browser has no context");
      // Reuse a QuickMail tab if one is open, so their session and any
      // in-page state carry over; otherwise open a new tab beside their work.
      /**
       * Work in the window the user already has open.
       *
       * An existing QuickMail tab is reused so nothing new appears on screen.
       * Failing that, a localhost tab — the one running this app — is a good
       * second choice: it is the same window the user is looking at, so the
       * automation happens where they can see it. Only if neither exists does a
       * new tab get opened, and `newPage` adds a tab to the existing window
       * rather than spawning a separate one.
       */
      const pages = ctx.pages();
      page =
        pages.find((p) => p.url().includes("quickmail.com")) ??
        pages.find((p) => p.url().includes("localhost:3000")) ??
        (await ctx.newPage());

      /**
       * Render tall, regardless of the real window size.
       *
       * The trigger popover extends below the fold on a normal window, leaving
       * Apply "outside of the viewport" — Playwright then refuses to click it,
       * and even a forced click does nothing. Overriding the rendered metrics
       * puts the whole form on screen. It affects only what the page thinks it
       * has; the user's window is not resized.
       */
      const cdp = await ctx.newCDPSession(page);
      await cdp
        .send("Emulation.setDeviceMetricsOverride", {
          width: 1600,
          height: 1600,
          deviceScaleFactor: 1,
          mobile: false,
        })
        .catch(() => undefined);
      restoreMetrics = () =>
        cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => undefined);

      log.push("attached to the running browser");
    } else {
      browser = await chromium.launch({ headless: opts.headed !== true });
      page = await browser.newPage();
      await login(page, log);
    }

    page.setDefaultTimeout(15_000);

    /**
     * Land on QuickMail and sign in if needed, before looking for controls.
     *
     * Skipping this produced a misleading failure: the automation reported "no
     * '+ Trigger' button found" when it was in fact sitting on the login page.
     */
    if (attach) {
      if (!page.url().includes("quickmail.com")) {
        await page
          .goto(`${opts.campaignUrl}/automation`, { waitUntil: "domcontentloaded" })
          .catch(() => undefined);
        await page.waitForTimeout(2000);
      }
      if (!(await ensureSignedIn(page, log))) {
        return {
          ok: false,
          unpaused: false,
          triggerSet: false,
          log,
          error: "Not signed in to QuickMail in the attached browser",
        };
      }
    }

    const triggerSet = await setTrigger(
      page,
      opts.campaignUrl,
      opts.leadsPerDay,
      // Mon-Fri is the sane default if the campaign never specified days.
      opts.days?.length ? opts.days : ["monday", "tuesday", "wednesday", "thursday", "friday"],
      opts.time ?? "09:00",
      log,
    );
    let blockedBy: string | undefined;
    const unpaused = await unpause(page, opts.campaignUrl, log, (r) => {
      blockedBy = r;
    });

    return {
      ok: triggerSet && unpaused,
      unpaused,
      triggerSet,
      log,
      // Only meaningful if the switch actually failed.
      ...(unpaused ? {} : blockedBy ? { blockedBy } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      unpaused: false,
      triggerSet: false,
      log,
      error: (error as Error).message,
    };
  } finally {
    // Undo the render override before detaching, or the user is left with a
    // page laid out for a 1600px window inside a smaller one.
    await restoreMetrics?.();
    // For an attached browser this only drops the CDP connection; Playwright
    // leaves a browser it did not launch running, so the user's window and
    // tabs survive. For one we launched, it shuts it down.
    await browser?.close().catch(() => undefined);
  }
}
