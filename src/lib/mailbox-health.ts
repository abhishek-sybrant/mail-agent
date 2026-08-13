/**
 * Whether a sending mailbox can actually be used, and why not.
 *
 * Four different things stop a mailbox from working and they fail in four
 * different ways, none of them loud:
 *
 *   not accredited → QuickMail has judged its mail unfit; it sends, and lands
 *                    in spam
 *   not authorized → the OAuth connection is dead; QuickMail accepts the
 *                    mailbox and then silently sends nothing at all
 *   paused         → nothing goes out until someone unpauses it there
 *   not assignable → attaching it to a campaign 500s, so the build fails
 *
 * A picker that lists all seventeen as equal invites picking one of these, and
 * the campaign then underperforms or never sends, with nothing on screen ever
 * having said why. Shared by both composers and the agent's plan so the three
 * cannot disagree about which senders are safe.
 */

export type MailboxLike = {
  email: string;
  accredited?: boolean | null;
  authorized?: boolean | null;
  qm_paused?: boolean | null;
  paused_reason?: string | null;
  assignable?: boolean | null;
  score?: number | null;
  daily_sent?: number | null;
  daily_quota?: number | null;
};

export type MailboxVerdict = {
  /** False when this mailbox must not be used to send. */
  usable: boolean;
  severity: "ok" | "warn" | "blocked";
  /** Short enough for a row; explains the consequence, not just the state. */
  reason: string | null;
};

/**
 * A warm-up score below this is poor enough to mention.
 *
 * Only mailboxes that have been through QuickMail's auto-warmer have one at
 * all, so a null score is "not measured", never "bad".
 */
const LOW_SCORE = 50;

export function mailboxHealth(m: MailboxLike): MailboxVerdict {
  if (m.authorized === false) {
    return {
      usable: false,
      severity: "blocked",
      reason:
        "disconnected from QuickMail — it would be accepted and then send nothing",
    };
  }

  if (m.accredited === false) {
    return {
      usable: false,
      severity: "blocked",
      reason: "not accredited by QuickMail — its mail lands in spam",
    };
  }

  if (m.qm_paused === true) {
    return {
      usable: false,
      severity: "blocked",
      reason: m.paused_reason
        ? `paused in QuickMail — ${m.paused_reason}`
        : "paused in QuickMail",
    };
  }

  if (m.assignable === false) {
    return {
      usable: false,
      severity: "blocked",
      reason: "QuickMail refuses to attach this mailbox to a campaign",
    };
  }

  if (typeof m.score === "number" && m.score < LOW_SCORE) {
    return {
      usable: true,
      severity: "warn",
      reason: `warm-up score ${m.score} — deliverability is still poor`,
    };
  }

  if (
    typeof m.daily_sent === "number" &&
    typeof m.daily_quota === "number" &&
    m.daily_quota > 0 &&
    m.daily_sent >= m.daily_quota
  ) {
    return {
      usable: true,
      severity: "warn",
      reason: `at its daily cap (${m.daily_sent}/${m.daily_quota}) — the rest waits for tomorrow`,
    };
  }

  return { usable: true, severity: "ok", reason: null };
}

/** The mailbox to pre-select: healthy first, never a blocked one. */
export function bestMailbox<T extends MailboxLike>(list: T[]): T | undefined {
  return (
    list.find((m) => mailboxHealth(m).severity === "ok") ??
    list.find((m) => mailboxHealth(m).usable)
  );
}
