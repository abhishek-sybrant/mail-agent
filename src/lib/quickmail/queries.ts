import { query } from "./client";

export type CampaignStats = {
  total: number;
  delivered: number;
  opens: number;
  clicks: number;
  replies: number;
  repliesPositive: number;
  repliesNegative: number;
  bounces: number;
  unsubscribes: number;
};

export type LeadStatusCounts = {
  total: number | null;
  active: number | null;
  available: number | null;
  completed: number | null;
  failed: number | null;
};

export type QmCampaign = {
  id: string;
  name: string;
  paused: boolean;
  /** Archived campaigns still carry stats and must be counted in totals. */
  archived?: boolean;
  createdAt: string;
  appUrl: string | null;
  leadStatus: LeadStatusCounts | null;
  stats: CampaignStats;
};

export type QmEmailAccount = {
  id: string;
  email: string;
  /** False when the OAuth connection has expired or been revoked. */
  authorized?: boolean | null;
  paused?: boolean | null;
};

export type QmWorkspace = {
  id: string;
  name: string;
};

const CAMPAIGN_FIELDS = `
  id
  name
  paused
  createdAt
  appUrl
  leadStatus { total active available completed failed }
  stats {
    total delivered opens clicks
    replies repliesPositive repliesNegative
    bounces unsubscribes
  }
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries through the burst limiter with exponential backoff. */
async function withBackoff<T>(fn: () => Promise<T>): Promise<T> {
  let delay = 1000;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!/too many requests|rate limit/i.test((error as Error).message ?? ""))
        throw error;
      await sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }
  }
  throw new Error("QuickMail rate limit did not clear after 6 retries");
}

/**
 * Fetches every campaign, active and archived.
 *
 * Two traps here, both found by comparing against QuickMail's own UI:
 *  - `campaigns` caps at 10 per page exactly like `leads`, regardless of the
 *    `first` value. Asking for 100 silently returns 10.
 *  - Omitting `archived` returns only non-archived campaigns, so archived
 *    history vanishes from every total.
 */
async function fetchCampaignPage(
  archived: boolean,
): Promise<QmCampaign[]> {
  const out: QmCampaign[] = [];
  let after: string | null = null;

  for (;;) {
    const data: {
      campaigns: {
        pageInfo: { endCursor: string | null; hasNextPage: boolean };
        nodes: QmCampaign[];
      };
    } = await withBackoff(() =>
      query(
      `query Campaigns($after: String, $arch: Boolean) {
         campaigns(first: 10, after: $after, archived: $arch) {
           pageInfo { endCursor hasNextPage }
           nodes { ${CAMPAIGN_FIELDS} }
         }
       }`,
      { after, arch: archived },
    ));

    out.push(...data.campaigns.nodes.map((c) => ({ ...c, archived })));
    if (!data.campaigns.pageInfo.hasNextPage) break;
    after = data.campaigns.pageInfo.endCursor;
  }

  return out;
}

export async function fetchCampaigns(): Promise<QmCampaign[]> {
  // Sequential, not parallel — two concurrent walks double the request rate
  // and trip the burst limiter immediately.
  const active = await fetchCampaignPage(false);
  const archived = await fetchCampaignPage(true);
  return [...active, ...archived];
}

export async function fetchCampaign(id: string): Promise<QmCampaign | null> {
  const data = await query<{ campaign: QmCampaign | null }>(
    `query Campaign($id: ID!) { campaign(id: $id) { ${CAMPAIGN_FIELDS} } }`,
    { id },
  );
  return data.campaign;
}

/**
 * Every sending mailbox, paginated.
 *
 * `emailAccounts` is subject to the same undocumented 10-per-page cap as leads
 * and campaigns: `first: 100` silently returns 10 rather than erroring. That
 * looked harmless until syncMailboxes() started deleting local rows absent from
 * the response — with 17 mailboxes on the account it saw 10 and removed 7,
 * which is why senders disappeared from the picker. Anything that drives a
 * delete has to walk the cursor.
 */
export async function fetchEmailAccounts(): Promise<QmEmailAccount[]> {
  const out: QmEmailAccount[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 50; page++) {
    const after: string = cursor ? `, after: "${cursor}"` : "";
    const data = await query<{
      emailAccounts: {
        pageInfo: { hasNextPage: boolean; endCursor: string };
        nodes: QmEmailAccount[];
      };
    }>(`{ emailAccounts(first: 10${after}) {
          pageInfo { hasNextPage endCursor }
          nodes { id email authorized paused } } }`);

    out.push(...data.emailAccounts.nodes);
    if (!data.emailAccounts.pageInfo.hasNextPage) break;
    cursor = data.emailAccounts.pageInfo.endCursor;
  }

  return out;
}

export async function fetchWorkspaces(): Promise<QmWorkspace[]> {
  const data = await query<{ workspaces: { nodes: QmWorkspace[] } }>(
    `{ workspaces(first: 50) { nodes { id name } } }`,
  );
  return data.workspaces.nodes;
}

/** Sums per-campaign stats into account-wide totals. */
export function aggregate(campaigns: QmCampaign[]): CampaignStats {
  const zero: CampaignStats = {
    total: 0,
    delivered: 0,
    opens: 0,
    clicks: 0,
    replies: 0,
    repliesPositive: 0,
    repliesNegative: 0,
    bounces: 0,
    unsubscribes: 0,
  };

  return campaigns.reduce((acc, c) => {
    for (const key of Object.keys(zero) as (keyof CampaignStats)[]) {
      acc[key] += c.stats?.[key] ?? 0;
    }
    return acc;
  }, zero);
}

/** Percentage helper that treats a zero denominator as 0 rather than NaN. */
export function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? (numerator / denominator) * 100 : 0;
}

export type Severity = "ok" | "warn" | "critical";

/**
 * Deliverability thresholds. Industry consensus puts a healthy hard-bounce rate
 * under ~2%; above 5% mailbox providers start throttling or blocking the
 * sending domain, which is why this escalates hard.
 */
export function bounceSeverity(bounceRate: number): Severity {
  if (bounceRate >= 5) return "critical";
  if (bounceRate >= 2) return "warn";
  return "ok";
}

/** Reply rate below ~1% usually means targeting or copy is off, not deliverability. */
export function replySeverity(replyRate: number): Severity {
  if (replyRate < 0.5) return "critical";
  if (replyRate < 1) return "warn";
  return "ok";
}
