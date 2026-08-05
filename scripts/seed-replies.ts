/**
 * Seeds a handful of inbound replies so the Replies tab can be driven end to
 * end without waiting on the Zapier webhook (which needs a public tunnel).
 *
 *   npx tsx scripts/seed-replies.ts
 *   npx tsx scripts/seed-replies.ts --clean   # remove what this script added
 *
 * Every row it writes is tagged in `content`, so --clean removes exactly these
 * and nothing a real reply produced.
 */
import { prisma } from "../src/lib/prisma";
import { handleInboundReply } from "../src/lib/reply-pipeline";

const TAG = "[seeded-test-reply]";

const SAMPLES = [
  {
    email: "dhilak.m@sybrantdigital.com",
    text: "This looks interesting. Can we get on a call next week to talk through the lease abstraction side? Tuesday or Wednesday afternoon works for me.",
  },
  {
    email: "reply-test-negative@example.com",
    name: "Priya Raman",
    company: "Northline Realty",
    text: "Thanks but we're not looking at this right now. Not interested.",
  },
  {
    email: "reply-test-unsub@example.com",
    name: "Mark Devlin",
    company: "Devlin Partners",
    text: "Please remove me from your list and do not contact me again.",
  },
];

async function report() {
  const logs = await prisma.emailLog.findMany({
    where: { type: "REPLIED", content: { contains: TAG } },
    include: { lead: { include: { approvals: true } } },
  });
  for (const log of logs) {
    console.log(
      [
        log.lead.email,
        `sentiment=${log.sentiment}`,
        `suppressed=${log.lead.suppressed}`,
        `handled=${log.handled_action ?? "-"}`,
        `approvals=${log.lead.approvals.map((a) => `${a.type}:${a.status}`).join(",") || "-"}`,
      ].join("  "),
    );
  }
  const barred = await prisma.suppression.findMany({
    where: { source: { in: ["reply", "reply-review"] } },
    select: { email: true, reason: true, source: true },
  });
  console.log("suppression list from replies:", barred);
}

async function main() {
  if (process.argv.includes("--report")) return report();

  if (process.argv.includes("--clean")) {
    const emails = SAMPLES.map((s) => s.email);

    const { count: logs } = await prisma.emailLog.deleteMany({
      where: { content: { contains: TAG } },
    });
    // Approvals and suppressions the seeded replies raised.
    const { count: approvals } = await prisma.approval.deleteMany({
      where: { lead: { email: { in: emails } } },
    });
    const { count: barred } = await prisma.suppression.deleteMany({
      where: { email: { in: emails }, source: { in: ["reply", "reply-review"] } },
    });
    // The fake addresses go entirely; a real lead only loses the reply state.
    const { count: leads } = await prisma.lead.deleteMany({
      where: { email: { in: emails.filter((e) => e.endsWith("@example.com")) } },
    });
    await prisma.lead.updateMany({
      where: { email: { in: emails }, status: "REPLIED" },
      data: { status: "EMAILED", suppressed: false, suppressed_reason: null, ai_intent_score: 0 },
    });

    console.log(
      `Removed ${logs} replies, ${approvals} approvals, ${barred} suppressions, ${leads} test leads.`,
    );
    return;
  }

  for (const sample of SAMPLES) {
    const lead = await prisma.lead.upsert({
      where: { email: sample.email },
      update: {},
      create: {
        email: sample.email,
        name: sample.name ?? null,
        company: sample.company ?? null,
        title: "Director of Operations",
        source: "MANUAL",
        status: "EMAILED",
      },
    });

    const result = await handleInboundReply({
      leadId: lead.id,
      replyText: `${sample.text}\n\n${TAG}`,
    });

    console.log(
      `${sample.email} → ${result.verdict.sentiment} (intent ${result.verdict.intent_score}) → ${result.action}`,
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
