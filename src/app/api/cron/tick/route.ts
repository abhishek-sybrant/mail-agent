import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { applyDueSchedules } from "@/lib/quickmail/schedule";

export const maxDuration = 300;

/**
 * POST /api/cron/tick
 *
 * Applies any campaign schedule that has come due. Idempotent — a second call
 * in the same window does nothing.
 *
 * Auth: a signed-in user, or the CRON_SECRET header so an external scheduler
 * (Task Scheduler, cron, a hosted cron service) can call it unattended.
 */
async function run() {
  const result = await applyDueSchedules();
  return NextResponse.json({ ok: true, ...result, at: new Date().toISOString() });
}

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  const provided = request.headers.get("x-cron-secret");

  if (secret && provided === secret) return run();

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return run();
}

/** GET is allowed too, so a plain scheduled curl or browser hit works. */
export async function GET(request: Request) {
  return POST(request);
}
