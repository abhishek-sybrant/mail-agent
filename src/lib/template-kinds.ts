/**
 * The four moments a template can be written for.
 *
 * Plain data in a plain module, deliberately. This started out exported from
 * the studio component, which carries "use client" — and Next.js replaces a
 * client module's exports with client references on the server, so a server
 * component importing the list got a proxy and `KINDS.map is not a function`.
 * Anything both sides need has to live outside that boundary.
 *
 * Icons stay in the client component: they are React, and this file is not.
 */

/** Kept in step with the TemplateKind enum in the schema. */
export type TemplateKind =
  | "FIRST_MAIL"
  | "FOLLOW_UP"
  | "POSITIVE_REPLY"
  | "NEGATIVE_REPLY";

export type KindMeta = {
  value: TemplateKind;
  /** Shown on the category button. */
  label: string;
  /** One word, for counts like "6 first · 10 follow-up". */
  short: string;
  /** What this category is for, under the button. */
  blurb: string;
  /** What the AI is told it is writing, so button and prompt cannot drift. */
  hint: string;
};

export const KINDS: KindMeta[] = [
  {
    value: "FIRST_MAIL",
    label: "First mail",
    short: "first",
    blurb: "The cold opener. Nobody has heard from us yet.",
    hint: "Cold opening email to a prospect who has never heard from us.",
  },
  {
    value: "FOLLOW_UP",
    label: "Follow-up mail",
    short: "follow-up",
    blurb: "Sent when the first email got no reply. Shorter, one new angle.",
    hint: "Short follow-up to someone who did not reply to the first email.",
  },
  {
    value: "POSITIVE_REPLY",
    label: "Positive reply",
    short: "positive",
    blurb: "They answered with interest. Answer them and propose a time.",
    hint: "Reply to a prospect who answered with interest and wants to talk.",
  },
  {
    value: "NEGATIVE_REPLY",
    label: "Negative reply",
    short: "negative",
    blurb: "They said no. Accept it gracefully and stop selling.",
    hint: "Short, gracious reply to a prospect who declined. Do not pitch again.",
  },
];

export function kindMeta(kind: TemplateKind): KindMeta {
  return KINDS.find((k) => k.value === kind) ?? KINDS[0];
}
