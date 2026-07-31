import { prisma } from "@/lib/prisma";
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

  const suppress = verdict.should_stop_sequence;

  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      status:
        verdict.sentiment === "NEGATIVE" || verdict.sentiment === "UNSUBSCRIBE"
          ? "DNC"
          : "REPLIED",
      ai_intent_score: verdict.intent_score,
      suppressed: suppress,
      suppressed_reason: suppress
        ? `${verdict.sentiment}: ${verdict.reasoning}`
        : null,
    },
  });

  // Negative and opt-out: stop, log, and do not ask a human to write back.
  // Chasing these is what generates spam complaints.
  if (
    verdict.sentiment === "NEGATIVE" ||
    verdict.sentiment === "UNSUBSCRIBE"
  ) {
    return { verdict, log, action: "suppressed" as const };
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
