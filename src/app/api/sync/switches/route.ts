import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { logActivity } from "@/lib/activity";
import { badRequest, readJson } from "@/lib/webhook";
import { SWITCHES, setSwitch, switchStates, type SwitchKey } from "@/lib/sync/switches";

/**
 * GET  /api/sync/switches — every per-part switch and its state
 * POST /api/sync/switches — { key, on: boolean }
 *
 * Stopping a part of the sync without stopping the timer. Killing the whole
 * timer to silence one job also stopped campaign windows being applied on
 * time, which is a worse problem than the one it solved.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ switches: await switchStates() });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const key = parsed.data.key;
  const known = SWITCHES.some((s) => s.key === key);
  if (typeof key !== "string" || !known) {
    return badRequest(`\`key\` must be one of ${SWITCHES.map((s) => s.key).join(", ")}`);
  }
  if (typeof parsed.data.on !== "boolean") {
    return badRequest("`on` must be true or false");
  }

  await setSwitch(key as SwitchKey, parsed.data.on);
  await logActivity("sync.switch", key, parsed.data.on ? "started" : "stopped");
  return NextResponse.json({ ok: true, switches: await switchStates() });
}
