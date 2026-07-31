import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { handleInboundReply } from "@/lib/reply-pipeline";
import {
  badRequest,
  normalizeEmail,
  notFound,
  optionalString,
  readJson,
  verifySecret,
} from "@/lib/webhook";

/**
 * POST /api/webhooks/quickmail/reply
 *
 * Accepts both the flat Zapier shape `{ email, reply_text, campaign_id }` and
 * QuickMail's own nested payload, so it keeps working whichever way the events
 * are routed.
 *
 * All routing logic lives in the reply pipeline — negative replies stop the
 * sequence, positive ones raise an approval.
 */
export async function POST(request: Request) {
  const unauthorized = verifySecret(request);
  if (unauthorized) return unauthorized;

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const body = parsed.data;
  const nested = (body.prospect ?? body.lead ?? {}) as Record<string, unknown>;

  const email = normalizeEmail(body.email ?? nested.email);
  if (!email) return badRequest("A valid `email` is required");

  const replyText =
    optionalString(body.reply_text) ??
    optionalString(body.message) ??
    optionalString(body.body) ??
    optionalString(body.text);
  if (!replyText) return badRequest("`reply_text` is required");

  const campaignId =
    optionalString(body.campaign_id) ?? optionalString(nested.campaign_id);

  const lead = await prisma.lead.findUnique({ where: { email } });
  if (!lead) return notFound(`No lead found for ${email}`);

  const campaign = campaignId
    ? await prisma.campaign.findUnique({ where: { id: campaignId } })
    : null;

  const result = await handleInboundReply({
    leadId: lead.id,
    replyText,
    campaignId: campaign?.id ?? null,
  });

  return NextResponse.json({
    ok: true,
    action: result.action,
    sentiment: result.verdict.sentiment,
    intent_score: result.verdict.intent_score,
    stopped: result.verdict.should_stop_sequence,
    approval_id: "approval" in result ? result.approval?.id : undefined,
  });
}
