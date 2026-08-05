import "dotenv/config";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../src/generated/prisma/client";

/**
 * Links existing campaigns to the agent chat that created them.
 *
 * The link column was added after these campaigns were built, so it is null on
 * all of them. Each saved conversation stores its resolved spec, and that spec
 * contains the campaign name — which is enough to match retrospectively.
 *
 *   npx tsx scripts/link-agent-campaigns.ts        (report)
 *   npx tsx scripts/link-agent-campaigns.ts --write
 *
 * Matching is exact on a trimmed name. A fuzzy match here would attach the
 * wrong conversation to a campaign, and a wrong provenance record is worse than
 * a missing one.
 */

const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({
    url: process.env.DATABASE_URL ?? "file:./prisma/dev.db",
  }),
});

const WRITE = process.argv.includes("--write");

async function main() {
  const convos = await prisma.agentConversation.findMany({
    orderBy: { updated_at: "desc" },
  });

  // name -> conversation. Newest wins if two chats named a campaign the same.
  const byName = new Map<string, { id: string; title: string }>();
  for (const c of convos) {
    let name: string | undefined;
    try {
      name = (JSON.parse(c.spec) as { name?: string }).name?.trim();
    } catch {
      name = undefined;
    }
    if (name && !byName.has(name)) byName.set(name, { id: c.id, title: c.title });
  }
  console.log(`${convos.length} conversation(s), ${byName.size} naming a campaign`);

  const unlinked = await prisma.campaign.findMany({
    where: { agent_conversation_id: null },
    select: { id: true, name: true },
  });

  let matched = 0;
  for (const c of unlinked) {
    const hit = byName.get(c.name.trim());
    if (!hit) continue;
    matched++;
    console.log(`  ${c.name}  ->  "${hit.title.slice(0, 60)}"`);
    if (WRITE) {
      await prisma.campaign.update({
        where: { id: c.id },
        data: { agent_conversation_id: hit.id },
      });
    }
  }

  console.log(
    `\n${matched} of ${unlinked.length} unlinked campaign(s) ${WRITE ? "linked" : "would link"}`,
  );
  if (!WRITE && matched > 0) console.log("re-run with --write to apply");

  const linked = await prisma.campaign.count({
    where: { agent_conversation_id: { not: null } },
  });
  console.log(`total linked now: ${linked}`);
  await prisma.$disconnect();
}

main();
