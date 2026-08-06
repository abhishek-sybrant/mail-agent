/** Quick shape check on the mirrored QuickMail conversations. */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";

async function main() {
  const byType = await prisma.qmConversation.groupBy({
    by: ["reply_type"],
    _count: { _all: true },
  });
  console.log("reply_type:", byType.map((r) => `${r.reply_type ?? "null"}=${r._count._all}`).join("  "));

  const byState = await prisma.qmConversation.groupBy({
    by: ["state"],
    _count: { _all: true },
  });
  console.log("state:     ", byState.map((r) => `${r.state ?? "null"}=${r._count._all}`).join("  "));

  console.log("ooo:       ", await prisma.qmConversation.count({ where: { is_ooo: true } }));
  console.log("dnc:       ", await prisma.qmConversation.count({ where: { do_not_contact: true } }));
  console.log(
    "replyable: ",
    await prisma.qmConversation.count({ where: { NOT: { replyable_todo_id: null } } }),
  );
  console.log("with lead: ", await prisma.qmConversation.count({ where: { NOT: { lead_id: null } } }));

  const sample = await prisma.qmConversation.findFirst({
    where: { is_ooo: false, NOT: { replyable_todo_id: null } },
    include: { messages: { orderBy: { sent_at: "desc" } } },
  });
  if (sample) {
    console.log(
      `\nsample ${sample.id}: ${sample.prospect_name} <${sample.prospect_email}> via ${sample.inbox_email}`,
    );
    console.log(`  subject: ${sample.subject}`);
    console.log(`  campaign: ${sample.campaign_name}  replyableTodo: ${sample.replyable_todo_id}`);
    for (const m of sample.messages.slice(0, 3)) {
      console.log(`  [${m.direction}] ${m.sent_at?.toISOString()} ${m.from_email} → ${m.to_email}`);
      console.log("    " + (m.body_text ?? "").split("\n").slice(0, 5).join("\n    "));
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
