/**
 * Re-measures how well each merge tag is backed by data.
 *
 *   npm run tag-coverage
 *
 * The percentages quoted in src/lib/merge-tags.ts decide which tags the studio
 * recommends and which the AI is told to avoid, so they need re-checking when
 * the lead data changes materially. A tag with nothing behind it resolves to
 * empty text — "Hi ," — which is worse than not personalising at all.
 *
 * Read-only.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";

function pct(n: number, of: number): string {
  return of === 0 ? "n/a" : `${((n / of) * 100).toFixed(1)}%`;
}

async function main() {
  const leads = await prisma.lead.count();

  const present = async (field: "first_name" | "last_name" | "title" | "phone") =>
    prisma.lead.count({ where: { NOT: { [field]: null }, [field]: { not: "" } } });

  console.log(`Lead fields, across ${leads.toLocaleString()} synced leads:\n`);
  for (const f of ["first_name", "last_name", "title", "phone"] as const) {
    const n = await present(f);
    const tag = `{{lead.${f}}}`;
    console.log(`  ${tag.padEnd(24)} ${String(n).padStart(6)}  ${pct(n, leads)}`);
  }

  /**
   * Company comes from the reply mirror, not the lead table.
   *
   * QuickMail's v2 Lead type has no company field at all — it was probed — so
   * the only place we ever see one is the prospect record attached to a
   * conversation. That is a biased sample (people who replied), and it is
   * stated as such rather than presented as workspace-wide.
   */
  const convos = await prisma.qmConversation.count();
  const withCompany = await prisma.qmConversation.count({
    where: { NOT: { prospect_company: null }, prospect_company: { not: "" } },
  });
  const withTitle = await prisma.qmConversation.count({
    where: { NOT: { prospect_title: null }, prospect_title: { not: "" } },
  });

  console.log(
    `\nCompany and title, across ${convos} prospects QuickMail returned in full`,
  );
  console.log("(the reply mirror — people who replied, so not representative):\n");
  console.log(`  ${"{{company.name}}".padEnd(24)} ${String(withCompany).padStart(6)}  ${pct(withCompany, convos)}`);
  console.log(`  ${"prospect title".padEnd(24)} ${String(withTitle).padStart(6)}  ${pct(withTitle, convos)}`);

  console.log("\nA sample of what is actually stored as the company:");
  const sample = await prisma.qmConversation.findMany({
    where: { NOT: { prospect_company: null }, prospect_company: { not: "" } },
    select: { prospect_company: true },
    take: 8,
    orderBy: { synced_at: "desc" },
  });
  for (const s of sample) console.log(`  ${s.prospect_company}`);
  console.log(
    "\nCheck that list: some records hold a job title here instead of a company.",
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
