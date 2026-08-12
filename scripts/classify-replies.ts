/**
 * Classifies mirrored reply threads that QuickMail left unlabelled.
 *
 *   npm run classify-replies                 # unclassified, non-auto-reply
 *   npm run classify-replies -- --all        # re-do every thread
 *   npm run classify-replies -- --limit=50
 *
 * The work itself lives in src/lib/sync/classify-pending.ts, shared with the
 * automatic sync so the two cannot drift apart.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { classifyPending } from "../src/lib/sync/classify-pending";

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main() {
  const result = await classifyPending({
    limit: Number(arg("limit", "100")),
    all: process.argv.includes("--all"),
    onEach: (done, of, label) =>
      console.log(`  ${done.toString().padStart(3)}/${of}  ${label}`),
  });

  console.log(
    `\n${result.classified} labelled, ${result.failed} failed, ` +
      `${result.considered} considered`,
  );
  console.log(
    Object.entries(result.tally)
      .map(([k, v]) => `${k}=${v}`)
      .join("  "),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
