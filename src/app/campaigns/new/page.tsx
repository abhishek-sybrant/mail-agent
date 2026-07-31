import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { prisma } from "@/lib/prisma";
import { cachedMailboxes } from "@/lib/quickmail/cached";
import { isConfigured, isDryRun } from "@/lib/quickmail/client";
import { CampaignForm } from "./campaign-form";

export const dynamic = "force-dynamic";

export default async function NewCampaignPage() {
  if (!isConfigured()) {
    return (
      <>
        <PageHeader title="Create campaign" />
        <div className="p-8">
          <Card>
            <CardContent className="text-muted-foreground py-12 text-center text-sm">
              Set <code>QUICKMAIL_API_KEY</code> in <code>.env</code> first.
            </CardContent>
          </Card>
        </div>
      </>
    );
  }

  // Everything here reads the local mirror. A live API call in this render path
  // made the page 500 whenever a sync held the rate limiter.
  const [{ mailboxes, workspaceId }, templates, leads] = await Promise.all([
    cachedMailboxes(),
    prisma.template.findMany({
      orderBy: { created_at: "desc" },
      select: { id: true, name: true, subject: true, body: true },
    }),
    prisma.lead.findMany({
      where: { suppressed: false, status: { in: ["UNCONTACTED", "EMAILED"] } },
      orderBy: [{ ai_intent_score: "desc" }, { created_at: "desc" }],
      take: 500,
      select: {
        id: true,
        email: true,
        name: true,
        company: true,
        status: true,
        ai_intent_score: true,
      },
    }),
  ]);

  if (mailboxes.length === 0) {
    return (
      <>
        <PageHeader title="Create campaign" />
        <div className="p-8">
          <Card className="border-amber-300 dark:border-amber-900">
            <CardContent className="space-y-3 py-10 text-center">
              <p className="text-sm font-medium">No sending mailboxes cached</p>
              <p className="text-muted-foreground text-xs">
                Run a sync to mirror your QuickMail mailboxes locally.
              </p>
              <Button asChild size="sm">
                <Link href="/sync">Go to sync</Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Create campaign"
        description="Compose the sequence, pick the leads, and build it in QuickMail."
      />
      <div className="p-8">
        <CampaignForm
          mailboxes={mailboxes}
          templates={templates}
          workspaceId={workspaceId}
          dryRunDefault={true}
          envLocked={isDryRun()}
          leads={leads.map((l) => ({
            id: l.id,
            email: l.email,
            name: l.name,
            company: l.company,
            status: l.status,
            intent: l.ai_intent_score,
          }))}
        />
      </div>
    </>
  );
}
