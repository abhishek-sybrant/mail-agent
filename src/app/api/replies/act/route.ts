import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { suppress, suppressDomain } from "@/lib/suppression";
import { stopProspect, withSession, type StopResult } from "@/lib/quickmail/inbox";
import { badRequest, optionalString, readJson } from "@/lib/webhook";

/**
 * POST /api/replies/act
 *
 * Body: { conversation_id, action: "replied" | "stop" | "ignore" }
 *
 * Records what a human did with a reply thread. Sending is a separate route —
 * this one only ever writes locally.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const id = optionalString(parsed.data.conversation_id);
  const action = optionalString(parsed.data.action);
  if (!id) return badRequest("`conversation_id` is required");
  if (action !== "replied" && action !== "stop" && action !== "ignore") {
    return badRequest("`action` must be replied, stop or ignore");
  }

  /**
   * How wide the stop goes. "domain" bars everyone at the company, not just the
   * person who replied — for a competitor, a client, or a domain whose server
   * rejects everything. Defaults to the narrow one: widening a block is a
   * deliberate choice, never a default.
   */
  const scope = optionalString(parsed.data.scope) === "domain" ? "domain" : "email";

  const convo = await prisma.qmConversation.findUnique({
    where: { id },
    include: { lead: true },
  });
  if (!convo) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  let suppressed: { email: string; hits: number } | null = null;
  let domainBlocked: { domain: string; leadsAffected: number } | null = null;
  let quickmail: StopResult | null = null;

  if (action === "stop") {
    const email = convo.lead?.email ?? convo.prospect_email;
    if (!email) return badRequest("This conversation has no address to suppress");

    /**
     * Local first, and unconditionally.
     *
     * Bars the address rather than only flagging the Lead: the flag resets on
     * the next spreadsheet import, and someone who asked to be left alone is
     * the worst possible address to resurrect. This must not be skipped or
     * rolled back because QuickMail was unreachable.
     */
    const r = await suppress({
      email,
      reason: "NEGATIVE_REPLY",
      source: "reply-review",
      note: "Stopped by a human from the Replies tab",
    });
    suppressed = { email: r.email, hits: r.hits };

    /**
     * A domain stop bars the address as well as the domain.
     *
     * Belt and braces on purpose: the domain row is what catches every other
     * address at that company, and the address row is what survives if someone
     * later unblocks the domain but not the person who actually asked to stop.
     */
    if (scope === "domain") {
      const d = await suppressDomain({
        domain: email,
        reason: "NEGATIVE_REPLY",
        source: "reply-review",
        note: `Blocked from a reply by ${email}`,
      });
      domainBlocked = { domain: d.domain, leadsAffected: d.leadsAffected };
    }

    /**
     * Then QuickMail, which is where the sending actually happens.
     *
     * Suppressing locally only stops campaigns this app builds. QuickMail keeps
     * its own copy of the prospect and its own running sequences, so without
     * this the next scheduled follow-up still goes out — the person told us to
     * stop and got another email anyway.
     *
     * Best-effort: a failure is reported, never thrown. The address is already
     * barred here, and the alternative is a stop that half-applies and reports
     * failure, leaving nobody sure what state anything is in.
     */
    if (convo.qm_prospect_id) {
      try {
        quickmail = await withSession((s) => stopProspect(s, convo.qm_prospect_id!));
        if (quickmail.doNotContact || quickmail.dryRun) {
          await prisma.qmConversation.update({
            where: { id },
            data: { do_not_contact: quickmail.doNotContact },
          });
        }
      } catch (error) {
        quickmail = {
          dryRun: false,
          doNotContact: false,
          cancelled: false,
          errors: [error instanceof Error ? error.message : "QuickMail unreachable"],
        };
      }
    } else {
      quickmail = {
        dryRun: false,
        doNotContact: false,
        cancelled: false,
        errors: ["No QuickMail prospect id on this thread — re-run the reply sync."],
      };
    }
  }

  const updated = await prisma.qmConversation.update({
    where: { id },
    data: {
      handled_at: new Date(),
      handled_action:
        action === "stop" ? "STOPPED" : action === "replied" ? "REPLIED" : "IGNORED",
    },
  });

  // Clear any pending stop decision for this lead, whichever way it went.
  if (convo.lead_id) {
    const cleared = await prisma.approval.updateMany({
      where: { lead_id: convo.lead_id, type: "STOP_SEQUENCE", status: "PENDING" },
      data: {
        status: action === "stop" ? "APPROVED" : "REJECTED",
        resolved_by: session.user.id,
        resolved_at: new Date(),
      },
    });

    /**
     * Audit record for a stop that had no queued decision behind it.
     *
     * Barring an address is permanent and survives re-imports, so it must be
     * traceable to a person even when the reviewer chose it themselves rather
     * than answering a flag the classifier raised.
     */
    if (action === "stop" && cleared.count === 0) {
      await prisma.approval.create({
        data: {
          type: "STOP_SEQUENCE",
          status: "APPROVED",
          lead_id: convo.lead_id,
          title: `Stopped emailing ${convo.prospect_name ?? convo.prospect_email}`,
          summary: `Suppressed from the Replies tab · thread ${convo.id}`,
          payload: JSON.stringify({
            conversation_id: convo.id,
            email: convo.prospect_email,
            campaign: convo.campaign_name,
          }),
          resolved_by: session.user.id,
          resolved_at: new Date(),
        },
      });
    }
  }

  return NextResponse.json({
    ok: true,
    conversation: { id: updated.id, handled_action: updated.handled_action },
    suppressed,
    domain: domainBlocked,
    quickmail,
  });
}
