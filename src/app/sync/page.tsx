import { PageHeader } from "@/components/page-header";
import { prisma } from "@/lib/prisma";
import {
  SYNC_INTERVAL_MS,
  isSyncRunning,
  lastSyncRun,
  nextSyncDueAt,
} from "@/lib/sync/run-all";
import { AutoSync, type SyncStatus } from "./auto-sync";
import { SyncPanel } from "./sync-panel";

export const dynamic = "force-dynamic";

export default async function SyncPage() {
  const [localLeads, localCampaigns, fromQuickmail, last, nextDueAt] =
    await Promise.all([
      prisma.lead.count(),
      prisma.campaign.count({ where: { quickmail_campaign_id: { not: null } } }),
      prisma.lead.count({ where: { quickmail_lead_id: { not: null } } }),
      lastSyncRun(),
      nextSyncDueAt(),
    ]);

  const status: SyncStatus = {
    intervalMs: SYNC_INTERVAL_MS,
    running: isSyncRunning(),
    last,
    nextDueAt,
  };

  return (
    <>
      <PageHeader
        title="Sync"
        description="Everything mirrors from QuickMail on the hour. Run a part by hand when you can't wait."
      />
      <div className="max-w-3xl space-y-6 p-8">
        <AutoSync initial={status} />
        <SyncPanel
          localLeads={localLeads}
          localCampaigns={localCampaigns}
          fromQuickmail={fromQuickmail}
        />
      </div>
    </>
  );
}
