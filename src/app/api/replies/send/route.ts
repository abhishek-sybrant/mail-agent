import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isSuppressed } from "@/lib/suppression";
import { sendReply, withSession } from "@/lib/quickmail/inbox";
import { refreshThread } from "@/lib/quickmail/inbox-sync";
import { badRequest, optionalString, readJson } from "@/lib/webhook";

/**
 * POST /api/replies/send — { conversation_id, body, subject?, cc?, archive? }
 *
 * Sends a real email to a real prospect, through QuickMail, from the mailbox
 * that received the reply.
 *
 * This is the one irreversible action in the app. Four things guard it:
 *
 *   1. The address must not be suppressed. Emailing someone who asked to be
 *      left alone is the single worst thing this tool could do.
 *   2. The thread must have a replyable message. QuickMail threads a reply onto
 *      a specific message id; without one there is nothing to attach to.
 *   3. It goes out from the receiving mailbox, never a chosen one — replying
 *      from a different address breaks the thread and lands in spam.
 *   4. QUICKMAIL_DRY_RUN gates it exactly like every other write. The response
 *      reports `dry_run` so the UI can say nothing was sent, rather than
 *      claiming a success that did not happen.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const id = optionalString(parsed.data.conversation_id);
  const body = optionalString(parsed.data.body);
  if (!id) return badRequest("`conversation_id` is required");
  if (!body) return badRequest("`body` is required");

  const convo = await prisma.qmConversation.findUnique({
    where: { id },
    include: {
      lead: true,
      messages: { where: { direction: "IN" }, orderBy: { sent_at: "desc" }, take: 1 },
    },
  });
  if (!convo) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  const to = convo.lead?.email ?? convo.prospect_email;
  if (!to) return badRequest("This conversation has no recipient address");

  if (await isSuppressed(to)) {
    return NextResponse.json(
      { error: `${to} is on the suppression list and must not be emailed.` },
      { status: 409 },
    );
  }
  if (convo.do_not_contact) {
    return NextResponse.json(
      { error: `${to} is marked do-not-contact in QuickMail.` },
      { status: 409 },
    );
  }

  if (!convo.replyable_todo_id || !convo.inbox_id) {
    return NextResponse.json(
      {
        error:
          "QuickMail has no replyable message for this thread. Re-run the reply sync, " +
          "or answer it in QuickMail directly.",
      },
      { status: 409 },
    );
  }

  const subject =
    optionalString(parsed.data.subject) ??
    convo.messages[0]?.subject ??
    convo.subject ??
    "Re:";

  // QuickMail's composer is an HTML editor, so plain text has to be marked up
  // or the whole reply arrives as one unbroken paragraph.
  const html = body
    .trim()
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, "<br>")}</p>`)
    .join("");

  try {
    const result = await withSession(async (s) => {
      const sent = await sendReply(s, {
        todoId: convo.replyable_todo_id!,
        inboxId: convo.inbox_id!,
        subject,
        html,
        to,
        cc: optionalString(parsed.data.cc),
        archive: parsed.data.archive === true,
      });

      /**
       * Pull the thread back straight away, on the same session.
       *
       * Replying moves the opportunity out of QuickMail's active scope, so the
       * bulk sync stops returning it — without this the reply that was just
       * sent would never appear in its own thread.
       */
      if (sent.sent) {
        await refreshThread(s, id, convo.prospect_email).catch(() => 0);
      }
      return sent;
    });

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 502 });
    }

    if (result.sent) {
      await prisma.qmConversation.update({
        where: { id },
        data: { handled_at: new Date(), handled_action: "REPLIED" },
      });
      // EmailLog is keyed to a Lead, and a conversation can exist without one.
      if (convo.lead_id) {
        await prisma.emailLog.create({
          data: { lead_id: convo.lead_id, type: "SENT", content: body },
        });
      }

      /**
       * Audit record of who approved this send.
       *
       * Written already-resolved, because the gate is the confirmation in the
       * UI, not a queue — the approval happened before the request, so this
       * records it rather than asking again. Kept so "who emailed this person,
       * when, and with what" has an answer months later.
       */
      await prisma.approval.create({
        data: {
          type: "REPLY_SEND",
          status: "APPROVED",
          lead_id: convo.lead_id,
          title: `Replied to ${convo.prospect_name ?? to}`,
          summary: `Sent from ${convo.inbox_email} · ${subject}`,
          ai_draft: body,
          payload: JSON.stringify({
            conversation_id: id,
            to,
            from: convo.inbox_email,
            subject,
          }),
          resolved_by: session.user.id,
          resolved_at: new Date(),
        },
      });
    }

    return NextResponse.json({
      ok: true,
      sent: result.sent,
      dry_run: result.dryRun,
      from: convo.inbox_email,
      to,
      subject,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Send failed" },
      { status: 502 },
    );
  }
}
