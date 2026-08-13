import { PageHeader } from "@/components/page-header";
import { prisma } from "@/lib/prisma";
import { withSession } from "@/lib/quickmail/inbox";
import { listDncDomains, listDncEmails } from "@/lib/quickmail/dnc";
import { StoppedList, type BlockedItem } from "./stopped-list";

export const dynamic = "force-dynamic";

/**
 * QuickMail's own blocked lists, read live.
 *
 * Best-effort on purpose: it needs the browser session, and if that is down the
 * page still has to render the local list rather than fail outright. The reason
 * is returned so the page can say the QuickMail side is unread instead of
 * quietly showing a short list as though it were complete.
 */
async function readQuickMail(): Promise<{
  emails: { email: string; author: string | null }[];
  domains: string[];
  error: string | null;
}> {
  try {
    return await withSession(async (s) => {
      const [e, d] = await Promise.all([
        listDncEmails(s, { limit: 500 }),
        listDncDomains(s),
      ]);
      return {
        emails: e.emails.map((x) => ({ email: x.email, author: x.author })),
        domains: d.domains.map((x) => x.domain),
        error: null,
      };
    });
  } catch (error) {
    return {
      emails: [],
      domains: [],
      error: error instanceof Error ? error.message : "QuickMail unreachable",
    };
  }
}

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

  const [quickmail, addresses, domains, addressTotal, domainTotal, repeats] =
    await Promise.all([
      readQuickMail(),
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

  const qmEmails = new Set(quickmail.emails.map((e) => e.email.toLowerCase()));
  const qmDomains = new Set(quickmail.domains.map((d) => d.toLowerCase()));
  const qmAuthor = new Map(
    quickmail.emails.map((e) => [e.email.toLowerCase(), e.author]),
  );

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
      where: qmDomains.has(d.domain.toLowerCase())
        ? ("both" as const)
        : ("local" as const),
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
      where: qmEmails.has(a.email.toLowerCase())
        ? ("both" as const)
        : ("local" as const),
    })),
  ];

  /**
   * Blocks that exist only in QuickMail.
   *
   * Someone who unsubscribed there, or an address a colleague blocked in their
   * UI, never appeared here at all — so this list read as complete while the
   * app was quietly willing to email people QuickMail had already stopped.
   * They carry no local row, which is why unblocking has to be able to act on
   * QuickMail alone.
   */
  const matchesQuery = (v: string) => !q || v.toLowerCase().includes(q.toLowerCase());

  const quickmailOnly: BlockedItem[] = [
    ...(kind === "emails"
      ? []
      : quickmail.domains
          .filter((d) => matchesQuery(d))
          .filter((d) => !domains.some((x) => x.domain.toLowerCase() === d.toLowerCase()))
          .map((d) => ({
            id: `qm-domain-${d}`,
            value: d,
            kind: "domain" as const,
            reason: "MANUAL",
            source: "quickmail",
            hits: 0,
            note: null,
            since: "",
            where: "quickmail" as const,
          }))),
    ...(kind === "domains"
      ? []
      : quickmail.emails
          .filter((e) => matchesQuery(e.email))
          .filter(
            (e) => !addresses.some((x) => x.email.toLowerCase() === e.email.toLowerCase()),
          )
          .map((e) => ({
            id: `qm-email-${e.email}`,
            value: e.email,
            kind: "email" as const,
            reason: "MANUAL",
            source: "quickmail",
            hits: 0,
            note: qmAuthor.get(e.email.toLowerCase())
              ? `blocked in QuickMail by ${qmAuthor.get(e.email.toLowerCase())}`
              : null,
            since: "",
            where: "quickmail" as const,
          }))),
  ];

  /**
   * Count what is actually on the list, both systems together.
   *
   * The pills counted only local rows while the list below showed QuickMail's
   * blocks too, so a page listing four entries announced "All 1". Overlap is
   * subtracted with a targeted query rather than by trusting the loaded page,
   * which is capped at 300 and would undercount once the bounce import lands.
   */
  const qmEmailList = quickmail.emails.map((e) => e.email.toLowerCase());
  const qmDomainList = quickmail.domains.map((d) => d.toLowerCase());

  const [emailOverlap, domainOverlap] = await Promise.all([
    qmEmailList.length
      ? prisma.suppression.count({ where: { email: { in: qmEmailList } } })
      : 0,
    qmDomainList.length
      ? prisma.suppressedDomain.count({ where: { domain: { in: qmDomainList } } })
      : 0,
  ]);

  const addressCount = addressTotal + qmEmailList.length - emailOverlap;
  const domainCount = domainTotal + qmDomainList.length - domainOverlap;

  const qmTotal = quickmail.emails.length + quickmail.domains.length;
  const localTotal = addressTotal + domainTotal;

  return (
    <>
      <PageHeader
        title="Stopped"
        description={
          localTotal + qmTotal === 0
            ? "Nothing is blocked yet."
            : `${addressCount} address${addressCount === 1 ? "" : "es"} and ${domainCount} domain${domainCount === 1 ? "" : "s"} will never be emailed` +
              (quickmail.error
                ? " — and QuickMail's own list could not be read, so there may be more."
                : ".")
        }
      />
      <div className="max-w-5xl p-8">
        <StoppedList
          items={[...items, ...quickmailOnly]}
          query={q}
          kind={kind}
          addressTotal={addressCount}
          domainTotal={domainCount}
          repeatOffenders={repeats}
          quickmailError={quickmail.error}
        />
      </div>
    </>
  );
}
