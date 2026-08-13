import { workspaceId, type Session } from "./inbox";

/**
 * QuickMail's account-level do-not-contact domain list.
 *
 * This is the one place where blocking a domain here also blocks it there. The
 * per-prospect stop (see `stopProspect`) covers one person; this covers every
 * address at a company, including ones neither system has seen.
 *
 * Shapes came from the call sites in QuickMail's bundle, since introspection is
 * disabled on this endpoint:
 *
 *   addDomains()    → addDncDomains({entityId: accountId, entityType: "workspace", domains: []})
 *   removeDomains() → removeDncDomains({entityId, entityType, domainIds: []})
 *
 * `entityType` is "workspace" — not "account". The dnc-table component is bound
 * with entityType="account", but that is a display prop; the handler that
 * actually calls the mutation passes "workspace". An organisation-scoped list
 * exists too and passes "organization"; we only use the workspace one.
 */

const ADD_DOMAINS = `
  mutation addDncDomains($input: AddDncDomainsInput!) {
    addDncDomains(input: $input) { error }
  }
`;

const REMOVE_DOMAINS = `
  mutation removeDncDomains($input: RemoveDncDomainsInput!) {
    removeDncDomains(input: $input) { error }
  }
`;

const LIST_DOMAINS = `
  query workspaceDncDomainsPagination($accountId: ID!, $first: Int, $searchFilter: String) {
    account(accountId: $accountId) {
      id
      dncDomains(first: $first, searchFilter: $searchFilter) {
        totalCount
        edges { node { id domain } }
      }
    }
  }
`;

/**
 * The same three operations for individual addresses.
 *
 * QuickMail keeps addresses on a separate list from domains — the UI shows them
 * as separate tabs — so blocking someone's address there needs its own calls.
 * Shapes taken from the same call sites:
 *
 *   addDncEmails({entityId, entityType: "workspace", emails: []})
 *   removeDncEmails({entityId, entityType, emailIds: []})
 *
 * Removal takes row ids, not addresses, exactly as the domain list does.
 */
const ADD_EMAILS = `
  mutation addDncEmails($input: AddDncEmailsInput!) {
    addDncEmails(input: $input) { error }
  }
`;

const REMOVE_EMAILS = `
  mutation removeDncEmails($input: RemoveDncEmailsInput!) {
    removeDncEmails(input: $input) { error }
  }
`;

const LIST_EMAILS = `
  query workspaceDncEmailsPagination($accountId: ID!, $first: Int, $skip: Int, $searchFilter: String) {
    account(accountId: $accountId) {
      id
      dncEmails(first: $first, skip: $skip, searchFilter: $searchFilter) {
        totalCount
        edges { node { id email label author createdAt } }
      }
    }
  }
`;

export type DncEmail = {
  id: string;
  email: string;
  label: string | null;
  author: string | null;
  createdAt: string | null;
};

export type DncResult = {
  dryRun: boolean;
  ok: boolean;
  error?: string;
  /**
   * How many rows the call actually removed there.
   *
   * Distinct from `ok`: removing something that was never on the list succeeds
   * and removes nothing. The caller needs the difference to answer "was this
   * blocked anywhere at all?" — an address blocked only in QuickMail has no
   * local row, and reporting "not blocked" for it would be wrong.
   */
  removed?: number;
};

type ListResponse = {
  account: {
    dncDomains: {
      totalCount: number;
      edges: { node: { id: string; domain: string } }[];
    };
  };
};

/** Reads QuickMail's blocked-domain list. Read-only. */
export async function listDncDomains(
  s: Session,
  search?: string,
): Promise<{ total: number; domains: { id: string; domain: string }[] }> {
  const data = await s.gql<ListResponse>(LIST_DOMAINS, {
    accountId: workspaceId(),
    first: 100,
    // Sent as a JSON string, the same way their own table does it.
    searchFilter: JSON.stringify({ text: search ?? "" }),
  });

  const conn = data.account.dncDomains;
  return {
    total: conn.totalCount,
    domains: conn.edges.map((e) => e.node),
  };
}

/**
 * Reads QuickMail's blocked-address list. Read-only.
 *
 * Paged explicitly: `first` is not obeyed past their own page size, the same
 * quirk the opportunities list has, so asking for 500 quietly returns far
 * fewer and the list would look shorter than it is.
 */
export async function listDncEmails(
  s: Session,
  opts: { search?: string; limit?: number } = {},
): Promise<{ total: number; emails: DncEmail[] }> {
  const limit = opts.limit ?? 500;
  const emails: DncEmail[] = [];
  let total = 0;

  for (let skip = 0; emails.length < limit; ) {
    const data = await s.gql<{
      account: {
        dncEmails: { totalCount: number; edges: { node: DncEmail }[] };
      };
    }>(LIST_EMAILS, {
      accountId: workspaceId(),
      first: 100,
      skip,
      searchFilter: JSON.stringify({ text: opts.search ?? "" }),
    });

    const conn = data.account.dncEmails;
    total = conn.totalCount;
    if (conn.edges.length === 0) break;

    emails.push(...conn.edges.map((e) => e.node));
    skip += conn.edges.length;
    if (skip >= total) break;
  }

  return { total, emails: emails.slice(0, limit) };
}

