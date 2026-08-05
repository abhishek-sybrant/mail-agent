import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { prisma } from "@/lib/prisma";
import { ApprovalCard, type ApprovalItem } from "./approval-card";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  // STOP_SEQUENCE is deliberately excluded: it is a decision about an inbound
  // reply, so it is answered next to that reply in /replies. Showing it here as
  // well would give the same decision two buttons with different consequences.
  const [approvals, stops] = await Promise.all([
    prisma.approval.findMany({
      where: { status: "PENDING", type: { not: "STOP_SEQUENCE" } },
      orderBy: [{ type: "asc" }, { created_at: "desc" }],
      include: { lead: true },
    }),
    prisma.approval.count({ where: { status: "PENDING", type: "STOP_SEQUENCE" } }),
  ]);

  const items: ApprovalItem[] = approvals.map((a) => {
    let incoming: string | null = null;
    try {
      incoming = a.payload
        ? ((JSON.parse(a.payload) as { incoming?: string }).incoming ?? null)
        : null;
    } catch {
      incoming = null;
    }

    return {
      id: a.id,
      type: a.type,
      title: a.title,
      summary: a.summary,
      aiDraft: a.ai_draft ?? "",
      incoming,
      createdAt: a.created_at.toISOString(),
      lead: a.lead
        ? {
            email: a.lead.email,
            name: a.lead.name,
            company: a.lead.company,
            intent: a.lead.ai_intent_score,
          }
        : null,
    };
  });

  return (
    <>
      <PageHeader
        title="Approvals"
        description={
          items.length === 0
            ? "Nothing waiting on you."
            : `${items.length} item${items.length === 1 ? "" : "s"} need your sign-off before anything sends.`
        }
      />
      <div className="max-w-4xl space-y-6 p-8">
        {items.length === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground py-16 text-center text-sm">
              Inbox zero.
              {stops > 0 ? (
                <>
                  {" "}
                  {stops} stop request{stops === 1 ? "" : "s"} waiting in{" "}
                  <Link href="/replies" className="underline">
                    Replies
                  </Link>
                  .
                </>
              ) : null}
            </CardContent>
          </Card>
        ) : (
          items.map((item) => <ApprovalCard key={item.id} item={item} />)
        )}
      </div>
    </>
  );
}
