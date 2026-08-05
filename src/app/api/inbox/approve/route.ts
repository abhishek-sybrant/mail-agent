import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { badRequest, notFound, optionalString, readJson } from "@/lib/webhook";

/**
 * POST /api/inbox/approve
 *
 * Human-in-the-loop send. The rep has read the AI draft and approved it; we log
 * the outbound message and hand it to Zapier.
 *
 * Returns `sent: false` when no ZAPIER_WEBHOOK_URL is configured. Nothing leaves
 * the machine in that case, and the caller must not claim otherwise — QuickMail's
 * API has no send-email mutation, so Zapier is the only route out. The /replies
 * tab avoids the problem entirely by handing the draft to a real mail client.
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
  let sent = false;

  if (url) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails: [{ email: lead.email, body: reply }] }),
    }).catch(() => null);
    sent = res?.ok ?? false;
  } else {
    console.log(`[no send webhook] Reply to ${lead.email} logged, not sent`);
  }

  const log = await prisma.emailLog.create({
    // QUEUED, not SENT, when nothing actually went out — a SENT row that never
    // left is what makes the dashboard's own numbers untrustworthy.
    data: { lead_id: lead.id, type: sent ? "SENT" : "QUEUED", content: reply },
  });

  return NextResponse.json({ ok: true, sent, log_id: log.id });
}
