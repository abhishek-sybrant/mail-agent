import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isDryRun, query, QuickMailError } from "@/lib/quickmail/client";
import {
  ADD_LEADS_TO_CAMPAIGN,
  CREATE_LEADS,
  findExistingLeads,
  type QmLeadInput,
} from "@/lib/quickmail/mutations";
import { badRequest, notFound, optionalString, readJson } from "@/lib/webhook";

export const maxDuration = 300;

/**
 * POST /api/quickmail/campaigns/enroll
 *
 * Adds leads to a campaign that already exists in QuickMail.
 *
 * Deliberately does NOT require a template: the campaign's email steps live in
 * QuickMail, so enrolling is purely createLeads → addLeadsToCampaign. The older
 * /api/campaigns/trigger endpoint demanded a template because it was written
 * for locally-composed campaigns, which is why pushing leads to a synced
 * campaign failed with "Campaign has no template".
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const campaignId = optionalString(parsed.data.campaign_id);
  if (!campaignId) return badRequest("`campaign_id` is required");

  const leadIds = Array.isArray(parsed.data.lead_ids)
    ? parsed.data.lead_ids.filter((v): v is string => typeof v === "string")
    : [];
  if (leadIds.length === 0) return badRequest("Select at least one lead");

  // Accept either the local row id or QuickMail's own campaign id.
  const local = await prisma.campaign.findFirst({
    where: {
      OR: [{ id: campaignId }, { quickmail_campaign_id: campaignId }],
    },
  });
  const qmCampaignId = local?.quickmail_campaign_id ?? campaignId;
  if (!qmCampaignId.startsWith("campaign_")) {
    return notFound(`No QuickMail campaign for ${campaignId}`);
  }

  // Never enrol a bounced, suppressed or opted-out lead, whatever was selected.
  const leads = await prisma.lead.findMany({
    where: {
      id: { in: leadIds },
      suppressed: false,
      status: { in: ["UNCONTACTED", "EMAILED"] },
    },
  });
  const skipped = leadIds.length - leads.length;

  if (leads.length === 0) {
    return NextResponse.json({
      ok: true,
      enrolled: 0,
      skipped,
      message: "None of those leads are eligible — all bounced, DNC or suppressed.",
    });
  }

  const qmLeads: QmLeadInput[] = leads.map((l) => ({
    email: l.email,
    firstName: l.first_name ?? l.name?.split(" ")[0] ?? null,
    lastName: l.last_name ?? l.name?.split(" ").slice(1).join(" ") ?? null,
    companyName: l.company,
    title: l.title,
    phone: l.phone,
    location: l.location,
    score: l.ai_intent_score,
  }));

  const header = request.headers.get("x-dry-run");
  const effectiveDryRun = isDryRun() || header !== "false";

  if (effectiveDryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      campaign: local?.name ?? qmCampaignId,
      eligible: qmLeads.length,
      skipped,
      plan: [
        { mutation: "createLeads", detail: `${qmLeads.length} leads (new ones only)` },
        { mutation: "addLeadsToCampaign", detail: `into ${local?.name ?? qmCampaignId}` },
      ],
      message: "Dry run — nothing written to QuickMail.",
    });
  }

  try {
    const ws = await query<{ workspaces: { nodes: { id: string }[] } }>(
      `{ workspaces(first: 1) { nodes { id } } }`,
    );
    const workspaceId = ws.workspaces.nodes[0]?.id;
    if (!workspaceId) return badRequest("No workspace available");

    // Reuse QuickMail's existing lead records rather than duplicating them.
    const { found: existing, skipped: unchecked } = await findExistingLeads(
      qmLeads.map((l) => l.email),
    );
    const toCreate = qmLeads.filter((l) => !existing.has(l.email.toLowerCase()));

    const createdIds: string[] = [];
    if (toCreate.length > 0) {
      const res = await query<{
        createLeads: { leads: { id: string; email: string }[] };
      }>(CREATE_LEADS, { input: { workspaceId, leads: toCreate } });
      createdIds.push(...res.createLeads.leads.map((l) => l.id));
    }

    const allIds = [...existing.values(), ...createdIds];
    const added = await query<{
      addLeadsToCampaign: { leads: { id: string }[] };
    }>(ADD_LEADS_TO_CAMPAIGN, {
      input: { campaignId: qmCampaignId, leadIds: allIds },
    });

    await prisma.lead.updateMany({
      where: { id: { in: leads.map((l) => l.id) } },
      data: { status: "EMAILED" },
    });

    return NextResponse.json({
      ok: true,
      dryRun: false,
      campaign: local?.name ?? qmCampaignId,
      enrolled: added.addLeadsToCampaign.leads.length,
      reused: existing.size,
      created: createdIds.length,
      skipped,
      // Addresses enrolled without a duplicate check, to keep the request from
      // running for minutes. Reported rather than hidden.
      unchecked,
    });
  } catch (error) {
    const message =
      error instanceof QuickMailError || error instanceof Error
        ? error.message
        : "Enrolment failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
