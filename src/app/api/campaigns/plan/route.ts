import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { AiUnavailable, completeJson, providerFor } from "@/lib/ai/provider";
import { bestMailbox, mailboxHealth } from "@/lib/mailbox-health";
import { badRequest, optionalString, readJson } from "@/lib/webhook";

export const maxDuration = 300;

/**
 * POST /api/campaigns/plan
 *
 * Turns a plain-language brief into a campaign plan plus a set of checkbox
 * questions. Nothing is created here — the answers feed the existing
 * /api/quickmail/campaigns/create endpoint, which keeps every write behind the
 * same dry-run and paused-draft guards.
 */

export type PlanOption = {
  id: string;
  label: string;
  hint?: string;
  recommended: boolean;
  /** Shown, but not choosable — see the mailbox question. */
  disabled?: boolean;
};

export type PlanQuestion = {
  id: string;
  question: string;
  multi: boolean;
  options: PlanOption[];
};

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    campaign_name: { type: "string" },
    service_line: {
      type: "string",
      description: "Which existing service line this fits, or 'new'.",
    },
    audience: {
      type: "string",
      description: "One sentence describing who this targets.",
    },
    subject: { type: "string" },
    body: {
      type: "string",
      description:
        "80-140 words, plain text. The only merge tag that works is " +
        "{{lead.first_name}}.",
    },
    follow_up_subject: { type: "string" },
    follow_up_body: { type: "string", description: "60-100 words." },
    suggested_titles: {
      type: "array",
      items: { type: "string" },
      description: "Job-title keywords to filter leads by.",
    },
    first_template: {
      type: "integer",
      description:
        "Number of the existing first-mail template that fits this brief, or " +
        "0 if none do and you wrote fresh copy instead.",
    },
    follow_up_template: {
      type: "integer",
      description:
        "Number of the existing follow-up template that fits, or 0 for none.",
    },
  },
  required: ["campaign_name", "audience", "subject", "body", "suggested_titles"],
  additionalProperties: false,
} as const;

type Plan = {
  campaign_name: string;
  service_line?: string;
  audience: string;
  subject: string;
  body: string;
  follow_up_subject?: string;
  follow_up_body?: string;
  suggested_titles: string[];
  first_template?: number;
  follow_up_template?: number;
};

/** A template offered to the wizard, trimmed to what the picker shows. */
export type TemplateChoice = {
  id: string;
  name: string;
  subject: string;
  body: string;
  category: string | null;
  step: number | null;
};

/**
 * How the catalogue is put to the model.
 *
 * Numbered, not by id: template ids are cuids, and a model asked to echo a
 * 25-character random string gets one character wrong often enough to matter.
 * A small integer it cannot mangle, resolved back here, is safer.
 */
