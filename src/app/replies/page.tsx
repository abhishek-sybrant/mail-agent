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
/**
 * The two buckets for threads with no sending mailbox, and why there are two.
 *
 * They are not one thing. QuickMail files LinkedIn outreach as opportunities
 * exactly like email threads, and those have no address, no mailbox and
 * nothing to reply to — 47 of them. Separately, 28 genuine email threads have
 * no inbox recorded on QuickMail's side either; those are a gap in their data,
 * not a different channel, and the difference matters when you are asking
 * which sender produced a result.
 *
 * Told apart by QuickMail's own channelType rather than by an address that
 * happens to end in @linkedin.profile.
 */
const LINKEDIN = "__linkedin__";
const NO_MAILBOX = "__none__";

const TONE_GROUPS: Record<string, string[]> = {
  positive: ["POSITIVE", "MEETING_REQUEST"],
  neutral: ["NEUTRAL", "OUT_OF_OFFICE"],
  negative: ["NEGATIVE", "UNSUBSCRIBE"],
};

export default async function RepliesPage({
  searchParams,
}: {
  searchParams: Promise<{
    ooo?: string;
    show?: string;
    q?: string;
    tone?: string;
    inbox?: string;
  }>;
}) {
  const params = await searchParams;
  const includeOoo = params.ooo === "1";
  const includeHandled = params.show === "all";
  const q = params.q?.trim() ?? "";
  const tone = params.tone && TONE_GROUPS[params.tone] ? params.tone : "";
  const inbox = params.inbox?.trim() ?? "";

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

  /** The chosen sending mailbox, if any. */
  const inboxWhere = !inbox
    ? {}
    : inbox === LINKEDIN
      ? { channel: "linkedin" }
      : inbox === NO_MAILBOX
        ? { sender_email: null, NOT: { channel: "linkedin" } }
        : { sender_email: inbox };

  const where = {
    ...base,
    ...search,
    ...inboxWhere,
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

  /**
   * Each set of counts drops its own filter, so switching within one set does
   * not make its own numbers move under the cursor.
   *
   * Tone counts keep the mailbox filter — picking a mailbox should re-bucket
   * that mailbox's replies, which is the point of the panel. Mailbox counts
   * keep the tone filter for the mirror reason: with "Negative" selected, the
   * panel should say how many negatives each mailbox has.
   */
  const scoped = { ...base, ...search, ...inboxWhere };
  const mailboxScoped = {
    ...base,
    ...search,
    ...(tone ? { reply_type: { in: TONE_GROUPS[tone] } } : {}),
  };
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

  /**
   * Replies grouped by the mailbox that sent the campaign.
   *
   * Which sender a reply came back to is the one dimension the page had no way
   * to slice on, and it is the one that matters when a single mailbox is
   * producing all the rejections — that is a deliverability signal, not a
   * copy problem.
   */
  /**
   * Grouped by the derived sender, not by the opportunity's inbox.
   *
   * QuickMail sets that inbox to whichever mailbox touched the thread last, and
   * forwarding a reply to a manager touches it — so grouping on it reported the
   * forwarding mailbox as the sender of every thread we had forwarded.
   */
  const inboxGroups = await prisma.qmConversation.groupBy({
    by: ["sender_email"],
    where: { ...mailboxScoped, NOT: { channel: "linkedin" } },
    _count: { _all: true },
  });

  const linkedinCount = await prisma.qmConversation.count({
    where: { ...mailboxScoped, channel: "linkedin" },
  });

  const named = inboxGroups
    .filter((g) => g.sender_email)
    .map((g) => ({ email: g.sender_email as string, count: g._count._all }))
    .sort((a, b) => b.count - a.count);

  const noneCount = inboxGroups.find((g) => !g.sender_email)?._count._all ?? 0;

  // The two catch-alls go last, so the column still sums to the total.
  const inboxes = [
    ...named,
    ...(noneCount ? [{ email: NO_MAILBOX, count: noneCount }] : []),
    ...(linkedinCount ? [{ email: LINKEDIN, count: linkedinCount }] : []),
  ];

  const items: ReplyThread[] = conversations.map((c) => ({
    id: c.id,
    subject: c.subject,
    state: c.state,
    replyType: c.reply_type,
    isOoo: c.is_ooo,
    channel: c.channel,
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
      <div className="p-8">
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
          inboxes={inboxes}
          inbox={inbox}
          lastSync={lastSync._max.synced_at?.toISOString() ?? null}
        />
      </div>
    </>
  );
}
