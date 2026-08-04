import { prisma } from "@/lib/prisma";

/**
 * The do-not-send list.
 *
 * Why this exists as its own table rather than a flag on Lead: a flag dies with
 * the row. Re-uploading a spreadsheet creates a fresh Lead with `suppressed`
 * back to false, and the dead address goes straight back into a campaign. That
 * is measurably what has been happening on this account — roughly 41 bounce
 * events per unique bad address, and 139 campaigns above a 5% bounce rate.
 * Keying on the address and never deleting it is the whole point.
 *
 * QuickMail cannot backfill this. Its API has no lead-level deliverability
 * field, no bounce/event query and no tags — only per-campaign totals — so the
 * sources are the bounce webhook, CSV exports from QuickMail's UI, and negative
 * or unsubscribe replies.
 */

export type SuppressionReason =
  | "BOUNCE"
  | "COMPLAINT"
  | "UNSUBSCRIBE"
  | "NEGATIVE_REPLY"
  | "MANUAL";

/** Addresses are compared lowercased and trimmed, always. */
export function normalise(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Adds or reinforces a suppression.
 *
 * Repeats bump `hits` rather than erroring — a second bounce for the same
 * address is meaningful, because it means something re-enrolled it.
 */
export async function suppress(input: {
  email: string;
  reason: SuppressionReason;
  source: string;
  note?: string | null;
}): Promise<{ email: string; hits: number; firstTime: boolean }> {
  const email = normalise(input.email);

  const existing = await prisma.suppression.findUnique({ where: { email } });
  const row = await prisma.suppression.upsert({
    where: { email },
    update: {
      hits: { increment: 1 },
      // A later, firmer reason wins: a complaint outranks a soft bounce.
      reason: input.reason,
      note: input.note ?? existing?.note ?? null,
    },
    create: {
      email,
      reason: input.reason,
      source: input.source,
      note: input.note ?? null,
    },
  });

  // Keep the Lead row consistent so existing queries and the UI agree.
  await prisma.lead
    .update({
      where: { email },
      data: {
        suppressed: true,
        suppressed_reason: input.note ?? input.reason,
        ai_intent_score: 0,
        ...(input.reason === "BOUNCE" ? { status: "BOUNCED" as const } : {}),
        ...(input.reason === "UNSUBSCRIBE" || input.reason === "COMPLAINT"
          ? { status: "DNC" as const }
          : {}),
      },
    })
    .catch(() => undefined); // no local lead is fine — the address is still barred

  return { email, hits: row.hits, firstTime: !existing };
}

/** Is this address barred? */
export async function isSuppressed(email: string): Promise<boolean> {
  const row = await prisma.suppression.findUnique({
    where: { email: normalise(email) },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Filters a set of addresses down to the ones that may be contacted.
 *
 * Batched deliberately: enrolment can involve thousands of leads, and one query
 * per address would be both slow and easy to accidentally skip under load.
 */
export async function partitionSuppressed(emails: string[]): Promise<{
  allowed: string[];
  blocked: { email: string; reason: string; hits: number }[];
}> {
  const wanted = [...new Set(emails.map(normalise))];
  if (wanted.length === 0) return { allowed: [], blocked: [] };

  const rows = await prisma.suppression.findMany({
    where: { email: { in: wanted } },
    select: { email: true, reason: true, hits: true },
  });
  const byEmail = new Map(rows.map((r) => [r.email, r]));

  return {
    allowed: wanted.filter((e) => !byEmail.has(e)),
    blocked: rows.map((r) => ({ email: r.email, reason: r.reason, hits: r.hits })),
  };
}

/** Counts for the dashboard, cheap enough to call on a page render. */
export async function suppressionSummary(): Promise<{
  total: number;
  byReason: { reason: string; count: number }[];
  repeatOffenders: number;
}> {
  const [total, grouped, repeats] = await Promise.all([
    prisma.suppression.count(),
    prisma.suppression.groupBy({ by: ["reason"], _count: true }),
    // More than one hit means something re-enrolled an address we already knew
    // was dead — the signal that the import path needs attention.
    prisma.suppression.count({ where: { hits: { gt: 1 } } }),
  ]);

  return {
    total,
    byReason: grouped.map((g) => ({ reason: g.reason, count: g._count })),
    repeatOffenders: repeats,
  };
}
