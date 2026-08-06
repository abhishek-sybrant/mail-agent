import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { draftReply } from "@/lib/ai/generate";
import { classifyReply } from "@/lib/ai/classify";
import { replyText } from "@/lib/quickmail/mail-text";
import { badRequest, optionalString, readJson } from "@/lib/webhook";

/** First name to sign a reply with, from the mailbox that received it. */
function senderFirstName(
  inboxName: string | null,
  inboxEmail: string | null,
): string | undefined {
  const fromName = inboxName?.trim().split(/\s+/)[0];
  if (fromName) return fromName;

  const local = inboxEmail?.split("@")[0]?.split(/[._-]/)[0];
  if (!local) return undefined;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

/**
 * POST /api/replies/draft — { conversation_id, variation?: number }
 *
 * Drafts an answer to the latest inbound message in a thread, and classifies
 * it. Deliberately on demand rather than during the page render: a draft costs
 * a model round trip, and doing one per thread on load would put the whole
 * queue behind the slowest of them.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const id = optionalString(parsed.data.conversation_id);
  if (!id) return badRequest("`conversation_id` is required");
  const variation = Number(parsed.data.variation) || 0;

  const convo = await prisma.qmConversation.findUnique({
    where: { id },
    include: {
      messages: { where: { direction: "IN" }, orderBy: { sent_at: "desc" }, take: 1 },
    },
  });
  if (!convo) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  const latest = convo.messages[0];
  if (!latest) return badRequest("This thread has no inbound message to answer");

  // The quoted history is stripped: replying to the whole thread makes the
  // model answer a message from three weeks ago.
  const incoming = replyText(latest);
  const bookingLink = process.env.BOOKING_LINK?.trim() || null;

  try {
    const [draft, verdict] = await Promise.all([
      draftReply({
        incoming,
        name: convo.prospect_name,
        company: convo.prospect_company,
        sentiment: convo.reply_type ?? "NEUTRAL",
        bookingLink,
        // Sign as whoever owns the mailbox that received it, not a generic
        // name. The local part is only a fallback, and needs capitalising —
        // "lisa.white@…" was signing replies "lisa".
        senderName: senderFirstName(convo.inbox_name, convo.inbox_email),
        variation,
      }),
      classifyReply(incoming, {
        name: convo.prospect_name,
        company: convo.prospect_company,
      }).catch(() => null),
    ]);

    // Cache the classification so the next page load can colour the thread.
    if (verdict && !convo.reply_type) {
      await prisma.qmConversation.update({
        where: { id },
        data: { reply_type: verdict.sentiment },
      });
    }

    return NextResponse.json({
      draft,
      booking_link: bookingLink,
      sentiment: verdict?.sentiment ?? null,
      intent_score: verdict?.intent_score ?? null,
      reasoning: verdict?.reasoning ?? null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Draft failed" },
      { status: 502 },
    );
  }
}
