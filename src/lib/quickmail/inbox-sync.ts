import { prisma } from "@/lib/prisma";
import { decodeEntities, htmlToText } from "./mail-text";
import { getThread, type OpportunityThread, type Session } from "./inbox";

/**
 * Writing one QuickMail thread into the local mirror.
 *
 * Shared by the bulk sync and by the send route, because a reply has to appear
 * in the thread straight away. It cannot wait for the next bulk run: replying
 * moves the opportunity out of QuickMail's "active_and_pending" scope, so the
 * list query stops returning it — the mirror would silently stay stale for
 * exactly the threads someone has acted on.
 */

/**
 * Which way an email went.
 *
 * `type` is the reliable signal. `author` is not: on a reply we send it holds
 * the QuickMail user who pressed send ("Lisa White (lisa.white@…)"), not a
 * direction. Comparing the sender against the receiving mailbox is no good
 * either — inbox rotation means a campaign's own sends come from several
 * different mailboxes.
 */
export function directionOf(
  type: string | null,
  fromEmail: string | null,
  prospectEmail: string | null,
): "IN" | "OUT" {
  if (type === "sent") return "OUT";
  if (type === "reply") return "IN";

  const from = fromEmail?.trim().toLowerCase();
  const prospect = prospectEmail?.trim().toLowerCase();
  return from && prospect && from === prospect ? "IN" : "OUT";
}

/** Stores a thread's messages, and the reply target the thread now has. */
export async function storeThread(
  thread: OpportunityThread,
  prospectEmail: string | null,
): Promise<number> {
  await prisma.qmConversation.update({
    where: { id: thread.id },
    data: {
      state: thread.state,
      status: thread.status,
      replyable_todo_id: thread.replyableTodoId,
      ai_summary: thread.aiSummary,
      synced_at: new Date(),
    },
  });

  for (const m of thread.messages) {
    const row = {
      direction: directionOf(m.type, m.fromEmail ?? m.from, prospectEmail),
      subject: decodeEntities(m.subject),
      body_html: m.body,
      // `body` first: QuickMail's `content` is their own plain-text rendering
      // and it drops text — a reply signed "Best,<br>Amelia" came back as
      // "<br>Amelia". The delivered mail was correct; their extraction was not.
      body_text: htmlToText(m.body || m.content),
      from_name: decodeEntities(m.fromName),
      from_email: m.fromEmail ?? m.from,
      to_email: m.to,
      cc: m.cc,
      sent_at: m.date || m.createdAt ? new Date(m.date ?? m.createdAt!) : null,
    };

    await prisma.qmMessage.upsert({
      where: { id: m.todoId },
      update: row,
      create: { id: m.todoId, ...row, conversation: { connect: { id: thread.id } } },
    });
  }

  return thread.messages.length;
}

/** Re-reads one thread from QuickMail and mirrors it. */
export async function refreshThread(
  s: Session,
  conversationId: string,
  prospectEmail: string | null,
): Promise<number> {
  const thread = await getThread(s, conversationId, 40);
  if (!thread) return 0;
  return storeThread(thread, prospectEmail);
}
