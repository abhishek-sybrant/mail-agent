import { prisma } from "@/lib/prisma";
// Aliased: a local `suppress` boolean already exists in this file.
import { suppress as addSuppression } from "@/lib/suppression";
import { classifyReply } from "@/lib/ai/classify";
import { draftReply } from "@/lib/ai/generate";
import { notifyApprovalNeeded } from "@/lib/notify";

/**
 * The core reply-handling rule set.
 *
 * Everything inbound funnels through here so the routing decision lives in one
 * place: negative replies stop the sequence immediately and silently, positive
 * ones stop it too but raise an approval for a human to answer.
 */
export async function handleInboundReply(input: {
  leadId: string;
  replyText: string;
  campaignId?: string | null;
}) {
  const lead = await prisma.lead.findUnique({ where: { id: input.leadId } });
  if (!lead) throw new Error(`Lead ${input.leadId} not found`);

  const verdict = await classifyReply(input.replyText, {
    name: lead.name,
    company: lead.company,
  });

  const log = await prisma.emailLog.create({
    data: {
      lead_id: lead.id,
      campaign_id: input.campaignId ?? null,
      type: "REPLIED",
      content: input.replyText,
      sentiment: verdict.sentiment,
      sentiment_score: verdict.intent_score,
    },
  });

  // An out-of-office isn't a real reply — don't burn the lead on it.
  if (verdict.sentiment === "OUT_OF_OFFICE") {
    return { verdict, log, action: "ignored" as const };
  }

  /**
   * An explicit opt-out is honoured immediately; a plain "not interested" waits
   * for a human.
   *
   * These are deliberately treated differently. "Remove me from your list" is a
   * legal obligation under CAN-SPAM and GDPR and must not sit in a queue until
   * someone clicks a button, so it suppresses on arrival. "Not interested" is a
   * judgement call — the classifier gets it wrong on hedged replies like "not
   * right now, try me next quarter" — so it raises a decision instead of
   * silently killing a live prospect.
   */
  const optedOut = verdict.sentiment === "UNSUBSCRIBE";
  const rejected = verdict.sentiment === "NEGATIVE";

  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      // A pending decision is not yet a DNC — only a real opt-out is.
      status: optedOut ? "DNC" : "REPLIED",
      ai_intent_score: verdict.intent_score,
      suppressed: optedOut,
      suppressed_reason: optedOut
        ? `${verdict.sentiment}: ${verdict.reasoning}`
        : null,
    },
  });

  if (optedOut) {
    /**
     * Bar the address permanently, not just this Lead row.
     *
     * The flag set above dies with the row: re-import the same spreadsheet and
     * the person who told us to stop is contacted again. Someone who asked to
     * be left alone is the worst possible address to resurrect.
     */
    await addSuppression({
      email: lead.email,
      reason: "UNSUBSCRIBE",
      source: "reply",
      note: verdict.reasoning?.slice(0, 200) ?? null,
    });
    return { verdict, log, action: "suppressed" as const };
  }

  if (rejected) {
    // Queued for a human, who confirms the stop in the Replies tab.
    await prisma.approval.create({
      data: {
        type: "STOP_SEQUENCE",
        lead_id: lead.id,
        title: `Stop emailing ${lead.name ?? lead.email}?`,
        summary: verdict.reasoning?.slice(0, 300) ?? "Replied negatively",
        payload: JSON.stringify({ incoming: input.replyText }),
      },
    });
    return { verdict, log, action: "needs_decision" as const };
  }

  // Anything with real intent goes to a human with a draft ready to edit.
  const wantsMeeting = verdict.sentiment === "MEETING_REQUEST";

  const ai_draft = await draftReply({
    incoming: input.replyText,
    name: lead.name,
    company: lead.company,
    sentiment: verdict.sentiment,
    bookingLink: process.env.BOOKING_LINK ?? null,
  });

  const approval = await prisma.approval.create({
    data: {
      type: wantsMeeting ? "MEETING_BOOK" : "REPLY_SEND",
      lead_id: lead.id,
      title: wantsMeeting
        ? `Meeting request from ${lead.name ?? lead.email}`
        : `Reply from ${lead.name ?? lead.email}`,
      summary: verdict.reasoning,
      ai_draft,
      payload: JSON.stringify({
        incoming: input.replyText,
        sentiment: verdict.sentiment,
        intent_score: verdict.intent_score,
        booking_link: process.env.BOOKING_LINK ?? null,
      }),
    },
  });

  await notifyApprovalNeeded({
    title: approval.title,
    summary: verdict.reasoning,
    leadEmail: lead.email,
    intent: verdict.intent_score,
  });

  return { verdict, log, approval, action: "awaiting_approval" as const };
}
