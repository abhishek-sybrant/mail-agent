import { applyDueSchedules } from "@/lib/quickmail/schedule";
import {
  SYNC_INTERVAL_MS,
  isSyncRunning,
  reclaimAbandonedRuns,
  runFullSync,
  syncIsDue,
} from "./run-all";

/**
 * The in-process timer behind the automatic sync.
 *
 * It wakes every minute and asks the database whether a pass is due, rather
 * than counting from when the server booted. That distinction matters: an
 * interval anchored to boot time restarts its hour on every deploy or crash,
 * so a server that restarts every fifty minutes would never sync at all. Due
 * is "the last pass started more than an interval ago", which survives
 * restarts and makes the countdown on the Sync page honest — it is derived
 * from the same recorded timestamp.
 *
 * Campaign windows are checked every minute regardless. QuickMail has no
 * campaign start date, so this app unpauses the steps itself, and a campaign
 * set to begin at 09:00 should not sit idle until the next hourly pass.
 */

const EVERY_MS = 60_000;

/**
 * Survives the module being re-evaluated.
 *
 * Dev reloads and the instrumentation hook can both import this more than
 * once; a plain module-level flag would let a second timer arm alongside the
 * first, and two overlapping passes would share the rate limit and crawl.
 */
const ARMED = Symbol.for("sdr.sync.ticker");
type Global = typeof globalThis & { [ARMED]?: boolean };

function stamp() {
  return new Date().toISOString().slice(11, 19);
}

async function tick() {
  try {
    if (isSyncRunning()) return;

    if (await syncIsDue()) {
      console.log(`[sync ${stamp()}] starting the pass`);

      // Reported as each part lands, not at the end: the lead walk runs for a
      // quarter of an hour, and a pass that says nothing until it finishes is
      // indistinguishable from one that has hung.
      const run = await runFullSync("timer", (p) => {
        const mark = p.skipped ? "skip" : p.ok ? "ok" : "FAILED";
        console.log(
          `[sync ${stamp()}]   ${mark.padEnd(6)} ${p.part}: ${p.error ?? p.detail}`,
        );
      });

      console.log(
        `[sync ${stamp()}] pass ${run.ok ? "complete" : "finished with failures"}`,
      );
      return;
    }

    // Between passes, keep campaign windows to the minute.
    const r = await applyDueSchedules();
    if (r.started.length) console.log(`[sync ${stamp()}] started: ${r.started.join(", ")}`);
    if (r.ended.length) console.log(`[sync ${stamp()}] ended: ${r.ended.join(", ")}`);
    for (const e of r.errors) console.error(`[sync ${stamp()}] schedule error: ${e}`);
  } catch (error) {
    // Never let one bad tick kill the timer — the next may well succeed.
    console.error(`[sync ${stamp()}] tick failed:`, (error as Error).message);
  }
}

export function startSyncTicker() {
  const g = globalThis as Global;
  if (g[ARMED]) return;
  g[ARMED] = true;

  console.log(
    `[sync] automatic sync armed — every ${Math.round(SYNC_INTERVAL_MS / 60_000)} minutes, ` +
      `campaign windows every ${EVERY_MS / 1000}s`,
  );

  // A pass only lives inside one process, so anything still open belongs to a
  // server that is no longer here.
  void reclaimAbandonedRuns()
    .then((n) => {
      if (n > 0) console.log(`[sync] closed ${n} pass(es) a restart interrupted`);
    })
    .catch(() => {});

  // Not on the boot path: `register()` has to finish before the server accepts
  // requests, and the first pass can run for a quarter of an hour.
  const timer = setInterval(() => void tick(), EVERY_MS);
  timer.unref?.();
}