/**
 * Blocks an address in QuickMail.
 *
 * Gated behind QUICKMAIL_DRY_RUN like every other write.
 */
export async function addDncEmail(s: Session, email: string): Promise<DncResult> {
  if (process.env.QUICKMAIL_DRY_RUN !== "false") {
    console.log("[quickmail:dry-run] addDncEmails", email);
    return { dryRun: true, ok: false };
  }

  try {
    const data = await s.gql<{ addDncEmails: { error: string | null } }>(ADD_EMAILS, {
      input: {
        entityId: workspaceId(),
        entityType: "workspace",
        emails: [email],
      },
    });
    const error = data.addDncEmails?.error;
    return error ? { dryRun: false, ok: false, error } : { dryRun: false, ok: true };
  } catch (e) {
    return { dryRun: false, ok: false, error: (e as Error).message };
  }
}

/**
 * Unblocks an address in QuickMail.
 *
 * Looks the row up first because removal takes ids. An address that is not on
 * the list counts as ok — the desired end state already holds, and failing
 * would make an unblock of a purely local block look broken.
 */
export async function removeDncEmail(s: Session, email: string): Promise<DncResult> {
  if (process.env.QUICKMAIL_DRY_RUN !== "false") {
    console.log("[quickmail:dry-run] removeDncEmails", email);
    return { dryRun: true, ok: false };
  }

  try {
    const { emails } = await listDncEmails(s, { search: email, limit: 100 });
    const match = emails.filter(
      (e) => e.email.toLowerCase() === email.toLowerCase(),
    );
    if (match.length === 0) return { dryRun: false, ok: true, removed: 0 };

    const data = await s.gql<{ removeDncEmails: { error: string | null } }>(
      REMOVE_EMAILS,
      {
        input: {
          entityId: workspaceId(),
          entityType: "workspace",
          emailIds: match.map((e) => e.id),
        },
      },
    );
    const error = data.removeDncEmails?.error;
    return error
      ? { dryRun: false, ok: false, error, removed: 0 }
      : { dryRun: false, ok: true, removed: match.length };
  } catch (e) {
    return { dryRun: false, ok: false, error: (e as Error).message };
  }
}

/**
 * Blocks a domain in QuickMail.
 *
 * Gated behind QUICKMAIL_DRY_RUN like every other write. Idempotent in practice
 * — adding a domain twice is not an error on their side — so a re-run after a
 * failure is safe.
 */
export async function addDncDomain(s: Session, domain: string): Promise<DncResult> {
  if (process.env.QUICKMAIL_DRY_RUN !== "false") {
    console.log("[quickmail:dry-run] addDncDomains", domain);
    return { dryRun: true, ok: false };
  }

  try {
    const data = await s.gql<{ addDncDomains: { error: string | null } }>(ADD_DOMAINS, {
      input: {
        entityId: workspaceId(),
        entityType: "workspace",
        domains: [domain],
      },
    });
    const error = data.addDncDomains?.error;
    return error ? { dryRun: false, ok: false, error } : { dryRun: false, ok: true };
  } catch (e) {
    return { dryRun: false, ok: false, error: (e as Error).message };
  }
}

/**
 * Unblocks a domain in QuickMail.
 *
 * Removal takes their internal row ids, not the domain text, so the list is
 * searched first. A domain that is not there is reported as ok — the desired
 * end state already holds, and failing would make an unblock look broken.
 */
export async function removeDncDomain(s: Session, domain: string): Promise<DncResult> {
  if (process.env.QUICKMAIL_DRY_RUN !== "false") {
    console.log("[quickmail:dry-run] removeDncDomains", domain);
    return { dryRun: true, ok: false };
  }

  try {
    const { domains } = await listDncDomains(s, domain);
    const match = domains.filter((d) => d.domain.toLowerCase() === domain.toLowerCase());
    if (match.length === 0) return { dryRun: false, ok: true, removed: 0 };

    const data = await s.gql<{ removeDncDomains: { error: string | null } }>(
      REMOVE_DOMAINS,
      {
        input: {
          entityId: workspaceId(),
          entityType: "workspace",
          domainIds: match.map((d) => d.id),
        },
      },
    );
    const error = data.removeDncDomains?.error;
    return error
      ? { dryRun: false, ok: false, error, removed: 0 }
      : { dryRun: false, ok: true, removed: match.length };
  } catch (e) {
    return { dryRun: false, ok: false, error: (e as Error).message };
  }
}
