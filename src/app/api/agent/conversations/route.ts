import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { optionalString, readJson } from "@/lib/webhook";

/**
 * Saved AI-agent conversations.
 *
 * GET  → the most recent chats, newest first (list view; transcripts included
 *        so reopening one needs no second request).
 * POST → upsert the current chat. The client owns the id so a chat updates in
 *        place as it grows rather than creating a row per turn.
 */

const MAX = 50;

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await prisma.agentConversation.findMany({
    orderBy: { updated_at: "desc" },
    take: MAX,
  });

  return NextResponse.json({
    conversations: rows.map((r) => ({
      id: r.id,
      title: r.title,
      updatedAt: r.updated_at.toISOString(),
      messages: safeParse(r.messages, []),
      spec: safeParse(r.spec, {}),
    })),
  });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const id = optionalString(body.id);
  const title = (optionalString(body.title) ?? "Untitled").slice(0, 120);
  const messages = JSON.stringify(body.messages ?? []);
  const spec = JSON.stringify(body.spec ?? {});

  // A chat is one row for its whole life; the client keeps the id between turns.
  const row = id
    ? await prisma.agentConversation.upsert({
        where: { id },
        update: { title, messages, spec },
        create: { id, title, messages, spec },
      })
    : await prisma.agentConversation.create({ data: { title, messages, spec } });

  return NextResponse.json({ ok: true, id: row.id });
}

export async function DELETE(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "`id` is required" }, { status: 400 });

  await prisma.agentConversation.delete({ where: { id } }).catch(() => undefined);
  return NextResponse.json({ ok: true });
}

/** A malformed row should not break the whole list. */
function safeParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
