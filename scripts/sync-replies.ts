/**
 * Mirrors QuickMail's reply inbox into the local database.
 *
 *   npm run sync-replies                 # active + pending, all assignees
 *   npm run sync-replies -- --scope=me   # only what's assigned to you
 *   npm run sync-replies -- --limit=200
 *   npm run sync-replies -- --no-threads # list only, skip message bodies
 *
 * Requires Edge running with --remote-debugging-port and signed in to
 * QuickMail; see src/lib/quickmail/inbox.ts for why a browser session is the
 * only route to reply content.
 *
 * The work itself lives in src/lib/quickmail/inbox-pull.ts, shared with the
 * Sync button in the UI — two implementations would eventually disagree about
 * what "synced" means.
 *
 * Read-only against QuickMail. Writes locally.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { withSession, type InboxScope } from "../src/lib/quickmail/inbox";
import { pullReplies } from "../src/lib/quickmail/inbox-pull";

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const SCOPE = arg("scope", "all") as InboxScope;
const LIMIT = Number(arg("limit", "100"));
const WITH_THREADS = !process.argv.includes("--no-threads");

async function main() {
  const result = await withSession((s) =>
    pullReplies(s, {
      scope: SCOPE,
      limit: LIMIT,
      withThreads: WITH_THREADS,
      onProgress: (done, of) => {
        if (done % 10 === 0 || done === of) console.log(`  ${done}/${of} …`);
      },
    }),
  );

  console.log(
    `\nQuickMail has ${result.total} conversations in scope "${SCOPE}".\n` +
      `${result.conversations} stored, ${result.threads} threads, ` +
      `${result.messages} messages, ${result.refreshed} answered threads refreshed.`,
  );
  if (result.conversations < result.total) {
    console.log(
      `Only ${result.conversations} of ${result.total} were pulled — raise --limit for the rest.`,
    );
  }

  const inbound = await prisma.qmMessage.count({ where: { direction: "IN" } });
  const open = await prisma.qmConversation.count({ where: { handled_at: null } });
  console.log(`Local totals: ${inbound} inbound messages, ${open} unhandled threads.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
