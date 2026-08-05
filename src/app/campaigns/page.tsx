import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { isConfigured } from "@/lib/quickmail/client";
import { cachedCampaigns, relativeTime } from "@/lib/quickmail/cached";
import { CampaignTable } from "@/app/page";
import { prisma } from "@/lib/prisma";
import { AgentCampaigns, type AgentBuilt } from "./agent-campaigns";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 40;

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; show?: string }>;
}) {
  if (!isConfigured()) {
    return (
      <>
        <PageHeader title="Campaigns" />
        <div className="p-8">
          <Card>
            <CardContent className="text-muted-foreground py-12 text-center text-sm">
              Set <code>QUICKMAIL_API_KEY</code> to load campaigns.
            </CardContent>
          </Card>
        </div>
      </>
    );
  }

  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const show = params.show === "archived" ? "archived" : "active";

  const { campaigns, syncedAt } = await cachedCampaigns();

  /**
   * Locally-created campaigns that came from the AI agent.
   *
   * Read from the local table, not the QuickMail mirror: only this side knows
   * which conversation produced a campaign, and only the local id can be linked
   * to a detail page.
   */
  const agentRows = await prisma.campaign.findMany({
    where: { agent_conversation_id: { not: null } },
    orderBy: { created_at: "desc" },
    take: 25,
    include: { agentConversation: { select: { id: true, title: true, messages: true } } },
  });

  const agentBuilt: AgentBuilt[] = agentRows.map((c) => {
    let messageCount = 0;
    try {
      const parsed = JSON.parse(c.agentConversation?.messages ?? "[]") as unknown[];
      messageCount = Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      messageCount = 0;
    }
    return {
      id: c.id,
      name: c.name,
      createdAt: c.created_at,
      quickmailId: c.quickmail_campaign_id,
      conversationId: c.agentConversation?.id ?? null,
      messageCount,
      prompt: c.agentConversation?.title ?? null,
    };
  });

  const activeCount = campaigns.filter((c) => !c.archived).length;
  const archivedCount = campaigns.length - activeCount;

  // 312 campaigns is too many to render at once — it cost ~2.8s a page load.
  const filtered = campaigns
    .filter((c) => (show === "archived" ? c.archived : !c.archived))
    // Live campaigns first, then by volume.
    .sort(
      (a, b) =>
        Number(a.paused) - Number(b.paused) || b.stats.total - a.stats.total,
    );

  const lastPage = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const slice = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const href = (p: number, s: string) =>
    `/campaigns?show=${s}${p > 1 ? `&page=${p}` : ""}`;

  return (
    <>
      <PageHeader
        title="Campaigns"
        description={`${campaigns.length} campaigns · synced ${relativeTime(syncedAt)}`}
        action={
          <Button asChild>
            <Link href="/campaigns/new">Create campaign</Link>
          </Button>
        }
      />
      <div className="space-y-4 p-8">
        <AgentCampaigns built={agentBuilt} qm={campaigns} />

        <div className="flex flex-wrap items-center gap-2">
          <Button
            asChild
            size="sm"
            variant={show === "active" ? "default" : "outline"}
          >
            <Link href={href(1, "active")}>Active ({activeCount})</Link>
          </Button>
          <Button
            asChild
            size="sm"
            variant={show === "archived" ? "default" : "outline"}
          >
            <Link href={href(1, "archived")}>Archived ({archivedCount})</Link>
          </Button>
          <p className="text-muted-foreground ml-auto text-xs tabular-nums">
            Showing {slice.length} of {filtered.length} · live first, then busiest
          </p>
        </div>

        <Card>
          <CardContent className="pt-6">
            <CampaignTable campaigns={slice} />
          </CardContent>
        </Card>

        <div className="flex items-center justify-end gap-2">
          {page > 1 ? (
            <Button asChild size="sm" variant="outline">
              <Link href={href(page - 1, show)}>Previous</Link>
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled>
              Previous
            </Button>
          )}

          <span className="text-muted-foreground text-xs tabular-nums">
            {page} / {lastPage}
          </span>

          {page < lastPage ? (
            <Button asChild size="sm" variant="outline">
              <Link href={href(page + 1, show)}>Next</Link>
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled>
              Next
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
