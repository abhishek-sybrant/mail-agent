import { PageHeader } from "@/components/page-header";
import { prisma } from "@/lib/prisma";
import { RepliesList, type ReplyItem } from "./replies-list";

export const dynamic = "force-dynamic";

/**
 * The reply queue.
 *
 * Every inbound reply the app has captured, newest first, with the ones nobody
 * has dealt with yet at the top. Drafts are NOT generated here — a model call
 * per reply would put the whole page behind the slowest one, so the client asks
 * for a draft when a reviewer opens a reply.
 */
export default async function RepliesPage() {
  const logs = await prisma.emailLog.findMany({
    where: { type: "REPLIED" },
    // Unhandled-first is done below rather than in SQL: Prisma's `nulls`
    // ordering isn't available on SQLite.
    orderBy: { created_at: "desc" },
    take: 200,
    include: {
      lead: {
        include: {
          approvals: {
            where: { type: "STOP_SEQUENCE", status: "PENDING" },
            select: { id: true },
          },
        },
      },
      campaign: {
        select: {
          id: true,
          name: true,
          quickmail_campaign_id: true,
          steps: {
            where: { type: "EMAIL" },
            orderBy: { position: "asc" },
            take: 1,
            select: { subject: true },
          },
        },
      },
    },
  });

  const all: ReplyItem[] = logs.map((log) => ({
    logId: log.id,
    leadId: log.lead_id,
    name: log.lead.name,
    email: log.lead.email,
    company: log.lead.company,
    title: log.lead.title,
    intent: log.sentiment_score ?? log.lead.ai_intent_score,
    sentiment: log.sentiment,
    incoming: log.content?.trim() || "(empty reply)",
    receivedAt: log.created_at.toISOString(),
    subject: log.campaign?.steps[0]?.subject ?? null,
    campaign: log.campaign
      ? {
          id: log.campaign.id,
          name: log.campaign.name,
          quickmailId: log.campaign.quickmail_campaign_id,
        }
      : null,
    needsStopDecision: log.lead.approvals.length > 0,
    suppressed: log.lead.suppressed,
    handledAction: log.handled_action,
    handledAt: log.handled_at?.toISOString() ?? null,
  }));

  const pending = all.filter((i) => !i.handledAt);
  const items = [...pending, ...all.filter((i) => i.handledAt)];
  const open = pending.length;

  return (
    <>
      <PageHeader
        title="Replies"
        description={`${open} repl${open === 1 ? "y" : "ies"} waiting on you.`}
      />
      <div className="max-w-4xl p-8">
        <RepliesList items={items} bookingLink={process.env.BOOKING_LINK ?? null} />
      </div>
    </>
  );
}
