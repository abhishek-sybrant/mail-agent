import nodemailer from "nodemailer";
import { prisma } from "@/lib/prisma";
import { replyText } from "@/lib/quickmail/mail-text";
import { sendReply, withSession } from "@/lib/quickmail/inbox";

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

/**
 * How much gets forwarded, set by FORWARD_SCOPE in .env.
 *
 *   human      every reply written by a person — the default, and what a
 *              mailbox forwarding rule cannot do, because Gmail and Outlook
 *              have no reliable way to tell an autoresponder apart.
 *   actionable only positives, meeting requests, rejections and opt-outs.
 *   all        everything, autoresponders included. 239 of 378 threads here.
 *
 * Auto-replies are excluded from the first two because they are the majority of
 * the inbox: forward those and the manager learns to ignore the channel.
 */
const ACTIONABLE = new Set(["POSITIVE", "MEETING_REQUEST", "NEGATIVE", "UNSUBSCRIBE"]);

export type ForwardScope = "human" | "actionable" | "all";

export function forwardScope(): ForwardScope {
  const v = process.env.FORWARD_SCOPE?.trim().toLowerCase();
  return v === "actionable" || v === "all" ? v : "human";
}

export type ForwardOutcome =
  | { sent: true; to: string }
  | { sent: false; reason: string };

/**
 * How the forward is delivered.
 *
 *   quickmail  through QuickMail's own replyToEmail, using the OAuth token it
 *              already holds for one of your mailboxes. No credentials here,
 *              but it needs the attached browser and files a copy of the
 *              forward inside the prospect's QuickMail thread.
 *   smtp       straight from a mailbox over SMTP. Needs an app password, but
 *              runs without a browser and leaves QuickMail untouched.
 */
export type ForwardTransport = "quickmail" | "smtp";

export function forwardTransport(): ForwardTransport {
  return process.env.FORWARD_TRANSPORT?.trim().toLowerCase() === "smtp"
    ? "smtp"
    : "quickmail";
}

export function forwardingConfigured(): boolean {
  if (!process.env.MANAGER_EMAIL) return false;
  return forwardTransport() === "smtp"
    ? Boolean(process.env.SMTP_HOST && process.env.SMTP_USER)
    : Boolean(process.env.FORWARD_FROM_INBOX);
}

/**
 * SMTP, not a third-party sending service.
 *
 * The forward goes out from a mailbox Sybrant already owns, so the manager sees
 * a sender they recognise instead of a shared address belonging to an API
 * provider — which is what a spam filter sees too. It also means no extra
 * account, and the credentials are ones you already control.
 */
