import "dotenv/config";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../src/generated/prisma/client";
import { toQuickMailTags } from "../src/lib/quickmail/merge-tags";

/**
 * Rewrites stored template copy to QuickMail's merge-tag syntax.
 *
 * Templates imported before this used `{{firstName}}`, which QuickMail does not
 * recognise — it sends the literal text to the prospect. Run once:
 *   npx tsx scripts/fix-merge-tags.ts          (report only)
 *   npx tsx scripts/fix-merge-tags.ts --write  (apply)
 */

const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({
    url: process.env.DATABASE_URL ?? "file:./prisma/dev.db",
  }),
});

const WRITE = process.argv.includes("--write");

async function main() {
  const templates = await prisma.template.findMany();
  let changed = 0;
  const unknown = new Set<string>();

  for (const t of templates) {
    const subject = toQuickMailTags(t.subject ?? "");
    const body = toQuickMailTags(t.body ?? "");
    const edits = [...subject.rewritten, ...body.rewritten];
    subject.unknown.concat(body.unknown).forEach((u) => unknown.add(u));

    if (edits.length === 0) continue;
    changed++;
    console.log(`${t.name}\n  ${[...new Set(edits)].join("\n  ")}`);

    if (WRITE) {
      await prisma.template.update({
        where: { id: t.id },
        data: { subject: subject.text, body: body.text },
      });
    }
  }

  console.log(
    `\n${changed}/${templates.length} templates ${WRITE ? "updated" : "would change"}`,
  );
  if (unknown.size > 0) {
    console.log(`unmapped tags needing a human: ${[...unknown].join(", ")}`);
  }
  if (!WRITE && changed > 0) console.log("re-run with --write to apply");

  await prisma.$disconnect();
}

main();
