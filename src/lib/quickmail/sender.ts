import { prisma } from "@/lib/prisma";

/**
 * Which mailbox actually ran the campaign behind a reply thread.
 *
 * `inbox_email` cannot answer this. QuickMail sets an opportunity's inbox to
 * whichever mailbox touched it most recently, and forwarding a reply to a
 * manager touches it — so 57 threads were rewritten to the forwarding mailbox,
 * and the Replies panel reported that mailbox as the sender of 57 campaigns
 * when the real sender of 33 of them was ryker.scott@sybrant.com.
 *
 * The thread itself is not rewritten. Its earliest outbound message carries the
 * address the campaign sent from, and an inbound reply is addressed to that
 * same mailbox, so either one recovers it.
 */

const EMAIL = /^[^\s@;,]+@[^\s@;,]+\.[a-z]{2,}$/i;

/**
 * Takes the first usable address out of a header value.
 *
 * Some stored `to_email` values are a whole recipient list, semicolon
 * separated — a reply sent to every mailbox in the workspace. The first entry
 * is the one that matters, and treating the raw string as an address would put
 * a twelve-address blob in the panel as if it were a mailbox.
 */
function firstAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  for (const part of value.split(/[;,]/)) {
    const trimmed = part.trim().toLowerCase();
    if (EMAIL.test(trimmed)) return trimmed;
  }
  return null;
}

/** The mailbox this app forwards from, which must never count as a sender. */
function forwardingMailbox(): string | null {
  return process.env.FORWARD_FROM_EMAIL?.trim().toLowerCase() ?? null;
}

export type MessageLike = {
  direction: string;
  from_email: string | null;
  to_email: string | null;
  sent_at: Date | null;
};

/**
 * Derives the sending mailbox from a thread's messages, oldest first.
 *
 * Returns null rather than guessing when the thread holds nothing usable —
 * LinkedIn threads have no address anywhere, and a wrong attribution is worse
 * than an honest gap.
 */
export function deriveSender(
  messages: MessageLike[],
  /**
   * Known sending mailboxes, lowercased.
   *
   * A thread's earliest outbound message is usually the campaign's own send,
   * but not always — a quoted or forwarded message can be filed as outbound
   * with a prospect's address on it, which put two prospects in the sender
   * list. Preferring an address that is actually one of our mailboxes settles
   * it; without the list the first usable address is still used, so this
   * degrades rather than failing.
   */
  known?: Set<string>,
): string | null {
  const forwarder = forwardingMailbox();
  const ordered = [...messages].sort(
    (a, b) => (a.sent_at?.getTime() ?? 0) - (b.sent_at?.getTime() ?? 0),
  );

  const usable = (v: string | null) => {
    const a = firstAddress(v);
    return a && a !== forwarder ? a : null;
  };

  const candidates: string[] = [];
  // The campaign's own send is the earliest outbound message.
  for (const m of ordered) {
    if (m.direction === "OUT") {
      const from = usable(m.from_email);
      if (from) candidates.push(from);
    }
  }
  // Failing that, a reply is addressed to whichever mailbox sent to them.
  for (const m of ordered) {
    if (m.direction === "IN") {
      const to = usable(m.to_email);
      if (to) candidates.push(to);
    }
  }

  /**
   * Only ever one of our own mailboxes.
   *
   * The earliest outbound message is usually the campaign's send, but a quoted
   * or forwarded message can be filed as outbound carrying a prospect's
   * address — which put two prospects, and two Sybrant addresses that are not
   * QuickMail mailboxes at all, into a list headed "Sending mailbox". An
   * honest gap is better than a confident wrong name, so anything unrecognised
   * falls through to "sender unknown".
   *
   * Without a list to check against, the first usable address is still used —
   * this degrades rather than failing.
   */
  if (known?.size) return candidates.find((c) => known.has(c)) ?? null;
  return candidates[0] ?? null;
}

/** The addresses of every mailbox QuickMail knows about, lowercased. */
export async function knownMailboxes(): Promise<Set<string>> {
  const rows = await prisma.qmMailbox.findMany({ select: { email: true } });
  return new Set(rows.map((r) => r.email.trim().toLowerCase()));
}

/** Recomputes `sender_email` for one thread from what is stored. */
export async function refreshSender(
  conversationId: string,
  known?: Set<string>,
): Promise<string | null> {
  const messages = await prisma.qmMessage.findMany({
    where: { conversation_id: conversationId },
    select: { direction: true, from_email: true, to_email: true, sent_at: true },
  });

  const sender = deriveSender(messages, known ?? (await knownMailboxes()));
  if (sender) {
    await prisma.qmConversation.update({
      where: { id: conversationId },
      data: { sender_email: sender },
    });
  }
  return sender;
}

/**
 * Recomputes every thread's sender.
 *
 * Only ever writes a value it found: a thread whose messages have not been
 * pulled yet keeps whatever it had rather than being blanked by a sync that
 * ran with --no-threads.
 */
export async function backfillSenders(): Promise<{ scanned: number; set: number }> {
  const convos = await prisma.qmConversation.findMany({
    select: {
      id: true,
      messages: {
        select: { direction: true, from_email: true, to_email: true, sent_at: true },
      },
    },
  });

  const known = await knownMailboxes();

  let set = 0;
  for (const c of convos) {
    const sender = deriveSender(c.messages, known);
    if (!sender) continue;
    await prisma.qmConversation.update({
      where: { id: c.id },
      data: { sender_email: sender },
    });
    set++;
  }

  return { scanned: convos.length, set };
}
