import "dotenv/config";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../src/generated/prisma/client";
import {
  syncCampaigns,
  syncLeads,
  syncMailboxes,
} from "../src/lib/quickmail/sync";

/**
 * Full pull of everything QuickMail exposes.
 *
 * Paced by the shared limiter in the client (QuickMail's documented 10
 * requests per 10 seconds), so this no longer thrashes against throttling.
 * Leads come 10 to a page, so the walk is inherently long — progress is
 * printed each batch and the cursor is resumable if it dies.
 */

const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({
    url: process.env.DATABASE_URL ?? "file:./prisma/dev.db",
  }),
});

const started = Date.now();
const mins = () => ((Date.now() - started) / 60000).toFixed(1);

async function main() {
  const boxes = await syncMailboxes();
  console.log(`mailboxes : ${boxes.total} cached`);

  const camps = await syncCampaigns();
  console.log(
    `campaigns : ${camps.total} total (${camps.imported} new, ${camps.updated} updated)`,
  );

  const before = await prisma.lead.count();
  console.log(`leads     : ${before.toLocaleString()} in the database before we start\n`);

  let cursor: string | null = null;
  let processed = 0;
  let imported = 0;
  let linked = 0;
  let total = 0;

  for (;;) {
    const r = await syncLeads({ cursor, maxPages: 100 });
    cursor = r.cursor;
    processed += r.processed;
    imported += r.imported;
    linked += r.updated;
    total = r.totalCount;

    const pct = total > 0 ? ((processed / total) * 100).toFixed(1) : "0.0";
    const rate = processed / Math.max(1, (Date.now() - started) / 60000);
    const eta = rate > 0 ? Math.round((total - processed) / rate) : 0;

    console.log(
      `${processed.toLocaleString()}/${total.toLocaleString()} (${pct}%) · ` +
        `${imported} new · ${linked} linked · ${Math.round(rate)}/min · ` +
        `${mins()}m elapsed · ~${eta}m left`,
    );

    if (!r.hasNext) break;
  }

  const after = await prisma.lead.count();
  console.log(
    `\nDONE in ${mins()}m — ${after.toLocaleString()} leads ` +
      `(${(after - before).toLocaleString()} added this run)`,
  );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(`FAILED after ${mins()}m:`, e.message);
  await prisma.$disconnect();
  process.exit(1);
});
