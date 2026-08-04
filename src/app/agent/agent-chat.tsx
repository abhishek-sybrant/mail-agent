"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bot,
  Check,
  ExternalLink,
  History,
  Loader2,
  Pencil,
  Plus,
  Rocket,
  SendHorizonal,
  Sparkles,
  TriangleAlert,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LeadPicker, type PickedLeads } from "./lead-picker";
import {
  DAYS,
  missingFields,
  TIMEZONES,
  type AgentQuestion,
  type CampaignSpec,
  type FollowUp,
} from "@/lib/agent/campaign-spec";
import { fmtDateTime, fmtNumber } from "@/lib/format";

/**
 * Parses a response without assuming it contains JSON.
 *
 * `res.json()` on an empty body throws "Unexpected end of JSON input", which
 * says nothing about what went wrong. A route that crashes before responding —
 * a stale Prisma client after a migration is the usual cause in dev — returns
 * exactly that. Reading the text first means the real status and any HTML error
 * page reach the user instead.
 */
// `any` deliberately: this stands in for res.json(), which is also `any`, and
// narrowing it here would just push casts onto every call site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJsonSafe(res: Response): Promise<any> {
  const raw = await res.text();
  if (raw.trim() === "") {
    throw new Error(
      `The server returned an empty ${res.status} response. If a migration just ` +
        `ran, restart the dev server — its Prisma client is stale.`,
    );
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const title = raw.match(/<title>([^<]+)<\/title>/)?.[1];
    throw new Error(
      `The server returned ${res.status} but not JSON${title ? `: ${title.trim()}` : ""}`,
    );
  }
}

type Msg =
  | { role: "user"; text: string }
  | { role: "agent"; text: string; questions?: AgentQuestion[] };

type SavedConvo = {
  id: string;
  title: string;
  updatedAt: string;
  messages: Msg[];
  spec: Partial<CampaignSpec>;
};

const EXAMPLES = [
  "Start a lease abstraction campaign",
  "Run an AI voice agents campaign to retail ops leaders, Mon–Fri 9-5 Eastern, 50 leads a day",
];

export type TemplateOption = {
  id: string;
  name: string;
  subject: string;
  body: string;
  category: string | null;
  step: number | null;
};

