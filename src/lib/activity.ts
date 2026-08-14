import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import type { ActivityAction } from "./activity-labels";

/**
 * Recording who did what.
 *
 * Every outward-facing action goes through here — creating a campaign, sending
 * a reply, blocking an address. None of it left a trace before, so "who made
 * this campaign" was unanswerable from inside the app.
 *
 * Never throws into the thing it is recording. A campaign that was created
 * must not fail because the log write did; a missing line is a smaller problem
 * than a rolled-back send.
 */

export { ACTIONS, actionLabel, type ActivityAction } from "./activity-labels";

/**
 * Writes one line, attributing it to the signed-in user.
 *
 * The session is read here rather than passed in, so a call site cannot forget
 * it and quietly produce an unattributed record.
 */
export async function logActivity(
  action: ActivityAction,
  subject: string,
  detail?: string | null,
): Promise<void> {
  try {
    const session = await auth();
    const who = session?.user as
      | { id?: string; name?: string | null; email?: string | null }
      | undefined;

    await prisma.activityLog.create({
      data: {
        action,
        subject: subject.slice(0, 300),
        detail: detail?.slice(0, 500) ?? null,
        user_id: who?.id ?? null,
        // Written down as well as linked, so removing the account later leaves
        // the line attributed rather than looking automatic.
        actor: who?.name ?? who?.email ?? null,
      },
    });
  } catch {
    // Deliberately silent — see the note above.
  }
}

/**
 * The same, for work with no person behind it.
 *
 * The hourly sync forwards replies and applies campaign windows on its own;
 * attributing that to whoever happened to be signed in would be a lie.
 */
export async function logSystemActivity(
  action: ActivityAction,
  subject: string,
  detail?: string | null,
): Promise<void> {
  try {
    await prisma.activityLog.create({
      data: {
        action,
        subject: subject.slice(0, 300),
        detail: detail?.slice(0, 500) ?? null,
        user_id: null,
      },
    });
  } catch {
    /* never breaks the caller */
  }
}
