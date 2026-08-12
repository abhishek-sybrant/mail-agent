import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  SYNC_INTERVAL_MS,
  isSyncRunning,
  lastSyncRun,
  nextSyncDueAt,
  runFullSync,
} from "@/lib/sync/run-all";

/**
 * The automatic sync, on demand.
 *
 *   GET  — what the last pass did and when the next one is due
 *   POST — run every part now
 *
 * A pass can take a quarter of an hour, most of it the resumable lead walk, so
 * POST holds the request for as long as that takes. The panel shows a spinner
 * rather than polling: there is exactly one pass at a time, and `runFullSync`
 * hands back the one already in flight instead of starting a competing one.
 */
export const maxDuration = 3600;

async function status() {
  const [last, nextDueAt] = await Promise.all([lastSyncRun(), nextSyncDueAt()]);
  return { intervalMs: SYNC_INTERVAL_MS, running: isSyncRunning(), last, nextDueAt };
}

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await status());
}

export async function POST(request: Request) {
  /**
   * Same two doors as the campaign tick: a signed-in user, or CRON_SECRET so an
   * external scheduler can drive this when the app is hosted somewhere that
   * won't keep a long-lived process alive.
   */
  const secret = process.env.CRON_SECRET;
  const provided = request.headers.get("x-cron-secret");
  const viaCron = Boolean(secret) && provided === secret;

  if (!viaCron) {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const run = await runFullSync(viaCron ? "cron" : "manual");
    return NextResponse.json({ ok: true, run, ...(await status()) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Sync failed" },
      { status: 502 },
    );
  }
}
