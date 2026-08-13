/**
 * Who owns the threads QuickMail refuses to let us reply to.
 *
 *   npx tsx scripts/probe-assignment.ts
 *
 * Forwarding fails on a few conversations with "You (N) don't have the
 * permission to todo (M)", while other threads in the SAME inbox forward
 * fine — so it is not inbox-level access. Opportunities carry a `logons`
 * list (the team members they are assigned to), and this reads it.
 *
 * Strictly read-only. It changes nothing.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { withSession, workspaceId } from "../src/lib/quickmail/inbox";

/**
 * Field names copied from the bundle's AppOpportunitiesFields fragment rather
 * than guessed — an invented selection makes their endpoint answer 500 with an
 * HTML error page, which says nothing about which field was wrong.
 */
const OPPS = `
  query Assigned($accountId: ID!, $first: Int, $skip: Int, $searchFilter: String) {
    account(accountId: $accountId) {
      id
      opportunities(first: $first, skip: $skip, searchFilter: $searchFilter) {
        totalCount
        edges {
          node {
            id
            state
            logons { id name email }
            inbox { id name email }
            prospect { id email }
          }
        }
      }
    }
  }
`;

type OppsResult = {
  account: {
    opportunities: {
      totalCount: number;
      edges: {
        node: {
          id: string;
          state: string;
          logons: { id: string; name: string; email: string }[] | null;
          inbox: { id: string; name: string; email: string } | null;
          prospect: { id: string; email: string } | null;
        };
      }[];
    };
  };
};

async function main() {
  const blocked = await prisma.qmConversation.findMany({
    where: { forward_attempts: { gt: 0 } },
    select: {
      id: true,
      prospect_email: true,
      inbox_email: true,
      forward_error: true,
    },
  });

  const ids = new Set(blocked.map((b) => b.id));
  console.log(`${blocked.length} thread(s) QuickMail has refused:\n`);
  for (const b of blocked) {
    console.log(`  ${b.prospect_email} via ${b.inbox_email ?? "-"}`);
    console.log(`     ${b.forward_error}`);
  }

  await withSession(async (s) => {
    /**
     * Paged, because `first` is not obeyed — asking for more than 30 returns
     * 30, the same page size their own UI uses.
     */
    /**
     * Look each refused thread up by its prospect address.
     *
     * Paging blind through the list missed them: there are hundreds of
     * conversations and the two that matter can sit anywhere. The `text` field
     * of searchFilter is the same box their UI searches with.
     */
    console.log("\nlooking up each refused thread directly:");
    for (const b of blocked) {
      if (!b.prospect_email) continue;
      const hit = await s.gql<OppsResult>(OPPS, {
        accountId: workspaceId(),
        first: 30,
        skip: 0,
        searchFilter: JSON.stringify({
          state: "all",
          assigned: "all",
          logon_id: "all",
          group_by: "active_desc",
          text: b.prospect_email,
        }),
      });
      const node = (hit.account?.opportunities?.edges ?? [])
        .map((e) => e.node)
        .find((n) => n.id === b.id || n.prospect?.email === b.prospect_email);

      if (!node) {
        console.log(`  ${b.prospect_email}: not found by search`);
        continue;
      }
      const names = (node.logons ?? []).map((l) => `${l.name} (${l.id})`);
      console.log(
        `  ${b.prospect_email}` +
          `\n     inbox    : ${node.inbox?.email ?? "-"}` +
          `\n     state    : ${node.state}` +
          `\n     assigned : ${names.length ? names.join(", ") : "(unassigned)"}`,
      );
    }

    /**
     * Who is in the organisation, and who can administer it.
     *
     * Decides whether a permission change is even possible from this session:
     * a non-admin cannot widen their own access, which would make "grant this
     * login access" something only an org admin can do, in QuickMail itself.
     */
    const ORG = `
      query organizationPermission($orgId: ID!) {
        organization(orgId: $orgId) {
          id
          permissions {
            edges { node { id admin logon { id name email } } }
          }
        }
      }
    `;
    try {
      const org = await s.gql<{
        organization: {
          id: string;
          permissions: {
            edges: {
              node: {
                id: string;
                admin: boolean;
                logon: { id: string; name: string; email: string };
              };
            }[];
          };
        };
      }>(ORG, { orgId: process.env.QUICKMAIL_ORG_ID ?? "56279" });

      console.log("\norganisation members:");
      for (const { node: p } of org.organization.permissions.edges) {
        console.log(
          `  ${p.admin ? "ADMIN" : "     "}  ${p.logon.name} <${p.logon.email}> ` +
            `logon=${p.logon.id} permission=${p.id}`,
        );
      }
    } catch (error) {
      console.log(`\ncould not read organisation permissions: ${(error as Error).message}`);
    }

    console.log("\nassignment of every mirrored thread (sampling for owners):");
    const owners = new Map<string, number>();
    let found = 0;

    for (let skip = 0; skip < 240; skip += 30) {
      /**
       * searchFilter is not optional in practice.
       *
       * Leaving it out makes their endpoint answer 500 with an HTML error page.
       * The shape is the one their own filter chips send, with "all" for both
       * assignment and state so nothing is hidden from the sample.
       */
      const page = await s.gql<OppsResult>(OPPS, {
        accountId: workspaceId(),
        first: 30,
        skip,
        searchFilter: JSON.stringify({
          state: "all",
          assigned: "all",
          logon_id: "all",
          group_by: "active_desc",
          text: "",
        }),
      });
      const edges = page.account?.opportunities?.edges ?? [];
      if (edges.length === 0) break;

      for (const e of edges) {
        const names = (e.node.logons ?? []).map((l) => `${l.name} (${l.id})`);
        const key = names.length ? names.join(", ") : "(unassigned)";
        owners.set(key, (owners.get(key) ?? 0) + 1);

        if (ids.has(e.node.id)) {
          found++;
          console.log(
            `\n  REFUSED THREAD ${e.node.prospect?.email ?? e.node.id}` +
              `\n     inbox    : ${e.node.inbox?.email ?? "-"} (${e.node.inbox?.id ?? "-"})` +
              `\n     assigned : ${key}`,
          );
        }
      }
    }

    console.log(`\n(matched ${found} of ${blocked.length} refused threads in the first 240)`);
    console.log("\nwho threads are assigned to, across that sample:");
    for (const [k, v] of [...owners].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(v).padStart(4)}  ${k}`);
    }
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
