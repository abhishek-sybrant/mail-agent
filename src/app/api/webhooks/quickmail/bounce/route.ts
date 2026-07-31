import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  badRequest,
  normalizeEmail,
  notFound,
  optionalString,
  readJson,
  verifySecret,
} from "@/lib/webhook";

/**
 * POST /api/webhooks/quickmail/bounce
 *
 * Payload: { email: string, reason?: string, campaign_id?: string }
 *
 * Marks the lead BOUNCED and zeroes intent so it drops out of send lists.
 */
export async function POST(request: Request) {
  const unauthorized = verifySecret(request);
  if (unauthorized) return unauthorized;

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const email = normalizeEmail(parsed.data.email);
  if (!email) return badRequest("A valid `email` is required");

  const reason = optionalString(parsed.data.reason);
  const campaignId = optionalString(parsed.data.campaign_id);

  const lead = await prisma.lead.findUnique({ where: { email } });
  if (!lead) return notFound(`No lead found for ${email}`);

  const campaign = campaignId
    ? await prisma.campaign.findUnique({ where: { id: campaignId } })
    : null;

  const [updated] = await prisma.$transaction([
    prisma.lead.update({
      where: { id: lead.id },
      data: { status: "BOUNCED", ai_intent_score: 0 },
    }),
    prisma.emailLog.create({
      data: {
        lead_id: lead.id,
        campaign_id: campaign?.id ?? null,
        type: "BOUNCED",
        content: reason ?? "Hard bounce reported by QuickMail",
      },
    }),
  ]);

  return NextResponse.json({
    ok: true,
    lead: { id: updated.id, email: updated.email, status: updated.status },
  });
}
