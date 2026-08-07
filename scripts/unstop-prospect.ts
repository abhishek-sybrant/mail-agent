/**
 * Reverses a stop: unbars an address here and clears do-not-contact in QuickMail.
 *
 *   npm run unstop -- someone@example.com
 *   npm run unstop -- someone@example.com --dry
 *
 * Stopping is deliberately hard to undo from the UI — barring an address is
 * meant to feel final. It still needs an escape hatch, because the classifier
 * misreads hedged replies and a misclick should not cost a live prospect
 * permanently.
 *
 * Note it cannot un-cancel a sequence. QuickMail has no such mutation: a
 * cancelled journey is gone, and the prospect has to be added to a campaign
 * again. This clears the flags that block that.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { withSession, workspaceId } from "../src/lib/quickmail/inbox";

const EMAIL = process.argv[2]?.trim().toLowerCase();
const DRY = process.argv.includes("--dry");

const UNDO_DNC = `
  mutation setProspectsAsDoNotContact($input: SetProspectsAsDoNotContactInput!) {
    setProspectsAsDoNotContact(input: $input) { error }
  }
`;

async function main() {
  if (!EMAIL || !EMAIL.includes("@")) {
    console.error("Usage: npm run unstop -- someone@example.com [--dry]");
    process.exitCode = 1;
    return;
  }

  const suppression = await prisma.suppression.findUnique({ where: { email: EMAIL } });
  const lead = await prisma.lead.findUnique({ where: { email: EMAIL } });
  const convo = await prisma.qmConversation.findFirst({
    where: { prospect_email: EMAIL, NOT: { qm_prospect_id: null } },
    select: { id: true, qm_prospect_id: true },
  });

  console.log(
    `suppression: ${suppression ? `${suppression.reason} via ${suppression.source}` : "none"}\n` +
      `lead:        ${lead ? `${lead.status} suppressed=${lead.suppressed}` : "none"}\n` +
      `quickmail:   ${convo?.qm_prospect_id ?? "no mirrored thread"}`,
  );

  if (DRY) {
    console.log("\n--dry: nothing changed.");
    return;
  }

  /**
   * QuickMail first, local second — the reverse of stopping.
   *
   * Order matters because the two directions have opposite safe failures. When
   * stopping, barring locally first means a QuickMail outage still leaves the
   * address blocked. Un-stopping is the other way round: clearing locally first
   * and then failing to reach QuickMail leaves the address unbarred here while
   * QuickMail still refuses it, which reads as "undone" when it isn't. So
   * nothing local changes until QuickMail has agreed.
   */
  if (convo?.qm_prospect_id) {
    if (process.env.QUICKMAIL_DRY_RUN !== "false") {
      console.log("\nQUICKMAIL_DRY_RUN is on — nothing was changed anywhere.");
      return;
    }

    const error = await withSession(async (s) => {
      const data = await s.gql<{
        setProspectsAsDoNotContact: { error: string | null };
      }>(UNDO_DNC, {
        input: { prospectIds: [convo.qm_prospect_id], doNotContact: false },
      });
      return data.setProspectsAsDoNotContact?.error ?? null;
    });

    if (error) {
      console.error(`\nQuickMail refused: ${error}. Nothing was changed locally.`);
      process.exitCode = 1;
      return;
    }

    console.log(
      `\nQuickMail do-not-contact cleared for prospect ${convo.qm_prospect_id}.`,
    );
    await prisma.qmConversation.updateMany({
      where: { prospect_email: EMAIL },
      data: { do_not_contact: false, handled_at: null, handled_action: null },
    });
  }

  if (suppression) await prisma.suppression.delete({ where: { email: EMAIL } });
  if (lead) {
    await prisma.lead.update({
      where: { email: EMAIL },
      data: { suppressed: false, suppressed_reason: null, status: "REPLIED" },
    });
  }

  console.log(
    `\n${EMAIL} can be emailed again. Any cancelled sequence stays cancelled — ` +
      `re-add them to a campaign in QuickMail (workspace ${workspaceId()}) if you want one running.`,
  );
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
