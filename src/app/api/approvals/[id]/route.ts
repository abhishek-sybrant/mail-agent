import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { suppress } from "@/lib/suppression";
import { stopProspect, withSession, type StopResult } from "@/lib/quickmail/inbox";
import { badRequest, notFound, optionalString, readJson } from "@/lib/webhook";

/**
 * Marks an address do-not-contact in QuickMail and cancels its sequence.
 *
 * An approval carries a Lead, not a QuickMail prospect, so the prospect id is
 * looked up through the mirrored conversation. No conversation means the reply
 * came in by webhook and was never synced — the address is still barred here,
 * and the response says QuickMail needs doing by hand.
 */
async function stopInQuickMail(email: string): Promise<StopResult | null> {
  const convo = await prisma.qmConversation.findFirst({
    where: { prospect_email: email, NOT: { qm_prospect_id: null } },
    select: { qm_prospect_id: true },
  });

  if (!convo?.qm_prospect_id) {
    return {
      dryRun: false,
      doNotContact: false,
      cancelled: false,
      errors: ["No mirrored QuickMail thread for this address — set it there by hand."],
    };
  }

  try {
    return await withSession((s) => stopProspect(s, convo.qm_prospect_id!));
  } catch (error) {
    return {
      dryRun: false,
      doNotContact: false,
      cancelled: false,
      errors: [error instanceof Error ? error.message : "QuickMail unreachable"],
    };
  }
}

/** Pulls the classifier's verdict back out of the stored payload. */
function readSentiment(payload: string | null): string | null {
  if (!payload) return null;
  try {
    return (JSON.parse(payload) as { sentiment?: string }).sentiment ?? null;
  } catch {
    return null;
  }
}

/**
 * POST /api/approvals/[id]
 *
 * Body: { decision: "APPROVED" | "REJECTED", reply_text?: string }
 *
 * This is the human-in-the-loop gate. Nothing outbound happens anywhere else
 * in the reply path — an approval recorded here is the only thing that causes
 * a message to be sent.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const decision = optionalString(parsed.data.decision);
  if (decision !== "APPROVED" && decision !== "REJECTED") {
    return badRequest("`decision` must be APPROVED or REJECTED");
  }

  const approval = await prisma.approval.findUnique({
    where: { id },
    include: { lead: true },
  });
  if (!approval) return notFound(`No approval ${id}`);
  if (approval.status !== "PENDING") {
    return badRequest(`Already ${approval.status.toLowerCase()}`);
  }

  const replyText = optionalString(parsed.data.reply_text) ?? approval.ai_draft;

  if (decision === "REJECTED") {
    await prisma.approval.update({
      where: { id },
      data: {
        status: "REJECTED",
        resolved_by: session.user.id,
        resolved_at: new Date(),
      },
    });
    return NextResponse.json({ ok: true, status: "REJECTED" });
  }

  if (!approval.lead) return badRequest("Approval has no lead attached");

  /**
   * A stop decision approves a suppression, not a send.
   *
   * Without this branch, approving one would fall through to the reply path
   * below and fail on an empty draft — or worse, email the person who just
   * asked to be left alone.
   */
  if (approval.type === "STOP_SEQUENCE") {
    const result = await suppress({
      email: approval.lead.email,
      reason:
        readSentiment(approval.payload) === "UNSUBSCRIBE"
          ? "UNSUBSCRIBE"
          : "NEGATIVE_REPLY",
      source: "approval",
      note: approval.summary?.slice(0, 200) ?? null,
    });

    await prisma.$transaction([
      prisma.approval.update({
        where: { id },
        data: {
          status: "APPROVED",
          resolved_by: session.user.id,
          resolved_at: new Date(),
        },
      }),
      prisma.lead.update({
        where: { id: approval.lead.id },
        data: { status: "DNC" },
      }),
    ]);

    /**
     * Tell QuickMail too, or its own sequences keep sending.
     *
     * Same reasoning as the Replies tab: suppressing locally only governs
     * campaigns this app builds. Best-effort — the address is already barred
     * here, so a QuickMail failure is reported rather than thrown.
     */
    const quickmail = await stopInQuickMail(approval.lead.email);

    return NextResponse.json({
      ok: true,
      status: "APPROVED",
      suppressed: { email: result.email, hits: result.hits },
      quickmail,
    });
  }

  if (!replyText) return badRequest("Nothing to send — draft is empty");

  // Send is mocked until an outbound provider is wired up. The log row and the
  // status change are real either way, so the dashboard stays truthful.
  const url = process.env.ZAPIER_WEBHOOK_URL;
  let delivery: unknown = { mode: "mock" };

  if (url) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          emails: [{ email: approval.lead.email, body: replyText }],
        }),
      });
      delivery = { mode: "live", ok: res.ok, status: res.status };
    } catch (error) {
      delivery = { mode: "live", ok: false, error: String(error) };
    }
  }

  await prisma.$transaction([
    prisma.emailLog.create({
      data: {
        lead_id: approval.lead.id,
        type: "SENT",
        content: replyText,
      },
    }),
    prisma.approval.update({
      where: { id },
      data: {
        status: "APPROVED",
        ai_draft: replyText,
        resolved_by: session.user.id,
        resolved_at: new Date(),
      },
    }),
    prisma.lead.update({
      where: { id: approval.lead.id },
      data:
        approval.type === "MEETING_BOOK"
          ? { status: "MEETING_BOOKED" }
          : { status: "REPLIED" },
    }),
  ]);

  return NextResponse.json({ ok: true, status: "APPROVED", delivery });
}
