import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * QuickMail v2 GraphQL client.
 *
 * Endpoint and auth scheme were confirmed by probing the live API:
 *   POST https://api.quickmail.com/v2/graphql
 *   Authorization: <raw api key>        (no "Bearer" prefix — that fails)
 *
 * Reads are always allowed. Writes route through `mutate()`, which refuses to
 * run unless the caller has explicitly opted out of dry-run mode, because this
 * key points at a live production workspace with real sending domains.
 */

/**
 * The host QuickMail documents. `api.quickmail.io` also answers and was used
 * during development, but `.com` is the published one.
 * https://help.quickmail.com/integrations/setting-up-api-v2/
 */
const ENDPOINT = process.env.QUICKMAIL_URL ?? "https://api.quickmail.com/v2/graphql";

/**
 * QuickMail documents "10 requests per 10 seconds", and it is enforced
 * exactly — a burst of 20 returns precisely 10 successes and 10 throttles.
 *
 * The window is shared across *processes* via a small file, so the dev server
 * and any CLI script draw from the same budget. Pacing to
 * the real limit is *faster* than over-driving it: the earlier 5-per-second
 * sync spent most of its time in exponential backoff after being throttled.
 */
const LIMIT = 9; // one under the documented 10, for headroom
const WINDOW_MS = 10_000;
/**
 * Minimum gap between requests. Allowing a full burst of 10 and then another
 * as the window rolls put 20 inside the server's own window and got half of
 * them throttled — a steady drip does not.
 */
const MIN_GAP_MS = 1_150;

/**
 * The window lives in a file, not just memory, because the budget is per API
 * key — not per process. The dev server and a sync script are separate
 * processes; each honouring the limit alone still totals ~1.8 req/s and gets
 * throttled. A shared file makes them queue behind each other.
 */
const STATE_FILE = path.join(os.tmpdir(), "quickmail-ratelimit.json");
const LOCK_DIR = path.join(os.tmpdir(), "quickmail-ratelimit.lock");

/** mkdir is atomic on every platform, which makes it a serviceable mutex. */
async function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.mkdir(LOCK_DIR);
      break;
    } catch {
      // Break a lock abandoned by a crashed process.
      if (attempt > 40) {
        await fs.rm(LOCK_DIR, { recursive: true, force: true }).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(LOCK_DIR, { recursive: true, force: true }).catch(() => {});
  }
}

async function readWindow(): Promise<number[]> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as number[]) : [];
  } catch {
    return [];
  }
}

let chain: Promise<void> = Promise.resolve();

async function reserve(): Promise<void> {
  for (;;) {
    const wait = await withLock(async () => {
      const now = Date.now();
      const recent = (await readWindow())
        .filter((t) => now - t < WINDOW_MS)
        .sort((a, b) => a - b);

      const last = recent.length > 0 ? recent[recent.length - 1] : 0;
      const gapWait = Math.max(0, last + MIN_GAP_MS - now);
      const windowWait =
        recent.length >= LIMIT ? WINDOW_MS - (now - recent[0]) + 25 : 0;
      const needed = Math.max(gapWait, windowWait);

      if (needed === 0) {
        recent.push(now);
        await fs.writeFile(STATE_FILE, JSON.stringify(recent)).catch(() => {});
      }
      return needed;
    });

    if (wait === 0) return;
    await new Promise((r) => setTimeout(r, wait));
  }
}

/** Serialises slot-taking so concurrent callers can't claim the same gap. */
function takeSlot(): Promise<void> {
  const next = chain.then(reserve);
  // Keep the chain alive even if a caller rejects later.
  chain = next.catch(() => undefined);
  return next;
}

export class QuickMailError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "QuickMailError";
  }
}

/** Writes are blocked unless QUICKMAIL_DRY_RUN is explicitly "false". */
export function isDryRun(): boolean {
  return process.env.QUICKMAIL_DRY_RUN !== "false";
}

export function isConfigured(): boolean {
  return Boolean(process.env.QUICKMAIL_API_KEY);
}