function transport() {
  const port = Number(process.env.SMTP_PORT ?? 587);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    // 465 is implicit TLS; 587 upgrades with STARTTLS after connecting.
    secure: port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

/** Should this thread be forwarded automatically? */
export function shouldForward(convo: {
  is_ooo: boolean;
  reply_type: string | null;
  handled_at: Date | null;
  forwarded_at: Date | null;
}): boolean {
  // Already dealt with, or already sent — never send the same reply twice.
  if (convo.handled_at) return false;
  if (convo.forwarded_at) return false;

  const scope = forwardScope();
  if (scope === "all") return true;
  if (convo.is_ooo) return false;
  if (scope === "human") return true;

  // "actionable" is the only scope that needs a classification, so an
  // unclassified thread is held back rather than guessed at.
  return convo.reply_type !== null && ACTIONABLE.has(convo.reply_type);
}

/** The same rule as a Prisma filter, for the batch query. */
function pendingWhere() {
  const scope = forwardScope();
  return {
    handled_at: null,
    forwarded_at: null,
    ...(scope === "all" ? {} : { is_ooo: false }),
    ...(scope === "actionable" ? { reply_type: { in: [...ACTIONABLE] } } : {}),
  };
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

  if (!forwardingConfigured() || !to) {
    console.log(
      `[forward] would send ${convo.prospect_email} to a manager — MANAGER_EMAIL / SMTP_* not set`,
    );
    return { sent: false, reason: "not configured" };
  }

  /**
   * Deep link to this one conversation, not a search over all of them.
   *
   * APP_URL must be an address the recipient's machine can actually resolve.
   * A localhost default works only for whoever is running the app — see the
   * warning below, which is emitted rather than silently sending a dead link.
   */
  const appUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  const link = `${appUrl}/replies/${encodeURIComponent(convo.id)}`;
  if (/localhost|127\.0\.0\.1/.test(appUrl)) {
    console.warn(
      `[forward] APP_URL is ${appUrl} — the link will not open on anyone else's machine.`,
    );
  }
  const who = convo.prospect_name ?? convo.prospect_email ?? "a prospect";
  const tone = convo.reply_type ? (TONE_LABEL[convo.reply_type] ?? convo.reply_type) : null;
  const body = replyText(latest, 4000);

  /**
   * Reply-To is the prospect, so hitting Reply in Outlook reaches them.
   *
   * That is a real tradeoff, stated in the email rather than hidden: a reply
   * sent that way comes from the manager's own address, outside the QuickMail
   * thread, and QuickMail never records it. The link is the better route and is
   * presented first; direct reply is the fast one for a manager who is not
   * going to open a web app.
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
    "--- two ways to answer ---",
    `1. Open it in the AI SDR app: ${link}`,
    "   Gives you a drafted reply, and sends from the mailbox that received",
    "   this one so the conversation stays on the same thread. You can also",
    "   stop emailing them entirely from there.",
    "",
    "2. Just hit Reply to this email.",
    `   Goes straight to ${convo.prospect_email ?? "them"}, but from your own`,
    "   address and outside the campaign, so it won't be recorded.",
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
      <p style="margin:0 0 8px">
        <a href="${link}" style="background:#111;color:#fff;text-decoration:none;padding:11px 20px;border-radius:6px;display:inline-block;font-size:14px;font-weight:600">Open in the AI SDR app</a>
      </p>
      <p style="margin:0 0 20px;color:#555;font-size:12.5px;line-height:1.5">
        Drafts a reply for you, sends it from
        ${convo.inbox_email ? `<strong>${escapeHtml(convo.inbox_email)}</strong>` : "the original mailbox"}
        so it stays on the same thread, and lets you stop emailing them entirely.
      </p>
      <p style="margin:0 0 20px;color:#555;font-size:12.5px;line-height:1.5;border-top:1px solid #eee;padding-top:14px">
        <strong>Or just hit Reply</strong> to this email — it goes straight to
        ${escapeHtml(convo.prospect_email ?? "them")}. Faster, but it comes from your
        own address and outside the campaign, so it won't be recorded against it.
      </p>
      <p style="margin:0;color:#888;font-size:11.5px;line-height:1.5">
        ${convo.campaign_name ? `Campaign: ${escapeHtml(convo.campaign_name)}<br>` : ""}
        ${convo.inbox_email ? `Received by ${escapeHtml(convo.inbox_email)}` : ""}
      </p>
    </div>`;

  try {
    if (forwardTransport() === "quickmail") {
      /**
       * Sent through QuickMail, using the mailbox authorisation it already has.
       *
       * `replyToEmail` exists to answer a prospect, but its `to` is explicit and
       * fully replaces the thread's recipient — verified live: the manager got
       * it, the prospect got nothing, cc was empty.
       *
       * FORWARD_FROM_INBOX chooses which mailbox sends. It should NOT be the one
       * that received the reply: those are cold-outreach accounts, and the first
       * forward sent from one landed in Gmail's spam folder. A mailbox that has
       * never run a campaign has no such reputation to overcome.
       */
      if (!convo.replyable_todo_id) {
        return { sent: false, reason: "no replyable message — re-run the reply sync" };
      }

      const result = await withSession((s) =>
        sendReply(s, {
          todoId: convo.replyable_todo_id!,
          inboxId: process.env.FORWARD_FROM_INBOX!.trim(),
          subject,
          html,
          to,
          archive: false,
        }),
      );

      if (result.dryRun) return { sent: false, reason: "QUICKMAIL_DRY_RUN is on" };
      if (!result.sent) return { sent: false, reason: result.error ?? "QuickMail refused" };
    } else {
      await transport().sendMail({
        from: process.env.NOTIFY_FROM ?? process.env.SMTP_USER,
        to,
        // Reply goes to the prospect; see the note above on the tradeoff.
        replyTo: convo.prospect_email ?? to,
        subject,
        text,
        html,
      });
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
export async function forwardPending(limit?: number): Promise<{
  sent: number;
  failed: number;
  remaining: number;
  reasons: string[];
}> {
  if (!forwardingConfigured()) {
    return { sent: 0, failed: 0, remaining: 0, reasons: ["not configured"] };
  }

  /**
   * How many go out per sync, from FORWARD_BATCH.
   *
   * There is a 137-reply backlog, and dispatching that in one press would look
   * like a malfunction to whoever receives it — and to Gmail, which treats a
   * sudden burst from one sender as exactly what it looks like. A small batch
   * drains it over several syncs instead, newest first.
   */
  const batch = limit ?? Math.min(Math.max(Number(process.env.FORWARD_BATCH) || 5, 1), 100);
  const where = pendingWhere();

  const [pending, total] = await Promise.all([
    prisma.qmConversation.findMany({
      where,
      orderBy: { waiting_since: "desc" },
      take: batch,
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