export function AgentChat({
  aiReady,
  aiDetail,
  aiModel,
  mailboxes,
  templates,
}: {
  aiReady: boolean;
  aiDetail: string;
  aiModel: string | null;
  mailboxes: { id: string; email: string; assignable: boolean | null }[];
  templates: TemplateOption[];
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: "agent",
      text: "Tell me what campaign to start. If you leave details out I'll ask; if you give me everything, I'll go straight to the summary.",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  const [spec, setSpec] = useState<Partial<CampaignSpec>>({});
  const [prompt, setPrompt] = useState("");
  const [ready, setReady] = useState(false);
  const [suggested, setSuggested] = useState<string | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  const [showLeads, setShowLeads] = useState(false);
  const [picked, setPicked] = useState<PickedLeads | null>(null);
  // Default to a mailbox QuickMail is known to accept, not merely the first.
  const [mailboxSel, setMailboxSel] = useState<Set<string>>(() => {
    const good = mailboxes.find((m) => m.assignable !== false);
    return new Set(good ? [good.id] : []);
  });
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  /** Arms the second click on a live create. */
  const [confirmLive, setConfirmLive] = useState(false);

  /**
   * Chat history. `convoId` is generated client-side and reused for every save
   * of this chat, so a conversation is one growing row rather than one per turn.
   */
  const [convoId, setConvoId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<SavedConvo[]>([]);

  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  /**
   * Persist after each exchange.
   *
   * Keyed off `messages` rather than called from `ask()` so a save also covers
   * turns that failed — a chat that errored is often the one worth revisiting.
   * The opening greeting alone is not worth a row.
   */
  useEffect(() => {
    if (messages.length < 2) return;
    const firstUser = messages.find((m) => m.role === "user");
    if (!firstUser) return;

    const controller = new AbortController();
    void fetch("/api/agent/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: convoId,
        title: firstUser.text.slice(0, 120),
        messages,
        spec,
      }),
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j?.id && !convoId) setConvoId(j.id);
      })
      .catch(() => undefined); // history is a convenience, never block the chat
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  async function openHistory() {
    setShowHistory(true);
    try {
      const res = await fetch("/api/agent/conversations");
      const json = await readJsonSafe(res);
      setHistory(json.conversations ?? []);
    } catch {
      toast.error("Could not load history");
    }
  }

  /** Reopens a past chat in place, replacing what is on screen. */
  function restore(c: SavedConvo) {
    setConvoId(c.id);
    setMessages(c.messages);
    setSpec(c.spec ?? {});
    const firstUser = c.messages.find((m) => m.role === "user");
    setPrompt(firstUser?.text ?? "");
    // Whether it is finished is derived from the restored spec, not remembered.
    setReady(missingFields(c.spec ?? {}).length === 0);
    setResult(null);
    setPicked(null);
    setShowSummary(false);
    setShowHistory(false);
  }

  /** Clears the board for a new chat without touching what is saved. */
  function newChat() {
    setConvoId(null);
    setMessages([
      {
        role: "agent",
        text: "Tell me what campaign to start. If you leave details out I'll ask; if you give me everything, I'll go straight to the summary.",
      },
    ]);
    setSpec({});
    setPrompt("");
    setReady(false);
    setResult(null);
    setPicked(null);
    setShowSummary(false);
    setShowHistory(false);
  }

  async function ask(text: string, mergedSpec: Partial<CampaignSpec>) {
    setBusy(true);
    try {
      const res = await fetch("/api/agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text, spec: mergedSpec }),
      });
      const json = await readJsonSafe(res);
      if (!res.ok) throw new Error(json.error ?? "Agent failed");

      setSpec(json.spec);
      setReady(json.ready);
      setSuggested(json.suggestedCategory ?? null);

      const counts = (json.keywordCounts ?? []) as {
        keyword: string;
        count: number;
      }[];

      // Say where the copy came from. Silently swapping in a stored template
      // would be surprising — and knowing it was generated is the cue to read
      // it more carefully than approved copy.
      const tpl = json.usedTemplate as
        | { name: string; steps: number }
        | null
        | undefined;
      const copyNote = tpl
        ? ` Using your approved "${json.suggestedCategory}" copy — ${tpl.steps} email${
            tpl.steps === 1 ? "" : "s"
          } from "${tpl.name}".`
        : json.copySource === "generated"
          ? " No approved template matched, so I wrote fresh copy — worth a read."
          : "";

      setMessages((m) => [
        ...m,
        {
          role: "agent",
          text: json.ready
            ? `${json.summary} I have everything I need.${copyNote}`
            : `${json.summary}${copyNote}${
                counts.length
                  ? ` Matching leads: ${counts
                      .map((c) => `${c.keyword} (${fmtNumber(c.count)})`)
                      .join(", ")}.`
                  : ""
              } A few things to confirm:`,
          questions: json.ready ? undefined : json.questions,
        },
      ]);

      if (json.ready) setShowSummary(true);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Failed";
      setMessages((m) => [...m, { role: "agent", text: `⚠ ${msg}` }]);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  function send() {
    const text = input.trim();
    if (!text) return;
    setMessages((m) => [...m, { role: "user", text }]);
    setInput("");
    setPrompt(text);
    void ask(text, spec);
  }

  /** Applies the inline answers and re-asks; the server decides what's left. */
  function submitAnswers(patch: Partial<CampaignSpec>) {
    const merged = { ...spec, ...patch };
    setSpec(merged);
    setMessages((m) => [...m, { role: "user", text: describe(patch) }]);
    void ask(prompt, merged);
  }

  // A scheduled campaign is always held paused, so "live" isn't reachable.
  const liveMode = spec.launchMode === "live" && !spec.startDate;

  async function create(dryRun: boolean) {
    if (!picked || picked.ids.length === 0) {
      toast.error("Choose the leads first");
      return;
    }
    if (mailboxSel.size === 0) {
      toast.error("Pick at least one sending mailbox");
      return;
    }

    setCreating(true);
    setConfirmLive(false);
    setResult(null);
    try {
      const res = await fetch("/api/quickmail/campaigns/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-dry-run": String(dryRun),
        },
        body: JSON.stringify({
          name: spec.name,
          subject: spec.subject,
          body: spec.body,
          preview: spec.preview ?? "",
          cc: spec.cc ?? "",
          bcc: spec.bcc ?? "",
          email_account_ids: [...mailboxSel],
          lead_ids: picked.ids,
          schedule: {
            days: spec.days,
            timezone: spec.timezone,
            from: spec.fromTime,
            to: spec.toTime,
            all_hours: spec.allHours,
            start_date: spec.startDate,
            start_at: spec.startAt,
            end_date: spec.endDate,
            end_at: spec.endAt,
          },
          launch_mode: spec.launchMode ?? "ready",
          // Drives the QuickMail trigger the UI automation creates.
          trigger_at: spec.triggerAt ?? spec.fromTime ?? "09:00",
          // Not settable through the API — passed so the response can tell the
          // user the exact number to enter as the QuickMail trigger.
          leads_per_day: spec.leadsPerDay ?? null,
          follow_ups: (spec.followUps ?? [])
            .filter((f) => f.body.trim())
            .map((f) => ({
              wait_days: f.waitDays,
              subject: f.subject,
              body: f.body,
            })),
        }),
      });
      const json = await readJsonSafe(res);
      if (!res.ok) throw new Error(json.error ?? "Failed");

      setResult(json);
      const warnings: string[] = json.warnings ?? [];
      if (warnings.length > 0) {
        // Every warning matters — a swallowed one hid a campaign that could
        // never send. They also stay visible in `result` below.
        for (const w of warnings) toast.warning(w, { duration: 15000 });
      } else {
        toast.success(
          json.dryRun
            ? "Preview only — nothing written to QuickMail"
            : `Created · ${json.leads_enrolled} leads enrolled`,
        );
      }
      if (!json.dryRun) router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex h-[calc(100vh-8.5rem)] flex-col">
      {!aiReady && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50/60 p-3 text-xs dark:border-amber-900 dark:bg-amber-950/30">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <p className="text-amber-800 dark:text-amber-300">{aiDetail}</p>
        </div>
      )}

      <div className="mb-2 flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-xs"
          onClick={openHistory}
        >
          <History className="size-3.5" />
          History
        </Button>
        {messages.length > 1 && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 text-xs"
            onClick={newChat}
          >
            <Plus className="size-3.5" />
            New chat
          </Button>
        )}
        {/*
          The summary is dismissable, so it needs a way back — otherwise closing
          it strands a finished campaign with no route to the create button.
        */}
        {ready && !showSummary && (
          <Button
            size="sm"
            className="ml-auto h-7 gap-1.5 text-xs"
            onClick={() => setShowSummary(true)}
          >
            <Sparkles className="size-3.5" />
            Review campaign
          </Button>
        )}
      </div>

      {/* Conversation */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {messages.map((m, i) => (
          <div key={i}>
            {m.role === "user" ? (
              <div className="flex justify-end">
                <div className="bg-primary text-primary-foreground max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap">
                  {m.text}
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <Bot className="text-primary mt-1 size-4 shrink-0" />
                <div className="min-w-0 flex-1 space-y-3">
                  <p className="text-sm whitespace-pre-wrap">{m.text}</p>
                  {m.questions && m.questions.length > 0 && (
                    <QuestionBlock
                      questions={m.questions}
                      onSubmit={submitAnswers}
                      disabled={busy || i !== messages.length - 1}
                    />
                  )}
                </div>
              </div>
            )}
          </div>
        ))}

        {busy && (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" />
            Thinking…
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Composer */}
      <div className="pt-3">
        {messages.length === 1 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {EXAMPLES.map((ex) => (
              <Button
                key={ex}
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setInput(ex)}
              >
                {ex.length > 46 ? ex.slice(0, 46) + "…" : ex}
              </Button>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <Textarea
            rows={2}
            value={input}
            disabled={busy || !aiReady}
            placeholder="e.g. Start a lease abstraction campaign"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <Button onClick={send} disabled={busy || !aiReady || !input.trim()}>
            <SendHorizonal className="size-4" />
          </Button>
        </div>
        <p className="text-muted-foreground mt-1.5 text-xs">
          {aiModel ? `Powered by ${aiModel}. ` : ""}Enter sends, Shift+Enter for
          a new line.
        </p>
      </div>

      {/* Summary "popup" */}
      {showHistory && (
        <div className="bg-background/80 fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-6 backdrop-blur-sm">
          <Card className="my-auto w-full max-w-xl">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <History className="text-primary size-4" />
                Previous chats
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Close history"
                  className="ml-auto size-7"
                  onClick={() => setShowHistory(false)}
                >
                  <X className="size-4" />
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {history.length === 0 && (
                <p className="text-muted-foreground text-sm">
                  No saved chats yet. They appear here once you send a prompt.
                </p>
              )}
              {history.map((c) => (
                <div
                  key={c.id}
                  className="hover:bg-accent flex items-start gap-2 rounded-md border p-2.5"
                >
                  <button
                    onClick={() => restore(c)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <p className="truncate text-sm font-medium">{c.title}</p>
                    <p className="text-muted-foreground text-xs">
                      {fmtDateTime(c.updatedAt)} ·{" "}
                      {c.messages.length} message
                      {c.messages.length === 1 ? "" : "s"}
                      {c.spec?.name ? ` · ${c.spec.name}` : ""}
                    </p>
                  </button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Delete this chat"
                    className="size-7 shrink-0"
                    onClick={async () => {
                      await fetch(`/api/agent/conversations?id=${c.id}`, {
                        method: "DELETE",
                      });
                      setHistory((h) => h.filter((x) => x.id !== c.id));
                      if (convoId === c.id) setConvoId(null);
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      )}

      {showSummary && ready && (
        <div className="bg-background/80 fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-6 backdrop-blur-sm">
          <Card className="my-auto w-full max-w-2xl">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="text-primary size-4" />
                Campaign ready
                {/*
                  Dismissing must not discard anything — `spec` lives in the
                  parent, so closing returns to the chat with every edit intact
                  and the summary reopens from the same state.
                */}
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Close and go back to the chat"
                  className="ml-auto size-7"
                  onClick={() => setShowSummary(false)}
                >
                  <X className="size-4" />
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <SummaryRows spec={spec} setSpec={setSpec} />

              <Separator />

              <DateFields spec={spec} setSpec={setSpec} />

              <Separator />

              <CopyEditor
                spec={spec}
                setSpec={setSpec}
                templates={templates}
                suggested={suggested}
              />

              <Separator />

              <div className="space-y-1.5">
                <Label className="text-xs">
                  Sending mailboxes ({mailboxSel.size})
                </Label>
                <div className="max-h-28 space-y-0.5 overflow-y-auto rounded-md border p-2">
                  {mailboxes.map((m) => (
                    <label
                      key={m.id}
                      className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs"
                    >
                      <input
                        type="checkbox"
                        className="size-3.5"
                        checked={mailboxSel.has(m.id)}
                        onChange={() =>
                          setMailboxSel((prev) => {
                            const n = new Set(prev);
                            if (n.has(m.id)) n.delete(m.id);
                            else n.add(m.id);
                            return n;
                          })
                        }
                      />
                      <span className="min-w-0 flex-1 truncate">{m.email}</span>
                      {m.assignable === false && (
                        <span
                          className="shrink-0 text-amber-600 dark:text-amber-400"
                          title="QuickMail rejected this mailbox last time it was attached"
                        >
                          ⚠
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              </div>

              <Separator />

              {picked ? (
                <p className="flex items-center gap-2 text-sm">
                  <Check className="size-4 text-emerald-600" />
                  {picked.label}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowLeads(true)}
                  >
                    Change
                  </Button>
                </p>
              ) : (
                <Button onClick={() => setShowLeads(true)}>
                  <Users className="size-4" />
                  Select leads
                </Button>
              )}

              {showLeads && (
                <div className="rounded-lg border p-3">
                  <LeadPicker
                    titleKeywords={spec.titleKeywords ?? []}
                    onPicked={(p) => {
                      setPicked(p);
                      setShowLeads(false);
                      toast.success(p.label);
                    }}
                  />
                </div>
              )}

              {result && (
                <>
                  <Separator />
                  {/*
                    The trigger cannot be set through the API — it is the one
                    step that must happen in QuickMail, and skipping it means
                    the campaign silently never sends. It gets its own block
                    rather than a toast, which would scroll away unread.
                  */}
                  {result.action_required != null && (
                    <div className="border-amber-500/50 bg-amber-500/10 space-y-1 rounded-md border p-3">
                      <p className="flex items-center gap-1.5 text-sm font-medium">
                        <TriangleAlert className="size-4 shrink-0 text-amber-600" />
                        {
                          (result.action_required as { what: string }).what
                        }
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {(result.action_required as { why: string }).why}
                      </p>
                      <ol className="ml-4 list-decimal space-y-0.5 text-xs">
                        {(
                          (result.action_required as { steps?: string[] })
                            .steps ?? []
                        ).map((s) => (
                          <li key={s}>{s}</li>
                        ))}
                      </ol>
                      {/^https?:/.test(
                        (result.action_required as { where: string }).where,
                      ) ? (
                        <a
                          href={(result.action_required as { where: string }).where}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary inline-flex items-center gap-1 text-xs font-medium underline"
                        >
                          Open the Automation tab
                          <ExternalLink className="size-3" />
                        </a>
                      ) : (
                        <p className="text-xs">
                          {(result.action_required as { where: string }).where}
                        </p>
                      )}
                    </div>
                  )}
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
                  <pre className="bg-muted max-h-56 overflow-auto rounded-md p-3 text-xs">
                    {JSON.stringify(result, null, 2)}
                  </pre>
                </>
              )}

              <Separator />

              <LaunchModePicker
                value={spec.launchMode ?? "ready"}
                scheduled={Boolean(spec.startDate)}
                onChange={(launchMode) => {
                  setConfirmLive(false);
                  setSpec({ ...spec, launchMode });
                }}
              />

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => create(true)}
                  disabled={creating || !picked}
                >
                  {creating ? <Loader2 className="size-4 animate-spin" /> : null}
                  Preview
                </Button>
                <Button
                  variant={liveMode ? "destructive" : "default"}
                  onClick={() => {
                    // Live is the one mode that can't be walked back, so it
                    // takes a second, deliberate click.
                    if (liveMode && !confirmLive) {
                      setConfirmLive(true);
                      return;
                    }
                    void create(false);
                  }}
                  disabled={creating || !picked}
                >
                  <Rocket className="size-4" />
                  {liveMode
                    ? confirmLive
                      ? "Click again to start sending"
                      : "Create and start sending"
                    : "Create in QuickMail"}
                </Button>
                <Button
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => setShowSummary(false)}
                >
                  Close
                </Button>
              </div>

              <p className="text-muted-foreground text-xs">
                {spec.startDate
                  ? `Held paused until ${spec.startDate} ${spec.startAt ?? ""}, then released automatically.`
                  : LAUNCH_MODES.find(
                      (m) => m.id === (spec.launchMode ?? "ready"),
                    )?.note}
              </p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

const LAUNCH_MODES = [
  {
    id: "paused" as const,
    label: "Paused",
    hint: "Draft steps",
    note: "Steps arrive as drafts — open each one in QuickMail and finalise it before anything can send.",
  },
  {
    id: "ready" as const,
    label: "Ready",
    hint: "One click to start",
    note: "Copy is finalised and the steps are paused. Unpause the campaign in QuickMail to start sending.",
  },
  {
    id: "live" as const,
    label: "Live",
    hint: "Sends immediately",
    note: "Sending starts on the next slot in the schedule. Nothing else will ask you to confirm.",
  },
];

/**
 * Chooses how finished the campaign is when it reaches QuickMail. A scheduled
 * campaign is always held paused, so the choice is disabled in that case
 * rather than shown as a promise the scheduler will override.
 */
function LaunchModePicker({
  value,
  scheduled,
  onChange,
}: {
  value: CampaignSpec["launchMode"];
  scheduled: boolean;
  onChange: (v: CampaignSpec["launchMode"]) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">On create</p>
      <div className="flex flex-wrap gap-2">
        {LAUNCH_MODES.map((m) => (
          <Button
            key={m.id}
            type="button"
            size="sm"
            variant={value === m.id ? "default" : "outline"}
            disabled={scheduled && m.id === "live"}
            onClick={() => onChange(m.id)}
            className="h-auto flex-col items-start gap-0 py-1.5"
          >
            <span className="text-xs font-medium">{m.label}</span>
            <span className="text-[10px] font-normal opacity-70">{m.hint}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}

/** Renders one batch of questions as inline controls. */
function QuestionBlock({
  questions,
  onSubmit,
  disabled,
}: {
  questions: AgentQuestion[];
  onSubmit: (patch: Partial<CampaignSpec>) => void;
  disabled: boolean;
}) {
  const [local, setLocal] = useState<Record<string, unknown>>({});

  function set(id: string, value: unknown) {
    setLocal((p) => ({ ...p, [id]: value }));
  }

  function submit() {
    const patch: Partial<CampaignSpec> = {};

    for (const q of questions) {
      const v = local[q.id];
      if (v === undefined) continue;

      if (q.id === "days") patch.days = v as CampaignSpec["days"];
      else if (q.id === "fromTime") {
        const s = String(v);
        if (s === "all") {
          patch.allHours = true;
          patch.fromTime = "00:00";
          patch.toTime = "23:59";
        } else {
          const [f, t] = s.split("-");
          patch.fromTime = f;
          patch.toTime = t;
        }
      } else if (q.id === "leadsPerDay") patch.leadsPerDay = Number(v);
      else if (q.id === "sharing") patch.sharing = v as CampaignSpec["sharing"];
      else if (q.id === "timezone") patch.timezone = String(v);
      else if (q.id === "name") patch.name = String(v);
    }
    onSubmit(patch);
  }

  const allAnswered = questions.every((q) => local[q.id] !== undefined);

  return (
    <div className="space-y-3 rounded-lg border p-3">
      {questions.map((q) => (
        <div key={q.id} className="space-y-1.5">
          <p className="text-sm font-medium">{q.question}</p>

          {q.id === "name" && (
            <Input
              placeholder="Lease Abstraction — August"
              disabled={disabled}
              onChange={(e) => set(q.id, e.target.value)}
            />
          )}

          {q.kind === "checkbox" && q.id === "days" && (
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map((d) => {
                const on = ((local.days as string[]) ?? []).includes(d);
                return (
                  <button
                    key={d}
                    disabled={disabled}
                    onClick={() => {
                      const cur = new Set((local.days as string[]) ?? []);
                      if (cur.has(d)) cur.delete(d);
                      else cur.add(d);
                      set("days", [...cur]);
                    }}
                    className={
                      "rounded-md border px-2.5 py-1 text-xs capitalize transition-colors " +
                      (on
                        ? "border-primary bg-primary/10 text-primary font-medium"
                        : "hover:bg-accent")
                    }
                  >
                    {d.slice(0, 3)}
                  </button>
                );
              })}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                disabled={disabled}
                onClick={() =>
                  set("days", ["monday", "tuesday", "wednesday", "thursday", "friday"])
                }
              >
                Weekdays
              </Button>
            </div>
          )}

          {q.kind === "select" && (
            <Select disabled={disabled} onValueChange={(v) => set(q.id, v)}>
              <SelectTrigger>
                <SelectValue placeholder="Choose…" />
              </SelectTrigger>
              <SelectContent>
                {(q.options ?? TIMEZONES.map((t) => ({ value: t.value, label: t.label }))).map(
                  (o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          )}

          {(q.kind === "radio" || q.kind === "time" || q.kind === "number") &&
            q.options &&
            q.options.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {q.options.map((o) => {
                  const on = local[q.id] === o.value;
                  return (
                    <button
                      key={o.value}
                      disabled={disabled}
                      onClick={() => set(q.id, o.value)}
                      title={o.hint}
                      className={
                        "rounded-md border px-2.5 py-1 text-xs transition-colors " +
                        (on
                          ? "border-primary bg-primary/10 text-primary font-medium"
                          : "hover:bg-accent")
                      }
                    >
                      {o.label}
                      {o.hint && (
                        <span className="text-muted-foreground ml-1.5">
                          {o.hint}
                        </span>
                      )}
                    </button>
                  );
                })}

                {/*
                  The presets cover the common cases but not "37 a day". A
                  free-text box beside them means an unusual number never
                  requires abandoning the chat and editing the summary instead.
                */}
                {q.kind === "number" && (
                  <Input
                    type="number"
                    min={0}
                    disabled={disabled}
                    placeholder="or type…"
                    className="h-7 w-24 text-xs"
                    value={
                      q.options.some((o) => o.value === local[q.id])
                        ? ""
                        : ((local[q.id] as string) ?? "")
                    }
                    onChange={(e) => set(q.id, e.target.value)}
                  />
                )}
              </div>
            )}
        </div>
      ))}

      <Button size="sm" onClick={submit} disabled={disabled || !allAnswered}>
        Confirm
      </Button>
    </div>
  );
}

/**
 * The campaign settings, read-only until you click Edit.
 *
 * Everything here came from a prompt, and a prompt is easy to get slightly
 * wrong — the wrong day, an off-by-one hour, a leads/day figure the model
 * inferred. Re-prompting to change one field is a poor trade, so each row is
 * directly editable in place.
 */
function SummaryRows({
  spec,
  setSpec,
}: {
  spec: Partial<CampaignSpec>;
  setSpec: (s: Partial<CampaignSpec>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const tz =
    TIMEZONES.find((t) => t.value === spec.timezone)?.label ?? spec.timezone;

  if (!editing) {
    return (
      <div className="space-y-2 text-sm">
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 gap-1 text-xs"
            onClick={() => setEditing(true)}
          >
            <Pencil className="size-3" />
            Edit
          </Button>
        </div>
        <Row label="Name" value={spec.name ?? "—"} />
        <Row
          label="Sharing"
          value={spec.sharing === "only_me" ? "Only me" : "Everyone"}
        />
        <Row
          label="Send days"
          value={(spec.days ?? []).map((d) => d.slice(0, 3)).join(", ") || "—"}
        />
        <Row label="Timezone" value={tz ?? "—"} />
        <Row
          label="Window"
          value={spec.allHours ? "All hours" : `${spec.fromTime} – ${spec.toTime}`}
        />
        <Row
          label="Leads / day"
          value={
            spec.leadsPerDay === 0 || spec.leadsPerDay == null
              ? "No limit"
              : String(spec.leadsPerDay)
          }
        />
        {(spec.followUps ?? []).length > 0 && (
          <Badge variant="secondary">
            {spec.followUps!.length} follow-up
            {spec.followUps!.length === 1 ? "" : "s"} ·{" "}
            {spec.followUps!.map((f) => `+${f.waitDays}d`).join(", ")}
          </Badge>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          className="h-6 gap-1 text-xs"
          onClick={() => setEditing(false)}
        >
          <Check className="size-3" />
          Done
        </Button>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Name</Label>
        <Input
          className="h-8 text-xs"
          value={spec.name ?? ""}
          onChange={(e) => setSpec({ ...spec, name: e.target.value })}
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Sharing</Label>
        <div className="flex gap-1.5">
          {(["everyone", "only_me"] as const).map((v) => (
            <Button
              key={v}
              size="sm"
              variant={spec.sharing === v ? "default" : "outline"}
              className="h-7 text-xs"
              onClick={() => setSpec({ ...spec, sharing: v })}
            >
              {v === "everyone" ? "Everyone" : "Only me"}
            </Button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Send days</Label>
        <div className="flex flex-wrap gap-1.5">
          {DAYS.map((d) => {
            const on = (spec.days ?? []).includes(d);
            return (
              <Button
                key={d}
                size="sm"
                variant={on ? "default" : "outline"}
                className="h-7 px-2 text-xs capitalize"
                onClick={() =>
                  setSpec({
                    ...spec,
                    days: on
                      ? (spec.days ?? []).filter((x) => x !== d)
                      : [...(spec.days ?? []), d],
                  })
                }
              >
                {d.slice(0, 3)}
              </Button>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Timezone</Label>
        <Select
          value={spec.timezone ?? ""}
          onValueChange={(v) => setSpec({ ...spec, timezone: v })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Choose…" />
          </SelectTrigger>
          <SelectContent>
            {TIMEZONES.map((t) => (
              <SelectItem key={t.value} value={t.value} className="text-xs">
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Window</Label>
        <div className="flex items-center gap-2">
          <Input
            type="time"
            className="h-8 w-28 text-xs"
            disabled={spec.allHours === true}
            value={spec.fromTime ?? "09:00"}
            onChange={(e) => setSpec({ ...spec, fromTime: e.target.value })}
          />
          <span className="text-muted-foreground text-xs">to</span>
          <Input
            type="time"
            className="h-8 w-28 text-xs"
            disabled={spec.allHours === true}
            value={spec.toTime ?? "17:00"}
            onChange={(e) => setSpec({ ...spec, toTime: e.target.value })}
          />
          <Button
            size="sm"
            variant={spec.allHours ? "default" : "outline"}
            className="h-7 text-xs"
            onClick={() => setSpec({ ...spec, allHours: !spec.allHours })}
          >
            All hours
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Leads / day</Label>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={0}
            className="h-8 w-24 text-xs"
            placeholder="0 = no limit"
            value={spec.leadsPerDay ?? ""}
            onChange={(e) =>
              setSpec({
                ...spec,
                leadsPerDay: e.target.value === "" ? null : Number(e.target.value),
              })
            }
          />
          <span className="text-muted-foreground text-xs">
            0 or blank means no limit
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Choose where the copy comes from: the AI draft, or one of the approved
 * templates imported from the campaign briefs. Either way it stays editable —
 * the model's wording is a starting point, not a decision.
 */
function CopyEditor({
  spec,
  setSpec,
  templates,
  suggested,
}: {
  spec: Partial<CampaignSpec>;
  setSpec: (s: Partial<CampaignSpec>) => void;
  templates: TemplateOption[];
  suggested: string | null;
}) {
  const [source, setSource] = useState<"ai" | "template">("ai");
  const [aiCopy, setAiCopy] = useState({
    subject: spec.subject,
    preview: spec.preview,
    body: spec.body,
  });
  const [picked, setPicked] = useState<string>("");

  /** The copy brief, separate from the campaign prompt. */
  const [brief, setBrief] = useState("");
  const [genBusy, setGenBusy] = useState(false);
  /** Subjects already shown and turned down, sent back to force divergence. */
  const [rejected, setRejected] = useState<string[]>([]);

  async function generate(reject: string[]) {
    setGenBusy(true);
    try {
      const res = await fetch("/api/templates/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: brief, reject }),
      });
      const json = await readJsonSafe(res);
      if (!res.ok) throw new Error(json.error ?? "Generation failed");

      const t = json.template as {
        subject: string;
        preview?: string;
        body: string;
      };
      setAiCopy({ subject: t.subject, preview: t.preview ?? "", body: t.body });
      setSpec({
        ...spec,
        subject: t.subject,
        preview: t.preview ?? "",
        body: t.body,
      });
      // Remember what was on screen so the next re-roll avoids it too.
      setRejected((r) => [...new Set([...r, t.subject])]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Generation failed");
    } finally {
      setGenBusy(false);
    }
  }

  const groups = new Map<string, TemplateOption[]>();
  for (const t of templates) {
    const c = t.category ?? "Other";
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c)!.push(t);
  }
  // Put the service line the agent matched at the top of the list.
  const ordered = [...groups.entries()].sort((a, b) =>
    a[0] === suggested ? -1 : b[0] === suggested ? 1 : a[0].localeCompare(b[0]),
  );

  /** Single email — replaces the first step only. */
  function applyTemplate(id: string) {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setPicked(id);
    setSpec({ ...spec, subject: t.subject, body: t.body });
  }

  /**
   * Load a whole service line: step 1 becomes the first email and the rest
   * become follow-ups. The briefs are already written as sequences — email 2
   * opens "Following up on my earlier note" — so loading one step in isolation
   * would ship copy that references an email that was never sent.
   */
  function applySequence(category: string) {
    const steps = (groups.get(category) ?? [])
      .slice()
      .sort((a, b) => (a.step ?? 99) - (b.step ?? 99));
    if (steps.length === 0) return;

    const [first, ...rest] = steps;
    setPicked(first.id);
    setSpec({
      ...spec,
      subject: first.subject,
      body: first.body,
      followUps: rest.map((t, i) => ({
        // Standard cold-outbound cadence: 3 days, then 5.
        waitDays: (spec.followUps ?? [])[i]?.waitDays ?? (i === 0 ? 3 : 5),
        subject: t.subject,
        body: t.body,
      })),
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">Email copy</p>
        <div className="ml-auto flex gap-1.5">
          <Button
            size="sm"
            variant={source === "ai" ? "default" : "outline"}
            onClick={() => {
              setSource("ai");
              setSpec({
                ...spec,
                subject: aiCopy.subject,
                preview: aiCopy.preview,
                body: aiCopy.body,
              });
            }}
          >
            <Sparkles className="size-3.5" />
            AI draft
          </Button>
          <Button
            size="sm"
            variant={source === "template" ? "default" : "outline"}
            onClick={() => setSource("template")}
            disabled={templates.length === 0}
          >
            Use a template ({templates.length})
          </Button>
        </div>
      </div>

      {/*
        Describe-and-generate, rather than only replaying the opener.
        The campaign prompt is about scheduling and targeting; the copy brief is
        a different thing ("demo offer to RE teams, lead on turnaround time"),
        and rewriting it meant restarting the whole chat. Rejected subjects are
        sent back so "Try another" changes the angle rather than the wording.
      */}
      {source === "ai" && (
        <div className="space-y-2 rounded-lg border p-2.5">
          <Label className="text-xs">Describe the email you want</Label>
          <Textarea
            rows={2}
            className="text-xs"
            placeholder="e.g. Offer a demo of AI lease abstraction to real estate teams — lead on cutting turnaround from days to hours"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              className="h-7 gap-1.5 text-xs"
              disabled={genBusy || !brief.trim()}
              onClick={() => void generate([])}
            >
              {genBusy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
              Generate
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 text-xs"
              disabled={genBusy || !brief.trim() || rejected.length === 0}
              onClick={() => void generate(rejected)}
            >
              Try another
            </Button>
            {rejected.length > 0 && (
              <span className="text-muted-foreground text-xs">
                {rejected.length} version{rejected.length === 1 ? "" : "s"} tried
              </span>
            )}
          </div>
          <p className="text-muted-foreground text-xs">
            Fills Subject, Preview text and Body below — all editable afterwards.
          </p>
        </div>
      )}

      {source === "template" && (
        <div className="max-h-52 space-y-2 overflow-y-auto rounded-lg border p-2">
          {ordered.map(([category, list]) => (
            <div key={category}>
              <div className="flex items-center gap-1.5 px-1 py-1">
                <p className="text-muted-foreground min-w-0 flex-1 truncate text-xs font-medium">
                  {category}
                </p>
                {category === suggested && (
                  <Badge variant="secondary" className="shrink-0 text-xs">
                    matches your brief
                  </Badge>
                )}
                {list.length > 1 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 shrink-0 text-xs"
                    onClick={() => applySequence(category)}
                  >
                    Use all {list.length} as sequence
                  </Button>
                )}
              </div>
              {list.map((t) => (
                <button
                  key={t.id}
                  onClick={() => applyTemplate(t.id)}
                  className={
                    "block w-full rounded-md px-2 py-1.5 text-left text-xs transition-colors " +
                    (picked === t.id
                      ? "bg-primary/10 text-primary font-medium"
                      : "hover:bg-accent")
                  }
                >
                  <span className="flex items-center gap-1.5">
                    {t.step && (
                      <span className="bg-muted shrink-0 rounded px-1 tabular-nums">
                        {t.step}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate">{t.subject}</span>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="space-y-1.5">
        <Label className="text-xs">Subject</Label>
        <Input
          value={spec.subject ?? ""}
          onChange={(e) => setSpec({ ...spec, subject: e.target.value })}
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Preview text</Label>
        <Input
          placeholder="Shown after the subject in the inbox — leave blank and clients use “Hi Dhilak,”"
          value={spec.preview ?? ""}
          onChange={(e) => setSpec({ ...spec, preview: e.target.value })}
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Body</Label>
        <Textarea
          rows={9}
          className="font-mono text-xs"
          value={spec.body ?? ""}
          onChange={(e) => setSpec({ ...spec, body: e.target.value })}
        />
      </div>

      {/*
        cc/bcc apply to the opener and every follow-up. QuickMail accepts these
        but will not read them back, so what is typed here is the only record.
      */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">Cc</Label>
          <Input
            placeholder="comma separated"
            value={spec.cc ?? ""}
            onChange={(e) => setSpec({ ...spec, cc: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Bcc</Label>
          <Input
            placeholder="comma separated"
            value={spec.bcc ?? ""}
            onChange={(e) => setSpec({ ...spec, bcc: e.target.value })}
          />
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        Cc and Bcc are applied to the first email and all follow-ups. Every
        recipient sees the same Cc list on every send — for a colleague who only
        needs visibility, Bcc is usually the right choice.
      </p>

      <FollowUpEditor spec={spec} setSpec={setSpec} />
    </div>
  );
}

/**
 * When the QuickMail trigger fires.
 *
 * This replaced campaign start/end dates. QuickMail has no field for those —
 * every input type in the schema was searched — so they were enforced locally
 * by pausing steps, which made the dates imply control this app did not have.
 * They also only ever narrowed the daily window, and an end time before the
 * window opened produced a campaign that could never send at all.
 *
 * The trigger is the real lever: it admits leads into the sequence, so its
 * time is the thing worth collecting.
 */
function DateFields({
  spec,
  setSpec,
}: {
  spec: Partial<CampaignSpec>;
  setSpec: (s: Partial<CampaignSpec>) => void;
}) {
  const from = spec.fromTime ?? "09:00";
  const to = spec.toTime ?? "17:00";
  const trigger = spec.triggerAt ?? from;
  // A trigger outside the sending window never fires.
  const outsideWindow =
    spec.allHours !== true && (trigger < from || trigger > to);

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Trigger time</p>
      <p className="text-muted-foreground text-xs">
        The clock time each day when QuickMail starts new leads, in the campaign
        timezone. This is what actually begins the campaign.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="time"
          className="h-8 w-32 text-xs"
          value={trigger}
          onChange={(e) => setSpec({ ...spec, triggerAt: e.target.value })}
        />
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => setSpec({ ...spec, triggerAt: from })}
        >
          Match window start ({from})
        </Button>
      </div>

      {outsideWindow && (
        <p className="flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          {trigger} is outside the {from}–{to} sending window, so the trigger
          would never fire. Move it inside the window.
        </p>
      )}
    </div>
  );
}


/** Add, reorder-by-delay, edit and remove the steps after the first email. */
function FollowUpEditor({
  spec,
  setSpec,
}: {
  spec: Partial<CampaignSpec>;
  setSpec: (s: Partial<CampaignSpec>) => void;
}) {
  const followUps = spec.followUps ?? [];

  function update(i: number, patch: Partial<FollowUp>) {
    const next = followUps.map((f, j) => (j === i ? { ...f, ...patch } : f));
    setSpec({ ...spec, followUps: next });
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium">
          Follow-ups ({followUps.length})
        </p>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-7 text-xs"
          onClick={() =>
            setSpec({
              ...spec,
              followUps: [...followUps, { waitDays: 3, subject: "", body: "" }],
            })
          }
        >
          <Plus className="size-3.5" />
          Add step
        </Button>
      </div>

      {followUps.length === 0 && (
        <p className="text-muted-foreground text-xs">
          None. Most replies come from the second or third touch.
        </p>
      )}

      {followUps.map((f, i) => (
        <div key={i} className="space-y-2 rounded-md border p-2.5">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Wait</span>
            <Input
              type="number"
              min={1}
              max={60}
              value={f.waitDays}
              className="h-7 w-16"
              onChange={(e) =>
                update(i, { waitDays: Math.max(1, Number(e.target.value) || 1) })
              }
            />
            <span className="text-muted-foreground">
              business days after {i === 0 ? "the first email" : `step ${i + 1}`}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-7"
              onClick={() =>
                setSpec({
                  ...spec,
                  followUps: followUps.filter((_, j) => j !== i),
                })
              }
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>

          <Input
            className="h-8 text-xs"
            placeholder="Subject — leave blank to reply on the same thread"
            value={f.subject}
            onChange={(e) => update(i, { subject: e.target.value })}
          />
          <Textarea
            rows={4}
            className="font-mono text-xs"
            placeholder="Following up on my note about…"
            value={f.body}
            onChange={(e) => update(i, { body: e.target.value })}
          />
        </div>
      ))}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

function describe(patch: Partial<CampaignSpec>): string {
  const bits: string[] = [];
  if (patch.name) bits.push(`Name: ${patch.name}`);
  if (patch.days) bits.push(`Days: ${patch.days.map((d) => d.slice(0, 3)).join(", ")}`);
  if (patch.timezone) bits.push(`Timezone: ${patch.timezone}`);
  if (patch.allHours) bits.push("All hours");
  else if (patch.fromTime) bits.push(`${patch.fromTime}–${patch.toTime}`);
  if (patch.sharing) bits.push(patch.sharing === "only_me" ? "Only me" : "Everyone");
  if (patch.leadsPerDay !== undefined)
    bits.push(patch.leadsPerDay === 0 ? "No daily limit" : `${patch.leadsPerDay}/day`);
  return bits.join(" · ") || "Confirmed";
}
