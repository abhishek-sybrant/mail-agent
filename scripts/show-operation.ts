/** Prints one operation extracted from QuickMail's bundle, in full. */
import { promises as fs } from "node:fs";
import path from "node:path";

async function main() {
  const file = path.join(process.cwd(), ".quickmail-capture", "operations.json");
  const ops = JSON.parse(await fs.readFile(file, "utf8")) as {
    kind: string;
    name: string;
    body: string;
  }[];

  const wanted = process.argv.slice(2);
  if (wanted.length === 0) {
    console.log(ops.map((o) => `${o.kind} ${o.name}`).join("\n"));
    return;
  }

  for (const name of wanted) {
    const op = ops.find((o) => o.name === name);
    console.log(`\n===== ${name} =====`);
    console.log(op ? op.body : "(not found)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
