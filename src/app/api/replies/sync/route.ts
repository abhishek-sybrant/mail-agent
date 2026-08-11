import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { withSession } from "@/lib/quickmail/inbox";
import { pullReplies } from "@/lib/quickmail/inbox-pull";
import { forwardPending } from "@/lib/forward-reply";
import { readJson } from "@/lib/webhook";

/**
 * POST /api/replies/sync — { limit?: number }
 *
 * Pulls the reply inbox from QuickMail. Read-only against QuickMail; writes the
 * local mirror.
 *
 * Bounded on purpose. Each thread is a separate round trip through the browser
 * session, so a full pull of every conversation takes minutes — far too long to
 * hold a click. The default is one page, and the response says how many of the
 * total were fetched so a partial sync never reads as a complete one.
 */
export const maxDuration = 300;

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await readJson(request);
  // Read the raw value: `limit` arrives as a JSON number, and optionalString
  // returns null for anything that isn't a string — which silently pinned every
  // request to the default.
  const limitRaw = parsed.ok ? parsed.data.limit : null;
  const limit = Math.min(Math.max(Number(limitRaw) || 30, 1), 200);

  try {
    const result = await withSession((s) => pullReplies(s, { limit }));

    /**
     * Forward after the pull, not during it.
     *
     * A thread is only worth forwarding once it has been classified and stored,
     * and doing it here means a failure to email never costs us the sync — the
     * replies are already saved either way.
     */
    const forwarded = await forwardPending().catch((error) => ({
      sent: 0,
      failed: 0,
      remaining: 0,
      reasons: [error instanceof Error ? error.message : "forwarding failed"],
    }));

    return NextResponse.json({
      ok: true,
      ...result,
      partial: result.conversations < result.total,
      forwarded,
    });
  } catch (error) {
    /**
     * The common failure is not a bug: Edge is closed, or the debugging port
     * isn't open, or nobody is signed in. Say which, because "sync failed" sends
     * people looking in the wrong place.
     */
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Sync failed" },
      { status: 502 },
    );
  }
}
