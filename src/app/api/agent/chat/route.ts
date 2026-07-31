import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { AiUnavailable, completeJson, providerFor } from "@/lib/ai/provider";
import {
  DAYS,
  DEFAULT_SPEC,
  missingFields,
  TIMEZONES,
  type CampaignSpec,
} from "@/lib/agent/campaign-spec";
import { parsePrompt } from "@/lib/agent/parse-prompt";
import { badRequest, optionalString, readJson } from "@/lib/webhook";

export const maxDuration = 300;

/**
 * POST /api/agent/chat
 *
 * The campaign agent's single turn: read everything said so far, extract what
 * it can, and ask only for what's genuinely missing. When nothing is missing
 * it returns `ready: true` and the caller shows the review dialog.
 */

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Campaign name, or empty if not stated." },
    subject: { type: "string" },
    body: { type: "string", description: "80-140 words, {{lead.first_name}} tags." },
    preview: {
      type: "string",
      description:
        "Inbox preheader, under 90 characters. Must not repeat the subject or " +
        "the first body line. Empty if the request gives nothing to work with.",
    },
    cc: { type: "string", description: "Only if the user named cc addresses. Comma separated." },
    bcc: { type: "string", description: "Only if the user named bcc addresses. Comma separated." },
    follow_up_subject: { type: "string" },
    follow_up_body: { type: "string" },
    follow_up_wait_days: { type: "integer" },
    title_keywords: {
      type: "array",
      items: { type: "string" },
      description:
        "ONLY job titles or roles the user named explicitly. Empty array if " +
        "they did not name any — do not infer a buyer persona from the topic.",
    },
    days: {
      type: "array",
      items: { type: "string" },
      description: "Only if stated. Lowercase weekday names.",
    },
    timezone: { type: "string", description: "IANA zone, only if stated." },
    from_time: { type: "string", description: "HH:MM, only if stated." },
    to_time: { type: "string", description: "HH:MM, only if stated." },
    all_hours: { type: "boolean" },
    sharing: { type: "string", description: "everyone | only_me, only if stated." },
    leads_per_day: { type: "integer", description: "0 means no limit. Only if stated." },
    start_immediately: { type: "boolean" },
    service_line: {
      type: "string",
      description:
        "Which existing service line this matches, copied verbatim from the list, or empty if none fit.",
    },
    summary: { type: "string", description: "One sentence on what you understood." },
  },
  required: ["name", "subject", "body", "title_keywords", "summary"],
  additionalProperties: false,
} as const;

type Extracted = {
  name: string;
  subject: string;
  body: string;
  preview?: string;
  cc?: string;
  bcc?: string;
  follow_up_subject?: string;
  follow_up_body?: string;
  follow_up_wait_days?: number;
  title_keywords: string[];
  days?: string[];
  timezone?: string;
  from_time?: string;
  to_time?: string;
  all_hours?: boolean;
  sharing?: string;
  leads_per_day?: number;
  start_immediately?: boolean;
  service_line?: string;
  summary: string;
};

/**
 * Did the prompt actually mention who to target?
 *
 * A guard on the model rather than a replacement for it: the schema already
 * tells it to return nothing when no role is named, but a 3B-class model
 * infers a persona anyway. If none of these appear, any keywords it produced
 * were invented and are dropped.
 */
