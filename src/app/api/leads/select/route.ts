import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { readJson } from "@/lib/webhook";

/**
 * POST /api/leads/select
 *
 * Resolves a title filter into concrete lead IDs, so the campaign builder can
 * show how many people a filter actually reaches before anything is created.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const titles = Array.isArray(parsed.data.titles)
    ? parsed.data.titles.filter((t): t is string => typeof t === "string")
    : [];
  // Free-text search across the fields a person actually remembers.
  const q = typeof parsed.data.q === "string" ? parsed.data.q.trim() : "";
  const excludeSuppressed = parsed.data.exclude_suppressed !== false;
  const limit = Math.min(Number(parsed.data.limit) || 500, 2000);

  const where = {
    status: { in: ["UNCONTACTED", "EMAILED"] as ("UNCONTACTED" | "EMAILED")[] },
    ...(excludeSuppressed ? { suppressed: false } : {}),
    // Title keywords and free text are ANDed: "director" in the title AND
    // "cbre" anywhere narrows, rather than widening the net.
    ...(titles.length > 0
      ? { OR: titles.map((t) => ({ title: { contains: t } })) }
      : {}),
    ...(q
      ? {
          AND: [
            {
              OR: [
                { name: { contains: q } },
                { email: { contains: q } },
                { company: { contains: q } },
              ],
            },
          ],
        }
      : {}),
  };

  const [count, leads] = await Promise.all([
    prisma.lead.count({ where }),
    prisma.lead.findMany({
      where,
      orderBy: [{ ai_intent_score: "desc" }, { created_at: "desc" }],
      take: limit,
      select: {
        id: true,
        email: true,
        name: true,
        company: true,
        title: true,
        status: true,
        ai_intent_score: true,
      },
    }),
  ]);

  return NextResponse.json({
    ok: true,
    count,
    capped: count > limit,
    lead_ids: leads.map((l) => l.id),
    // The picker renders these so a human can deselect individuals rather
    // than trusting a bare count.
    leads: leads.map((l) => ({
      id: l.id,
      email: l.email,
      name: l.name,
      company: l.company,
      title: l.title,
      status: l.status,
      intent: l.ai_intent_score,
    })),
  });
}