function catalogue(rows: TemplateChoice[]): string {
  if (rows.length === 0) return "none";
  return rows
    .map(
      (t, i) =>
        `${i + 1}. [${t.category ?? "no service line"}] "${t.subject}" — ${t.name}`,
    )
    .join("\n");
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const prompt = optionalString(parsed.data.prompt);
  if (!prompt) return badRequest("`prompt` is required");

  if (providerFor("plan") === "off") {
    return NextResponse.json(
      {
        error:
          "No AI configured. Run Ollama (AI_PROVIDER=ollama) or set ANTHROPIC_API_KEY.",
      },
      { status: 400 },
    );
  }

  /**
   * Ground the model in what actually exists.
   *
   * Service lines so it proposes real ones, and the approved copy itself so it
   * can reuse a template instead of inventing a fourth version of an email the
   * team already signed off. Fresh copy is still allowed — but it should be a
   * decision, not the only option on the table.
   */
  const select = {
    id: true,
    name: true,
    subject: true,
    body: true,
    category: true,
    step: true,
  };

  const [categories, mailboxes, firstMails, followUps] = await Promise.all([
    prisma.template.findMany({
      where: { category: { not: null } },
      distinct: ["category"],
      select: { category: true },
    }),
    prisma.qmMailbox.findMany({ orderBy: { email: "asc" } }),
    prisma.template.findMany({
      where: { kind: "FIRST_MAIL" },
      orderBy: [{ category: "asc" }, { step: "asc" }],
      select,
    }),
    prisma.template.findMany({
      where: { kind: "FOLLOW_UP" },
      orderBy: [{ category: "asc" }, { step: "asc" }],
      select,
    }),
  ]);

  const lines = categories.map((c) => c.category!).filter(Boolean);
  const recommendedMailboxId = bestMailbox(mailboxes)?.id ?? null;

  let plan: Plan;
  try {
    plan = await completeJson<Plan>({
      task: "plan",
      maxTokens: 1600,
      temperature: 0.4,
      schema: PLAN_SCHEMA as unknown as Record<string, unknown>,
      system: `You plan B2B cold-email campaigns for Sybrant, an IT and data services firm.

Existing service lines: ${lines.join("; ") || "none yet"}.

APPROVED FIRST-MAIL TEMPLATES:
${catalogue(firstMails)}

APPROVED FOLLOW-UP TEMPLATES:
${catalogue(followUps)}

Prefer an existing template when one genuinely fits the brief — it has already
been approved. Set first_template and follow_up_template to its number. Only
when nothing fits, set the number to 0 and write fresh copy instead. Do not
force a match: a template about a different service line does not fit.

Fill subject/body and follow_up_subject/follow_up_body either way — with the
template's own wording when you picked one, or with your new copy when you did
not.

Write copy that is 80-140 words, one clear ask, plain text, no markdown, no
"I hope this finds you well". The ONLY merge tag that works is
{{lead.first_name}} — there is no company or title data behind any other tag,
so anything else sends as blank text. Name the company in words instead.
suggested_titles should be job-title keywords that match the buyer, lowercase.`,
      user: prompt,
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as AiUnavailable).message ?? "Planning failed" },
      { status: 502 },
    );
  }

  /**
   * Resolve the model's picks, and let the template win on wording.
   *
   * When it says it chose template 3, the copy that goes out has to be
   * template 3 verbatim — a model asked to repeat approved text paraphrases it,
   * and a campaign that claims to use signed-off copy while sending a
   * near-miss is worse than one that admits it wrote something new.
   */
  const pick = (rows: TemplateChoice[], n: number | undefined) =>
    typeof n === "number" && n >= 1 && n <= rows.length ? rows[n - 1] : null;

  const chosenFirst = pick(firstMails, plan.first_template);
  const chosenFollowUp = pick(followUps, plan.follow_up_template);

  if (chosenFirst) {
    plan.subject = chosenFirst.subject;
    plan.body = chosenFirst.body;
  }
  if (chosenFollowUp) {
    plan.follow_up_subject = chosenFollowUp.subject;
    plan.follow_up_body = chosenFollowUp.body;
  }

  // Count how many leads each proposed title filter would actually reach —
  // a suggestion with 0 matches is worse than useless.
  const titleCounts = await Promise.all(
    (plan.suggested_titles ?? []).slice(0, 6).map(async (t) => ({
      id: t,
      label: t,
      hint: `${(
        await prisma.lead.count({
          where: {
            suppressed: false,
            status: { in: ["UNCONTACTED", "EMAILED"] },
            title: { contains: t },
          },
        })
      ).toLocaleString()} leads`,
      recommended: true,
    })),
  );

  const usable = titleCounts.filter((t) => !t.hint.startsWith("0 "));

  const questions: PlanQuestion[] = [
    {
      id: "steps",
      question: "Which emails should the sequence include?",
      multi: true,
      options: [
        {
          id: "email1",
          label: `Email 1 — ${plan.subject}`,
          hint: "First touch",
          recommended: true,
        },
        /**
         * Always offered, even when the planner wrote nothing for it.
         *
         * Hiding it made a two-email sequence look impossible rather than
         * merely unwritten, and the follow-up is where most replies come from.
         * The builder now lets a template be picked or drafted for it, so an
         * empty body at this point is a starting state, not a dead end.
         */
        {
          id: "email2",
          label: `Email 2 — ${plan.follow_up_subject ?? "follow-up"}`,
          hint: plan.follow_up_body
            ? "Follow-up after 3 business days"
            : "Follow-up after 3 business days — pick a template or draft it below",
          recommended: Boolean(plan.follow_up_body),
        },
      ],
    },
    {
      id: "titles",
      question: "Filter leads by job title?",
      multi: true,
      options:
        usable.length > 0
          ? usable
          : [
              {
                id: "__none__",
                label: "No title filter",
                hint: "Use all contactable leads",
                recommended: true,
              },
            ],
    },
    {
      id: "mailboxes",
      question: "Which mailboxes should send it?",
      multi: true,
      /**
       * Recommending index 0 meant recommending whichever address sorted
       * first, which is as likely to be a sender QuickMail has judged unfit as
       * a good one. The verdict decides now: unusable senders are listed with
       * their reason but cannot be chosen, and the first healthy one is
       * pre-ticked.
       */
      options: mailboxes.map((m) => {
        const v = mailboxHealth(m);
        return {
          id: m.id,
          label: m.email,
          hint: v.reason ?? undefined,
          disabled: !v.usable,
          recommended: v.usable && m.id === recommendedMailboxId,
        };
      }),
    },
    {
      id: "safety",
      question: "Safety options",
      multi: true,
      options: [
        {
          id: "exclude_bounced",
          label: "Exclude previously bounced and suppressed leads",
          hint: "Strongly recommended — 7.8% of your sends bounce",
          recommended: true,
        },
        {
          id: "dry_run",
          label: "Preview only — don't write to QuickMail yet",
          hint: "Shows the exact mutations first",
          recommended: true,
        },
      ],
    },
  ];

  /**
   * The catalogues go back with the plan so the wizard can offer alternatives
   * without a second round trip — the model's pick is a starting point, and
   * swapping it should be one click rather than a re-plan.
   */
  return NextResponse.json({
    ok: true,
    plan,
    questions,
    templates: {
      first: firstMails,
      follow_up: followUps,
      chosen_first_id: chosenFirst?.id ?? null,
      chosen_follow_up_id: chosenFollowUp?.id ?? null,
    },
  });
}
