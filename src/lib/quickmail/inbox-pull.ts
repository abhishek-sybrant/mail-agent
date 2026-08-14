import { prisma } from "@/lib/prisma";
import { decodeEntities } from "./mail-text";
import {
  getThread,
  listOpportunities,
  type InboxScope,
  type OpportunitySummary,
  type Session,
} from "./inbox";
import { refreshThread, storeThread } from "./inbox-sync";
import { campaignSender, refreshSender } from "./sender";

/**
 * Pulling QuickMail's reply inbox into the local mirror.
 *
 * Shared by `npm run sync-replies` and the Sync button, so the button cannot
 * drift from the script — one of them being subtly different is how a sync
 * starts looking complete when it isn't.
 */

export type PullResult = {
  total: number;
  conversations: number;
  threads: number;
  messages: number;
  refreshed: number;
};

/**
 * Ties a QuickMail prospect to a local Lead so suppression, approvals and the
 * stop decision all work off one identity.
 *
 * Never suppresses anything. QuickMail's own do-not-contact flag is mirrored
 * onto the conversation and blocks Send, but flipping the local suppression
 * flag is a decision a person makes.
 */
async function linkLead(o: OpportunitySummary): Promise<string | null> {
  const email = o.prospect?.email?.trim().toLowerCase();
  if (!email) return null;

  const existing = await prisma.lead.findUnique({ where: { email } });
  if (existing) return existing.id;

  const created = await prisma.lead.create({
    data: {
      email,
      name: decodeEntities(o.prospect?.name),
      title: decodeEntities(o.prospect?.title),
      company: decodeEntities(o.prospect?.company),
      phone: o.prospect?.phone ?? null,
      source: "QUICKMAIL",
      status: "REPLIED",
    },
  });
  return created.id;
}

export async function pullReplies(
  s: Session,
  opts: {
    scope?: InboxScope;
    limit?: number;
    withThreads?: boolean;
    onProgress?: (done: number, of: number) => void;
  } = {},
): Promise<PullResult> {
  const scope = opts.scope ?? "all";
  const limit = opts.limit ?? 100;
  const withThreads = opts.withThreads !== false;

  /**
   * Paged, because `first` is not obeyed: asking for 40 returns 30, the same
   * page size their own UI uses. Without this a limit of 200 would silently
   * mean 30 — the kind of quiet truncation that makes a sync look complete.
   */
  const items: OpportunitySummary[] = [];
  let total = 0;
  for (let skip = 0; items.length < limit; ) {
    const page = await listOpportunities(s, { scope, limit: 30, skip });
    total = page.total;
    if (page.items.length === 0) break;
    items.push(...page.items);
    skip += page.items.length;
    if (skip >= total) break;
  }
  items.length = Math.min(items.length, limit);

  const result: PullResult = {
    total,
    conversations: 0,
    threads: 0,
    messages: 0,
    refreshed: 0,
  };

  for (const [i, o] of items.entries()) {
    const leadId = await linkLead(o);

    /**
     * Only overwrite the classification when QuickMail actually made one.
     *
     * It returns reply_type null on nearly everything, so assigning it blindly
     * erased our own classifications on every sync — the tone filters emptied
     * out and it looked like the classifier had stopped working.
     */
    const tone = o.replyType ? { reply_type: o.replyType } : {};

    const data = {
      subject: decodeEntities(o.subject),
      state: o.state,
      ai_summary: o.aiSummary,
      is_ooo: o.isOoo,
      waiting_since: o.waitingSince ? new Date(o.waitingSince) : null,
      channel: o.channel,
      inbox_id: o.inbox?.id ?? null,
      inbox_email: o.inbox?.email ?? null,
      inbox_name: decodeEntities(o.inbox?.name),
      qm_campaign_id: o.campaign?.id ?? null,
      campaign_name: o.campaign?.name ?? null,
      qm_prospect_id: o.prospect?.id ?? null,
      prospect_email: o.prospect?.email ?? null,
      prospect_name: decodeEntities(o.prospect?.name),
      prospect_title: decodeEntities(o.prospect?.title),
      prospect_company: decodeEntities(o.prospect?.company),
      do_not_contact: o.prospect?.doNotContact ?? false,
      synced_at: new Date(),
    };

    // Nested connect, not a scalar FK: Prisma rejects `lead_id` on create for a
    // model that declares the relation.
    const link = leadId ? { lead: { connect: { id: leadId } } } : {};

    await prisma.qmConversation.upsert({
      where: { id: o.id },
      // handled_at is never overwritten: a re-sync must not resurrect a thread
      // someone has already dealt with.
      update: { ...data, ...tone, ...link },
      create: { id: o.id, ...data, reply_type: o.replyType, ...link },
    });
    result.conversations++;

    if (withThreads) {
      const thread = await getThread(s, o.id, 40);
      if (thread) {
        result.threads++;
        result.messages += await storeThread(thread, o.prospect?.email ?? null);
        /**
         * Attribution comes from the thread, not from the opportunity's inbox,
         * which forwarding rewrites. Only possible once messages are stored.
         *
         * Falling back to the campaign's own mailbox covers the threads whose
         * messages hold no address of ours — an old conversation imported into
         * a campaign, where the one message on file is the prospect forwarding
         * it to a colleague.
         */
        const sender = await refreshSender(o.id);
        if (!sender && o.campaign?.id) {
          const fromCampaign = await campaignSender(s, o.campaign.id);
          if (fromCampaign) {
            await prisma.qmConversation.update({
              where: { id: o.id },
              data: { sender_email: fromCampaign },
            });
          }
        }
      }
    }

    opts.onProgress?.(i + 1, items.length);
  }

  /**
   * Threads that have dropped out of the list.
   *
   * Answering a conversation moves it out of "active_and_pending", so it stops
   * appearing above and the mirror would freeze at the moment before the reply.
   */
  if (withThreads) {
    const seen = new Set(items.map((o) => o.id));
    const stale = await prisma.qmConversation.findMany({
      where: { NOT: { handled_at: null }, id: { notIn: [...seen] } },
      orderBy: { handled_at: "desc" },
      take: 20,
      select: { id: true, prospect_email: true },
    });

    for (const c of stale) {
      result.messages += await refreshThread(s, c.id, c.prospect_email);
      result.refreshed++;
    }
  }

  return result;
}
