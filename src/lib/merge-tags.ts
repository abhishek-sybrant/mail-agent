/**
 * The merge tags QuickMail actually substitutes, and how well each one is
 * backed by data in this workspace.
 *
 * The list is theirs, taken from the variable picker in their own bundle —
 * not guessed. That matters more than usual here: a tag QuickMail does not
 * recognise is not dropped, it is sent literally, so a prospect receives an
 * email containing "{{lead.company}}" in the middle of a sentence.
 *
 * Coverage is measured, not assumed. It decides which tags are worth offering:
 * a tag with nothing behind it resolves to empty text, which reads as a broken
 * mail-merge — "Hi ," — and is worse than never having personalised at all.
 *
 * Figures below were counted on 2026-08-13 over 52,584 synced leads, and over
 * the 382 prospects QuickMail has returned in full (the reply mirror) for the
 * fields the lead API does not expose. They are a snapshot; re-measure with
 * `npm run tag-coverage` if the imports change materially.
 */

export type TagRisk = "safe" | "care" | "avoid";

export type MergeTag = {
  token: string;
  label: string;
  group: "Lead" | "Company" | "Mailbox";
  risk: TagRisk;
  /** What happens when it is used — coverage, and what an empty one looks like. */
  note: string;
  /** Stand-in used by the studio preview. */
  sample: string;
};

export const MERGE_TAGS: MergeTag[] = [
  {
    token: "{{lead.first_name}}",
    label: "First name",
    group: "Lead",
    risk: "safe",
    note: "99% of leads have one",
    sample: "Sarah",
  },
  {
    token: "{{lead.email}}",
    label: "Email",
    group: "Lead",
    risk: "safe",
    note: "always present, but rarely worth putting in a sentence",
    sample: "sarah.chen@example.com",
  },
  {
    token: "{{lead.last_name}}",
    label: "Last name",
    group: "Lead",
    risk: "care",
    note: "82% — one in six would read as a missing word",
    sample: "Chen",
  },
  {
    token: "{{lead.title}}",
    label: "Job title",
    group: "Lead",
    risk: "care",
    note: "82% — and the wording varies wildly between records",
    sample: "Head of Lease Administration",
  },
  {
    token: "{{lead.role}}",
    label: "Role",
    group: "Lead",
    risk: "avoid",
    note: "usually the same as the title, often blank",
    sample: "Operations",
  },
  {
    token: "{{lead.phone}}",
    label: "Phone",
    group: "Lead",
    risk: "avoid",
    note: "39% — and a phone number rarely belongs in a cold email",
    sample: "+1 555 0100",
  },
  {
    token: "{{lead.linkedin}}",
    label: "LinkedIn",
    group: "Lead",
    risk: "avoid",
    note: "sparse, and quoting it back reads as surveillance",
    sample: "linkedin.com/in/example",
  },
  {
    token: "{{company.name}}",
    label: "Company name",
    group: "Company",
    risk: "care",
    note:
      "87% present, but some records hold a job title here instead of a company — read it before trusting it",
    sample: "Northwind Analytics",
  },
  {
    token: "{{company.domain}}",
    label: "Company domain",
    group: "Company",
    risk: "avoid",
    note: "thinly populated, and it reads like a database field",
    sample: "northwind.io",
  },
  {
    token: "{{inbox.signature}}",
    label: "Your signature",
    group: "Mailbox",
    risk: "safe",
    note: "the sending mailbox's own signature — put it at the very end",
    sample: "— Alex\nSybrant Technologies",
  },
  {
    token: "{{inbox.friendly_name}}",
    label: "Your name",
    group: "Mailbox",
    risk: "safe",
    note: "the sender's display name, from the mailbox",
    sample: "Alex Morgan",
  },
  {
    token: "{{inbox.email}}",
    label: "Your email",
    group: "Mailbox",
    risk: "safe",
    note: "the sending address",
    sample: "alex@sybrant.com",
  },
];

/**
 * Replaces every known tag with its stand-in, for the editor preview.
 *
 * Spaces inside the braces are tolerated, matching what `unknownTags` accepts:
 * otherwise "{{ lead.first_name }}" passes the check as valid and then shows
 * up unsubstituted in the preview, which reads as the tag being broken.
 */
export function previewTags(text: string): string {
  const byName = new Map(
    MERGE_TAGS.map((t) => [t.token.slice(2, -2), t.sample]),
  );
  return (text ?? "").replace(/\{\{\s*([^}]{0,60}?)\s*\}\}/g, (whole, name) =>
    byName.get(name) ?? whole,
  );
}

/**
 * Tags left in a draft that QuickMail will not recognise.
 *
 * Anything of the shape {{…}} that is not on the list above is sent verbatim,
 * so it is worth catching before a human approves the copy rather than after
 * a prospect reads it.
 */
export function unknownTags(text: string): string[] {
  const known = new Set(MERGE_TAGS.map((t) => t.token));
  const found = text.match(/\{\{[^}]{0,60}\}\}/g) ?? [];
  return [
    ...new Set(
      found
        .map((f) => f.replace(/\s+/g, ""))
        // Date helpers are a family, not fixed tokens: {{=day+3}} and so on.
        .filter((f) => !known.has(f) && !/^\{\{=(b?day)[+-]\d+\}\}$/.test(f)),
    ),
  ];
}

/** The instruction block handed to the model, so prompts cannot drift. */
export function tagInstructions(): string {
  const line = (risk: TagRisk) =>
    MERGE_TAGS.filter((t) => t.risk === risk)
      .map((t) => t.token)
      .join(", ");

  return [
    "MERGE TAGS — these are the only ones QuickMail substitutes. Any other",
    "{{...}} is sent to the prospect literally, so never invent one.",
    `- Use freely: ${line("safe")}`,
    `- Use only if the copy still reads correctly when it is blank: ${line("care")}`,
    `- Do not use: ${line("avoid")}`,
    "Prefer naming the company in words over a tag. Write so that a missing",
    "value leaves a sentence that still makes sense — never 'Hi {{lead.first_name}},'",
    "as the entire greeting of a mail whose value might be empty.",
  ].join("\n");
}
