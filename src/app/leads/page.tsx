import Link from "next/link";
import { Upload } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { prisma } from "@/lib/prisma";
import { LeadsTable } from "./leads-table";
import { fmtNumber } from "@/lib/format";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

/**
 * Leads are paginated and filtered in the database, not in the browser.
 *
 * The workspace has ~48,000 leads; loading them all took 19.5s and shipped
 * megabytes of JSON to the client. Filters live in the URL so a view is
 * linkable and the server can answer with one page.
 */
export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>;
}) {
  const params = await searchParams;
  const q = (params.q ?? "").trim();
  const status = params.status ?? "ALL";
  const page = Math.max(1, Number(params.page) || 1);

  const where = {
    ...(status !== "ALL"
      ? { status: status as "UNCONTACTED" | "EMAILED" | "REPLIED" | "BOUNCED" | "DNC" | "MEETING_BOOKED" }
      : {}),
    ...(q
      ? {
          OR: [
            { email: { contains: q } },
            { name: { contains: q } },
            { company: { contains: q } },
          ],
        }
      : {}),
  };

  const [total, grandTotal, leads, campaigns, statusGroups] = await Promise.all([
    prisma.lead.count({ where }),
    prisma.lead.count(),
    prisma.lead.findMany({
      where,
      orderBy: [{ ai_intent_score: "desc" }, { created_at: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    // Offer a real choice instead of silently grabbing "the newest" — that
    // picked an arbitrary synced campaign and produced a confusing error.
    prisma.campaign.findMany({
      where: { quickmail_campaign_id: { not: null } },
      orderBy: [{ qm_paused: "asc" }, { qm_sent: "desc" }],
      take: 100,
      select: {
        id: true,
        name: true,
        qm_paused: true,
        qm_archived: true,
        qm_sent: true,
      },
    }),
    prisma.lead.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  // Live campaigns first — those are the ones you actually enrol into.
  const campaignOptions = campaigns
    .filter((c) => !c.qm_archived)
    .map((c) => ({
      id: c.id,
      name: c.name,
      paused: c.qm_paused ?? false,
      sent: c.qm_sent,
    }));

  const counts = Object.fromEntries(
    statusGroups.map((g) => [g.status as string, g._count._all]),
  );

  return (
    <>
      <PageHeader
        title="Leads"
        description={`${fmtNumber(grandTotal)} leads in the database`}
        action={
          <Button variant="outline" asChild>
            <Link href="/leads/import">
              <Upload className="size-4" />
              Import file
            </Link>
          </Button>
        }
      />
      <div className="p-8">
        {grandTotal === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground space-y-3 py-16 text-center text-sm">
              <p>No leads yet.</p>
              <div className="flex justify-center gap-2">
                <Button asChild size="sm">
                  <Link href="/sync">Sync from QuickMail</Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link href="/leads/import">Import a file</Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <LeadsTable
            campaigns={campaignOptions}
            query={q}
            status={status}
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            counts={counts}
            leads={leads.map((lead) => ({
              id: lead.id,
              email: lead.email,
              name: lead.name,
              company: lead.company,
              title: lead.title,
              status: lead.status,
              ai_intent_score: lead.ai_intent_score,
              source: lead.source,
              suppressed: lead.suppressed,
              created_at: lead.created_at.toISOString(),
            }))}
          />
        )}
      </div>
    </>
  );
}
