import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { prisma } from "@/lib/prisma";
import { replyText } from "@/lib/quickmail/mail-text";
import { opportunityUrl } from "@/lib/quickmail/inbox";
import { RepliesList, type ReplyThread } from "../replies-list";

export const dynamic = "force-dynamic";

/**
 * One reply, on its own page.
 *
 * This is what the forwarded email links to. The list view would work, but it
 * opens on 138 threads and asks the reader to find the right one — a manager
 * arriving from an email wants the conversation they were just sent, already
 * open, with the actions in front of them.
 */
export default async function ReplyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const c = await prisma.qmConversation.findUnique({
    where: { id },
    include: {
      lead: { select: { id: true, suppressed: true, ai_intent_score: true } },
      messages: { orderBy: { sent_at: "desc" } },
    },
  });
  if (!c) notFound();

  const item: ReplyThread = {
    id: c.id,
    subject: c.subject,
    state: c.state,
    replyType: c.reply_type,
    isOoo: c.is_ooo,
    aiSummary: c.ai_summary,
    waitingSince: c.waiting_since?.toISOString() ?? null,
    canReply: Boolean(c.replyable_todo_id && c.inbox_id),
    qmUrl: opportunityUrl(c.id),
    inboxEmail: c.inbox_email,
    campaignName: c.campaign_name,
    prospect: {
      name: c.prospect_name,
      email: c.prospect_email ?? "",
      title: c.prospect_title,
      company: c.prospect_company,
    },
    doNotContact: c.do_not_contact,
    suppressed: c.lead?.suppressed ?? false,
    handledAt: c.handled_at?.toISOString() ?? null,
    handledAction: c.handled_action,
    forwardedAt: c.forwarded_at?.toISOString() ?? null,
    messages: c.messages.map((m) => ({
      id: m.id,
      direction: m.direction as "IN" | "OUT",
      subject: m.subject,
      text: replyText(m, 8000),
      fromName: m.from_name,
      fromEmail: m.from_email,
      toEmail: m.to_email,
      sentAt: m.sent_at?.toISOString() ?? null,
    })),
  };

  return (
    <>
      <PageHeader
        title={c.prospect_name ?? c.prospect_email ?? "Reply"}
        description={c.subject ?? "One conversation from QuickMail."}
      />
      <div className="max-w-5xl space-y-4 p-8">
        <Link
          href="/replies"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm"
        >
          <ArrowLeft className="size-4" />
          All replies
        </Link>

        <RepliesList
          items={[item]}
          bookingLink={process.env.BOOKING_LINK?.trim() || null}
          liveSending={process.env.QUICKMAIL_DRY_RUN === "false"}
          oooHidden={0}
          handledCount={0}
          includeOoo={false}
          includeHandled={false}
          query=""
          tone=""
          toneCounts={{ positive: 0, neutral: 0, negative: 0, all: 1 }}
          lastSync={c.synced_at.toISOString()}
          singleThread
        />
      </div>
    </>
  );
}
