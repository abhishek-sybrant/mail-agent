/**
 * Approval notifications.
 *
 * The in-app queue is always the source of truth — email is a nudge on top.
 * If SMTP isn't configured we log and move on rather than failing the webhook
 * that triggered this.
 */
export async function notifyApprovalNeeded(input: {
  title: string;
  summary: string | null;
  leadEmail: string;
  intent: number;
}) {
  const to = process.env.NOTIFY_EMAIL;
  const apiKey = process.env.RESEND_API_KEY;

  if (!to || !apiKey) {
    console.log(`[notify] approval pending: ${input.title} (${input.leadEmail})`);
    return { sent: false, reason: "not configured" as const };
  }

  const appUrl = process.env.APP_URL ?? "http://localhost:3000";

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
        subject: `[AI SDR] ${input.title}`,
        text: [
          input.title,
          "",
          input.summary ?? "",
          `Lead: ${input.leadEmail}`,
          `Intent score: ${input.intent}`,
          "",
          `Review and approve: ${appUrl}/approvals`,
        ].join("\n"),
      }),
    });

    return { sent: res.ok, status: res.status };
  } catch (error) {
    console.error("[notify] email failed", error);
    return { sent: false, reason: "error" as const };
  }
}
