import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { badRequest, notFound, optionalString, readJson } from "@/lib/webhook";

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

  if (!replyText) return badRequest("Nothing to send — draft is empty");
  if (!approval.lead) return badRequest("Approval has no lead attached");

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
