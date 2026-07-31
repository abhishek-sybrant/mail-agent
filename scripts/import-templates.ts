import "dotenv/config";
import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../src/generated/prisma/client";

/**
 * Imports the campaign briefs in /templates into the Template table.
 *
 * Each .docx holds one service line: targeting metadata followed by a
 * three-email sequence. Every email becomes its own Template row, grouped by
 * category and ordered by step, so the sequence can be rebuilt in a campaign.
 */

const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({
    url: process.env.DATABASE_URL ?? "file:./prisma/dev.db",
  }),
});

/** .docx is a zip; word/document.xml holds the text. */
function lines(file: string): string[] {
  let xml = execSync(`unzip -p "templates/${file}" word/document.xml`, {
    maxBuffer: 1 << 26,
  }).toString("utf8");

  // Strip paragraph/run properties first — they contain tags that otherwise
  // leak into the extracted text.
  xml = xml
    .replace(/<w:pPr>[\s\S]*?<\/w:pPr>/g, "")
    .replace(/<w:rPr>[\s\S]*?<\/w:rPr>/g, "")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:br\s*\/>/g, "\n");

  return xml
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

const SECTION =
  /^(Campaign Name|Campaign Timelines|Geography|Industry|Target Segment|Target Contact|Email Template:?)$/i;

type Parsed = {
  name: string;
  geography: string[];
  industry: string[];
  emails: { step: number; subject: string; body: string }[];
};

function parse(file: string): Parsed {
  const L = lines(file);
  const out: Parsed = {
    name: file.replace(/\.docx$/, ""),
    geography: [],
    industry: [],
    emails: [],
  };

  let section: string | null = null;
  let i = 0;

  for (; i < L.length; i++) {
    if (/^Email Template/i.test(L[i])) {
      i++;
      break;
    }
    if (SECTION.test(L[i])) {
      section = L[i].toLowerCase();
      continue;
    }
    if (section === "campaign name") out.name = L[i];
    else if (section === "geography") out.geography.push(L[i]);
    else if (
      section === "industry" &&
      !/^(this email campaign|this campaign is|target any industry)/i.test(L[i])
    )
      out.industry.push(L[i]);
  }

  type Draft = { step: number; subject: string; body: string[] };
  let cur: Draft | null = null;
  const bodies: Draft[] = [];

  for (; i < L.length; i++) {
    const l = L[i];
    if (/^Email\s*\d+\s*:?$/i.test(l)) continue;
    const s = l.match(/^Subject:\s*(.+)$/i);
    if (s) {
      // Some subjects carry an "OR" alternative; keep the first variant.
      const subject = s[1].replace(/\s+OR\s*$/i, "").trim();
      cur = { step: bodies.length + 1, subject, body: [] };
      bodies.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^Body:?$/i.test(l)) continue;
    cur.body.push(l);
  }

  out.emails = bodies
    .filter((b): b is NonNullable<typeof b> => b !== null)
    .map((b) => ({ step: b.step, subject: b.subject, body: b.body.join("\n").trim() }));

  return out;
}

/**
 * Swap the docx placeholders for QuickMail's merge tags so the copy is
 * send-ready rather than needing a manual find-and-replace.
 */
function toMergeTags(text: string): string {
  return text
    .replace(/\[First Name\]/gi, "{{lead.first_name}}")
    .replace(/\[Last Name\]/gi, "{{lead.last_name}}")
    .replace(/\[Company( Name)?\]/gi, "{{lead.company_name}}")
    // QuickMail appends the sending inbox's own signature.
    .replace(/\[Your Name\]/gi, "{{inbox.signature}}");
}

async function main() {
  const files = readdirSync("templates").filter((f) => f.endsWith(".docx"));
  let created = 0;
  let updated = 0;

  for (const file of files) {
    const c = parse(file);

    for (const email of c.emails) {
      const name = `${c.name} — Email ${email.step}`;

      // Category + step is the natural key: re-running updates in place
      // instead of piling up duplicates.
      const existing = await prisma.template.findFirst({
        where: { category: c.name, step: email.step },
      });

      const data = {
        name,
        subject: toMergeTags(email.subject),
        body: toMergeTags(email.body),
        category: c.name,
        step: email.step,
        source: "DOCX",
        geography: JSON.stringify(c.geography),
        industry: JSON.stringify(c.industry),
      };

      if (existing) {
        await prisma.template.update({ where: { id: existing.id }, data });
        updated++;
      } else {
        await prisma.template.create({ data });
        created++;
      }
    }

    console.log(
      `${c.name}: ${c.emails.length} emails · ${c.geography.length} regions`,
    );
  }

  console.log(`\n${created} created, ${updated} updated.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
