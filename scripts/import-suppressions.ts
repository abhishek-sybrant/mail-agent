import "dotenv/config";
import { readFileSync } from "node:fs";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../src/generated/prisma/client";
import { normalise, suppressionSummary } from "../src/lib/suppression";
import type { SuppressionReason } from "../src/lib/suppression";

/**
 * Loads bounced / opted-out addresses into the suppression list.
 *
 * QuickMail's API cannot provide these. Its schema has no lead-level
 * deliverability field, no bounce or event query and no tags — only
 * per-campaign totals — so historical bounces have to come out of the UI as a
 * CSV export and in through here.
 *
 *   npx tsx scripts/import-suppressions.ts bounces.csv
 *   npx tsx scripts/import-suppressions.ts bounces.csv --reason=UNSUBSCRIBE
 *   npx tsx scripts/import-suppressions.ts --from-leads   (local BOUNCED/DNC)
 *   npx tsx scripts/import-suppressions.ts --report
 *
 * Any column called email / address / recipient is used; failing that, the
 * first thing on each line that looks like an address. That tolerance is
 * deliberate — export formats vary and a rejected file means the list does not
 * get populated, which is worse than a slightly fuzzy parse.
 */

const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({
    url: process.env.DATABASE_URL ?? "file:./prisma/dev.db",
  }),
});

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const fromLeads = args.includes("--from-leads");
const reportOnly = args.includes("--report");
const dryRun = args.includes("--dry");
const reason = ((args.find((a) => a.startsWith("--reason="))?.split("=")[1] ??
  "BOUNCE") as SuppressionReason);

const EMAIL_RE = /[^\s,;"'<>]+@[^\s,;"'<>]+\.[^\s,;"'<>]+/;

/** Pull addresses out of a CSV without assuming a fixed shape. */
function addressesFrom(csv: string): string[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];

  const header = lines[0].toLowerCase();
  const cols = header.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ""));
  const idx = cols.findIndex((c) => /^(email|e-mail|address|recipient|to)$/.test(c));

  const body = idx >= 0 || EMAIL_RE.test(header) === false ? lines.slice(1) : lines;
  const out: string[] = [];

  for (const line of body) {
    const cells = line.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ""));
    const candidate = idx >= 0 ? cells[idx] : undefined;
    const found = candidate && EMAIL_RE.test(candidate)
      ? candidate
      : (line.match(EMAIL_RE)?.[0] ?? null);
    if (found) out.push(normalise(found));
  }
  return [...new Set(out)];
}

async function report() {
  const s = await suppressionSummary();
  console.log(`suppressed addresses : ${s.total}`);
  for (const r of s.byReason) console.log(`  ${r.reason.padEnd(15)} ${r.count}`);
  console.log(`repeat offenders     : ${s.repeatOffenders}`);
  if (s.repeatOffenders > 0) {
    console.log(
      "  (an address with more than one hit was re-enrolled after it was already known dead)",
    );
  }

  const leads = await prisma.lead.count();
  const overlap = await prisma.lead.count({ where: { suppressed: true } });
  console.log(`\nleads in database    : ${leads}`);
  console.log(`flagged on the lead  : ${overlap}`);
}

/**
 * Seeds from local evidence: leads already marked BOUNCED or DNC.
 *
 * Small on this database, but it is the only historical source available
 * without an export, and it costs nothing to fold in.
 */
async function fromLocalLeads() {
  const rows = await prisma.lead.findMany({
    where: { OR: [{ status: "BOUNCED" }, { status: "DNC" }, { suppressed: true }] },
    select: { email: true, status: true, suppressed_reason: true },
  });
  console.log(`${rows.length} local lead(s) already marked bounced/DNC/suppressed`);

  let added = 0;
  for (const r of rows) {
    const mapped: SuppressionReason =
      r.status === "BOUNCED" ? "BOUNCE" : r.status === "DNC" ? "UNSUBSCRIBE" : "MANUAL";
    if (dryRun) continue;
    const existing = await prisma.suppression.findUnique({
      where: { email: normalise(r.email) },
    });
    if (!existing) {
      await prisma.suppression.create({
        data: {
          email: normalise(r.email),
          reason: mapped,
          source: "local-leads",
          note: r.suppressed_reason,
        },
      });
      added++;
    }
  }
  console.log(dryRun ? "(dry run — nothing written)" : `added ${added}`);
}

async function fromCsv(path: string) {
  const emails = addressesFrom(readFileSync(path, "utf8"));
  console.log(`${emails.length} unique address(es) in ${path}, reason=${reason}`);
  if (emails.length === 0) {
    console.log("nothing recognised as an email address — check the file");
    return;
  }
  if (dryRun) {
    console.log("sample:", emails.slice(0, 5).join(", "));
    console.log("(dry run — nothing written)");
    return;
  }

  const existing = await prisma.suppression.findMany({
    where: { email: { in: emails } },
    select: { email: true },
  });
  const known = new Set(existing.map((e) => e.email));

  const fresh = emails.filter((e) => !known.has(e));
  // createMany is worth it here: an export can run to tens of thousands.
  if (fresh.length > 0) {
    await prisma.suppression.createMany({
      data: fresh.map((email) => ({ email, reason, source: "import" })),
    });
  }
  // Already-known addresses get a hit, which is the re-enrolment signal.
  if (known.size > 0) {
    await prisma.suppression.updateMany({
      where: { email: { in: [...known] } },
      data: { hits: { increment: 1 } },
    });
  }

  // Keep matching Lead rows consistent so the pickers agree.
  const flagged = await prisma.lead.updateMany({
    where: { email: { in: emails } },
    data: {
      suppressed: true,
      suppressed_reason: `Suppression import (${reason})`,
      ai_intent_score: 0,
    },
  });

  console.log(`added ${fresh.length}, reinforced ${known.size}, leads flagged ${flagged.count}`);
}

async function main() {
  if (reportOnly || (!file && !fromLeads)) {
    await report();
    if (!reportOnly) {
      console.log(
        "\nusage: npx tsx scripts/import-suppressions.ts <file.csv> [--reason=BOUNCE|UNSUBSCRIBE|COMPLAINT] [--dry]",
      );
      console.log("       npx tsx scripts/import-suppressions.ts --from-leads");
    }
    await prisma.$disconnect();
    return;
  }

  if (fromLeads) await fromLocalLeads();
  if (file) await fromCsv(file);

  console.log("");
  await report();
  await prisma.$disconnect();
}

main();
