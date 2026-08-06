/**
 * Lists every GraphQL operation in QuickMail's cached JS bundles.
 *
 *   npm run qm-operations                # all of them
 *   npm run qm-operations -- unsubscribe # filter by name
 *
 * Their internal endpoint has introspection disabled, so the bundle is the only
 * complete catalogue of what the front end can do. Run
 * scripts/grep-quickmail-bundle.ts once first to populate the cache.
 *
 * Read-only.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const CACHE = path.join(process.cwd(), ".quickmail-capture", "bundles");
const FILTER = process.argv[2] ? new RegExp(process.argv[2], "i") : null;

/** Pulls `mutation Name(...) { … }` blocks out of a bundle by brace matching. */
function extract(src: string) {
  const out: { kind: string; name: string; body: string }[] = [];
  const re = /\b(mutation|query)\s+([A-Za-z][A-Za-z0-9_]*)\s*[({]/g;

  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index;
    let i = src.indexOf("{", m.index + m[0].length - 1);
    if (i === -1) continue;
    let depth = 0;
    let end = -1;
    for (; i < src.length && i - start < 20000; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end === -1) continue;
    out.push({ kind: m[1], name: m[2], body: src.slice(start, end) });
  }
  return out;
}

async function main() {
  let files: string[];
  try {
    files = (await fs.readdir(CACHE)).filter((f) => f.endsWith(".js"));
  } catch {
    console.error(
      `No cached bundles at ${CACHE}.\n` +
        `Run: npx tsx scripts/grep-quickmail-bundle.ts anything`,
    );
    process.exitCode = 1;
    return;
  }

  const found = new Map<string, { kind: string; name: string; body: string }>();
  for (const f of files) {
    for (const op of extract(await fs.readFile(path.join(CACHE, f), "utf8"))) {
      if (!found.has(op.name)) found.set(op.name, op);
    }
  }

  // Exact names print in full; anything else is treated as a name filter.
  const exact = process.argv.slice(2).filter((a) => found.has(a));
  if (exact.length > 0) {
    for (const name of exact) {
      console.log(`\n===== ${name} =====`);
      console.log(found.get(name)!.body);
    }
    return;
  }

  const all = [...found.values()].filter((o) => !FILTER || FILTER.test(o.name));
  const mutations = all.filter((o) => o.kind === "mutation").sort((a, b) => a.name.localeCompare(b.name));
  const queries = all.filter((o) => o.kind === "query").sort((a, b) => a.name.localeCompare(b.name));

  console.log(`${mutations.length} mutations:`);
  for (const m of mutations) console.log("  " + m.name);
  console.log(`\n${queries.length} queries:`);
  for (const q of queries) console.log("  " + q.name);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
