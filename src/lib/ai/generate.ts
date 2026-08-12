import { AiUnavailable, complete, completeJson, providerFor } from "./provider";

export type GeneratedTemplate = {
  name: string;
  subject: string;
  /** Inbox preheader shown after the subject. */
  preview: string;
  body: string;
};

const TEMPLATE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Short internal label." },
    subject: {
      type: "string",
      description: "Subject line under 60 characters.",
    },
    preview: {
      type: "string",
      description:
        "Inbox preheader under 90 characters. Must not repeat the subject or " +
        "the first line of the body.",
    },
    body: {
      type: "string",
      description: "Plain-text body, 80-140 words, with QuickMail merge tags.",
    },
  },
  required: ["name", "subject", "preview", "body"],
  additionalProperties: false,
} as const;

/** Kept in step with the TemplateKind enum in the schema. */
export type TemplateKind =
  | "FIRST_MAIL"
  | "FOLLOW_UP"
  | "POSITIVE_REPLY"
  | "NEGATIVE_REPLY";

const TEMPLATE_BASE = `You write email for a B2B SDR team.

Rules that matter more than style:
- One clear ask at the end. Never two.
- The ONLY merge tag that works is {{lead.first_name}}. Never use {{firstName}},
  {{companyName}} or any company/title tag — there is no company data behind
  them, so they would send as empty text. Name the company in words instead.
- Do not write a sign-off name or signature. The sending mailbox appends its own.
- No "I hope this email finds you well", no "circling back", no fake urgency.
- Plain text only. No markdown, no HTML, no emoji.
- Write like a person emailing one other person.`;

/**
 * What changes between the four moments.
 *
 * One prompt for all of them produced a cold opener every time — a "follow up"
 * that re-introduced the company as though they had never heard of it, and a
 * reply to a rejection that pitched again. Length and intent are the parts that
 * actually differ, so they are the parts stated separately.
 */
const KIND_GUIDANCE: Record<TemplateKind, string> = {
  FIRST_MAIL: `This is a COLD OPENER to someone who has never heard from us.
- 80-140 words. Longer emails get deleted.
- Lead with the prospect's problem, not the product.
- Earn the reply; do not assume any prior contact.`,

  FOLLOW_UP: `This is a FOLLOW-UP to someone who did not reply to an earlier email.
- 40-90 words. Shorter than the first email, always.
- Add one new thing — an angle, a proof point, a shorter ask. Never resend the
  pitch in different words.
- Do not open by naming the company again or explaining who we are; they have
  that email. Do not scold them for not replying.
- No "just checking in", no "bumping this to the top of your inbox".`,

  POSITIVE_REPLY: `This is a REPLY to a prospect who answered with interest.
- 40-90 words. They are already engaged; do not sell again.
- Answer what they actually asked, first.
- Propose one concrete next step — a specific call length, or two times to pick
  between. Never "let me know what works".`,

  NEGATIVE_REPLY: `This is a REPLY to a prospect who declined or said no.
- 25-60 words. Brief is respectful here.
- Thank them plainly and accept the answer. Do not pitch again, do not ask why,
  do not offer a discount, do not propose a call.
- Leave one door open in a single sentence, without asking for anything.
- If they asked to be removed, confirm that and say nothing else.`,
};

export async function generateTemplate(
  prompt: string,
  /**
   * Subjects already shown and rejected. Passed back so "give me another" gets
   * a genuinely different angle instead of the same email reworded — a model
   * asked twice at the same temperature tends to repeat itself.
   */
  reject: string[] = [],
  kind: TemplateKind = "FIRST_MAIL",
): Promise<GeneratedTemplate> {
  if (providerFor("generate") === "off") {
    throw new AiUnavailable(
      "No AI configured. Set GEMINI_API_KEY, or run Ollama and set AI_PROVIDER=ollama.",
    );
  }

  const user =
    reject.length === 0
      ? prompt
      : [
          prompt,
          "",
          "You have already suggested these, and they were rejected:",
          ...reject.map((s) => `- "${s}"`),
          "",
          "Write something materially different — a different opening, a",
          "different angle on the problem, and a different ask. Do not reword",
          "what you wrote before.",
        ].join("\n");

  return completeJson<GeneratedTemplate>({
    task: "generate",
    system: `${TEMPLATE_BASE}\n\n${KIND_GUIDANCE[kind]}`,
    user,
    maxTokens: 1200,
    // Nudge upward with each rejection so later attempts diverge more.
    temperature: Math.min(0.9, 0.4 + reject.length * 0.15),
    schema: TEMPLATE_SCHEMA as unknown as Record<string, unknown>,
  });
}

const REPLY_SYSTEM = `You draft replies for a B2B sales rep responding to a
prospect who answered a cold email. A human reviews and approves every draft
before it sends, so output the finished email only.

- Start directly with the greeting. Never write a preamble such as
  "Sure, here's the email" — output only what will be sent.
- Match the prospect's tone and length. A two-line reply gets a two-line answer.
- Answer what they actually asked before adding anything else.
- Do not repeat their own words back to them.
- One next step, stated plainly.
- If given a booking link, include it verbatim.
- No markdown, no subject line, no placeholder brackets you cannot fill.
- Never promise a link, attachment or document unless one was given to you.
  Offer to send it instead — a promise with nothing attached reads as a mistake.
- Sign off with YOUR OWN first name — the one given as "You are". Never sign with
  the prospect's name. You are writing TO the prospect, not as them.`;