function statedTitles(prompt: string): boolean {
  return /\b(title|titles|role|roles|manager|managers|director|directors|head of|vp|c[fte]o|founder|owner|lead|leads? (?:of|in)|analyst|analysts|administrator|administrators|executive|executives|officer|officers|president|partner|controller|specialist|engineer|engineers|targeting|target)\b/i
    .test(prompt);
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

  // Whatever the user has already answered via the inline controls.
  const answered = (parsed.data.spec ?? {}) as Partial<CampaignSpec>;

  if (providerFor("agent") === "off") {
    return NextResponse.json(
      { error: "No AI configured. Set GEMINI_API_KEY, or AI_PROVIDER=ollama." },
      { status: 400 },
    );
  }

  const lines = (
    await prisma.template.findMany({
      where: { category: { not: null } },
      distinct: ["category"],
      select: { category: true },
    })
  )
    .map((c) => c.category!)
    .filter(Boolean);

  let ex: Extracted;
  try {
    ex = await completeJson<Extracted>({
      task: "agent",
      maxTokens: 2000,
      temperature: 0.3,
      schema: EXTRACT_SCHEMA as unknown as Record<string, unknown>,
      system: `You set up B2B cold-email campaigns for Sybrant, an IT and data services firm.

Existing service lines: ${lines.join("; ") || "none"}.

From the user's request, extract campaign settings and write the email copy.
Only fill scheduling fields (days, timezone, from_time, to_time, sharing,
leads_per_day, start_immediately) if the user actually stated them — leave them
out otherwise so they can be asked about. Never invent a sending schedule.

Copy rules: 80-140 words, one clear ask, plain text, no markdown, no
"I hope this finds you well".

Also write "preview": the inbox preheader shown after the subject line. Under 90
characters, and it must NOT repeat the subject or the opening line of the body —
those are already visible, so repeating them wastes the slot. Leave "cc" and
"bcc" empty unless the user actually named addresses; never invent a recipient.

Personalisation: the ONLY placeholder you may use is {{lead.first_name}}.
QuickMail does not recognise any other spelling — it would send the prospect
the literal text instead of their name. Do not use {{firstName}},
{{companyName}} or any company/title placeholder: there is no company data
behind them in this workspace, so they resolve to nothing. Refer to the
company in words if you need to. Do not write a sign-off name or signature;
QuickMail appends the sender's own signature.`,
      user: prompt,
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as AiUnavailable).message ?? "Agent failed" },
      { status: 502 },
    );
  }

  // Deterministic pass first — days, times, zones and counts are regex-exact
  // and small models drop them. Precedence: clicked > parsed > model.
  const literal = parsePrompt(prompt);

  // Merge: what the user clicked wins over what was parsed or inferred.
  /**
   * Did a human choose the follow-up cadence, or did the model invent one?
   *
   * Matters when a template is selected further down: the approved sequence
   * should replace copy the model made up, but never overwrite follow-ups the
   * user actually asked for. Counting `spec.followUps` cannot tell them apart.
   */
  const userChoseFollowUps =
    answered.followUps !== undefined || (literal.followUps ?? []).length > 0;

  const validDays = new Set<string>(DAYS);
  const inferredDays = (ex.days ?? []).map((d) => d.toLowerCase()).filter((d) => validDays.has(d));

  const spec: Partial<CampaignSpec> = {
    name: answered.name ?? (ex.name?.trim() || undefined),
    subject: answered.subject ?? ex.subject,
    body: answered.body ?? ex.body,
    preview: answered.preview ?? ex.preview ?? "",
    // Only ever what the user actually asked for — never invent a recipient.
    cc: answered.cc ?? ex.cc ?? "",
    bcc: answered.bcc ?? ex.bcc ?? "",
    followUps:
      answered.followUps ??
      // A delay parsed from the prompt sets the cadence; the model supplies
      // copy for the first follow-up if it wrote one.
      (literal.followUps ?? []).map((f, i) => ({
        waitDays: f.waitDays,
        subject: i === 0 ? (ex.follow_up_subject ?? "") : "",
        body: i === 0 ? (ex.follow_up_body ?? "") : "",
      })),
    startDate: answered.startDate ?? literal.startDate ?? null,
    startAt: answered.startAt ?? literal.startAt ?? null,
    endDate: answered.endDate ?? literal.endDate ?? null,
    endAt: answered.endAt ?? literal.endAt ?? null,
    /**
     * Only keywords the user actually asked for.
     *
     * The model would otherwise invent a buyer persona from the topic — a data
     * services campaign silently became "data manager, cto", quietly narrowing
     * 48k leads to a few hundred. A filter nobody asked for is worse than none,
     * so an unstated persona means no filter and the full list to choose from.
     */
    titleKeywords:
      answered.titleKeywords ?? (statedTitles(prompt) ? ex.title_keywords ?? [] : []),
    days:
      answered.days ??
      literal.days ??
      (inferredDays.length ? (inferredDays as CampaignSpec["days"]) : undefined),
    timezone:
      answered.timezone ??
      literal.timezone ??
      (ex.timezone && TIMEZONES.some((t) => t.value === ex.timezone)
        ? ex.timezone
        : undefined),
    fromTime: answered.fromTime ?? literal.fromTime ?? ex.from_time,
    toTime: answered.toTime ?? literal.toTime ?? ex.to_time,
    allHours: answered.allHours ?? literal.allHours ?? ex.all_hours,
    sharing:
      answered.sharing ??
      literal.sharing ??
      (ex.sharing === "everyone" || ex.sharing === "only_me" ? ex.sharing : undefined),
    leadsPerDay: answered.leadsPerDay ?? literal.leadsPerDay ?? ex.leads_per_day,
    startImmediately:
      answered.startImmediately ?? literal.startImmediately ?? ex.start_immediately ?? false,
  };

  // The model wrote a follow-up but nobody specified a delay — keep the copy
  // and use a sane default rather than silently dropping the email.
  if ((spec.followUps ?? []).length === 0 && ex.follow_up_body) {
    spec.followUps = [
      {
        waitDays: ex.follow_up_wait_days ?? 3,
        subject: ex.follow_up_subject ?? "",
        body: ex.follow_up_body,
      },
    ];
  }

  // An "all hours" answer satisfies the window question.
  if (spec.allHours) {
    spec.fromTime = spec.fromTime ?? "00:00";
    spec.toTime = spec.toTime ?? "23:59";
  }

  const questions = missingFields(spec);

  // Show how many leads each keyword actually reaches — a keyword matching
  // nobody is worse than no keyword at all.
  const keywordCounts = await Promise.all(
    (spec.titleKeywords ?? []).slice(0, 6).map(async (k) => ({
      keyword: k,
      count: await prisma.lead.count({
        where: {
          suppressed: false,
          status: { in: ["UNCONTACTED", "EMAILED"] },
          title: { contains: k },
        },
      }),
    })),
  );

  const matched = ex.service_line
    ? lines.find(
        (l) =>
          l.toLowerCase() === ex.service_line!.toLowerCase() ||
          l.toLowerCase().includes(ex.service_line!.toLowerCase()),
      )
    : undefined;

  /**
   * Decide the copy from the prompt: use the approved sequence when the request
   * matches an existing service line, otherwise use what the model just wrote.
   *
   * An approved template beats fresh generation when one fits — it is copy a
   * human already signed off, and it carries the real follow-up sequence rather
   * than a single email. Generation is the fallback for a subject we have no
   * template for, not the default.
   *
   * Anything the user has already edited still wins over both.
   */
  let copySource: "template" | "generated" = "generated";
  let usedTemplate: { id: string; name: string; steps: number } | null = null;

  if (matched && !answered.subject && !answered.body) {
    const sequence = await prisma.template.findMany({
      where: { category: matched },
      orderBy: { step: "asc" },
    });
    const first = sequence.find((t) => (t.step ?? 1) === 1) ?? sequence[0];

    if (first) {
      copySource = "template";
      usedTemplate = { id: first.id, name: first.name, steps: sequence.length };
      spec.subject = first.subject;
      spec.body = first.body;
      // Templates predate the preview column, so keep the model's preheader
      // when the template has none — an empty preview wastes the inbox slot.
      spec.preview = first.preview ?? spec.preview ?? "";

      // The rest of the sequence becomes the follow-ups, unless the prompt
      // already specified its own cadence.
      // Replaces the single follow-up the model may have invented above, but
      // yields to a cadence the user actually specified.
      const rest = sequence.filter((t) => t !== first);
      if (rest.length > 0 && !userChoseFollowUps) {
        spec.followUps = rest.map((t, i) => ({
          // The briefs are three touches roughly a week apart.
          waitDays: 3 + i * 2,
          subject: t.subject,
          body: t.body,
        }));
      }
    }
  }

  return NextResponse.json({
    ok: true,
    summary: ex.summary,
    suggestedCategory: matched ?? null,
    copySource,
    usedTemplate,
    spec: { ...DEFAULT_SPEC, ...spec },
    questions,
    ready: questions.length === 0,
    keywordCounts: keywordCounts.filter((k) => k.count > 0),
  });
}
