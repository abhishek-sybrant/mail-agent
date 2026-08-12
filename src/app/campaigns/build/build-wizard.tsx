"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Check,
  ExternalLink,
  FileText,
  Loader2,
  Rocket,
  Sparkles,
  TriangleAlert,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { fetchErrorMessage } from "@/lib/fetch-error";

type Option = { id: string; label: string; hint?: string; recommended: boolean };
type Question = {
  id: string;
  question: string;
  multi: boolean;
  options: Option[];
};
type Plan = {
  campaign_name: string;
  audience: string;
  subject: string;
  body: string;
  follow_up_subject?: string;
  follow_up_body?: string;
};

type TemplateChoice = {
  id: string;
  name: string;
  subject: string;
  body: string;
  category: string | null;
  step: number | null;
};

type TemplateSets = {
  first: TemplateChoice[];
  follow_up: TemplateChoice[];
  chosen_first_id: string | null;
  chosen_follow_up_id: string | null;
};

/**
 * One email in the sequence: pick approved copy, or have the AI write some.
 *
 * The same control for the first mail and every follow-up. Before this the
 * opener could be re-drafted and the follow-up could only be typed over by
 * hand, which quietly pushed people towards sending whatever the planner
 * happened to produce for it.
 */
function StepEditor({
  label,
  hint,
  kind,
  templates,
  chosenId,
  subject,
  body,
  rows,
  prompt,
  onPick,
  onSubject,
  onBody,
}: {
  label: string;
  hint: string;
  kind: "FIRST_MAIL" | "FOLLOW_UP";
  templates: TemplateChoice[];
  chosenId: string | null;
  subject: string;
  body: string;
  rows: number;
  prompt: string;
  onPick: (t: TemplateChoice | null) => void;
  onSubject: (value: string) => void;
  onBody: (value: string) => void;
}) {
  const [drafting, setDrafting] = useState(false);

  async function draft() {
    setDrafting(true);
    try {
      const res = await fetch("/api/templates/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Not saved — this is campaign copy, not a template for the library.
        body: JSON.stringify({ prompt, kind }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Drafting failed");
      onPick(null);
      onSubject(json.template.subject);
      onBody(json.template.body);
      toast.success(`${label} redrafted`);
    } catch (error) {
      toast.error(fetchErrorMessage(error, "Drafting failed"));
    } finally {
      setDrafting(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-sm font-medium">{label}</p>
        {chosenId ? (
          <Badge variant="secondary" className="gap-1">
            <FileText className="size-3" />
            approved template
          </Badge>
        ) : (
          <Badge variant="outline">written by AI</Badge>
        )}
      </div>
      <p className="text-muted-foreground text-xs">{hint}</p>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={chosenId ?? ""}
          onChange={(e) => {
            const t = templates.find((x) => x.id === e.target.value) ?? null;
            onPick(t);
            if (t) {
              onSubject(t.subject);
              onBody(t.body);
            }
          }}
          className="border-input bg-background h-9 min-w-0 flex-1 rounded-md border px-2 text-sm"
        >
          <option value="">Fresh copy (not from a template)</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.category ? `${t.category} — ` : ""}
              {t.subject}
            </option>
          ))}
        </select>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={draft}
          disabled={drafting || !prompt.trim()}
          title={prompt.trim() ? undefined : "Describe the campaign first"}
        >
          {drafting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Wand2 className="size-4" />
          )}
          Draft with AI
        </Button>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Subject</Label>
        <Input value={subject} onChange={(e) => onSubject(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Body</Label>
        <Textarea
          rows={rows}
          className="font-mono text-sm"
          value={body}
          onChange={(e) => onBody(e.target.value)}
        />
      </div>
    </div>
  );
}

const EXAMPLES = [
  "Cold campaign to heads of lease administration at US commercial real estate firms. Angle: manual abstraction eats 20 hours a week. Ask for a 15-minute call.",
  "Target CFOs and finance directors in banking about automating financial data parsing from PDFs and statements.",
  "Reach operations leaders at retail and ecommerce companies about AI voice agents for customer support.",
];

export function BuildWizard({
  aiReady,
  aiDetail,
  aiModel,
}: {
  aiReady: boolean;
  aiDetail: string;
  aiModel: string | null;
}) {
  const router = useRouter();

  const [prompt, setPrompt] = useState("");
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [templates, setTemplates] = useState<TemplateSets | null>(null);
  const [firstId, setFirstId] = useState<string | null>(null);
  const [followUpId, setFollowUpId] = useState<string | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Record<string, Set<string>>>({});
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  async function makePlan() {
    if (!prompt.trim()) {
      toast.error("Describe the campaign first");
      return;
    }
    setPlanning(true);
    setResult(null);
    try {
      const res = await fetch("/api/campaigns/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Planning failed");

      setPlan(json.plan);
      setQuestions(json.questions);
      setTemplates(json.templates ?? null);
      setFirstId(json.templates?.chosen_first_id ?? null);
      setFollowUpId(json.templates?.chosen_follow_up_id ?? null);
      // Pre-tick whatever the planner recommended.
      const seeded: Record<string, Set<string>> = {};
      for (const q of json.questions as Question[]) {
        seeded[q.id] = new Set(
          q.options.filter((o) => o.recommended).map((o) => o.id),
        );
      }
      setAnswers(seeded);
      toast.success("Plan ready — review the questions below");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed");
    } finally {
      setPlanning(false);
    }
  }

  function toggle(qid: string, oid: string, multi: boolean) {
    setAnswers((prev) => {
      const cur = new Set(prev[qid] ?? []);
      if (!multi) {
        return { ...prev, [qid]: new Set([oid]) };
      }
      if (cur.has(oid)) cur.delete(oid);
      else cur.add(oid);
      return { ...prev, [qid]: cur };
    });
  }

  const picked = (qid: string) => [...(answers[qid] ?? [])];

  async function create() {
    if (!plan) return;

    const mailboxIds = picked("mailboxes");
    if (mailboxIds.length === 0) {
      toast.error("Pick at least one sending mailbox");
      return;
    }

    const steps = picked("steps");
    const titles = picked("titles").filter((t) => t !== "__none__");
    const safety = picked("safety");
    const dryRun = safety.includes("dry_run");

    setCreating(true);
    setResult(null);
    try {
      // Resolve the title filter into concrete lead IDs first, so the user can
      // see exactly how many people this reaches.
      const leadRes = await fetch("/api/leads/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          titles,
          exclude_suppressed: safety.includes("exclude_bounced"),
          limit: 500,
        }),
      });
      const leadJson = await leadRes.json();
      if (!leadRes.ok) throw new Error(leadJson.error ?? "Lead lookup failed");

      const res = await fetch("/api/quickmail/campaigns/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-dry-run": String(dryRun),
        },
        body: JSON.stringify({
          name: plan.campaign_name,
          subject: plan.subject,
          body: plan.body,
          email_account_ids: mailboxIds,
          lead_ids: leadJson.lead_ids ?? [],
          follow_ups:
            steps.includes("email2") && plan.follow_up_body
              ? [
                  {
                    wait_days: 3,
                    subject: plan.follow_up_subject ?? "",
                    body: plan.follow_up_body,
                  },
                ]
              : [],
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Creation failed");

      setResult({ matched_leads: leadJson.count, ...json });
      toast.success(
        json.dryRun
          ? `Preview ready — ${leadJson.count} leads matched, nothing written`
          : `Created in QuickMail · ${json.leads_enrolled} leads enrolled`,
      );
      if (!json.dryRun) router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      {!aiReady && (
        <Card className="border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30">
          <CardContent className="flex items-start gap-3 pt-6">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <div className="text-sm text-amber-800 dark:text-amber-300">
              <p className="font-medium">AI not available</p>
              <p className="mt-1 text-xs">{aiDetail}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 1 — the prompt */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="text-primary size-4" />
            Describe the campaign
          </CardTitle>
          <p className="text-muted-foreground text-xs">
            Say who you want to reach and what the angle is.
            {aiModel && ` Planned locally by ${aiModel}.`}
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            rows={4}
            value={prompt}
            placeholder={EXAMPLES[0]}
            onChange={(e) => setPrompt(e.target.value)}
          />

          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((ex, i) => (
              <Button
                key={i}
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setPrompt(ex)}
              >
                Example {i + 1}
              </Button>
            ))}
          </div>

          <Button onClick={makePlan} disabled={planning || !aiReady}>
            {planning ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Wand2 className="size-4" />
            )}
            {planning ? "Thinking — local models take a moment…" : "Plan it"}
          </Button>
        </CardContent>
      </Card>

      {/* Step 2 — the questions */}
      {plan && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Proposed campaign</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Name</Label>
                <Input
                  value={plan.campaign_name}
                  onChange={(e) =>
                    setPlan({ ...plan, campaign_name: e.target.value })
                  }
                />
              </div>
              <p className="text-muted-foreground text-xs">{plan.audience}</p>

              <Separator />

              <StepEditor
                label="Email 1 — first mail"
                hint="The opener. Goes to everyone in the list."
                kind="FIRST_MAIL"
                templates={templates?.first ?? []}
                chosenId={firstId}
                subject={plan.subject}
                body={plan.body}
                rows={10}
                prompt={prompt}
                onPick={(t) => setFirstId(t?.id ?? null)}
                onSubject={(v) => setPlan({ ...plan, subject: v })}
                onBody={(v) => setPlan({ ...plan, body: v })}
              />

              <StepEditor
                label="Email 2 — follow-up"
                hint="Sent 3 business days later, in the same thread, to anyone who has not replied."
                kind="FOLLOW_UP"
                templates={templates?.follow_up ?? []}
                chosenId={followUpId}
                subject={plan.follow_up_subject ?? ""}
                body={plan.follow_up_body ?? ""}
                rows={6}
                prompt={prompt}
                onPick={(t) => setFollowUpId(t?.id ?? null)}
                onSubject={(v) => setPlan({ ...plan, follow_up_subject: v })}
                onBody={(v) => setPlan({ ...plan, follow_up_body: v })}
              />

              {/**
               * The follow-up is always offered now, even when the planner
               * returned nothing for it. It used to be hidden unless the model
               * happened to write one, which made a two-email sequence look
               * impossible rather than simply unwritten.
               */}
            </CardContent>
          </Card>

          {questions.map((q) => (
            <Card key={q.id}>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">{q.question}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {q.options.map((o) => {
                  const on = answers[q.id]?.has(o.id) ?? false;
                  return (
                    <label
                      key={o.id}
                      className="hover:bg-accent flex cursor-pointer items-start gap-3 rounded-md px-2 py-2 text-sm"
                    >
                      <input
                        type={q.multi ? "checkbox" : "radio"}
                        name={q.id}
                        className="mt-0.5 size-4 shrink-0"
                        checked={on}
                        onChange={() => toggle(q.id, o.id, q.multi)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block break-words">{o.label}</span>
                        {o.hint && (
                          <span className="text-muted-foreground text-xs">
                            {o.hint}
                          </span>
                        )}
                      </span>
                      {o.recommended && (
                        <Badge variant="secondary" className="shrink-0 text-xs">
                          suggested
                        </Badge>
                      )}
                    </label>
                  );
                })}
              </CardContent>
            </Card>
          ))}

          <Card>
            <CardContent className="flex flex-wrap items-center gap-3 pt-6">
              <Button onClick={create} disabled={creating}>
                {creating ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Rocket className="size-4" />
                )}
                {picked("safety").includes("dry_run")
                  ? "Preview campaign"
                  : "Create in QuickMail"}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setPlan(null);
                  setQuestions([]);
                  setResult(null);
                }}
              >
                <ArrowLeft className="size-4" />
                Start over
              </Button>
              <p className="text-muted-foreground text-xs">
                Campaigns are always created paused with draft steps.
              </p>
            </CardContent>
          </Card>
        </>
      )}

      {result != null && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Check className="size-4" />
              Result
              {result.dryRun === false && (
                <Badge className="border-transparent bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                  Live
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {typeof (result.campaign as { appUrl?: string })?.appUrl ===
              "string" && (
              <a
                href={(result.campaign as { appUrl: string }).appUrl}
                target="_blank"
                rel="noreferrer"
                className="text-primary flex items-center gap-1 text-xs underline"
              >
                Open in QuickMail <ExternalLink className="size-3" />
              </a>
            )}
            <pre className="bg-muted max-h-72 overflow-auto rounded-md p-3 text-xs">
              {JSON.stringify(result, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
