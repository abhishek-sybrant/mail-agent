import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

/**
 * Managing who can sign in.
 *
 * The activity log can only be as useful as the number of logins: with one
 * shared account every line reads "Admin", and "who sent this reply" still has
 * no answer. This is what makes that log worth having.
 *
 * Two rules exist to stop the app being locked out of itself, and both are
 * enforced here rather than in the UI, because the UI is a courtesy and the
 * route is reachable directly.
 */

/** Same cost as the seeder and the set-password script. */
const COST = 12;

export type UserRow = {
  id: string;
  email: string;
  name: string | null;
  role: "ADMIN" | "MEMBER";
  createdAt: string;
  /** How much of the activity log is theirs. */
  actions: number;
};

export async function listUsers(): Promise<UserRow[]> {
  const rows = await prisma.user.findMany({
    orderBy: [{ role: "asc" }, { email: "asc" }],
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      created_at: true,
      _count: { select: { activity: true } },
    },
  });

  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    createdAt: r.created_at.toISOString(),
    actions: r._count.activity,
  }));
}

export class UserError extends Error {}

function checkPassword(password: string): void {
  /**
   * Eight characters, and not the seeded one.
   *
   * The seeded admin password is in the repo's history and in the README; a new
   * account created with it is not a new account, it is the same hole with
   * another name on it.
   */
  if (password.length < 8) {
    throw new UserError("Password must be at least 8 characters");
  }
  if (password.toLowerCase() === "changeme123") {
    throw new UserError("Pick something other than the seeded password");
  }
}

export async function createUser(input: {
  email: string;
  name?: string | null;
  password: string;
  role?: "ADMIN" | "MEMBER";
}): Promise<UserRow> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) throw new UserError(`"${input.email}" is not an email address`);
  checkPassword(input.password);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new UserError(`${email} already has an account`);

  const u = await prisma.user.create({
    data: {
      email,
      name: input.name?.trim() || null,
      role: input.role ?? "MEMBER",
      password_hash: await bcrypt.hash(input.password, COST),
    },
  });

  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    createdAt: u.created_at.toISOString(),
    actions: 0,
  };
}

export async function setPassword(id: string, password: string): Promise<string> {
  checkPassword(password);
  const u = await prisma.user.update({
    where: { id },
    data: { password_hash: await bcrypt.hash(password, COST) },
    select: { email: true },
  });
  return u.email;
}

/**
 * Changes a role, refusing to remove the last admin.
 *
 * Without this the app can be locked out of its own user management by one
 * click, and the only way back is a script on the server.
 */
export async function setRole(
  id: string,
  role: "ADMIN" | "MEMBER",
): Promise<string> {
  if (role === "MEMBER") {
    const admins = await prisma.user.count({ where: { role: "ADMIN" } });
    const target = await prisma.user.findUnique({ where: { id }, select: { role: true } });
    if (admins <= 1 && target?.role === "ADMIN") {
      throw new UserError("This is the only admin — promote someone else first");
    }
  }

  const u = await prisma.user.update({
    where: { id },
    data: { role },
    select: { email: true },
  });
  return u.email;
}

/**
 * Removes an account.
 *
 * Their activity survives: the log's user relation is SetNull, so the lines
 * stay and simply lose the name. Deleting the record must not delete the
 * history of what they did.
 */
export async function removeUser(id: string, actingUserId: string): Promise<string> {
  if (id === actingUserId) {
    throw new UserError("You cannot remove your own account");
  }

  const target = await prisma.user.findUnique({
    where: { id },
    select: { email: true, role: true },
  });
  if (!target) throw new UserError("No such account");

  if (target.role === "ADMIN") {
    const admins = await prisma.user.count({ where: { role: "ADMIN" } });
    if (admins <= 1) throw new UserError("This is the only admin — promote someone else first");
  }

  await prisma.user.delete({ where: { id } });
  return target.email;
}
