/**
 * Removes the fabricated demo data seeded before the QuickMail sync existed.
 *
 *   npm run remove-demo -- --dry     # show what would go
 *   npm run remove-demo              # do it
 *
 * Identification is by provenance, not by how the address looks. A lead counts
 * as fabricated only if it has NO QuickMail id and NO mirrored conversation —
 * the account contains real prospects at testset.com, bridgepointconsulting.com
 * and northwind-group.com that a name-based filter would have deleted.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";

const DRY = process.argv.includes("--dry");

/** Test addresses added to the block list by seeding, not by a real bounce. */
const SEEDED_BLOCKS = [
  "bounced.one@example.com",
  "bounced.two@example.com",
  "bounced.three@example.com",
  "bounced.four@example.com",
];

async function main() {
  // 1. Fabricated leads: never came from QuickMail, never appeared in a thread.
  const candidates = await prisma.lead.findMany({
    where: { source: { not: "QUICKMAIL" }, quickmail_lead_id: null },
    select: { id: true, email: true, company: true, source: true },
  });

  const mirrored = new Set(
    (
      await prisma.qmConversation.findMany({
        where: { prospect_email: { in: candidates.map((c) => c.email) } },
        select: { prospect_email: true },
      })
    ).map((c) => c.prospect_email),
  );

  const fake = candidates.filter((c) => !mirrored.has(c.email));
  const keptBack = candidates.filter((c) => mirrored.has(c.email));

  console.log(`fabricated leads to remove: ${fake.length}`);
  for (const f of fake) console.log(`  ${f.email.padEnd(38)} ${f.source.padEnd(8)} ${f.company ?? ""}`);
  if (keptBack.length) {
    console.log(`\nkept — they appear in real QuickMail threads: ${keptBack.length}`);
    for (const k of keptBack) console.log(`  ${k.email}`);
  }

  const emails = fake.map((f) => f.email);

  // 2. What hangs off them.
  const logs = await prisma.emailLog.count({ where: { lead: { email: { in: emails } } } });
  const appr = await prisma.approval.count({ where: { lead: { email: { in: emails } } } });
  console.log(`\nfabricated activity: ${logs} email log rows, ${appr} approvals`);

  // 3. Block-list rows that were seeded rather than earned.
  const blocks = await prisma.suppression.findMany({
    where: { OR: [{ email: { in: [...emails, ...SEEDED_BLOCKS] } }, { source: "local-leads" }] },
    select: { email: true, reason: true, source: true },
  });
  console.log(`\nseeded block-list entries: ${blocks.length}`);
  for (const b of blocks) console.log(`  ${b.email.padEnd(38)} ${b.reason} via ${b.source}`);

  /**
   * The manager's own address is on the block list, added by hand during
   * testing. Forwarding does not consult the list for its recipient so nothing
   * broke, but leaving it there means a campaign could never reach him.
   */
  const manager = process.env.MANAGER_EMAIL?.trim().toLowerCase();
  const managerBlocked = manager
    ? await prisma.suppression.findUnique({ where: { email: manager } })
    : null;
  if (managerBlocked) {
    console.log(`\nalso removing: ${manager} — the manager address, blocked in error`);
  }

  if (DRY) {
    console.log("\n--dry: nothing was changed.");
    return;
  }

  // Order matters: children before parents, though the schema cascades leads.
  const delLogs = await prisma.emailLog.deleteMany({ where: { lead: { email: { in: emails } } } });
  const delAppr = await prisma.approval.deleteMany({ where: { lead: { email: { in: emails } } } });
  const delBlocks = await prisma.suppression.deleteMany({
    where: {
      OR: [
        { email: { in: [...emails, ...SEEDED_BLOCKS] } },
        { source: "local-leads" },
        ...(managerBlocked ? [{ email: manager! }] : []),
      ],
    },
  });
  const delLeads = await prisma.lead.deleteMany({ where: { email: { in: emails } } });

  // Import batches left with nothing in them.
  const empty = await prisma.importBatch.findMany({
    where: { leads: { none: {} } },
    select: { id: true, filename: true },
  });
  const delBatches = await prisma.importBatch.deleteMany({
    where: { id: { in: empty.map((e) => e.id) } },
  });

  console.log(
    `\nremoved: ${delLeads.count} leads, ${delLogs.count} email logs, ` +
      `${delAppr.count} approvals, ${delBlocks.count} block entries, ` +
      `${delBatches.count} empty import batches`,
  );

  console.log("\nwhat remains:");
  console.log("  leads              :", await prisma.lead.count());
  console.log("  reply threads      :", await prisma.qmConversation.count());
  console.log("  email logs         :", await prisma.emailLog.count());
  console.log("  approvals pending  :", await prisma.approval.count({ where: { status: "PENDING" } }));
  console.log("  block list         :", await prisma.suppression.count());
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
