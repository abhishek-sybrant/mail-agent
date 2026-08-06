/** Prints one captured operation in full: query, variables, response shape. */
import { promises as fs } from "node:fs";
import path from "node:path";

const WANT = process.argv[2];

async function main() {
  const file = path.join(process.cwd(), ".quickmail-capture", "capture.json");
  const all = JSON.parse(await fs.readFile(file, "utf8")) as {
    operationName: string | null;
    query: string | null;
    variables: unknown;
    responsePreview: string;
    responseKeys: string[];
  }[];

  if (!WANT) {
    console.log(all.map((c, i) => `${i}  ${c.operationName}`).join("\n"));
    return;
  }

  for (const c of all) {
    if (c.operationName !== WANT) continue;
    console.log("=== query ===\n" + c.query);
    console.log("\n=== variables ===\n" + JSON.stringify(c.variables, null, 2));
    console.log("\n=== response keys ===\n" + c.responseKeys.join("\n"));
    console.log("\n=== response preview ===\n" + c.responsePreview);
    break;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
