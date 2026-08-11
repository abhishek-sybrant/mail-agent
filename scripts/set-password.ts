/**
 * Sets a dashboard user's password.
 *
 *   npm run set-password -- admin@sybrant.com
 *
 * Prompts for the password rather than taking it as an argument: a password on
 * the command line lands in shell history and in the process list, where any
 * other local account can read it.
 *
 * This exists because the seeded account still had the documented default —
 * fine while the app was bound to localhost, unacceptable once it is reachable
 * from another machine.
 */
import "dotenv/config";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma";

const email = process.argv[2]?.trim().toLowerCase();

/** Reads a line without echoing it to the terminal. */
function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    const asAny = rl as unknown as { _writeToOutput: (s: string) => void };
    const original = asAny._writeToOutput.bind(rl);
    let first = true;
    asAny._writeToOutput = (s: string) => {
      if (first) {
        original(s);
        first = false;
      } else if (s.includes("\n")) {
        original("\n");
      }
    };
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  if (!email || !email.includes("@")) {
    console.error("Usage: npm run set-password -- someone@example.com");
    process.exitCode = 1;
    return;
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    const all = await prisma.user.findMany({ select: { email: true } });
    console.error(`No user ${email}. Known users: ${all.map((u) => u.email).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const pw = await askHidden(`New password for ${email}: `);
  if (pw.length < 12) {
    console.error("\nToo short — use at least 12 characters.");
    process.exitCode = 1;
    return;
  }
  const again = await askHidden(`Confirm: `);
  if (pw !== again) {
    console.error("\nThey don't match. Nothing changed.");
    process.exitCode = 1;
    return;
  }

  await prisma.user.update({
    where: { email },
    data: { password_hash: await bcrypt.hash(pw, 12) },
  });
  console.log(`\nPassword updated for ${email}.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
