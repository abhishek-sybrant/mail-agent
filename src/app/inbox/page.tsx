import { PageHeader } from "@/components/page-header";
import { draftReply } from "@/lib/ai-draft";
import { prisma } from "@/lib/prisma";
import { InboxList, type InboxItem } from "./inbox-list";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const leads = await prisma.lead.findMany({
    where: { status: "REPLIED" },
    orderBy: { ai_intent_score: "desc" },
    include: {
      emailLogs: {
        where: { type: "REPLIED" },
        orderBy: { created_at: "desc" },
        take: 1,
      },
    },
  });

  const items: InboxItem[] = leads
    // A lead can only be triaged if we actually captured the inbound message.
    .filter((lead) => lead.emailLogs.length > 0)
    .map((lead) => {
      const log = lead.emailLogs[0];
      const incoming = log.content ?? "(empty reply)";

      return {
        leadId: lead.id,
        name: lead.name,
        email: lead.email,
        company: lead.company,
        intent: lead.ai_intent_score,
        incoming,
        receivedAt: log.created_at.toISOString(),
        draft: draftReply({
          name: lead.name,
          company: lead.company,
          incoming,
          intent: lead.ai_intent_score,
        }),
      };
    });

  return (
    <>
      <PageHeader
        title="AI Inbox"
        description={`${items.length} repl${items.length === 1 ? "y" : "ies"} waiting on human review before send.`}
      />
      <div className="max-w-4xl p-8">
        <InboxList items={items} />
      </div>
    </>
  );
}
