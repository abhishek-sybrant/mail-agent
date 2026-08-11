import { prisma } from "@/lib/prisma";
import { replyText } from "@/lib/quickmail/mail-text";

/**
 * Emailing an inbound reply to whoever handles them.
 *
 * The manager gets the message and a link back into the app rather than an
 * address they can reply to directly. That is deliberate: a reply sent from the
 * manager's own mailbox would leave the QuickMail thread, arrive from an address
 * the prospect has never seen, and never be recorded against the campaign.
 * Answering through the app keeps all three intact — it sends from the mailbox
 * that received the reply, in-thread, and QuickMail logs it.
 *
 * Nothing here is the source of truth. The Replies tab is; this is a nudge on
 * top, so a missing API key logs and moves on rather than failing a sync.
 */

/** Reply types worth a person's attention. */
const WORTH_FORWARDING = new Set([
  "POSITIVE",
  "MEETING_REQUEST",
  "NEGATIVE",
  "UNSUBSCRIBE",
]);

export type ForwardOutcome =
  | { sent: true; to: string }
  | { sent: false; reason: string };

export function forwardingConfigured(): boolean {
  return Boolean(process.env.MANAGER_EMAIL && process.env.RESEND_API_KEY);
}

/**
 * Should this thread be forwarded automatically?
 *
 * Auto-replies and neutral acknowledgements are excluded — 237 of 375 threads
 * are out-of-office autoresponders, and forwarding those trains the manager to
 * ignore the whole channel.
 */
export function shouldForward(convo: {
  is_ooo: boolean;
  reply_type: string | null;
  handled_at: Date | null;
  forwarded_at: Date | null;
}): boolean {
  if (convo.is_ooo) return false;
  if (convo.handled_at) return false;
  if (convo.forwarded_at) return false;
  return convo.reply_type !== null && WORTH_FORWARDING.has(convo.reply_type);
}

