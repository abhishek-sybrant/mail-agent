/**
 * Prints the real replies sitting in QuickMail right now.
 *
 *   npx tsx scripts/show-replies.ts [scope] [limit]
 *   scope: me | others | unassigned | all   (default: all)
 *
 * Read-only. Nothing is written to the database and nothing is sent.
 */
import "dotenv/config";
import {
  getThread,
  listOpportunities,
  withSession,
  type InboxScope,
} from "../src/lib/quickmail/inbox";

const SCOPE = (process.argv[2] as InboxScope) ?? "all";
const LIMIT = Number(process.argv[3] ?? 5);

function strip(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function main() {
  await withSession(async (s) => {
    const { total, items } = await listOpportunities(s, { scope: SCOPE, limit: LIMIT });
    console.log(`${total} opportunities in scope "${SCOPE}" — showing ${items.length}\n`);

    for (const o of items) {
      console.log("=".repeat(78));
      console.log(
        `${o.prospect?.name ?? "(no name)"} <${o.prospect?.email ?? "?"}>` +
          `${o.prospect?.company ? ` · ${o.prospect.company}` : ""}`,
      );
      console.log(
        `  subject:  ${o.subject}\n` +
          `  campaign: ${o.campaign?.name ?? "-"}\n` +
          `  inbox:    ${o.inbox?.email ?? "-"}\n` +
          `  type:     ${o.replyType ?? "-"}${o.isOoo ? " (out of office)" : ""}\n` +
          `  waiting:  ${o.waitingSince ?? "-"}\n` +
          `  ai:       ${o.aiSummary ?? "-"}`,
      );

      const thread = await getThread(s, o.id);
      if (!thread) {
        console.log("  (thread unavailable)");
        continue;
      }
      console.log(
        `  replyable todo: ${thread.replyableTodoId ?? "none"} · ${thread.messages.length} messages`,
      );

      for (const m of thread.messages.slice(0, 3)) {
        console.log(
          `\n  --- ${m.date ?? m.createdAt} · ${m.author ?? m.type} · from ${m.fromName ?? ""} <${m.fromEmail ?? m.from ?? "?"}> to ${m.to ?? "?"}`,
        );
        console.log(`      subject: ${m.subject}`);
        const text = strip(m.content ?? m.body);
        console.log(
          text
            .split("\n")
            .slice(0, 12)
            .map((l) => "      " + l)
            .join("\n"),
        );
      }
      console.log();
    }
  });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
