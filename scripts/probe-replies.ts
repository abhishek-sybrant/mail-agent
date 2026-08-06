/**
 * Finds out, from the live account, how an inbound reply can actually be read.
 *
 *   npx tsx scripts/probe-replies.ts
 *
 * Three surfaces get checked, because they are genuinely different APIs:
 *   1. v2 GraphQL  (api.quickmail.com/v2/graphql)  — introspected in full
 *   2. v1 REST     (api.quickmail.io/v1)           — probed endpoint by endpoint
 *   3. the reply-shaped fields on whatever v2 does expose
 *
 * Read-only throughout.
 */
import "dotenv/config";

const KEY = process.env.QUICKMAIL_API_KEY;
if (!KEY) throw new Error("QUICKMAIL_API_KEY is not set");

const V2 = process.env.QUICKMAIL_URL ?? "https://api.quickmail.com/v2/graphql";

const WORDS =
  /repl|inbox|message|thread|conversation|mail|received|inbound|unibox|email_?body|content/i;

async function gql(query: string, variables?: Record<string, unknown>) {
  const res = await fetch(V2, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: KEY! },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { httpStatus: res.status, raw: text.slice(0, 200) };
  }
}

type Field = { name: string; description?: string | null; type: unknown };
type TypeInfo = {
  name: string;
  kind: string;
  fields?: Field[] | null;
  inputFields?: Field[] | null;
};

function unwrap(t: unknown): string {
  const node = t as { name?: string; ofType?: unknown } | null;
  if (!node) return "?";
  if (node.name) return node.name;
  return unwrap(node.ofType);
}

async function introspect() {
  console.log("\n=== 1. v2 GraphQL introspection ===");
  const res = await gql(`
    query {
      __schema {
        queryType { name }
        mutationType { name }
        types {
          name
          kind
          fields(includeDeprecated: true) { name description type { name kind ofType { name kind ofType { name kind ofType { name } } } } }
          inputFields { name type { name kind ofType { name } } }
        }
      }
    }
  `);

  if (!res?.data?.__schema) {
    console.log("introspection unavailable:", JSON.stringify(res).slice(0, 300));
    return null;
  }

  const types: TypeInfo[] = res.data.__schema.types.filter(
    (t: TypeInfo) => !t.name.startsWith("__"),
  );

  const queryType = types.find((t) => t.name === res.data.__schema.queryType.name);
  const mutationType = types.find(
    (t) => t.name === res.data.__schema.mutationType?.name,
  );

  console.log(`types: ${types.length}`);
  console.log(
    `\nQuery fields (${queryType?.fields?.length ?? 0}):\n  ` +
      (queryType?.fields ?? []).map((f) => `${f.name}: ${unwrap(f.type)}`).join("\n  "),
  );

  console.log(
    `\nMutations (${mutationType?.fields?.length ?? 0}):\n  ` +
      (mutationType?.fields ?? []).map((f) => f.name).join("\n  "),
  );

  console.log("\n--- reply-shaped TYPES ---");
  for (const t of types) {
    if (WORDS.test(t.name)) console.log(`  ${t.kind} ${t.name}`);
  }

  console.log("\n--- reply-shaped FIELDS, anywhere in the schema ---");
  for (const t of types) {
    for (const f of t.fields ?? []) {
      if (WORDS.test(f.name)) {
        console.log(`  ${t.name}.${f.name}: ${unwrap(f.type)}`);
      }
    }
  }

  return types;
}

/** Every documented v1 REST path that could plausibly carry replies. */
const V1_PATHS = [
  "/replies",
  "/inbox",
  "/messages",
  "/threads",
  "/conversations",
  "/emails",
  "/campaigns",
  "/prospects",
  "/campaigns/replies",
  "/activity",
  "/events",
  "/unibox",
];

async function probeV1() {
  console.log("\n=== 2. v1 REST probe (api.quickmail.io/v1) ===");
  for (const p of V1_PATHS) {
    const url = `https://api.quickmail.io/v1${p}?api_key=${KEY}`;
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      const text = await res.text();
      const short = text.replace(/\s+/g, " ").slice(0, 150);
      console.log(`  ${res.status.toString().padEnd(4)} ${p.padEnd(20)} ${short}`);
    } catch (e) {
      console.log(`  ERR  ${p.padEnd(20)} ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** If the schema hides a lead-level reply field, ask a real lead for it. */
async function probeLeadFields(types: TypeInfo[] | null) {
  if (!types) return;
  console.log("\n=== 3. Lead / campaign reply fields ===");
  for (const name of ["Lead", "Campaign", "EmailAccount", "Activity", "Event"]) {
    const t = types.find((x) => x.name === name);
    if (!t) {
      console.log(`  (no type ${name})`);
      continue;
    }
    console.log(
      `  ${name}: ${(t.fields ?? []).map((f) => `${f.name}:${unwrap(f.type)}`).join(", ")}`,
    );
  }
}

async function main() {
  const types = await introspect();
  await probeLeadFields(types);
  await probeV1();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
