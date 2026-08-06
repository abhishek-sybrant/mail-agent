import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { prisma } from "@/lib/prisma";
import { ApprovalCard, type ApprovalItem } from "./approval-card";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  /**
   * Stop decisions are included.
   *
   * They were briefly hidden here on the grounds that they belong next to the
   * reply — but a decision raised by the webhook has no mirrored thread to sit
   * beside, so hiding it here meant an opt-out could sit unanswered and unseen.
   * Nothing is barred without a person, which only works if the person can see
   * the queue.
   */
  const approvals = await prisma.approval.findMany({
    where: { status: "PENDING" },
    orderBy: [{ type: "asc" }, { created_at: "desc" }],
    include: { lead: true },
  });

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
            : `${items.length} item${items.length === 1 ? "" : "s"} need your sign-off before anything sends or stops.`
        }
      />
      <div className="max-w-4xl space-y-6 p-8">
        {items.length === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground py-16 text-center text-sm">
              Inbox zero. Reply threads from QuickMail are in{" "}
              <Link href="/replies" className="underline">
                Replies
              </Link>
              .
            </CardContent>
          </Card>
        ) : (
          items.map((item) => <ApprovalCard key={item.id} item={item} />)
        )}
      </div>
    </>
  );
}