const TONE_LABEL: Record<string, string> = {
  POSITIVE: "Positive",
  MEETING_REQUEST: "Wants a meeting",
  NEGATIVE: "Not interested",
  UNSUBSCRIBE: "Asked to be removed",
  NEUTRAL: "Neutral",
  OUT_OF_OFFICE: "Auto-reply",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Forwards one conversation. Safe to call twice — the second call is a no-op
 * unless `force` is set, which the manual button uses.
 */
export async function forwardReply(
  conversationId: string,
  opts: { force?: boolean } = {},
): Promise<ForwardOutcome> {
  const to = process.env.MANAGER_EMAIL?.trim();
  const apiKey = process.env.RESEND_API_KEY?.trim();

  const convo = await prisma.qmConversation.findUnique({
    where: { id: conversationId },
    include: {
      messages: { where: { direction: "IN" }, orderBy: { sent_at: "desc" }, take: 1 },
    },
  });
  if (!convo) return { sent: false, reason: "conversation not found" };

  if (!opts.force && convo.forwarded_at) {
    return { sent: false, reason: "already forwarded" };
  }

  const latest = convo.messages[0];
  if (!latest) return { sent: false, reason: "no inbound message" };

  if (!to || !apiKey) {
    console.log(
      `[forward] would send ${convo.prospect_email} to a manager — MANAGER_EMAIL / RESEND_API_KEY not set`,
    );
    return { sent: false, reason: "not configured" };
  }

  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  const link = `${appUrl}/replies?q=${encodeURIComponent(convo.prospect_email ?? "")}`;
  const who = convo.prospect_name ?? convo.prospect_email ?? "a prospect";
  const tone = convo.reply_type ? (TONE_LABEL[convo.reply_type] ?? convo.reply_type) : null;
  const body = replyText(latest, 4000);

  /**
   * Reply-To points back at us, not the prospect.
   *
   * If the manager hits Reply in Outlook it must not go straight to the
   * prospect — that would send from the wrong address, outside the thread, with
   * QuickMail none the wiser. Pointing it at the manager's own address makes
   * Reply a harmless no-op and pushes them to the link instead.
   */
  const subject = `[Reply] ${who}${tone ? ` — ${tone}` : ""}`;

  const text = [
    `${who} replied${convo.prospect_company ? ` (${convo.prospect_company})` : ""}.`,
    convo.prospect_email ? `Address: ${convo.prospect_email}` : null,
    convo.campaign_name ? `Campaign: ${convo.campaign_name}` : null,
    convo.inbox_email ? `Received by: ${convo.inbox_email}` : null,
    tone ? `Classified as: ${tone}` : null,
    "",
    "--- their message ---",
    body,
    "",
    "--- to answer ---",
    `Open it here: ${link}`,
    "Replying from this email will not reach them — the app sends from the",
    "mailbox that received the reply, so the thread and the sending domain stay intact.",
  ]
    .filter((line) => line !== null)
    .join("\n");

  const html = `
    <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:640px;color:#111">
      <p style="margin:0 0 4px;font-size:17px;font-weight:600">${escapeHtml(who)} replied</p>
      <p style="margin:0 0 16px;color:#555;font-size:13px">
        ${escapeHtml(convo.prospect_email ?? "")}${convo.prospect_company ? ` · ${escapeHtml(convo.prospect_company)}` : ""}
        ${tone ? ` · <strong>${escapeHtml(tone)}</strong>` : ""}
      </p>
      <div style="border-left:3px solid #ddd;padding:2px 0 2px 14px;margin:0 0 18px;white-space:pre-wrap;font-size:14px;line-height:1.5">${escapeHtml(body)}</div>
      <p style="margin:0 0 18px">
        <a href="${link}" style="background:#111;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block;font-size:14px">Read and reply</a>
      </p>
      <p style="margin:0;color:#777;font-size:12px;line-height:1.5">
        ${convo.campaign_name ? `Campaign: ${escapeHtml(convo.campaign_name)}<br>` : ""}
        ${convo.inbox_email ? `Received by ${escapeHtml(convo.inbox_email)}<br>` : ""}
        Replying to this email will not reach them. Use the button — the app sends
        from the mailbox that received the reply, so the thread stays intact.
      </p>
    </div>`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.NOTIFY_FROM ?? "AI SDR <onboarding@resend.dev>",
        to: [to],
        reply_to: to,
        subject,
        text,
        html,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { sent: false, reason: `Resend returned ${res.status}: ${detail.slice(0, 200)}` };
    }

    await prisma.qmConversation.update({
      where: { id: conversationId },
      data: { forwarded_at: new Date(), forwarded_to: to },
    });

    return { sent: true, to };
  } catch (error) {
    return {
      sent: false,
      reason: error instanceof Error ? error.message : "send failed",
    };
  }
}

/**
 * Forwards everything that qualifies and has not gone yet.
 *
 * Called after a sync. Capped so a first run against a full inbox cannot
 * dispatch fifty emails at once — the rest go on the next run, and the count is
 * reported rather than silently trimmed.
 */
export async function forwardPending(limit = 20): Promise<{
  sent: number;
  failed: number;
  remaining: number;
  reasons: string[];
}> {
  if (!forwardingConfigured()) {
    return { sent: 0, failed: 0, remaining: 0, reasons: ["not configured"] };
  }

  const where = {
    is_ooo: false,
    handled_at: null,
    forwarded_at: null,
    reply_type: { in: [...WORTH_FORWARDING] },
  };

  const [pending, total] = await Promise.all([
    prisma.qmConversation.findMany({
      where,
      orderBy: { waiting_since: "desc" },
      take: limit,
      select: { id: true },
    }),
    prisma.qmConversation.count({ where }),
  ]);

  let sent = 0;
  const reasons: string[] = [];

  for (const c of pending) {
    const result = await forwardReply(c.id);
    if (result.sent) sent++;
    else reasons.push(result.reason);
  }

  return {
    sent,
    failed: pending.length - sent,
    remaining: Math.max(0, total - sent),
    reasons: [...new Set(reasons)],
  };
}
