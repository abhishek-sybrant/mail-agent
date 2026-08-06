/**
 * Asks QuickMail's internal GraphQL endpoint to describe one type, using the
 * signed-in browser session.
 *
 *   npx tsx scripts/probe-internal-schema.ts ReplyToEmailInput [More Types...]
 *
 * The request is issued from inside the page so the session cookie, the CSRF
 * token and the origin all match what their own front end sends.
 *
 * Read-only: introspection only, no data mutated.
 */
import { chromium } from "playwright";
import { CDP_PORT } from "../src/lib/quickmail/ui-automation";

const WORKSPACE = process.env.QUICKMAIL_WORKSPACE_ID ?? "54552";
const TYPES = process.argv.slice(2);
if (TYPES.length === 0) TYPES.push("ReplyToEmailInput");

const TYPE_QUERY = `
  query T($name: String!) {
    __type(name: $name) {
      name
      kind
      description
      inputFields {
        name
        description
        defaultValue
        type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
      }
      fields {
        name
        type { kind name ofType { kind name ofType { kind name } } }
      }
    }
  }
`;

function render(t: unknown): string {
  const n = t as { kind?: string; name?: string; ofType?: unknown } | null;
  if (!n) return "?";
  if (n.kind === "NON_NULL") return render(n.ofType) + "!";
  if (n.kind === "LIST") return "[" + render(n.ofType) + "]";
  return n.name ?? "?";
}

async function main() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const ctx = browser.contexts()[0];
  const page =
    ctx.pages().find((p) => p.url().includes("quickmail")) ?? (await ctx.newPage());

  if (!page.url().includes("next.quickmail.com")) {
    await page.goto(`https://next.quickmail.com/workspace/${WORKSPACE}/opportunities`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(5000);
  }

  for (const name of TYPES) {
    const result = await page.evaluate(
      async ([query, typeName]) => {
        const csrf =
          document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ??
          "";
        const res = await fetch("/graphql", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/plain, */*",
            "X-CSRF-Token": csrf,
          },
          body: JSON.stringify({ query, variables: { name: typeName } }),
        });
        return { status: res.status, text: (await res.text()).slice(0, 6000) };
      },
      [TYPE_QUERY, name] as const,
    );

    console.log(`\n===== ${name} (HTTP ${result.status}) =====`);
    let parsed: {
      data?: { __type?: { kind: string; inputFields?: unknown[]; fields?: unknown[] } };
      errors?: { message: string }[];
    };
    try {
      parsed = JSON.parse(result.text);
    } catch {
      console.log(result.text);
      continue;
    }

    if (parsed.errors) {
      console.log("errors:", parsed.errors.map((e) => e.message).join("; "));
      continue;
    }
    const t = parsed.data?.__type;
    if (!t) {
      console.log("(type not found — introspection may be disabled)");
      continue;
    }

    console.log(`${t.kind} ${name}`);
    for (const f of (t.inputFields ?? []) as { name: string; type: unknown; description?: string }[]) {
      console.log(`  ${f.name}: ${render(f.type)}${f.description ? `   // ${f.description}` : ""}`);
    }
    for (const f of (t.fields ?? []) as { name: string; type: unknown }[]) {
      console.log(`  ${f.name}: ${render(f.type)}`);
    }
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
