import { prisma } from "@/lib/prisma";
import { isConfigured } from "@/lib/quickmail/client";
import { syncCampaigns, syncLeads, syncMailboxes } from "@/lib/quickmail/sync";
import { withSession } from "@/lib/quickmail/inbox";
import { pullReplies } from "@/lib/quickmail/inbox-pull";
import { applyDueSchedules } from "@/lib/quickmail/schedule";
import { forwardPending, forwardingConfigured } from "@/lib/forward-reply";
import { classifyPending } from "./classify-pending";

/**
 * One pass over every part of the sync.
 *
 * The parts fail independently and that is the normal case, not an edge case:
 * campaigns and leads go over the plain API and keep working unattended, while
 * the reply pull drives a signed-in browser session and stops the moment Edge
 * is closed. So each part is wrapped, its outcome recorded, and the pass
 * carries on — a failed reply pull must not cost us the lead walk that would
 * have run after it.
 *
 * Order is deliberate: the cheap time-sensitive work first, the hour-long lead
 * walk last, so an overrun delays nothing that matters.
 */

export const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS) || 3_600_000;

/** Newest reply threads to pull per pass. Each one is its own round trip. */
const REPLY_LIMIT = Number(process.env.SYNC_REPLY_LIMIT) || 60;

/**
 * Lead pages per pass, at 10 leads a page.
 *
 * QuickMail's rate limit is 10 requests per 10 seconds, so this is roughly one
 * request a second: 900 pages is about 15 minutes of the hour and 9,000 leads.
 * A full pass over the workspace takes about six hours and then starts again.
 * Asking for all 4,800 pages in one slot would simply overrun the hour.
 */
const LEAD_PAGES = Number(process.env.SYNC_LEAD_PAGES) || 900;

export type PartResult = {
  part: string;
  ok: boolean;
  detail: string;
  ms: number;
  error?: string;
  skipped?: boolean;
};

export type SyncTrigger = "timer" | "manual" | "cron";

/** Called as each part finishes, so a long pass isn't silent while it runs. */
export type OnPart = (result: PartResult) => void;

export type SyncRunSummary = {
  id: string;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  ok: boolean;
  parts: PartResult[];
  lead_done: number;
  lead_total: number;
  lead_cursor: string | null;
};

/**
 * Guard against overlapping passes.
 *
 * A lead walk runs for a quarter of an hour; two at once share the rate limit,
 * both crawl, and they overwrite each other's cursor.
 *
 * The in-flight promise alone is not enough. The timer lives in the
 * instrumentation hook and the button calls a route handler, and Next.js gives
 * those separate instances of this module — so each had its own idea of
 * whether a pass was running, and a manual click landed straight on top of the
 * timer's pass. The open row in the database is the one fact both instances
 * share, so that is what decides.
 */
let running: Promise<SyncRunSummary> | null = null;

/** An open run older than this was abandoned; it must not block forever. */
const STALE_AFTER_MS = SYNC_INTERVAL_MS * 2;

async function openRun() {
  const row = await prisma.syncRun.findFirst({
    where: { finished_at: null, interrupted: false },
    orderBy: { started_at: "desc" },
  });
  if (!row) return null;
  if (Date.now() - row.started_at.getTime() > STALE_AFTER_MS) return null;
  return row;
}

export async function isSyncRunning(): Promise<boolean> {
  if (running) return true;
  return (await openRun()) !== null;
}

