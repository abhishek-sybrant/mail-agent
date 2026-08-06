/**
 * Classifies mirrored reply threads that QuickMail left unlabelled.
 *
 *   npm run classify-replies                 # unclassified, non-auto-reply
 *   npm run classify-replies -- --all        # re-do every thread
 *   npm run classify-replies -- --limit=50
 *
 * QuickMail returns reply_type null on almost everything, so without this the
 * queue is a flat list with no sense of which threads matter. Auto-replies are
 * skipped: they are already identified, and spending a model call to be told
 * "out of office" is waste.
 *
 * Local only — nothing is sent and nothing is suppressed. A negative reply
 * still waits for a human in the Replies tab.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { classifyReply } from "../src/lib/ai/classify";
import { replyText } from "../src/lib/quickmail/mail-text";

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const LIMIT = Number(arg("limit", "100"));
const ALL = process.argv.includes("--all");

async function main() {
  const threads = await prisma.qmConversation.findMany({
    where: {
      is_ooo: false,
      ...(ALL ? {} : { reply_type: null }),
    },
    orderBy: { waiting_since: "desc" },
    take: LIMIT,
    include: {
      messages: { where: { direction: "IN" }, orderBy: { sent_at: "desc" }, take: 1 },
    },
  });

  console.log(`${threads.length} threads to classify\n`);
  const tally = new Map<string, number>();

  for (const [i, t] of threads.entries()) {
    const latest = t.messages[0];
    if (!latest) continue;

    const incoming = replyText(latest, 3000);
    if (incoming.length < 5) continue;

    try {
      const verdict = await classifyReply(incoming, {
        name: t.prospect_name,
        company: t.prospect_company,
      });

      await prisma.qmConversation.update({
        where: { id: t.id },
        data: { reply_type: verdict.sentiment },
      });

      // Keep the Lead's score in step so the rest of the app agrees.
      if (t.lead_id) {
        await prisma.lead.update({
          where: { id: t.lead_id },
          data: { ai_intent_score: verdict.intent_score },
        });
      }

      tally.set(verdict.sentiment, (tally.get(verdict.sentiment) ?? 0) + 1);
      console.log(
        `  ${(i + 1).toString().padStart(3)}/${threads.length}  ${verdict.sentiment.padEnd(16)} ${t.prospect_email ?? t.id}`,
      );
    } catch (error) {
      console.log(
        `  ${(i + 1).toString().padStart(3)}/${threads.length}  FAILED           ${t.prospect_email ?? t.id}: ${(error as Error).message}`,
      );
    }
  }

  console.log("\n" + [...tally].map(([k, v]) => `${k}=${v}`).join("  "));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
