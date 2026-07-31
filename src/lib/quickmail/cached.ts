import { prisma } from "@/lib/prisma";
import type { QmCampaign } from "./queries";

/**
 * Reads campaign stats from the local mirror instead of the QuickMail API.
 *
 * The API caps pages at 10 records and rate-limits bursts, so a live call per
 * page view is both slow and fragile — during a lead sync it fails outright.
 * The sync writes these rows; pages read them and show how stale they are.
 */
export async function cachedCampaigns(): Promise<{
  campaigns: QmCampaign[];
  syncedAt: Date | null;
}> {
  const rows = await prisma.campaign.findMany({
    where: { quickmail_campaign_id: { not: null } },
    orderBy: { qm_sent: "desc" },
  });

  const campaigns: QmCampaign[] = rows.map((r) => ({
    id: r.quickmail_campaign_id!,
    name: r.name,
    paused: r.qm_paused ?? false,
    archived: r.qm_archived,
    createdAt: r.created_at.toISOString(),
    appUrl: r.qm_app_url,
    leadStatus: {
      total: r.qm_leads_total,
      active: null,
      available: null,
      completed: null,
      failed: null,
    },
    stats: {
      total: r.qm_sent,
      delivered: r.qm_delivered,
      opens: r.qm_opens,
      clicks: r.qm_clicks,
      replies: r.qm_replies,
      repliesPositive: r.qm_replies_pos,
      repliesNegative: 0,
      bounces: r.qm_bounces,
      unsubscribes: r.qm_unsubscribes,
    },
  }));

  const syncedAt = rows
    .map((r) => r.synced_at)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

  return { campaigns, syncedAt };
}

/** Locally mirrored sending mailboxes — never an API call in a render path. */
export async function cachedMailboxes(): Promise<{
  mailboxes: { id: string; email: string; assignable: boolean | null }[];
  workspaceId: string | null;
}> {
  const rows = await prisma.qmMailbox.findMany({
    // Known-good mailboxes first, then untried, then known-bad.
    orderBy: [{ assignable: "desc" }, { email: "asc" }],
  });
  return {
    mailboxes: rows.map((r) => ({
      id: r.id,
      email: r.email,
      assignable: r.assignable,
    })),
    workspaceId: rows[0]?.workspace_id ?? null,
  };
}

export function relativeTime(date: Date | null): string {
  if (!date) return "never";
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
