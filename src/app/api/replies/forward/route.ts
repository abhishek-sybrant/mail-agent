import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { forwardReply, forwardingConfigured } from "@/lib/forward-reply";
import { badRequest, optionalString, readJson } from "@/lib/webhook";

/**
 * POST /api/replies/forward — { conversation_id }
 *
 * Emails one reply to whoever handles them. The sync forwards qualifying
 * replies on its own; this is the manual override for a thread it skipped —
 * a neutral one that turns out to matter, or a re-send.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!forwardingConfigured()) {
    return NextResponse.json(
      {
        error:
          "Forwarding is not set up. Add MANAGER_EMAIL and RESEND_API_KEY to .env, then restart.",
      },
      { status: 409 },
    );
  }

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const id = optionalString(parsed.data.conversation_id);
  if (!id) return badRequest("`conversation_id` is required");

  // force: a human asking again means send it again, even if the sync already did.
  const result = await forwardReply(id, { force: true });

  if (!result.sent) {
    return NextResponse.json({ error: result.reason }, { status: 502 });
  }
  return NextResponse.json({ ok: true, to: result.to });
}
