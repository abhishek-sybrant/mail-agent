import { prisma } from "@/lib/prisma";
import { classifyReply } from "@/lib/ai/classify";
import { draftReply } from "@/lib/ai/generate";
import { notifyApprovalNeeded } from "@/lib/notify";

/**
 * The core reply-handling rule set.
 *
 * Everything inbound funnels through here so the routing decision lives in one
 * place. Nothing outbound and nothing irreversible happens as a result: every
 * path either ignores the reply or raises an approval for a human to answer.
 * This function never sends and never suppresses.
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
   * Nothing is barred without a person saying so.
   *
   * Both an opt-out and a flat "not interested" raise a decision rather than
   * suppressing on arrival. That is a deliberate instruction, and it cuts both
   * ways: the classifier misreads hedged replies like "not right now, try me
   * next quarter", so auto-suppressing kills live prospects — but an unactioned
   * opt-out is a compliance problem, because CAN-SPAM and GDPR expect an opt-out
   * to be honoured promptly. The queue must therefore be worked, not just filled.
   * Opt-outs are labelled so they can be spotted and cleared first.
   */
  const optedOut = verdict.sentiment === "UNSUBSCRIBE";
  const rejected = verdict.sentiment === "NEGATIVE";

  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      // A pending decision is not a DNC yet — a human still has to confirm.
      status: "REPLIED",
      ai_intent_score: verdict.intent_score,
    },
  });

  if (optedOut || rejected) {
    await prisma.approval.create({
      data: {
        type: "STOP_SEQUENCE",
        lead_id: lead.id,
        title: optedOut
          ? `Opt-out — stop emailing ${lead.name ?? lead.email}`
          : `Stop emailing ${lead.name ?? lead.email}?`,
        summary: optedOut
          ? `They asked to be removed. Confirm today. ${verdict.reasoning ?? ""}`.slice(
              0,
              300,
            )
          : (verdict.reasoning?.slice(0, 300) ?? "Replied negatively"),
        payload: JSON.stringify({
          incoming: input.replyText,
          sentiment: verdict.sentiment,
          urgent: optedOut,
        }),
      },
    });

    await notifyApprovalNeeded({
      title: optedOut
        ? `Opt-out from ${lead.name ?? lead.email}`
        : `Negative reply from ${lead.name ?? lead.email}`,
      summary: verdict.reasoning,
      leadEmail: lead.email,
      intent: verdict.intent_score,
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
