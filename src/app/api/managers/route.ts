import { NextResponse } from "next/server";
import { auth } from "@/auth";
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

  await removeManager(id);
  return NextResponse.json({ ok: true, managers: await listManagers() });
}
