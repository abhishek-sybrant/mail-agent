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

export type DncResult = {
  dryRun: boolean;
  ok: boolean;
  error?: string;
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
    if (match.length === 0) return { dryRun: false, ok: true };

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
    return error ? { dryRun: false, ok: false, error } : { dryRun: false, ok: true };
  } catch (e) {
    return { dryRun: false, ok: false, error: (e as Error).message };
  }
}