/**
 * Campaign IDs this app is permitted to modify. Empty means "none" — a stray
 * request can't touch a live production campaign by accident.
 */
export function allowedCampaignIds(): string[] {
  return (process.env.QUICKMAIL_ALLOWED_CAMPAIGN_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function assertCampaignAllowed(campaignId: string) {
  const allowed = allowedCampaignIds();
  if (!allowed.includes(campaignId)) {
    throw new QuickMailError(
      `Campaign ${campaignId} is not in QUICKMAIL_ALLOWED_CAMPAIGN_IDS. ` +
        `Add it explicitly to allow writes.`,
    );
  }
}

type GraphQLResponse<T> = {
  data?: T;
  errors?: { message: string }[];
  error?: string;
};

/**
 * Transport-level retries.
 *
 * A full lead sync is ~4,800 sequential requests over about 90 minutes. A
 * single DNS hiccup used to abort the whole run — and since the sync always
 * restarts from cursor null, that meant losing everything done so far. This
 * only covers the connection failing outright; HTTP and GraphQL errors are
 * still surfaced immediately, because those are answers, not blips.
 */
const NET_RETRIES = 4;

async function request<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const key = process.env.QUICKMAIL_API_KEY;
  if (!key) throw new QuickMailError("QUICKMAIL_API_KEY is not set");

  let res: Response | null = null;
  let lastCause: unknown = null;

  for (let attempt = 1; attempt <= NET_RETRIES; attempt++) {
    // Inside the loop: a retry is a real request and must claim its own slot.
    await takeSlot();
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: key },
        body: JSON.stringify({ query, variables }),
        cache: "no-store",
      });
      break;
    } catch (cause) {
      lastCause = cause;
      if (attempt < NET_RETRIES) {
        const wait = 1_000 * 2 ** (attempt - 1); // 1s, 2s, 4s
        console.warn(
          `[quickmail] connection failed (attempt ${attempt}/${NET_RETRIES}), retrying in ${wait / 1000}s`,
        );
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  if (!res) {
    throw new QuickMailError(
      `Could not reach QuickMail after ${NET_RETRIES} attempts`,
      lastCause,
    );
  }

  // QuickMail returns an HTML error page on 5xx, so read text first and only
  // then try JSON — otherwise the real cause is swallowed by a parse error.
  const raw = await res.text();
  let json: GraphQLResponse<T> = {};
  try {
    json = JSON.parse(raw) as GraphQLResponse<T>;
  } catch {
    if (!res.ok) {
      const title = raw.match(/<title>([^<]+)<\/title>/)?.[1] ?? raw.slice(0, 120);
      throw new QuickMailError(
        `QuickMail returned ${res.status}: ${title.trim()}`,
      );
    }
    throw new QuickMailError("QuickMail returned a non-JSON response");
  }

  // QuickMail returns auth failures as a bare {error: "..."}, not GraphQL errors.
  if (json.error) throw new QuickMailError(json.error);
  if (json.errors?.length) {
    throw new QuickMailError(
      json.errors.map((e) => e.message).join("; "),
      json.errors,
    );
  }
  if (!res.ok) throw new QuickMailError(`QuickMail returned ${res.status}`);
  if (!json.data) throw new QuickMailError("QuickMail returned no data");

  return json.data;
}

/** Read-only query. Safe to call freely. */
export const query = request;

/**
 * Mutation gate. In dry-run mode (the default) nothing is sent — the query and
 * variables are logged and returned so the UI can show exactly what *would*
 * have run.
 */
export async function mutate<T>(
  label: string,
  gql: string,
  variables: Record<string, unknown>,
): Promise<{ dryRun: true; label: string; variables: unknown } | T> {
  if (isDryRun()) {
    console.log(`[quickmail:dry-run] ${label}`, JSON.stringify(variables));
    return { dryRun: true as const, label, variables };
  }
  console.log(`[quickmail:LIVE] ${label}`);
  return request<T>(gql, variables);
}
