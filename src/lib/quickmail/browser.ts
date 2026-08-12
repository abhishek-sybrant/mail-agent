import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The automation browser, owned by the server.
 *
 * Everything QuickMail cannot do over its API — reading replies, sending one,
 * setting a campaign trigger — is done by driving a signed-in browser. That
 * browser has always run on the machine hosting this app, never on the
 * visitor's: `connectOverCDP` dials 127.0.0.1, which from the server's point of
 * view is the server. Someone opening the dashboard from another machine needs
 * no Edge, no Playwright and no QuickMail login.
 *
 * What they did need was for somebody to have started that browser by hand, and
 * the old error told them to do it — advice that makes no sense read from a
 * different computer. So the server starts it itself, on demand, and only says
 * something when it genuinely needs a person: the one-time QuickMail sign-in,
 * which has to happen at the server's keyboard because no password is stored
 * anywhere.
 */

export const CDP_PORT = Number(process.env.QUICKMAIL_UI_CDP_PORT ?? 9222);

/** Set QUICKMAIL_BROWSER_AUTOSTART=false to go back to launching it by hand. */
function autostartEnabled(): boolean {
  return process.env.QUICKMAIL_BROWSER_AUTOSTART !== "false";
}

/**
 * Where the automation profile lives.
 *
 * A profile of its own, separate from anyone's daily browsing: the session it
 * holds has to survive the person at the server closing their own windows.
 */
export function profileDir(): string {
  return (
    process.env.QUICKMAIL_BROWSER_PROFILE ??
    path.join(process.cwd(), ".edge-automation")
  );
}

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/microsoft-edge",
  "/usr/bin/google-chrome",
];

function browserBinary(): string | null {
  const override = process.env.QUICKMAIL_BROWSER_PATH;
  if (override) return existsSync(override) ? override : null;
  return EDGE_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

/** Is a debuggable browser listening right now? */
export async function cdpAvailable(timeoutMs = 2000): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Only ever one launch in flight.
 *
 * A sync pass and a campaign trigger can both find the port dead within the
 * same second; without this they would each start a browser, and the second
 * would fail to bind the port and die confusingly.
 */
let launching: Promise<boolean> | null = null;

async function launch(): Promise<boolean> {
  const binary = browserBinary();
  if (!binary) return false;

  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir()}`,
    "--no-first-run",
    "--no-default-browser-check",
    /**
     * No extensions in the automation profile.
     *
     * Edge copies the machine's existing profile into a new user-data-dir, and
     * newly installed extensions open their own welcome tabs — which is why a
     * launch that was given one URL produced a window full of unrelated sites.
     * Nothing is deleted by this; the extensions are simply not loaded.
     */
    "--disable-extensions",
    "--restore-last-session=false",
    `https://next.quickmail.com/workspace/${process.env.QUICKMAIL_WORKSPACE_ID ?? "54552"}/opportunities`,
  ];

  /**
   * Detached, with its streams released.
   *
   * The browser has to outlive the request that started it, and a child still
   * holding a pipe to a dead parent dies of EPIPE the moment it logs anything.
   */
  const child = spawn(binary, args, { detached: true, stdio: "ignore" });
  child.unref();

  // Give it time to bind the port; Edge is slow on a cold profile.
  for (let i = 0; i < 30; i++) {
    if (await cdpAvailable(1000)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export type BrowserState = {
  ok: boolean;
  /** True when this call is what started it. */
  started: boolean;
  reason?: string;
};

/**
 * Guarantees a debuggable browser, starting one if there isn't one.
 *
 * Says nothing about whether it is signed in to QuickMail — that is the
 * caller's check, because the answer differs between reading the inbox and
 * driving the campaign editor.
 */
export async function ensureDebuggableBrowser(): Promise<BrowserState> {
  if (await cdpAvailable()) return { ok: true, started: false };

  if (!autostartEnabled()) {
    return {
      ok: false,
      started: false,
      reason: "browser autostart is off (QUICKMAIL_BROWSER_AUTOSTART=false)",
    };
  }

  if (!browserBinary()) {
    return {
      ok: false,
      started: false,
      reason:
        "no Microsoft Edge or Chrome found on the server — set QUICKMAIL_BROWSER_PATH to its executable",
    };
  }

  launching ??= launch().finally(() => {
    launching = null;
  });

  const ok = await launching;
  return ok
    ? { ok: true, started: true }
    : {
        ok: false,
        started: false,
        reason: `started a browser on the server but nothing answered on port ${CDP_PORT} within 30s`,
      };
}

/**
 * The host a person would have to walk over to, for the one thing that still
 * needs hands: signing in to QuickMail.
 */
export function serverLabel(): string {
  const url = process.env.APP_URL;
  if (url) {
    try {
      return `the machine running this app (${new URL(url).hostname})`;
    } catch {
      /* fall through to the generic wording */
    }
  }
  return "the machine running this app";
}