export async function draftReply(input: {
  incoming: string;
  name: string | null;
  company: string | null;
  sentiment: string;
  bookingLink?: string | null;
  senderName?: string;
  /** Bumped each time the reviewer asks for a different wording. */
  variation?: number;
}): Promise<string> {
  const sender = input.senderName ?? process.env.SENDER_NAME ?? "Alex";
  const prospectFirst = input.name?.trim().split(/\s+/)[0] ?? "there";

  lastDraftSource = { source: "ai" };

  if (providerFor("draft") === "off") {
    lastDraftSource = { source: "fallback", reason: "AI drafting is switched off" };
    return fallbackDraft(input, sender);
  }

  const variation = input.variation ?? 0;

  const instructions = [
    `The prospect's reply was classified as ${input.sentiment}.`,
    variation > 0
      ? "Take a noticeably different angle and opening line from the obvious one."
      : null,
    input.sentiment === "MEETING_REQUEST" && input.bookingLink
      ? `They want to meet. Include this booking link exactly: ${input.bookingLink}`
      : null,
    input.sentiment === "MEETING_REQUEST" && !input.bookingLink
      ? "They want to meet. Propose two specific time windows next week."
      : null,
    input.sentiment === "NEGATIVE" || input.sentiment === "UNSUBSCRIBE"
      ? "Write a short, gracious acknowledgement. Confirm they won't be contacted again. Do not pitch."
      : null,
  ].filter(Boolean);

  try {
    const text = await complete({
      task: "draft",
      system: REPLY_SYSTEM,
      maxTokens: 700,
      // Climbs on each re-roll so a second ask doesn't return the first draft.
      temperature: Math.min(0.9, 0.3 + variation * 0.2),
      // "You are" first and last: a 3B model reading a flat list of names
      // reliably signed off as the prospect. Stating the role before the
      // prospect's name, and repeating it after the reply, fixes it.
      // A 3B model needs the shape shown, not described. Given only a list of
      // names it either signed off as the prospect or opened with the sender's
      // name. An explicit skeleton fixes both, because each name appears in
      // exactly one slot.
      user: [
        `Reply from ${input.name ?? "the prospect"}${input.company ? ` at ${input.company}` : ""}:`,
        input.incoming,
        "",
        ...instructions,
        "",
        "Write the email in exactly this shape:",
        "",
        `Hi ${prospectFirst},`,
        "",
        "<your reply, in your own words>",
        "",
        sender,
      ].join("\n"),
    });

    const cleaned = fixSignature(stripPreamble(text), input.name, sender);
    if (cleaned) return cleaned;
    lastDraftSource = { source: "fallback", reason: "the model returned nothing" };
    return fallbackDraft(input, sender);
  } catch (error) {
    if (!(error instanceof AiUnavailable)) throw error;
    console.error("[ai] draft unavailable, using fallback", error.message);
    lastDraftSource = { source: "fallback", reason: error.message };
    return fallbackDraft(input, sender);
  }
}

/**
 * Whether the last draft actually came from a model.
 *
 * The fallback is a fixed template, and it is indistinguishable from a real
 * draft once it reaches the screen — a reviewer editing "AI draft" deserves to
 * know when the model never ran. Module-level rather than a changed return
 * type because every caller wants the text and only the UI wants the provenance.
 */
let lastDraftSource: { source: "ai" | "fallback"; reason?: string } = {
  source: "ai",
};

export function lastDraftProvenance() {
  return lastDraftSource;
}

/**
 * Small local models often prefix a line like "Sure, here's the email:" despite
 * being told not to. Cut anything before the greeting rather than sending it.
 */
function stripPreamble(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^\s*(hi|hello|hey|dear)\b/i.test(l));
  return (start > 0 ? lines.slice(start) : lines).join("\n").trim();
}

/**
 * Corrects a draft signed with the prospect's own name.
 *
 * qwen2.5:3b did this consistently — an email to "Dhilak M" signed off
 * "Dhilak", which reads as though the prospect wrote it. Prompt wording reduces
 * it but a 3B model cannot be relied on for something this embarrassing, so the
 * last line is checked and rewritten deterministically.
 */
function fixSignature(
  text: string,
  prospectName: string | null,
  sender: string,
): string {
  const prospectFirst = prospectName?.trim().split(/\s+/)[0];
  if (!text || !prospectFirst) return text;

  const lines = text.split("\n");
  // Walk back past trailing blanks to find the real sign-off.
  let i = lines.length - 1;
  while (i >= 0 && lines[i].trim() === "") i--;
  if (i < 0) return text;

  const last = lines[i].trim().replace(/[,.!]$/, "");
  // Only touch a bare name, never a sentence that happens to mention them.
  if (last.toLowerCase() === prospectFirst.toLowerCase()) {
    lines[i] = lines[i].replace(new RegExp(prospectFirst, "i"), sender);
    console.warn(
      `[ai] draft signed off as the prospect ("${prospectFirst}") — corrected to "${sender}"`,
    );
    return lines.join("\n");
  }
  return text;
}

/** Deterministic draft so the Inbox works with no AI at all. */
function fallbackDraft(
  input: { name: string | null; sentiment: string; bookingLink?: string | null },
  sender: string,
): string {
  const first = input.name?.split(" ")[0] ?? "there";

  if (input.sentiment === "NEGATIVE" || input.sentiment === "UNSUBSCRIBE") {
    return `Hi ${first},\n\nUnderstood — I've taken you off the list and you won't hear from me again.\n\nBest,\n${sender}`;
  }

  if (input.sentiment === "MEETING_REQUEST") {
    return input.bookingLink
      ? `Hi ${first},\n\nGreat — easiest is to grab a slot that suits you here:\n${input.bookingLink}\n\nBest,\n${sender}`
      : `Hi ${first},\n\nHappy to find time. I have Tuesday and Thursday afternoon open next week — would either work?\n\nBest,\n${sender}`;
  }

  return `Hi ${first},\n\nThanks for getting back to me. Happy to share more detail — would a short call be useful, or would you rather I send it over by email?\n\nBest,\n${sender}`;
}
