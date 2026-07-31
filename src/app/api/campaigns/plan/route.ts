import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { AiUnavailable, completeJson, providerFor } from "@/lib/ai/provider";
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
      description: "80-140 words, plain text, {{firstName}} / {{companyName}}.",
    },
    follow_up_subject: { type: "string" },
    follow_up_body: { type: "string", description: "60-100 words." },
    suggested_titles: {
      type: "array",
      items: { type: "string" },
      description: "Job-title keywords to filter leads by.",
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
};

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

  // Ground the model in what actually exists so it proposes real service lines.
  const [categories, mailboxes] = await Promise.all([
    prisma.template.findMany({
      where: { category: { not: null } },
      distinct: ["category"],
      select: { category: true },
    }),
    prisma.qmMailbox.findMany({ orderBy: { email: "asc" } }),
  ]);

  const lines = categories.map((c) => c.category!).filter(Boolean);

  let plan: Plan;
  try {
    plan = await completeJson<Plan>({
      task: "plan",
      maxTokens: 1600,
      temperature: 0.4,
      schema: PLAN_SCHEMA as unknown as Record<string, unknown>,
      system: `You plan B2B cold-email campaigns for Sybrant, an IT and data services firm.

Existing service lines: ${lines.join("; ") || "none yet"}.

Write copy that is 80-140 words, one clear ask, plain text, no markdown, no
"I hope this finds you well". Use {{firstName}} and {{companyName}} merge tags.
suggested_titles should be job-title keywords that match the buyer, lowercase.`,
      user: prompt,
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as AiUnavailable).message ?? "Planning failed" },
      { status: 502 },
    );
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
        ...(plan.follow_up_body
          ? [
              {
                id: "email2",
                label: `Email 2 — ${plan.follow_up_subject ?? "same thread"}`,
                hint: "Follow-up after 3 business days",
                recommended: true,
              },
            ]
          : []),
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
      options: mailboxes.map((m, i) => ({
        id: m.id,
        label: m.email,
        recommended: i === 0,
      })),
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

  return NextResponse.json({ ok: true, plan, questions });
}
