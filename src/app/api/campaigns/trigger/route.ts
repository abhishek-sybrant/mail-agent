import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { badRequest, notFound, optionalString, readJson } from "@/lib/webhook";

/**
 * POST /api/campaigns/trigger
 *
 * Payload: { campaign_id: string, lead_ids?: string[], template_id?: string }
 *
 * Pushes the selected leads out to Zapier/QuickMail. The outbound call is
 * mocked unless ZAPIER_WEBHOOK_URL is set, so this is safe to hit locally.
 */
export async function POST(request: Request) {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const campaignId = optionalString(parsed.data.campaign_id);
  if (!campaignId) return badRequest("`campaign_id` is required");

  const leadIds = Array.isArray(parsed.data.lead_ids)
    ? parsed.data.lead_ids.filter((id): id is string => typeof id === "string")
    : [];

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { template: true },
  });
  if (!campaign) return notFound(`No campaign found for ${campaignId}`);

  const templateId = optionalString(parsed.data.template_id);
  const template = templateId
    ? await prisma.template.findUnique({ where: { id: templateId } })
    : campaign.template;
  if (!template) {
    return badRequest("Campaign has no template; pass `template_id`");
  }

  // Never send to bounced or opted-out addresses, whatever the caller asked for.
  const leads = await prisma.lead.findMany({
    where: {
      ...(leadIds.length > 0 ? { id: { in: leadIds } } : {}),
      status: { in: ["UNCONTACTED", "EMAILED"] },
    },
  });

  if (leads.length === 0) {
    return NextResponse.json(
      { ok: true, sent: 0, skipped: leadIds.length, message: "No eligible leads" },
      { status: 200 },
    );
  }

  const payload = leads.map((lead) => ({
    email: lead.email,
    subject: render(template.subject, lead),
    body: render(template.body, lead),
    campaign_id: campaign.id,
  }));

  const delivery = await dispatchToZapier(payload);

  await prisma.$transaction([
    prisma.emailLog.createMany({
      data: leads.map((lead, i) => ({
        lead_id: lead.id,
        campaign_id: campaign.id,
        type: "SENT" as const,
        content: `Subject: ${payload[i].subject}`,
      })),
    }),
    prisma.lead.updateMany({
      where: { id: { in: leads.map((l) => l.id) } },
      data: { status: "EMAILED" },
    }),
    prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: "ACTIVE" },
    }),
  ]);

  return NextResponse.json({
    ok: true,
    sent: leads.length,
    skipped: Math.max(0, leadIds.length - leads.length),
    delivery,
  });
}

/** Substitutes {name} / {company} / {email} placeholders in a template. */
function render(
  text: string,
  lead: { name: string | null; company: string | null; email: string },
) {
  return text
    .replaceAll("{name}", lead.name?.split(" ")[0] ?? "there")
    .replaceAll("{company}", lead.company ?? "your team")
    .replaceAll("{email}", lead.email)
    .replaceAll("{sender_name}", process.env.SENDER_NAME ?? "The AI SDR");
}

async function dispatchToZapier(payload: unknown[]) {
  const url = process.env.ZAPIER_WEBHOOK_URL;

  if (!url) {
    console.log(`[mock] Would push ${payload.length} emails to Zapier/QuickMail`);
    return { mode: "mock" as const, accepted: payload.length };
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails: payload }),
    });
    return { mode: "live" as const, status: res.status, ok: res.ok };
  } catch (error) {
    // A failed hand-off shouldn't lose the log entries we're about to write,
    // so we surface the error rather than throwing.
    return {
      mode: "live" as const,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
