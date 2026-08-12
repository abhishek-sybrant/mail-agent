import { prisma } from "@/lib/prisma";
import { classifyReply } from "@/lib/ai/classify";
import { replyText } from "@/lib/quickmail/mail-text";

/**
 * Labels mirrored reply threads that QuickMail left unlabelled.
 *
 * QuickMail returns reply_type null on nearly everything, so without this the
 * queue is a flat list with no sense of which threads matter. Shared by
 * `npm run classify-replies` and the automatic sync, so the button and the
 * script cannot drift apart.
 *
 * Auto-replies are skipped — they are already identified, and spending a model
 * call to be told "out of office" is waste.
 *
 * Local only: nothing is sent and nothing is suppressed. A negative reply still
 * waits for a human in the Replies tab.
 */

export type ClassifyResult = {
  considered: number;
  classified: number;
  failed: number;
  tally: Record<string, number>;
};

export async function classifyPending(
  opts: {
    limit?: number;
    all?: boolean;
    onEach?: (done: number, of: number, label: string) => void;
  } = {},
): Promise<ClassifyResult> {
  const limit = opts.limit ?? 100;

  const threads = await prisma.qmConversation.findMany({
    where: { is_ooo: false, ...(opts.all ? {} : { reply_type: null }) },
    orderBy: { waiting_since: "desc" },
    take: limit,
    include: {
      messages: {
        where: { direction: "IN" },
        orderBy: { sent_at: "desc" },
        take: 1,
      },
    },
  });

  const result: ClassifyResult = {
    considered: threads.length,
    classified: 0,
    failed: 0,
    tally: {},
  };

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

      result.classified++;
      result.tally[verdict.sentiment] = (result.tally[verdict.sentiment] ?? 0) + 1;
      opts.onEach?.(i + 1, threads.length, verdict.sentiment);
    } catch {
      /**
       * One thread failing must not end the pass.
       *
       * The usual cause is the AI provider being out of quota, which would
       * otherwise fail on the first thread and leave the rest unlabelled.
       */
      result.failed++;
      opts.onEach?.(i + 1, threads.length, "FAILED");
    }
  }

  return result;
}
