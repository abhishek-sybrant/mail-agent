import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { suppress } from "@/lib/suppression";
import { badRequest, optionalString, readJson } from "@/lib/webhook";

/**
 * POST /api/replies/act
 *
 * Body: { log_id, action: "replied" | "stop" | "ignore" }
 *
 * Records what a human did with an inbound reply.
 *
 * There is no `send` action, and that is not an omission: QuickMail's API has
 * no mutation that sends an email and no query that reads replies — verified
 * against the full schema. The reply itself is written from the real mailbox,
 * so "replied" means "I have sent it", not "send it for me". Claiming otherwise
 * would be the same class of silent failure as a campaign that looks live and
 * never sends.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const logId = optionalString(parsed.data.log_id);
  const action = optionalString(parsed.data.action);
  if (!logId) return badRequest("`log_id` is required");
  if (action !== "replied" && action !== "stop" && action !== "ignore") {
    return badRequest("`action` must be replied, stop or ignore");
  }

  const log = await prisma.emailLog.findUnique({
    where: { id: logId },
    include: { lead: true },
  });
  if (!log) return NextResponse.json({ error: "Reply not found" }, { status: 404 });

  let suppressed: { email: string; hits: number } | null = null;

  if (action === "stop") {
    /**
     * The confirmed stop.
     *
     * Bars the address rather than only flagging the Lead: the flag resets on
     * the next spreadsheet import, and someone who asked to be left alone is
     * the worst possible address to resurrect. The campaign keeps running for
     * everyone else — one rejection is not a reason to halt hundreds of sends.
     */
    const r = await suppress({
      email: log.lead.email,
      reason: "NEGATIVE_REPLY",
      source: "reply-review",
      note: "Stopped by a human from the Replies tab",
    });
    suppressed = { email: r.email, hits: r.hits };
  }

  const [updated] = await prisma.$transaction([
    prisma.emailLog.update({
      where: { id: log.id },
      data: {
        handled_at: new Date(),
        handled_action:
          action === "stop" ? "STOPPED" : action === "replied" ? "REPLIED" : "IGNORED",
      },
    }),
    // Clear any pending stop decision for this lead, whichever way it went.
    prisma.approval.updateMany({
      where: { lead_id: log.lead_id, type: "STOP_SEQUENCE", status: "PENDING" },
      data: {
        status: action === "stop" ? "APPROVED" : "REJECTED",
        resolved_at: new Date(),
      },
    }),
  ]);

  return NextResponse.json({
    ok: true,
    log: { id: updated.id, handled_action: updated.handled_action },
    suppressed,
  });
}
