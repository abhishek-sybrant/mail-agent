import "dotenv/config";
import { applyDueSchedules } from "../src/lib/quickmail/schedule";

/**
 * The campaign scheduler.
 *
 * QuickMail has no campaign start/end date, so this app implements the window
 * itself: `applyDueSchedules()` unpauses a campaign's email steps once its
 * start moment passes and re-pauses them at the end. That only works if
 * something calls it on a timer — and until now nothing did, so scheduled
 * campaigns sat in PENDING forever and never sent. That was the missing piece.
 *
 * Run it alongside the dev server:
 *   npm run scheduler
 *
 * In production this belongs in a real cron hitting /api/cron/tick with
 * CRON_SECRET, so it survives the app restarting. A long-lived loop is the
 * right shape for a local single-machine setup.
 */

const EVERY_MS = 60_000;

function stamp() {
  return new Date().toISOString().slice(11, 19);
}

async function tick() {
  try {
    const r = await applyDueSchedules();
    // Only speak up when something actually changed — a quiet scheduler that
    // logs every minute trains you to ignore it.
    if (r.started.length > 0) {
      console.log(`${stamp()} started: ${r.started.join(", ")}`);
    }
    if (r.ended.length > 0) {
      console.log(`${stamp()} ended: ${r.ended.join(", ")}`);
    }
    for (const e of r.errors) {
      console.error(`${stamp()} error: ${e}`);
    }
  } catch (error) {
    // Never let one bad tick kill the loop — the next one may well succeed.
    console.error(`${stamp()} tick failed:`, (error as Error).message);
  }
}

console.log(
  `scheduler running — checking every ${EVERY_MS / 1000}s. Ctrl+C to stop.`,
);
void tick();
setInterval(() => void tick(), EVERY_MS);
