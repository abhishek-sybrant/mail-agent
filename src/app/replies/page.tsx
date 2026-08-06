import { PageHeader } from "@/components/page-header";
import { prisma } from "@/lib/prisma";
import { replyText } from "@/lib/quickmail/mail-text";
import { opportunityUrl } from "@/lib/quickmail/inbox";
import { RepliesList, type ReplyThread } from "./replies-list";

export const dynamic = "force-dynamic";

/**
 * How QuickMail's reply types roll up into the three buckets on screen.
 *
 * Unclassified threads are deliberately absent from all three rather than
 * dumped into "neutral": nothing has judged them, and filing them as neutral
 * would claim otherwise. They show under "All".
 */
const TONE_GROUPS: Record<string, string[]> = {
  positive: ["POSITIVE", "MEETING_REQUEST"],
  neutral: ["NEUTRAL", "OUT_OF_OFFICE"],
  negative: ["NEGATIVE", "UNSUBSCRIBE"],
};

export default async function RepliesPage({
  searchParams,
}: {
  searchParams: Promise<{ ooo?: string; show?: string; q?: string; tone?: string }>;
}) {
  const params = await searchParams;
  const includeOoo = params.ooo === "1";
  const includeHandled = params.show === "all";
  const q = params.q?.trim() ?? "";
  const tone = params.tone && TONE_GROUPS[params.tone] ? params.tone : "";

  /**
   * Search covers who it's from and what it says.
   *
   * The message body is included because a name is often the thing you don't
   * remember — "the one who asked about pricing" is a far more likely search
   * than an address. SQLite's LIKE is case-insensitive for ASCII, which is what
   * `mode: "insensitive"` would give and SQLite does not support.
   */
  const search = q
    ? {
        OR: [
          { prospect_name: { contains: q } },
          { prospect_email: { contains: q } },
          { prospect_company: { contains: q } },
          { subject: { contains: q } },
          { campaign_name: { contains: q } },
          { inbox_email: { contains: q } },
          { messages: { some: { body_text: { contains: q } } } },
        ],
      }
    : {};

  const base = {
    ...(includeOoo ? {} : { is_ooo: false }),
    ...(includeHandled ? {} : { handled_at: null }),
  };

  const where = {
    ...base,
    ...search,
    ...(tone ? { reply_type: { in: TONE_GROUPS[tone] } } : {}),
  };

  const conversations = await prisma.qmConversation.findMany({
    where,
    orderBy: { waiting_since: "desc" },
    take: 200,
    include: {
      lead: { select: { id: true, suppressed: true, ai_intent_score: true } },
      messages: { orderBy: { sent_at: "desc" } },
    },
  });

  // Counts are computed against the same filters minus the tone, so switching
  // buckets doesn't make the other counts jump around.
  const scoped = { ...base, ...search };
  const [positive, neutral, negative, all, totalOoo, totalHandled, lastSync] =
    await Promise.all([
      prisma.qmConversation.count({
        where: { ...scoped, reply_type: { in: TONE_GROUPS.positive } },
      }),
      prisma.qmConversation.count({
        where: { ...scoped, reply_type: { in: TONE_GROUPS.neutral } },
      }),
      prisma.qmConversation.count({
        where: { ...scoped, reply_type: { in: TONE_GROUPS.negative } },
      }),
      prisma.qmConversation.count({ where: scoped }),
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
    messages: c.messages.map((m) => ({
      id: m.id,
      direction: m.direction as "IN" | "OUT",
      subject: m.subject,
      // Quoted history is stripped for reading; the thread is already on screen
      // as separate messages.
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
          q
            ? `${items.length} thread${items.length === 1 ? "" : "s"} matching “${q}”.`
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
          query={q}
          tone={tone}
          toneCounts={{ positive, neutral, negative, all }}
          lastSync={lastSync._max.synced_at?.toISOString() ?? null}
        />
      </div>
    </>
  );
}
