import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { badRequest, notFound, optionalString, readJson } from "@/lib/webhook";

/**
 * POST /api/inbox/approve
 *
 * Human-in-the-loop send. The rep has read the AI draft and approved it;
 * we log the outbound message and hand it to Zapier/QuickMail (mocked).
 */
export async function POST(request: Request) {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const leadId = optionalString(parsed.data.lead_id);
  const reply = optionalString(parsed.data.reply_text);

  if (!leadId) return badRequest("`lead_id` is required");
  if (!reply) return badRequest("`reply_text` is required");

  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return notFound(`No lead found for ${leadId}`);

  const url = process.env.ZAPIER_WEBHOOK_URL;
  if (url) {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails: [{ email: lead.email, body: reply }] }),
    }).catch(() => undefined);
  } else {
    console.log(`[mock] Approved reply to ${lead.email}`);
  }

  const log = await prisma.emailLog.create({
    data: { lead_id: lead.id, type: "SENT", content: reply },
  });

  return NextResponse.json({ ok: true, log_id: log.id });
}
