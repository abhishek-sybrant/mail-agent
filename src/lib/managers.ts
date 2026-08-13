import { prisma } from "@/lib/prisma";

/**
 * Who forwarded replies go to.
 *
 * This used to be one address in .env, changeable only by someone sitting at
 * the server, and only ever one person. Covering for a colleague, or copying a
 * second reviewer for a week, needed a file edit and a restart.
 *
 * MANAGER_EMAIL is still honoured, as a seed: on the first read, if no manager
 * has been added yet, the address from the environment becomes the first
 * record. Nobody has to re-enter what was already configured, and nothing stops
 * working the moment this ships.
 */

export type ManagerRow = {
  id: string;
  email: string;
  name: string | null;
  active: boolean;
  note: string | null;
};

/**
 * Adopts MANAGER_EMAIL as the first manager, once.
 *
 * Only when the table is completely empty — an env var left in place must not
 * resurrect someone who has been deliberately removed.
 */
async function seedFromEnv(): Promise<void> {
  const env = process.env.MANAGER_EMAIL?.trim().toLowerCase();
  if (!env) return;

  const any = await prisma.manager.count();
  if (any > 0) return;

  await prisma.manager.create({
    data: { email: env, note: "carried over from MANAGER_EMAIL" },
  });
}

export async function listManagers(): Promise<ManagerRow[]> {
  await seedFromEnv();
  return prisma.manager.findMany({
    orderBy: [{ active: "desc" }, { email: "asc" }],
    select: { id: true, email: true, name: true, active: true, note: true },
  });
}

/** Addresses a forward should actually go to. Empty means forwarding is off. */
export async function activeManagerEmails(): Promise<string[]> {
  await seedFromEnv();
  const rows = await prisma.manager.findMany({
    where: { active: true },
    select: { email: true },
    orderBy: { email: "asc" },
  });
  return rows.map((r) => r.email);
}

export async function addManager(input: {
  email: string;
  name?: string | null;
  note?: string | null;
}): Promise<ManagerRow> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) throw new Error(`"${input.email}" is not an email address`);

  /**
   * Re-adding someone who was deactivated turns them back on rather than
   * failing on the unique index — which is what the person doing it meant.
   */
  return prisma.manager.upsert({
    where: { email },
    update: { active: true, name: input.name ?? undefined, note: input.note ?? undefined },
    create: { email, name: input.name ?? null, note: input.note ?? null },
    select: { id: true, email: true, name: true, active: true, note: true },
  });
}

export async function setManagerActive(id: string, active: boolean): Promise<void> {
  await prisma.manager.update({ where: { id }, data: { active } });
}

export async function removeManager(id: string): Promise<void> {
  await prisma.manager.delete({ where: { id } });
}
