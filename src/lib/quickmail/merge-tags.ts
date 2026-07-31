/**
 * QuickMail merge tags.
 *
 * QuickMail namespaces its placeholders and uses snake_case: `{{lead.first_name}}`,
 * not `{{firstName}}`. An unrecognised tag is NOT an error — QuickMail sends the
 * email with the literal text `{{firstName}}` still in it, which is why this
 * only ever shows up after a real send.
 *
 * The vocabulary below was read off the live workspace rather than guessed:
 * every email in all 80 campaigns uses exactly two tags, 221 occurrences each —
 * `{{lead.first_name}}` and `{{inbox.signature}}`. Those two are therefore the
 * only ones proven to work here; the rest are accepted for translation but
 * flagged, because a tag with no data behind it renders as an empty string and
 * leaves a sentence with a hole in it.
 */

/** Tags observed working in this workspace. */
export const PROVEN_TAGS = ["lead.first_name", "inbox.signature"] as const;

/**
 * Tags QuickMail documents that we can translate to, but that are unproven
 * here. `lead.company_name` in particular has no readable backing field on the
 * Lead type in this workspace, so it may well render empty.
 */
export const KNOWN_TAGS = [
  ...PROVEN_TAGS,
  "lead.last_name",
  "lead.full_name",
  "lead.email",
  "lead.title",
  "lead.company_name",
  "lead.location",
  "lead.phone",
] as const;

/**
 * Loose names people (and language models) write, mapped to the real tag.
 * Keys are compared lowercased with separators stripped, so `firstName`,
 * `first_name`, `First Name` and `lead.firstName` all land on the same entry.
 */
const ALIASES: Record<string, string> = {
  firstname: "lead.first_name",
  fname: "lead.first_name",
  lastname: "lead.last_name",
  lname: "lead.last_name",
  fullname: "lead.full_name",
  name: "lead.full_name",
  email: "lead.email",
  title: "lead.title",
  jobtitle: "lead.title",
  role: "lead.title",
  company: "lead.company_name",
  companyname: "lead.company_name",
  organisation: "lead.company_name",
  organization: "lead.company_name",
  location: "lead.location",
  city: "lead.location",
  phone: "lead.phone",
  signature: "inbox.signature",
  sendername: "inbox.signature",
  yourname: "inbox.signature",
  sender: "inbox.signature",
};

function canonical(raw: string): string | null {
  const trimmed = raw.trim();
  // Already namespaced and known — keep as-is.
  const asIs = trimmed.toLowerCase();
  if ((KNOWN_TAGS as readonly string[]).includes(asIs)) return asIs;

  // Strip a namespace and any separators, then look up the loose name.
  const bare = asIs.replace(/^(lead|inbox|contact|prospect)\./, "");
  const key = bare.replace(/[^a-z]/g, "");
  return ALIASES[key] ?? null;
}

export type MergeTagResult = {
  text: string;
  /** Tags translated into QuickMail's syntax. */
  rewritten: string[];
  /** Tags we could not map — left untouched so nothing is silently deleted. */
  unknown: string[];
  /** Mapped, but not proven to carry data in this workspace. */
  unproven: string[];
};

/**
 * Rewrites every `{{...}}` placeholder into QuickMail's syntax.
 *
 * Unknown tags are deliberately left in place rather than stripped: silently
 * deleting one would change the sentence, and a visible `{{whatever}}` in the
 * warning list is easier to act on than copy that quietly lost a word.
 */
export function toQuickMailTags(text: string): MergeTagResult {
  const rewritten: string[] = [];
  const unknown: string[] = [];
  const unproven: string[] = [];

  const out = text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, inner: string) => {
    const mapped = canonical(inner);
    if (!mapped) {
      unknown.push(whole);
      return whole;
    }
    const tag = `{{${mapped}}}`;
    if (tag !== whole) rewritten.push(`${whole} -> ${tag}`);
    if (!(PROVEN_TAGS as readonly string[]).includes(mapped)) unproven.push(tag);
    return tag;
  });

  return { text: out, rewritten, unknown, unproven: [...new Set(unproven)] };
}

/**
 * QuickMail stores email bodies as HTML — the live campaigns are all `<div>`
 * per line. Plain text sent as-is loses every line break, so paragraphs run
 * together. Text that already contains markup is passed through untouched.
 */
export function toEmailHtml(body: string): string {
  if (/<(div|p|br|table|ul|ol)\b/i.test(body)) return body;

  const escape = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  // Merge tags must survive escaping intact, so escape first and then restore
  // the braces — they contain no HTML-significant characters themselves.
  return body
    .split(/\r?\n/)
    .map((line) => (line.trim() === "" ? "<div><br></div>" : `<div>${escape(line)}</div>`))
    .join("");
}

/** Convenience: fix the tags and render to HTML in one step. */
export function prepareEmailBody(body: string): MergeTagResult {
  const tagged = toQuickMailTags(body);
  return { ...tagged, text: toEmailHtml(tagged.text) };
}
