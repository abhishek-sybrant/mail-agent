import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { logActivity } from "@/lib/activity";
import {
  createUser,
  listUsers,
  removeUser,
  setPassword,
  setRole,
  UserError,
} from "@/lib/users";
import { badRequest, optionalString, readJson } from "@/lib/webhook";

/**
 * GET    /api/users — everyone who can sign in
 * POST   /api/users — { email, name?, password, role? } to create
 * PATCH  /api/users — { id, role? } or { id, password }
 * DELETE /api/users — { id }
 *
 * Admins only, on every verb including the read: the list is a roster of who
 * has access, which is not something a member needs.
 */
async function requireAdmin() {
  const session = await auth();
  if (!session?.user) return { error: "Unauthorized", status: 401 as const };

  const role = (session.user as { role?: string }).role;
  if (role !== "ADMIN") {
    return { error: "Only an admin can manage accounts", status: 403 as const };
  }
  return { id: session.user.id as string };
}

export async function GET() {
  const who = await requireAdmin();
  if ("error" in who) {
    return NextResponse.json({ error: who.error }, { status: who.status });
  }
  return NextResponse.json({ users: await listUsers() });
}

export async function POST(request: Request) {
  const who = await requireAdmin();
  if ("error" in who) {
    return NextResponse.json({ error: who.error }, { status: who.status });
  }

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const email = optionalString(parsed.data.email);
  const password = optionalString(parsed.data.password);
  if (!email) return badRequest("`email` is required");
  if (!password) return badRequest("`password` is required");

  const role = parsed.data.role === "ADMIN" ? "ADMIN" : "MEMBER";

  try {
    const u = await createUser({
      email,
      name: optionalString(parsed.data.name),
      password,
      role,
    });
    await logActivity("user.add", u.email, role === "ADMIN" ? "as an admin" : "as a member");
    return NextResponse.json({ ok: true, users: await listUsers() });
  } catch (error) {
    if (error instanceof UserError) return badRequest(error.message);
    throw error;
  }
}

export async function PATCH(request: Request) {
  const who = await requireAdmin();
  if ("error" in who) {
    return NextResponse.json({ error: who.error }, { status: who.status });
  }

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const id = optionalString(parsed.data.id);
  if (!id) return badRequest("`id` is required");

  try {
    const password = optionalString(parsed.data.password);
    if (password) {
      const email = await setPassword(id, password);
      await logActivity("user.password", email, "password changed by an admin");
      return NextResponse.json({ ok: true, users: await listUsers() });
    }

    if (parsed.data.role === "ADMIN" || parsed.data.role === "MEMBER") {
      const email = await setRole(id, parsed.data.role);
      await logActivity("user.role", email, `now ${parsed.data.role.toLowerCase()}`);
      return NextResponse.json({ ok: true, users: await listUsers() });
    }

    return badRequest("Nothing to change — send `role` or `password`");
  } catch (error) {
    if (error instanceof UserError) return badRequest(error.message);
    throw error;
  }
}

export async function DELETE(request: Request) {
  const who = await requireAdmin();
  if ("error" in who) {
    return NextResponse.json({ error: who.error }, { status: who.status });
  }

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const id = optionalString(parsed.data.id);
  if (!id) return badRequest("`id` is required");

  try {
    const email = await removeUser(id, who.id);
    await logActivity("user.remove", email, "their activity history is kept");
    return NextResponse.json({ ok: true, users: await listUsers() });
  } catch (error) {
    if (error instanceof UserError) return badRequest(error.message);
    throw error;
  }
}
