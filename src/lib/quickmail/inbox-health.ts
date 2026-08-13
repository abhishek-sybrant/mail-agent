import { prisma } from "@/lib/prisma";
import { workspaceId, type Session } from "./inbox";

/**
 * QuickMail's own verdict on whether a sender's mail will land.
 *
 * The v2 API says only whether a mailbox is authorized and paused, which
 * catches a dead connection but says nothing about deliverability — a mailbox
 * can be perfectly connected and still have its mail filed as spam. Their
 * internal inbox list carries the judgement (`accredited`), the warm-up health
 * number (`score`) and the daily send counter, so it is read from there.
 *
 * Mirrored rather than fetched on demand: it needs the browser session, and a
 * composer that cannot open when Edge is closed would be worse than one
 * showing figures from the last sync.
 */

const INBOXES = `
  query accountinboxPagination($accountId: ID!, $first: Int, $skip: Int, $searchFilter: String) {
    account(accountId: $accountId) {
      id
      paginatedInboxes(first: $first, skip: $skip, searchFilter: $searchFilter) {
        totalCount
        edges {
          node {
            id
            email
            accredited
            paused
            pausedReason
            hasAutoWarmer
            score
            dailySendingInfo { quota sendCount }
          }
        }
      }
    }
  }
`;

type InboxNode = {
  id: string;
  email: string | null;
  accredited: boolean | null;
  paused: boolean | null;
  pausedReason: string | null;
  hasAutoWarmer: boolean | null;
  score: number | null;
  dailySendingInfo: { quota: number | null; sendCount: number | null } | null;
};

export type HealthResult = {
  read: number;
  updated: number;
  /** Mailboxes QuickMail says are not fit to send. */
  unaccredited: string[];
};

/**
 * Reads every inbox's health and writes it onto the local mirror.
 *
 * Matched on the numeric id their internal API uses, falling back to the
 * address: the v2 ids (`email_kKXM…`) and the internal ids are different
 * namespaces for the same mailbox, and only the address is common to both.
 */
export async function syncInboxHealth(s: Session): Promise<HealthResult> {
  const nodes: InboxNode[] = [];
  let total = 0;

  for (let skip = 0; ; ) {
    const data = await s.gql<{
      account: {
        paginatedInboxes: { totalCount: number; edges: { node: InboxNode }[] };
      };
    }>(INBOXES, {
      accountId: workspaceId(),
      first: 50,
      skip,
      searchFilter: JSON.stringify({ text: "" }),
    });

    const conn = data.account.paginatedInboxes;
    total = conn.totalCount;
    if (conn.edges.length === 0) break;

    nodes.push(...conn.edges.map((e) => e.node));
    skip += conn.edges.length;
    if (skip >= total) break;
  }

  const result: HealthResult = { read: nodes.length, updated: 0, unaccredited: [] };

  for (const n of nodes) {
    const email = n.email?.trim().toLowerCase();
    if (!email) continue;

    if (n.accredited === false) result.unaccredited.push(email);

    const data = {
      accredited: n.accredited,
      score: n.score,
      paused_reason: n.pausedReason,
      has_warmer: n.hasAutoWarmer,
      daily_sent: n.dailySendingInfo?.sendCount ?? null,
      daily_quota: n.dailySendingInfo?.quota ?? null,
      health_at: new Date(),
      // Their own paused flag is the fresher of the two sources.
      ...(n.paused === null ? {} : { qm_paused: n.paused }),
    };

    /**
     * Update by address, not id.
     *
     * The mirror is keyed on the v2 id, which this endpoint does not use, so
     * matching on the id would silently update nothing at all.
     */
    const { count } = await prisma.qmMailbox.updateMany({
      where: { email },
      data,
    });
    result.updated += count;
  }

  return result;
}
