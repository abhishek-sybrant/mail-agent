import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { logActivity } from "@/lib/activity";
import {
  addManager,
  listManagers,
  removeManager,
  setManagerActive,
} from "@/lib/managers";
import { badRequest, optionalString, readJson } from "@/lib/webhook";

/**
 * GET    /api/managers — everyone who can receive forwarded replies
 * POST   /api/managers — { email, name?, note? } to add, or { id, active } to pause
 * DELETE /api/managers — { id }
 *
 * Pausing is the softer option and the one to reach for: it stops the sending
 * and keeps the record of what was already sent to them. Removing is for
 * somebody added by mistake.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ managers: await listManagers() });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const id = optionalString(parsed.data.id);
  if (id && typeof parsed.data.active === "boolean") {
    await setManagerActive(id, parsed.data.active);
    const who = (await listManagers()).find((m) => m.id === id);
    await logActivity(
      "manager.pause",
      who?.email ?? id,
      parsed.data.active ? "resumed" : "paused",
    );
    return NextResponse.json({ ok: true, managers: await listManagers() });
  }

  const email = optionalString(parsed.data.email);
  if (!email) return badRequest("`email` is required");

  try {
    await addManager({
      email,
      name: optionalString(parsed.data.name),
      note: optionalString(parsed.data.note),
    });
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : "Could not add that");
  }

  await logActivity("manager.add", email);
  return NextResponse.json({ ok: true, managers: await listManagers() });
}

export async function DELETE(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const id = optionalString(parsed.data.id);
  if (!id) return badRequest("`id` is required");

  const gone = (await listManagers()).find((m) => m.id === id);
  await removeManager(id);
  await logActivity("manager.remove", gone?.email ?? id);
  return NextResponse.json({ ok: true, managers: await listManagers() });
}