async function part(
  name: string,
  fn: () => Promise<string>,
): Promise<PartResult> {
  const at = Date.now();
  try {
    return { part: name, ok: true, detail: await fn(), ms: Date.now() - at };
  } catch (error) {
    return {
      part: name,
      ok: false,
      detail: "failed",
      ms: Date.now() - at,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function skip(name: string, why: string): PartResult {
  return { part: name, ok: true, detail: why, ms: 0, skipped: true };
}

type SyncRunRow = Awaited<ReturnType<typeof prisma.syncRun.findFirst>>;

function toSummary(row: NonNullable<SyncRunRow>): SyncRunSummary {
  return {
    id: row.id,
    trigger: row.trigger,
    started_at: row.started_at.toISOString(),
    finished_at: row.finished_at?.toISOString() ?? null,
    ok: row.ok,
    parts: JSON.parse(row.parts) as PartResult[],
    lead_done: row.lead_done,
    lead_total: row.lead_total,
    lead_cursor: row.lead_cursor,
  };
}

/** The most recent pass, finished or still going. */
export async function lastSyncRun(): Promise<SyncRunSummary | null> {
  const row = await prisma.syncRun.findFirst({ orderBy: { started_at: "desc" } });
  return row ? toSummary(row) : null;
}

/**
 * Whether a pass is due, i.e. the last one to *finish* started more than an
 * interval ago.
 *
 * Finished and not interrupted: a pass the server was killed in the middle of
 * did not happen, and counting it would block the next one for a full hour
 * over work that was never done. A pass that ran everything and had a part
 * fail is a different thing — that one counts. Overlap is prevented by
 * `isSyncRunning()` instead, which is accurate because a pass only ever exists
 * inside one process.
 */
export async function syncIsDue(): Promise<boolean> {
  const due = await nextSyncDueAt();
  return due === null || new Date(due).getTime() <= Date.now();
}

/**
 * When the next pass is due, or null if one is due now.
 *
 * The countdown on the Sync page reads this rather than working it out from
 * the newest row, so the clock the user watches is the same one the timer
 * obeys — including the part where an interrupted pass doesn't count.
 */
export async function nextSyncDueAt(): Promise<string | null> {
  const last = await prisma.syncRun.findFirst({
    where: { NOT: { finished_at: null }, interrupted: false },
    orderBy: { started_at: "desc" },
    select: { started_at: true },
  });
  if (!last) return null;
  return new Date(last.started_at.getTime() + SYNC_INTERVAL_MS).toISOString();
}

/**
 * Closes out passes that a restart interrupted.
 *
 * Called once as the timer arms. Nothing survives the process, so any run
 * still open at that moment is abandoned by definition — left alone it would
 * show in the panel as forever running. The lead cursor is deliberately kept:
 * the walk got as far as it got, and the next pass should carry on from there.
 */
export async function reclaimAbandonedRuns(): Promise<number> {
  const orphans = await prisma.syncRun.findMany({
    where: { finished_at: null },
    select: { id: true, parts: true },
  });

  for (const o of orphans) {
    const parts = [
      ...(JSON.parse(o.parts) as PartResult[]),
      {
        part: "Interrupted",
        ok: false,
        detail: "the server stopped before this pass finished",
        ms: 0,
      },
    ];
    await prisma.syncRun.update({
      where: { id: o.id },
      data: {
        finished_at: new Date(),
        ok: false,
        interrupted: true,
        parts: JSON.stringify(parts),
      },
    });
  }

  return orphans.length;
}

export async function runFullSync(
  trigger: SyncTrigger = "manual",
  onPart?: OnPart,
): Promise<SyncRunSummary> {
  // Join the pass already in flight rather than starting a competing one.
  if (running) return running;

  /**
   * A pass started by the other module instance shows up only as an open row.
   * Report it rather than starting a second one — there is no promise here to
   * await, so the caller gets what that pass has recorded so far.
   */
  const open = await openRun();
  if (open) return toSummary(open);

  running = execute(trigger, onPart).finally(() => {
    running = null;
  });
  return running;
}

async function execute(
  trigger: SyncTrigger,
  onPart?: OnPart,
): Promise<SyncRunSummary> {
  // Resume the lead walk where the previous pass stopped.
  const previous = await prisma.syncRun.findFirst({
    orderBy: { started_at: "desc" },
    select: { lead_cursor: true, lead_done: true },
  });

  const run = await prisma.syncRun.create({
    data: {
      trigger,
      lead_cursor: previous?.lead_cursor ?? null,
      lead_done: previous?.lead_done ?? 0,
    },
  });

  const parts: PartResult[] = [];

  /**
   * Records a part and writes it through immediately.
   *
   * Saving only at the end would mean a pass interrupted during the lead walk
   * lost every part that had already succeeded, and the panel would show
   * nothing while the longest part of the hour was running.
   */
  const add = async (r: PartResult) => {
    parts.push(r);
    onPart?.(r);
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { parts: JSON.stringify(parts) },
    });
    return r;
  };

  // 1. Campaign windows. Cheap, and the most time-sensitive thing here — a
  //    campaign due to start should not wait on a lead walk.
  await add(
    await part("Campaign schedules", async () => {
      const r = await applyDueSchedules();
      const bits = [
        r.started.length ? `${r.started.length} started` : null,
        r.ended.length ? `${r.ended.length} ended` : null,
      ].filter(Boolean);
      return bits.length ? bits.join(", ") : "nothing due";
    }),
  );

  if (!isConfigured()) {
    await add(skip("Campaigns", "QUICKMAIL_API_KEY is not set"));
    await add(skip("Mailboxes", "QUICKMAIL_API_KEY is not set"));
  } else {
    // 2. Campaign stats — one request.
    await add(
      await part("Campaigns", async () => {
        const r = await syncCampaigns();
        return `${r.total} mirrored — ${r.imported} new, ${r.updated} updated`;
      }),
    );

    // 3. Sending mailboxes, so the composer never sees a stale sender list.
    await add(
      await part("Mailboxes", async () => {
        const r = await syncMailboxes();
        return `${r.total} mailboxes`;
      }),
    );
  }

  // 4. Replies: pull, label, forward. Needs the signed-in browser session.
  const pull = await add(
    await part("Replies", async () => {
      const r = await withSession((s) => pullReplies(s, { limit: REPLY_LIMIT }));
      return (
        `${r.conversations} of ${r.total} threads, ${r.messages} messages` +
        (r.refreshed ? `, ${r.refreshed} refreshed` : "")
      );
    }),
  );

  /**
   * Only label and forward when the pull worked.
   *
   * Running them anyway would produce two more failures describing the same
   * closed browser, which buries the one line that says what to actually fix.
   */
  if (pull.ok) {
    await add(
      await part("Classify replies", async () => {
        const r = await classifyPending({ limit: 100 });
        if (r.considered === 0) return "nothing unlabelled";
        const tally = Object.entries(r.tally)
          .map(([k, v]) => `${k.toLowerCase()}=${v}`)
          .join(" ");
        return `${r.classified} labelled${r.failed ? `, ${r.failed} failed` : ""}${tally ? ` — ${tally}` : ""}`;
      }),
    );

    await add(
      forwardingConfigured()
        ? await part("Forward to manager", async () => {
            const r = await forwardPending();
            if (r.sent === 0 && r.failed === 0) return "nothing to forward";
            return (
              `${r.sent} sent` +
              (r.failed ? `, ${r.failed} failed` : "") +
              (r.remaining ? `, ${r.remaining} still queued` : "")
            );
          })
        : skip("Forward to manager", "MANAGER_EMAIL is not set"),
    );
  } else {
    await add(skip("Classify replies", "skipped — the reply pull failed"));
    await add(skip("Forward to manager", "skipped — the reply pull failed"));
  }

  // 5. The long one, last. A bounded slice of the resumable walk.
  let cursor = previous?.lead_cursor ?? null;
  let done = previous?.lead_done ?? 0;
  let total = 0;

  await add(
    !isConfigured()
      ? skip("Leads", "QUICKMAIL_API_KEY is not set")
      : await part("Leads", async () => {
          const r = await syncLeads({ cursor, maxPages: LEAD_PAGES });
          total = r.totalCount;
          done += r.processed;

          if (r.hasNext) {
            cursor = r.cursor;
            const pct = total ? ((done / total) * 100).toFixed(0) : "0";
            return `${r.processed} walked (${done}/${total}, ${pct}%) — ${r.imported} new, ${r.updated} linked`;
          }

          // Reached the end: clear the cursor so the next pass starts over.
          cursor = null;
          const walked = done;
          done = 0;
          return `full pass complete — ${walked} walked, ${r.imported} new, ${r.updated} linked`;
        }),
  );

  const ok = parts.every((p) => p.ok);

  await prisma.syncRun.update({
    where: { id: run.id },
    data: {
      finished_at: new Date(),
      ok,
      parts: JSON.stringify(parts),
      lead_cursor: cursor,
      lead_done: done,
      lead_total: total,
    },
  });

  return {
    id: run.id,
    trigger,
    started_at: run.started_at.toISOString(),
    finished_at: new Date().toISOString(),
    ok,
    parts,
    lead_done: done,
    lead_total: total,
    lead_cursor: cursor,
  };
}
