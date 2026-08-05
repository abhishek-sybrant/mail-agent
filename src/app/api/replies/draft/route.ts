import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { draftReply } from "@/lib/ai/generate";
import { badRequest, optionalString, readJson } from "@/lib/webhook";

/**
 * POST /api/replies/draft — { log_id, variation?: number }
 *
 * Drafts an answer to one inbound reply.
 *
 * Deliberately on demand rather than during the page render: a draft costs one
 * model round trip, and generating one per reply on load would put the whole
 * queue behind the slowest of them.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const logId = optionalString(parsed.data.log_id);
  if (!logId) return badRequest("`log_id` is required");
  const variation = Number(parsed.data.variation) || 0;

  const log = await prisma.emailLog.findUnique({
    where: { id: logId },
    include: { lead: true },
  });
  if (!log) return NextResponse.json({ error: "Reply not found" }, { status: 404 });

  const bookingLink = process.env.BOOKING_LINK?.trim() || null;

  try {
    const draft = await draftReply({
      incoming: log.content ?? "",
      name: log.lead.name,
      company: log.lead.company,
      sentiment: log.sentiment ?? "NEUTRAL",
      bookingLink,
      variation,
    });

    return NextResponse.json({ draft, booking_link: bookingLink });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Draft failed" },
      { status: 502 },
    );
  }
}
