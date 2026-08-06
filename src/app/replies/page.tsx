import { PageHeader } from "@/components/page-header";
import { prisma } from "@/lib/prisma";
import { replyText } from "@/lib/quickmail/mail-text";
import { RepliesList, type ReplyThread } from "./replies-list";

export const dynamic = "force-dynamic";

/**
 * The reply queue — real mail, mirrored from QuickMail.
 *
 * Reads the local mirror rather than QuickMail directly. The source is an
 * undocumented endpoint behind a browser session; it is far too slow and too
 * fragile to sit in a page render. `npm run sync-replies` refreshes it.
 */
export default async function RepliesPage({
  searchParams,
}: {
  searchParams: Promise<{ ooo?: string; show?: string }>;
}) {
  const params = await searchParams;
  const includeOoo = params.ooo === "1";
  const includeHandled = params.show === "all";

  const conversations = await prisma.qmConversation.findMany({
    where: {
      ...(includeOoo ? {} : { is_ooo: false }),
      ...(includeHandled ? {} : { handled_at: null }),
    },
    orderBy: { waiting_since: "desc" },
    take: 200,
    include: {
      lead: { select: { id: true, suppressed: true, ai_intent_score: true } },
      messages: { orderBy: { sent_at: "desc" } },
    },
  });

  const [totalOoo, totalHandled, lastSync] = await Promise.all([
    prisma.qmConversation.count({ where: { is_ooo: true, handled_at: null } }),
    prisma.qmConversation.count({ where: { NOT: { handled_at: null } } }),
    prisma.qmConversation.aggregate({ _max: { synced_at: true } }),
  ]);

  const items: ReplyThread[] = conversations.map((c) => ({
    id: c.id,
    subject: c.subject,
    state: c.state,
    replyType: c.reply_type,
    isOoo: c.is_ooo,
    aiSummary: c.ai_summary,
    waitingSince: c.waiting_since?.toISOString() ?? null,
    canReply: Boolean(c.replyable_todo_id && c.inbox_id),
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
    messages: c.messages.map((m) => ({
      id: m.id,
      direction: m.direction as "IN" | "OUT",
      subject: m.subject,
      // The quoted history is stripped for reading; the whole thread is
      // already on screen as separate messages.
      text: replyText(m, 8000),
      fromName: m.from_name,
      fromEmail: m.from_email,
      toEmail: m.to_email,
      sentAt: m.sent_at?.toISOString() ?? null,
    })),
  }));

  return (
    <>
      <PageHeader
        title="Replies"
        description={
          items.length === 0
            ? "Nothing waiting. Run `npm run sync-replies` to pull the latest from QuickMail."
            : `${items.length} thread${items.length === 1 ? "" : "s"} from QuickMail.`
        }
      />
      <div className="max-w-5xl p-8">
        <RepliesList
          items={items}
          bookingLink={process.env.BOOKING_LINK?.trim() || null}
          liveSending={process.env.QUICKMAIL_DRY_RUN === "false"}
          oooHidden={includeOoo ? 0 : totalOoo}
          handledCount={totalHandled}
          includeOoo={includeOoo}
          includeHandled={includeHandled}
          lastSync={lastSync._max.synced_at?.toISOString() ?? null}
        />
      </div>
    </>
  );
}
