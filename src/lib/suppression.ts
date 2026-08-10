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
 * The domain part of an address, normalised the same way.
 *
 * Accepts a bare domain too, so "@example.com", "example.com" and
 * "someone@example.com" all reduce to "example.com" — the UI passes whichever
 * the user typed.
 */
export function domainOf(value: string): string {
  const v = value.trim().toLowerCase().replace(/^@/, "");
  const at = v.lastIndexOf("@");
  return at === -1 ? v : v.slice(at + 1);
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

  /**
   * Keep the Lead row consistent so existing queries and the UI agree.
   *
   * updateMany, because having no local Lead for the address is normal — a
   * bounce webhook can name someone we never imported, and the address is
   * barred either way. `update` would throw and log an error for that.
   */
  await prisma.lead.updateMany({
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
  });

  return { email, hits: row.hits, firstTime: !existing };
}

/**
 * Bars an entire domain.
 *
 * Deliberately does not walk the existing leads and flag them one by one: the
 * check below consults this table on every send and every enrolment, so the
 * block applies to addresses we have never seen as well as the ones we have.
 * Back-filling would only make the same rule true twice, and go stale.
 */
export async function suppressDomain(input: {
  domain: string;
  reason: SuppressionReason;
  source: string;
  note?: string | null;
}): Promise<{ domain: string; firstTime: boolean; leadsAffected: number }> {
  const domain = domainOf(input.domain);
  if (!domain || !domain.includes(".")) {
    throw new Error(`"${input.domain}" is not a domain`);
  }

  const existing = await prisma.suppressedDomain.findUnique({ where: { domain } });

  await prisma.suppressedDomain.upsert({
    where: { domain },
    update: { reason: input.reason, note: input.note ?? existing?.note ?? null },
    create: {
      domain,
      reason: input.reason,
      source: input.source,
      note: input.note ?? null,
    },
  });

  // Count what it covers, for the confirmation message. Reading only — the
  // block is enforced by the check, not by these rows.
  const leadsAffected = await prisma.lead.count({
    where: { email: { endsWith: `@${domain}` } },
  });

  return { domain, firstTime: !existing, leadsAffected };
}

/** Is this address barred, either by itself or by its domain? */
export async function isSuppressed(email: string): Promise<boolean> {
  const address = normalise(email);
  const [byAddress, byDomain] = await Promise.all([
    prisma.suppression.findUnique({ where: { email: address }, select: { id: true } }),
    prisma.suppressedDomain.findUnique({
      where: { domain: domainOf(address) },
      select: { id: true },
    }),
  ]);
  return byAddress !== null || byDomain !== null;
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

  const domains = [...new Set(wanted.map(domainOf))];

  const [rows, blockedDomains] = await Promise.all([
    prisma.suppression.findMany({
      where: { email: { in: wanted } },
      select: { email: true, reason: true, hits: true },
    }),
    prisma.suppressedDomain.findMany({
      where: { domain: { in: domains } },
      select: { domain: true, reason: true },
    }),
  ]);

  const byEmail = new Map(rows.map((r) => [r.email, r]));
  const byDomain = new Map(blockedDomains.map((d) => [d.domain, d]));

  const blocked: { email: string; reason: string; hits: number }[] = [];
  const allowed: string[] = [];

  for (const email of wanted) {
    const direct = byEmail.get(email);
    if (direct) {
      blocked.push({ email, reason: direct.reason, hits: direct.hits });
      continue;
    }
    const domain = byDomain.get(domainOf(email));
    if (domain) {
      // Named so the caller can say *why* it was blocked — "the domain is
      // barred" is a different conversation from "this person opted out".
      blocked.push({ email, reason: `${domain.reason} (domain @${domain.domain})`, hits: 0 });
      continue;
    }
    allowed.push(email);
  }

  // Record that a domain block actually caught something. A domain with rising
  // hits is evidence the import pipeline keeps pulling that company back in.
  const caught = [...new Set(blocked.map((b) => domainOf(b.email)))].filter((d) =>
    byDomain.has(d),
  );
  if (caught.length > 0) {
    await prisma.suppressedDomain.updateMany({
      where: { domain: { in: caught } },
      data: { hits: { increment: 1 } },
    });
  }

  return { allowed, blocked };
}

/** Counts for the dashboard, cheap enough to call on a page render. */
export async function suppressionSummary(): Promise<{
  total: number;
  domains: number;
  byReason: { reason: string; count: number }[];
  repeatOffenders: number;
}> {
  const [total, domains, grouped, repeats] = await Promise.all([
    prisma.suppression.count(),
    prisma.suppressedDomain.count(),
    prisma.suppression.groupBy({ by: ["reason"], _count: true }),
    // More than one hit means something re-enrolled an address we already knew
    // was dead — the signal that the import path needs attention.
    prisma.suppression.count({ where: { hits: { gt: 1 } } }),
  ]);

  return {
    total,
    domains,
    byReason: grouped.map((g) => ({ reason: g.reason, count: g._count })),
    repeatOffenders: repeats,
  };
}

/** Lifts a block. Used by the Stopped tab and `npm run unstop`. */
export async function unsuppress(value: string): Promise<{
  removedAddress: boolean;
  removedDomain: boolean;
}> {
  const address = normalise(value);

  /**
   * deleteMany / updateMany rather than delete / update.
   *
   * The singular forms throw when nothing matches, and catching that logs a
   * Prisma error for what is a perfectly ordinary outcome — unblocking a domain
   * naturally finds no address row. The plural forms return a count instead, so
   * a clean run stays clean in the logs.
   */
  const { count: removedAddressCount } = await prisma.suppression.deleteMany({
    where: { email: address },
  });
  const removedAddress = removedAddressCount > 0;

  if (removedAddress) {
    await prisma.lead.updateMany({
      where: { email: address },
      data: { suppressed: false, suppressed_reason: null },
    });
  }

  // Only treat it as a domain when it has no local part, so unblocking
  // "someone@example.com" cannot silently unblock the whole company.
  let removedDomain = false;
  if (!address.includes("@")) {
    const { count } = await prisma.suppressedDomain.deleteMany({
      where: { domain: domainOf(address) },
    });
    removedDomain = count > 0;
  }

  return { removedAddress, removedDomain };
}
