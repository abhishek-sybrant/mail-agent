import { PageHeader } from "@/components/page-header";
import { prisma } from "@/lib/prisma";
import { StoppedList, type BlockedItem } from "./stopped-list";

export const dynamic = "force-dynamic";

/**
 * Everything that must never be emailed — addresses and whole domains.
 *
 * This list is the reason the bounce problem can be fixed rather than merely
 * observed: it is keyed on the address, not on a Lead row, so re-importing a
 * spreadsheet cannot resurrect someone who asked to stop.
 */
export default async function StoppedPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; kind?: string }>;
}) {
  const params = await searchParams;
  const q = params.q?.trim() ?? "";
  const kind = params.kind === "domains" || params.kind === "emails" ? params.kind : "";

  const [addresses, domains, addressTotal, domainTotal, repeats] = await Promise.all([
    kind === "domains"
      ? []
      : prisma.suppression.findMany({
          where: q ? { email: { contains: q } } : {},
          orderBy: [{ hits: "desc" }, { last_seen: "desc" }],
          take: 300,
        }),
    kind === "emails"
      ? []
      : prisma.suppressedDomain.findMany({
          where: q ? { domain: { contains: q } } : {},
          orderBy: [{ hits: "desc" }, { last_seen: "desc" }],
          take: 300,
        }),
    prisma.suppression.count(),
    prisma.suppressedDomain.count(),
    prisma.suppression.count({ where: { hits: { gt: 1 } } }),
  ]);

  const items: BlockedItem[] = [
    ...domains.map((d) => ({
      id: d.id,
      value: d.domain,
      kind: "domain" as const,
      reason: d.reason,
      source: d.source,
      hits: d.hits,
      note: d.note,
      since: d.first_seen.toISOString(),
    })),
    ...addresses.map((a) => ({
      id: a.id,
      value: a.email,
      kind: "email" as const,
      reason: a.reason,
      source: a.source,
      hits: a.hits,
      note: a.note,
      since: a.first_seen.toISOString(),
    })),
  ];

  return (
    <>
      <PageHeader
        title="Stopped"
        description={
          addressTotal + domainTotal === 0
            ? "Nothing is blocked yet."
            : `${addressTotal} address${addressTotal === 1 ? "" : "es"} and ${domainTotal} domain${domainTotal === 1 ? "" : "s"} will never be emailed.`
        }
      />
      <div className="max-w-5xl p-8">
        <StoppedList
          items={items}
          query={q}
          kind={kind}
          addressTotal={addressTotal}
          domainTotal={domainTotal}
          repeatOffenders={repeats}
        />
      </div>
    </>
  );
}
