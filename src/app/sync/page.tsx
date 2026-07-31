import { PageHeader } from "@/components/page-header";
import { prisma } from "@/lib/prisma";
import { SyncPanel } from "./sync-panel";

export const dynamic = "force-dynamic";

export default async function SyncPage() {
  const [localLeads, localCampaigns, fromQuickmail] = await Promise.all([
    prisma.lead.count(),
    prisma.campaign.count({ where: { quickmail_campaign_id: { not: null } } }),
    prisma.lead.count({ where: { quickmail_lead_id: { not: null } } }),
  ]);

  return (
    <>
      <PageHeader
        title="Sync"
        description="Pull your QuickMail campaigns and leads into the local database."
      />
      <div className="max-w-3xl p-8">
        <SyncPanel
          localLeads={localLeads}
          localCampaigns={localCampaigns}
          fromQuickmail={fromQuickmail}
        />
      </div>
    </>
  );
}
