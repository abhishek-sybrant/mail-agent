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
 * Read-only against QuickMail. Writes locally.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { decodeEntities, htmlToText } from "../src/lib/quickmail/mail-text";
import {
  getThread,
  listOpportunities,
  withSession,
  type InboxScope,
  type OpportunitySummary,
} from "../src/lib/quickmail/inbox";

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const SCOPE = (arg("scope", "all") as InboxScope) ?? "all";
const LIMIT = Number(arg("limit", "100"));
const WITH_THREADS = !process.argv.includes("--no-threads");

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Ties a QuickMail prospect to a local Lead so suppression, approvals and the
 * stop decision all keep working off one identity.
 *
 * Never suppresses anything by itself. QuickMail's own do-not-contact flag is
 * mirrored onto the conversation and blocks the Send button, but flipping the
 * local suppression flag is a decision a person makes in the Replies tab — a
 * sync silently barring addresses is exactly what this app must not do.
 */
async function linkLead(o: OpportunitySummary): Promise<string | null> {
  const email = o.prospect?.email?.trim().toLowerCase();
  if (!email) return null;

  const existing = await prisma.lead.findUnique({ where: { email } });
  if (existing) return existing.id;

  const created = await prisma.lead.create({
    data: {
      email,
      name: decodeEntities(o.prospect?.name),
      title: decodeEntities(o.prospect?.title),
      company: decodeEntities(o.prospect?.company),
      phone: o.prospect?.phone ?? null,
      source: "QUICKMAIL",
      status: "REPLIED",
    },
  });
  return created.id;
}

async function main() {
  let conversations = 0;
  let messages = 0;
  let threadsFetched = 0;

  await withSession(async (s) => {
    /**
     * Paged, because `first` is not obeyed: asking for 40 returns 30, the same
     * page size their own UI uses. Without this, "--limit=200" would silently
     * mean 30 — the kind of quiet truncation that makes a sync look complete
     * when it isn't.
     */
    const items: OpportunitySummary[] = [];
    let total = 0;
    for (let skip = 0; items.length < LIMIT; ) {
      const page = await listOpportunities(s, { scope: SCOPE, limit: 30, skip });
      total = page.total;
      if (page.items.length === 0) break;
      items.push(...page.items);
      skip += page.items.length;
      if (skip >= total) break;
    }
    items.length = Math.min(items.length, LIMIT);

    console.log(
      `QuickMail has ${total} conversations in scope "${SCOPE}"; pulling ${items.length}.`,
    );

    for (const [i, o] of items.entries()) {
      const leadId = await linkLead(o);

      const data = {
        subject: decodeEntities(o.subject),
        state: o.state,
        ai_summary: o.aiSummary,
        reply_type: o.replyType,
        is_ooo: o.isOoo,
        waiting_since: toDate(o.waitingSince),
        inbox_id: o.inbox?.id ?? null,
        inbox_email: o.inbox?.email ?? null,
        inbox_name: decodeEntities(o.inbox?.name),
        qm_campaign_id: o.campaign?.id ?? null,
        campaign_name: o.campaign?.name ?? null,
        prospect_email: o.prospect?.email ?? null,
        prospect_name: decodeEntities(o.prospect?.name),
        prospect_title: decodeEntities(o.prospect?.title),
        prospect_company: decodeEntities(o.prospect?.company),
        do_not_contact: o.prospect?.doNotContact ?? false,
        synced_at: new Date(),
      };

      // The lead goes in as a nested connect, not a scalar FK: Prisma rejects
      // `lead_id` on create for a model that declares the relation.
      const link = leadId ? { lead: { connect: { id: leadId } } } : {};

      await prisma.qmConversation.upsert({
        where: { id: o.id },
        // handled_at is intentionally never overwritten: a re-sync must not
        // resurrect a thread someone has already dealt with.
        update: { ...data, ...link },
        create: { id: o.id, ...data, ...link },
      });
      conversations++;

      if (!WITH_THREADS) continue;

      const thread = await getThread(s, o.id);
      threadsFetched++;
      if (!thread) continue;

      await prisma.qmConversation.update({
        where: { id: o.id },
        data: {
          status: thread.status,
          replyable_todo_id: thread.replyableTodoId,
          ai_summary: thread.aiSummary ?? data.ai_summary,
        },
      });

      for (const m of thread.messages) {
        const row = {
          // QuickMail labels its own sends "sent"; anything else came inbound.
          direction: m.author === "sent" || m.type === "sent" ? "OUT" : "IN",
          subject: decodeEntities(m.subject),
          body_html: m.body,
          body_text: htmlToText(m.content || m.body),
          from_name: decodeEntities(m.fromName),
          from_email: m.fromEmail ?? m.from,
          to_email: m.to,
          cc: m.cc,
          sent_at: toDate(m.date ?? m.createdAt),
        };
        await prisma.qmMessage.upsert({
          where: { id: m.todoId },
          update: row,
          create: {
            id: m.todoId,
            ...row,
            conversation: { connect: { id: o.id } },
          },
        });
        messages++;
      }

      if ((i + 1) % 10 === 0) {
        console.log(`  ${i + 1}/${items.length} …`);
      }
    }
  });

  console.log(
    `\n${conversations} conversations, ${threadsFetched} threads, ${messages} messages stored.`,
  );

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
