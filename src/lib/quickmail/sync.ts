import { prisma } from "@/lib/prisma";
import { query } from "./client";
import { fetchCampaigns, fetchEmailAccounts, fetchWorkspaces } from "./queries";

/**
 * Pulls QuickMail's own records into the local database.
 *
 * The workspace holds tens of thousands of leads, so this is cursor-paginated
 * and resumable: each call processes a bounded number of pages and hands back
 * a cursor. The caller loops until `hasNext` is false, which keeps any single
 * request well inside its timeout and lets the UI show real progress.
 */

/**
 * QuickMail hard-caps `first` at 10 regardless of what you ask for — verified
 * by probing 25/50/100/200/500, all of which return 10 nodes. A full sync of
 * this workspace is therefore ~4,800 requests, which is why it's resumable.
 */
const PAGE_SIZE = 10;

type QmLeadNode = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  title: string | null;
  role: string | null;
  location: string | null;
  phone: string | null;
  score: number | null;
};

const LEADS_PAGE = `
  query LeadsPage($first: Int!, $after: String) {
    leads(first: $first, after: $after) {
      totalCount
      pageInfo { endCursor hasNextPage }
      nodes {
        id email firstName lastName fullName
        title role location phone score
      }
    }
  }
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * QuickMail throttles bursts — 200 requests in 8s returns "Too many requests",
 * while a paced sequence of the same volume succeeds. This paces requests and
 * backs off exponentially when the limiter does trip, so a long sync rides
 * through it instead of aborting halfway.
 */
async function throttled<T>(fn: () => Promise<T>): Promise<T> {
  let delay = 1000;

  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const message = (error as Error).message ?? "";
      if (!/too many requests|rate limit/i.test(message)) throw error;
      await sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }
  }
  throw new Error("QuickMail rate limit did not clear after 6 retries");
}

/**
 * No manual pacing here any more: the client enforces QuickMail's documented
 * 10-requests-per-10-seconds budget for every caller.
 */

export type LeadSyncResult = {
  totalCount: number;
  processed: number;
  imported: number;
  updated: number;
  skipped: number;
  cursor: string | null;
  hasNext: boolean;
};

export async function syncLeads(opts: {
  cursor?: string | null;
  maxPages?: number;
}): Promise<LeadSyncResult> {
  // 10 leads a page means a lot of pages; allow big batches per request so the
  // client isn't making thousands of round trips of its own.
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? 200, 1000));

  let cursor = opts.cursor ?? null;
  let hasNext = true;
  let totalCount = 0;
  let processed = 0;
  let imported = 0;
  let updated = 0;
  let skipped = 0;

  for (let page = 0; page < maxPages && hasNext; page++) {
    const data = await throttled(() =>
      query<{
        leads: {
          totalCount: number;
          pageInfo: { endCursor: string | null; hasNextPage: boolean };
          nodes: QmLeadNode[];
        };
      }>(LEADS_PAGE, { first: PAGE_SIZE, after: cursor }),
    );

    totalCount = data.leads.totalCount;
    cursor = data.leads.pageInfo.endCursor;
    hasNext = data.leads.pageInfo.hasNextPage;

    const nodes = data.leads.nodes;
    processed += nodes.length;
    if (nodes.length === 0) break;

    // Normalise and drop anything without a usable address rather than
    // letting a blank email collide on the unique index.
    const rows = nodes
      .map((n) => ({
        quickmail_lead_id: n.id,
        email: (n.email ?? "").trim().toLowerCase(),
        first_name: n.firstName,
        last_name: n.lastName,
        name: n.fullName?.trim() || null,
        title: n.title ?? n.role,
        phone: n.phone,
        location: n.location,
        ai_intent_score: n.score ?? 0,
      }))
      .filter((r) => r.email.includes("@"));

    skipped += nodes.length - rows.length;

    // Dedupe inside the page — the same address can appear across campaigns.
    const byEmail = new Map(rows.map((r) => [r.email, r]));
    const emails = [...byEmail.keys()];

    const existing = await prisma.lead.findMany({
      where: { email: { in: emails } },
      select: { id: true, email: true, quickmail_lead_id: true },
    });
    const known = new Map(existing.map((e) => [e.email, e.id]));

    // Only touch rows that haven't been linked yet. Re-running the sync
    // otherwise means tens of thousands of pointless single-row writes.
    const needsLink = existing.filter((e) => e.quickmail_lead_id === null);

    const fresh = emails.filter((e) => !known.has(e)).map((e) => byEmail.get(e)!);

    if (fresh.length > 0) {
      const created = await prisma.lead.createMany({
        data: fresh.map((r) => ({ ...r, source: "QUICKMAIL" as const })),
      });
      imported += created.count;
    }

    // Backfill the QuickMail ID onto leads we already had locally, so future
    // enrolments reuse their record instead of creating a duplicate there.
    for (const e of needsLink) {
      const row = byEmail.get(e.email);
      if (!row) continue;
      await prisma.lead.update({
        where: { id: e.id },
        data: {
          quickmail_lead_id: row.quickmail_lead_id,
          first_name: row.first_name ?? undefined,
          last_name: row.last_name ?? undefined,
          title: row.title ?? undefined,
          phone: row.phone ?? undefined,
          location: row.location ?? undefined,
        },
      });
      updated++;
    }
  }

  return { totalCount, processed, imported, updated, skipped, cursor, hasNext };
}

/**
 * Mirrors sending mailboxes and the workspace ID locally.
 *
 * The campaign composer needs these on every render; hitting the API there
 * makes the page fail whenever a sync is holding the rate limiter.
 */
export async function syncMailboxes() {
  const [accounts, workspaces] = await Promise.all([
    fetchEmailAccounts(),
    fetchWorkspaces(),
  ]);
  const workspaceId = workspaces[0]?.id ?? null;

  for (const a of accounts) {
    await prisma.qmMailbox.upsert({
      where: { id: a.id },
      update: {
        email: a.email,
        workspace_id: workspaceId,
        authorized: a.authorized ?? null,
        qm_paused: a.paused ?? null,
        synced_at: new Date(),
      },
      create: {
        id: a.id,
        email: a.email,
        workspace_id: workspaceId,
        authorized: a.authorized ?? null,
        qm_paused: a.paused ?? null,
      },
    });
  }

  // Drop mailboxes that no longer exist in QuickMail.
  await prisma.qmMailbox.deleteMany({
    where: { id: { notIn: accounts.map((a) => a.id) } },
  });

  return { total: accounts.length, workspaceId };
}

/** Mirrors QuickMail's campaigns into the local Campaign table. */
export async function syncCampaigns() {
  const campaigns = await fetchCampaigns();
  let imported = 0;
  let updated = 0;

  for (const c of campaigns) {
    const existing = await prisma.campaign.findFirst({
      where: { quickmail_campaign_id: c.id },
    });

    const status: "PAUSED" | "ACTIVE" = c.paused ? "PAUSED" : "ACTIVE";

    // Some campaigns (mostly archived ones) come back with null stats.
    const st = c.stats ?? {
      total: 0, delivered: 0, opens: 0, clicks: 0,
      replies: 0, repliesPositive: 0, repliesNegative: 0,
      bounces: 0, unsubscribes: 0,
    };

    const data = {
      name: c.name,
      status,
      quickmail_campaign_id: c.id,
      qm_paused: c.paused,
      qm_archived: c.archived ?? false,
      qm_leads_total: c.leadStatus?.total ?? 0,
      qm_sent: st.total ?? 0,
      qm_delivered: st.delivered ?? 0,
      qm_opens: st.opens ?? 0,
      qm_clicks: st.clicks ?? 0,
      qm_replies: st.replies ?? 0,
      qm_replies_pos: st.repliesPositive ?? 0,
      qm_bounces: st.bounces ?? 0,
      qm_unsubscribes: st.unsubscribes ?? 0,
      qm_app_url: c.appUrl,
      synced_at: new Date(),
    };

    if (existing) {
      await prisma.campaign.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.campaign.create({ data });
      imported++;
    }
  }

  return { total: campaigns.length, imported, updated };
}
