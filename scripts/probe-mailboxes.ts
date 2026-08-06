/** Which mailboxes are actually sending, and what provider hosts them. */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";

async function main() {
  const boxes = await prisma.qmMailbox.findMany({ orderBy: { email: "asc" } });
  console.log(`${boxes.length} mailboxes\n`);
  for (const b of boxes) {
    console.log(
      `  ${b.email.padEnd(38)} auth=${String(b.authorized).padEnd(5)} paused=${String(b.qm_paused).padEnd(5)} assignable=${b.assignable}`,
    );
  }

  const domains = new Map<string, number>();
  for (const b of boxes) {
    const d = b.email.split("@")[1] ?? "?";
    domains.set(d, (domains.get(d) ?? 0) + 1);
  }
  console.log("\ndomains:", Object.fromEntries(domains));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
