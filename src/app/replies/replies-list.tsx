"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Ban,
  CalendarPlus,
  Check,
  CircleSlash,
  Copy,
  ExternalLink,
  Forward,
  Globe,
  Loader2,
  Mail,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { fmtDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export type ThreadMessage = {
  id: string;
  direction: "IN" | "OUT";
  subject: string | null;
  text: string;
  fromName: string | null;
  fromEmail: string | null;
  toEmail: string | null;
  sentAt: string | null;
};

export type ReplyThread = {
  id: string;
  subject: string | null;
  state: string | null;
  replyType: string | null;
  isOoo: boolean;
  aiSummary: string | null;
  waitingSince: string | null;
  /** QuickMail will accept a reply on this thread. */
  canReply: boolean;
  /** The same thread in QuickMail's own UI. */
  qmUrl: string;
  inboxEmail: string | null;
  campaignName: string | null;
  prospect: {
    name: string | null;
    email: string;
    title: string | null;
    company: string | null;
  };
  doNotContact: boolean;
  suppressed: boolean;
  handledAt: string | null;
  handledAction: string | null;
  /** When this was emailed to the manager, if it has been. */
  forwardedAt: string | null;
  messages: ThreadMessage[];
};

/** Classification gets an icon or a word, never colour on its own. */
const TONE: Record<string, { label: string; className: string }> = {
  MEETING_REQUEST: {
    label: "Wants a meeting",
    className: "border-emerald-600/30 bg-emerald-600/10 text-emerald-700",
  },
  POSITIVE: {
    label: "Positive",
    className: "border-emerald-600/30 bg-emerald-600/10 text-emerald-700",
  },
  NEUTRAL: { label: "Neutral", className: "" },
  OUT_OF_OFFICE: { label: "Out of office", className: "" },
  NEGATIVE: {
    label: "Not interested",
    className: "border-amber-600/30 bg-amber-600/10 text-amber-700",
  },
  UNSUBSCRIBE: {
    label: "Asked to stop",
    className: "border-red-600/30 bg-red-600/10 text-red-700",
  },
};

/** The tone buckets, in the order they read: good news first. */
const TONES = [
  { key: "", label: "All" },
  { key: "positive", label: "Positive" },
  { key: "neutral", label: "Neutral" },
  { key: "negative", label: "Negative" },
] as const;

export function RepliesList({
  items,
  bookingLink,
  liveSending,
  oooHidden,
  handledCount,
  includeOoo,
  includeHandled,
  query,
  tone,
  toneCounts,
  lastSync,
  singleThread = false,
}: {
  items: ReplyThread[];
  bookingLink: string | null;
  liveSending: boolean;
  oooHidden: number;
  handledCount: number;
  includeOoo: boolean;
  includeHandled: boolean;
  query: string;
  tone: string;
  toneCounts: { positive: number; neutral: number; negative: number; all: number };
  lastSync: string | null;
  /**
   * Rendered for one conversation, from the deep link in a forwarded email.
   * Drops the toolbar and filters — there is nothing to search or narrow — and
   * opens the thread, because the reader was sent here to act on it.
   */
  singleThread?: boolean;
}) {
  const router = useRouter();
  const [search, setSearch] = useState(query);
  const [syncing, setSyncing] = useState(false);
  const [, startTransition] = useTransition();

  /** Every filter lives in the URL, so a filtered view can be shared or reloaded. */
  const href = (over: Partial<Record<string, string>>) => {
    const p = new URLSearchParams();
    const state: Record<string, string> = {
      ooo: includeOoo ? "1" : "",
      show: includeHandled ? "all" : "",
      q: query,
      tone,
      ...over,
    };
    for (const [k, v] of Object.entries(state)) if (v) p.set(k, v);
    const qs = p.toString();
    return `/replies${qs ? `?${qs}` : ""}`;
  };

  /**
   * Debounced so typing doesn't fire a query per keystroke, but still in the
   * URL rather than filtered in the browser — the page holds at most 200
   * threads and the search has to reach the ones it didn't load.
   */
  useEffect(() => {
    if (search === query) return;
    const t = setTimeout(() => router.push(href({ q: search })), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  async function sync() {
    setSyncing(true);
    const started = Date.now();
    try {
      const res = await fetch("/api/replies/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 30 }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Sync failed");

      const secs = Math.round((Date.now() - started) / 1000);
      /**
       * "Run again for more" would be a lie — the pull always starts at the
       * newest, so pressing it twice re-reads the same threads. Anything older
       * needs a bigger limit, which is the CLI.
       */
      toast.success(
        `Refreshed the newest ${json.conversations} of ${json.total} threads ` +
          `(${json.messages} messages) in ${secs}s` +
          (json.partial
            ? ". For the older ones: npm run sync-replies -- --limit=200"
            : "."),
      );

      // Forwarding is a separate outcome and can fail on its own, so it gets
      // its own message rather than being folded into "synced".
      const f = json.forwarded;
      if (f?.sent > 0) {
        toast.success(
          `${f.sent} repl${f.sent === 1 ? "y" : "ies"} emailed to the manager` +
            (f.remaining > 0 ? `, ${f.remaining} still queued.` : "."),
        );
      } else if (f?.failed > 0) {
        toast.warning(`Could not forward ${f.failed}: ${f.reasons.join("; ")}`);
      }
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  if (singleThread) {
    return (
      <div className="space-y-4">
        {items.map((item) => (
          <ThreadCard
            key={item.id}
            item={item}
            bookingLink={bookingLink}
            liveSending={liveSending}
            startOpen
          />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar: refresh, search, then the tone buckets. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={sync} disabled={syncing}>
          {syncing ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          {syncing ? "Syncing…" : "Sync replies"}
        </Button>

        <div className="relative min-w-56 flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            value={search}
            placeholder="Search name, address, company, subject or message…"
            className="h-9 pl-8"
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <span className="text-muted-foreground text-xs">
          {lastSync ? `Synced ${fmtDateTime(lastSync)}` : "Never synced"}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {TONES.map(({ key, label }) => {
          const count =
            key === ""
              ? toneCounts.all
              : toneCounts[key as "positive" | "neutral" | "negative"];
          const active = tone === key;
          return (
            <Link
              key={key || "all"}
              href={href({ tone: key })}
              className={
                active
                  ? "bg-primary text-primary-foreground rounded-full px-3 py-1 text-xs font-medium"
                  : "hover:bg-accent rounded-full border px-3 py-1 text-xs"
              }
            >
              {label}
              <span className={active ? "ml-1.5" : "ml-1.5 text-muted-foreground"}>
                {count}
              </span>
            </Link>
          );
        })}

        <span className="text-muted-foreground ml-auto flex gap-3 text-xs">
          <Link href={href({ ooo: includeOoo ? "" : "1" })} className="hover:underline">
            {includeOoo ? "Hide" : "Show"} auto-replies
            {!includeOoo && oooHidden > 0 ? ` (${oooHidden})` : ""}
          </Link>
          <Link
            href={href({ show: includeHandled ? "" : "all" })}
            className="hover:underline"
          >
            {includeHandled ? "Hide" : "Show"} handled
            {!includeHandled && handledCount > 0 ? ` (${handledCount})` : ""}
          </Link>
        </span>
      </div>

      {!liveSending && (
        <div className="rounded-md border border-amber-600/30 bg-amber-600/5 p-3 text-xs">
          <span className="font-medium">Dry run is on.</span> Replies will be composed
          and logged but not sent. Set{" "}
          <code className="bg-muted rounded px-1">QUICKMAIL_DRY_RUN=false</code> to send
          for real.
        </div>
      )}

      {items.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground py-16 text-center text-sm">
            Nothing here.{" "}
            {!includeOoo && oooHidden > 0
              ? `${oooHidden} auto-replies are hidden.`
              : "Run the reply sync to pull the latest from QuickMail."}
          </CardContent>
        </Card>
      ) : (
        items.map((item, i) => (
          <ThreadCard
            key={item.id}
            item={item}
            index={i}
            bookingLink={bookingLink}
            liveSending={liveSending}
          />
        ))
      )}
    </div>
  );
}

function ThreadCard({
  item,
  index = 0,
  bookingLink,
  liveSending,
  startOpen = false,
}: {
  item: ReplyThread;
  /** Position in the list, so consecutive threads alternate shade. */
  index?: number;
  bookingLink: string | null;
  liveSending: boolean;
  startOpen?: boolean;
}) {
  const router = useRouter();

  /**
   * A thread the classifier flagged as wanting out is opened on arrival.
   *
   * It is the one case where a person has to decide something rather than
   * choose to look — leaving it collapsed behind a badge is how an opt-out sits
   * unanswered.
   */
  const flagged =
    !item.handledAt &&
    !item.suppressed &&
    (item.replyType === "NEGATIVE" || item.replyType === "UNSUBSCRIBE");

  const [open, setOpen] = useState(startOpen || flagged);
  const [draft, setDraft] = useState("");
  const [draftSource, setDraftSource] = useState<{
    source: string;
    reason: string | null;
  } | null>(null);
  const [subject, setSubject] = useState<string | null>(null);
  const [variation, setVariation] = useState(0);
  const [drafting, setDrafting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"send" | "stop" | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [, startTransition] = useTransition();

  /**
   * No badge is better than a wrong one. QuickMail leaves reply_type null on
   * most threads, and defaulting that to "Neutral" made every conversation
   * claim a classification nothing had actually made.
   */
  const emailDomain = item.prospect.email.split("@").pop() ?? "";

  const tone = item.replyType
    ? (TONE[item.replyType] ?? TONE.NEUTRAL)
    : { label: "Unclassified", className: "text-muted-foreground border-dashed" };
  const firstName = item.prospect.name?.trim().split(/\s+/)[0] ?? "them";
  const latestIn = item.messages.find((m) => m.direction === "IN");
  const shown = showAll ? item.messages : item.messages.slice(0, 2);

  async function generate(next: number) {
    setDrafting(true);
    try {
      const res = await fetch("/api/replies/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: item.id, variation: next }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Draft failed");
      setDraft(json.draft);
      setSubject(json.subject ?? null);
      setDraftSource({ source: json.source, reason: json.source_reason });
      setVariation(next);
      if (json.source === "fallback") {
        toast.warning(`Template draft — the model didn't run: ${json.source_reason}`);
      } else if (json.sentiment) {
        toast.info(`Classified as ${json.sentiment}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Draft failed");
    } finally {
      setDrafting(false);
    }
  }

  async function send() {
    setBusy("send");
    try {
      const res = await fetch("/api/replies/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: item.id, body: draft }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Send failed");

      if (json.sent) {
        toast.success(`Sent to ${json.to} from ${json.from}`);
      } else {
        toast.warning("Dry run — nothing was sent. Set QUICKMAIL_DRY_RUN=false.");
      }
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Send failed");
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  }

  async function act(
    action: "replied" | "stop" | "ignore",
    scope: "email" | "domain" = "email",
  ) {
    setBusy(action === "stop" && scope === "domain" ? "stopDomain" : action);
    try {
      const res = await fetch("/api/replies/act", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: item.id, action, scope }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");

      if (action !== "stop") {
        toast.success(action === "replied" ? "Marked as replied" : "Marked as ignored");
      } else {
        /**
         * Report the two halves separately.
         *
         * Barring the address here always succeeds; telling QuickMail can fail
         * on its own. Reporting a flat "stopped" when its sequences are still
         * running would be the exact failure this whole screen exists to avoid.
         */
        const qm = json.quickmail;
        if (json.domain?.inQuickMail) {
          toast.success(
            `@${json.domain.domain} blocked here and in QuickMail — covers ${json.domain.leadsAffected} known lead${json.domain.leadsAffected === 1 ? "" : "s"} and any new one.`,
          );
        } else if (json.domain) {
          // Half-applied is not "blocked". Their sequences may still be running.
          toast.warning(
            `@${json.domain.domain} blocked here, but not in QuickMail: ${json.domain_error ?? "unknown reason"}.`,
          );
        } else if (qm?.dryRun) {
          toast.warning(
            `Barred locally. Dry run — QuickMail was not told, so its sequences keep running.`,
          );
        } else if (qm?.errors?.length) {
          toast.warning(
            `Barred locally, but QuickMail refused: ${qm.errors.join("; ")} — set do-not-contact there by hand.`,
          );
        } else if (qm?.doNotContact && qm?.cancelled) {
          toast.success(
            `${item.prospect.email} barred here, marked do-not-contact in QuickMail, and its sequence cancelled.`,
          );
        } else {
          toast.success(`${item.prospect.email} will not be emailed again`);
        }
      }
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed");
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  }

  const mailto = `mailto:${encodeURIComponent(item.prospect.email)}?subject=${encodeURIComponent(
    subject ?? latestIn?.subject ?? item.subject ?? "Re:",
  )}&body=${encodeURIComponent(draft)}`;

  async function forward() {
    setBusy("forward");
    try {
      const res = await fetch("/api/replies/forward", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: item.id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Forward failed");
      toast.success(`Sent to ${json.to}`);
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Forward failed");
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(draft);
      toast.success("Draft copied");
    } catch {
      toast.error("Could not copy — select the text instead");
    }
  }

  /**
   * Google Calendar's composer, prospect already invited.
   *
   * No date is passed on purpose: the reviewer picks the slot rather than the
   * app guessing a time from prose like "sometime next week".
   */
  const calendarUrl =
    "https://calendar.google.com/calendar/render?action=TEMPLATE" +
    `&text=${encodeURIComponent(`${item.prospect.company ?? item.prospect.name ?? item.prospect.email} — intro call`)}` +
    `&add=${encodeURIComponent(item.prospect.email)}` +
    `&details=${encodeURIComponent(
      [
        `Intro call with ${item.prospect.name ?? item.prospect.email}.`,
        item.campaignName ? `Campaign: ${item.campaignName}` : "",
        "",
        latestIn?.text.slice(0, 800) ?? "",
      ]
        .filter(Boolean)
        .join("\n"),
    )}`;

  return (
    /**
     * Alternating shades, so where one thread ends and the next begins is
     * readable at a glance.
     *
     * Explicit greys rather than the theme's surface tokens. `--muted`,
     * `--secondary` and `--accent` are all oklch(0.97 0 0) in this theme — one
     * grey, three percent off white — so alternating between them, or between
     * opacities of one of them, produced a difference of about two points of
     * lightness. Real, measurable, and invisible on a screen.
     *
     * One grey at two strengths — 75% and 48% — so the pair stays related
     * rather than reading as two different colours. Light enough that the body
     * text keeps its contrast: these rows carry whole emails, signatures
     * included, not one line of summary.
     *
     * Both halves carry a dark-mode counterpart, so the pattern survives the
     * theme rather than inverting into mud.
     */
    <Card
      className={cn(
        index % 2 === 0
          ? "bg-neutral-300/75 dark:bg-neutral-700/75"
          : "bg-neutral-300/48 dark:bg-neutral-700/48",
        item.handledAt && "opacity-70",
      )}
    >
      <CardContent className="space-y-4 py-5">
        {/*
          The QuickMail link sits outside the expand button on purpose — an
          anchor nested inside a button is invalid, and clicking it would toggle
          the card as well as follow the link.
        */}
        <a
          href={item.qmUrl}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground hover:text-foreground float-right ml-3 inline-flex items-center gap-1 text-xs hover:underline"
        >
          <ExternalLink className="size-3" />
          QuickMail
        </a>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-start justify-between gap-4 text-left"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {item.prospect.name ?? item.prospect.email}
              {item.prospect.title ? (
                <span className="text-muted-foreground font-normal">
                  {" · "}
                  {item.prospect.title}
                </span>
              ) : null}
            </p>
            <p className="text-muted-foreground mt-0.5 truncate text-xs">
              {item.prospect.email}
              {item.prospect.company ? ` · ${item.prospect.company}` : ""}
            </p>
            <p className="mt-1.5 truncate text-xs font-medium">{item.subject}</p>
            {!open && latestIn && (
              <p className="text-muted-foreground mt-1 line-clamp-1 text-xs">
                {latestIn.text}
              </p>
            )}
            <p className="text-muted-foreground mt-1.5 truncate text-[11px]">
              via {item.inboxEmail ?? "unknown mailbox"}
              {item.campaignName ? ` · ${item.campaignName}` : ""}
              {item.waitingSince ? ` · ${fmtDateTime(item.waitingSince)}` : ""}
            </p>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <Badge variant="outline" className={tone.className}>
              {item.isOoo ? "Auto-reply" : tone.label}
            </Badge>
            {item.suppressed && (
              <Badge variant="outline" className="text-muted-foreground">
                <CircleSlash className="size-3" />
                Suppressed
              </Badge>
            )}
            {item.doNotContact && (
              <Badge variant="outline" className="border-red-600/30 text-red-700">
                Do not contact
              </Badge>
            )}
            {item.forwardedAt && (
              <Badge variant="outline" className="text-muted-foreground">
                <Forward className="size-3" />
                Sent to manager
              </Badge>
            )}
            {item.handledAction && (
              <Badge variant="outline" className="text-muted-foreground">
                {item.handledAction === "STOPPED"
                  ? "Stopped"
                  : item.handledAction === "REPLIED"
                    ? "Replied"
                    : "Ignored"}
              </Badge>
            )}
          </div>
        </button>

        {open && (
          <>
            <Separator />

            {item.aiSummary && (
              <p className="text-muted-foreground text-xs italic">{item.aiSummary}</p>
            )}

            {/* The thread itself, newest first. */}
            <div className="space-y-3">
              {shown.map((m) => (
                <div
                  key={m.id}
                  className={
                    m.direction === "IN"
                      ? "bg-muted/40 rounded-md border p-4"
                      : "border-primary/20 rounded-md border border-dashed p-4"
                  }
                >
                  <p className="text-muted-foreground mb-2 text-[11px]">
                    <span className="font-medium">
                      {m.direction === "IN" ? "Received" : "Sent"}
                    </span>
                    {" · "}
                    {m.fromName ? `${m.fromName} ` : ""}
                    &lt;{m.fromEmail ?? "?"}&gt; → {m.toEmail ?? "?"}
                    {m.sentAt ? ` · ${fmtDateTime(m.sentAt)}` : ""}
                  </p>
                  <p className="text-sm whitespace-pre-wrap">{m.text}</p>
                </div>
              ))}
              {item.messages.length > 2 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowAll((v) => !v)}
                  className="text-xs"
                >
                  {showAll
                    ? "Show less"
                    : `Show all ${item.messages.length} messages in this thread`}
                </Button>
              )}
            </div>

            {/*
              The flagged case gets its question up front, above the draft —
              answering "do we keep emailing this person" comes before writing
              anything back to them.
            */}
            {flagged && confirm === null && (
              <div className="rounded-md border border-amber-600/30 bg-amber-600/5 p-4">
                <p className="text-sm font-medium">
                  {item.replyType === "UNSUBSCRIBE"
                    ? `${firstName} asked to be taken off the list`
                    : `${firstName} does not want to hear from us`}
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  {item.replyType === "UNSUBSCRIBE"
                    ? "An opt-out. Confirm it today — it is a legal obligation, not a preference."
                    : "Classified from their reply, which is not always right. Read it above before deciding."}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => setConfirm("stop")}
                  >
                    <Ban className="size-4" />
                    Stop emailing this person
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => act("ignore")}
                  >
                    Keep them in the sequence
                  </Button>
                </div>
              </div>
            )}

            <Separator />

            {/* Draft. */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-muted-foreground flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase">
                  <Sparkles className="size-3.5" />
                  Your reply
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={drafting}
                  onClick={() => generate(draft ? variation + 1 : 0)}
                >
                  {drafting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                  {draft ? "Try another" : "Draft with AI"}
                </Button>
              </div>

              {(subject || latestIn?.subject) && (
                <p className="text-muted-foreground text-xs">
                  Subject:{" "}
                  <span className="text-foreground font-medium">
                    {subject ?? latestIn?.subject}
                  </span>
                </p>
              )}

              <Textarea
                value={draft}
                rows={draft ? 12 : 5}
                placeholder="Write a reply, or let the AI draft one."
                className="text-sm"
                onChange={(e) => setDraft(e.target.value)}
              />

              {draftSource?.source === "fallback" && (
                <p className="text-xs text-amber-700">
                  This is the fallback template, not an AI draft — {draftSource.reason}.
                </p>
              )}

              {item.replyType === "MEETING_REQUEST" && !bookingLink && (
                <p className="text-muted-foreground text-xs">
                  No BOOKING_LINK is set, so the draft proposes times instead of
                  linking a calendar.
                </p>
              )}

              <p className="text-muted-foreground text-xs">
                Sends from <span className="font-medium">{item.inboxEmail}</span> to{" "}
                <span className="font-medium">{item.prospect.email}</span>, in this
                thread.
                {!item.canReply && (
                  <span className="text-amber-700">
                    {" "}
                    QuickMail has no replyable message here — re-run the sync.
                  </span>
                )}
              </p>
            </div>

            <Separator />

            {/*
              Both outward-facing actions stop here first.

              Sending emails a real person and suppressing bars an address for
              good; neither has an undo, so neither happens on one click. The
              panel restates exactly what is about to happen — a button label
              alone is too easy to click past.
            */}
            {confirm === "send" && (
              <div className="rounded-md border border-red-600/40 bg-red-600/5 p-4">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <ShieldAlert className="size-4 text-red-700" />
                  {liveSending
                    ? "This sends a real email. Approve it?"
                    : "Dry run — this will not send. Run it anyway?"}
                </p>
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">From</dt>
                  <dd className="font-medium">{item.inboxEmail}</dd>
                  <dt className="text-muted-foreground">To</dt>
                  <dd className="font-medium">{item.prospect.email}</dd>
                  <dt className="text-muted-foreground">Subject</dt>
                  <dd className="font-medium">
                    {latestIn?.subject ?? item.subject ?? "Re:"}
                  </dd>
                </dl>
                <div className="bg-background mt-3 max-h-52 overflow-y-auto rounded border p-3 text-sm whitespace-pre-wrap">
                  {draft}
                </div>
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy !== null}
                    onClick={send}
                  >
                    {busy === "send" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Send className="size-4" />
                    )}
                    {liveSending ? `Yes, email ${firstName} now` : "Yes, run it"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {confirm === "stop" && (
              <div className="space-y-3 rounded-md border border-red-600/40 bg-red-600/5 p-4">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <ShieldAlert className="size-4 text-red-700" />
                  How far should this go?
                </p>

                {/*
                  Two blocks, deliberately separate. Stopping a person answers
                  "they asked us to leave them alone". Stopping a domain answers
                  "nobody at this company should be contacted" — a competitor, a
                  client, or a server that rejects everything. Same button would
                  make the wider one an accident.
                */}
                <div className="bg-background rounded border p-3">
                  <p className="text-sm font-medium">Just this person</p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    <span className="text-foreground font-medium">
                      {item.prospect.email}
                    </span>{" "}
                    goes on the block list and stays there through any re-import.
                    QuickMail is told too — marked do-not-contact, and any sequence
                    already running for them is cancelled. Everyone else at{" "}
                    <span className="font-medium">@{emailDomain}</span> keeps
                    receiving mail.
                  </p>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="mt-2.5"
                    disabled={busy !== null}
                    onClick={() => act("stop", "email")}
                  >
                    {busy === "stop" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Ban className="size-4" />
                    )}
                    Stop emailing {firstName}
                  </Button>
                </div>

                <div className="bg-background rounded border p-3">
                  <p className="text-sm font-medium">
                    Everyone at @{emailDomain}
                  </p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    Blocks the whole domain, including addresses we have never seen.
                    Nobody at this company can be enrolled in any campaign again.
                    Use it for a competitor, a client, or a domain that bounces
                    everything — not for one annoyed person.
                  </p>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="mt-2.5"
                    disabled={busy !== null}
                    onClick={() => act("stop", "domain")}
                  >
                    {busy === "stopDomain" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Globe className="size-4" />
                    )}
                    Stop the whole domain
                  </Button>
                </div>

                <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={
                  !draft.trim() ||
                  !item.canReply ||
                  item.suppressed ||
                  item.doNotContact ||
                  busy !== null ||
                  confirm !== null
                }
                onClick={() => setConfirm("send")}
              >
                <Send className="size-4" />
                Review &amp; send
              </Button>

              {/*
                The escape hatch. Sending through QuickMail is the normal path,
                but it needs the attached browser — when that is not running, or
                the reply needs an attachment, this hands the draft to the real
                mailbox instead. Rendered only with a draft: `disabled` does
                nothing to an <a>.
              */}
              {draft.trim() && (
                <Button size="sm" variant="outline" asChild>
                  <a href={mailto}>
                    <Mail className="size-4" />
                    Open in mail client
                  </a>
                </Button>
              )}

              <Button
                size="sm"
                variant="outline"
                disabled={!draft.trim()}
                onClick={copy}
              >
                <Copy className="size-4" />
                Copy
              </Button>

              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={forward}
              >
                {busy === "forward" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Forward className="size-4" />
                )}
                {item.forwardedAt ? "Forward again" : "Forward to manager"}
              </Button>

              {!item.suppressed && !item.doNotContact && (
                <Button size="sm" variant="outline" asChild>
                  <a href={calendarUrl} target="_blank" rel="noreferrer">
                    <CalendarPlus className="size-4" />
                    Schedule in Google Calendar
                  </a>
                </Button>
              )}

              {/* The same thread in QuickMail — for anything this screen can't
                  do, like attachments or their own labels and snoozing. */}
              <Button size="sm" variant="outline" asChild>
                <a href={item.qmUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4" />
                  Open in QuickMail
                </a>
              </Button>

              <div className="ml-auto flex gap-2">
                {!item.handledAt && (
                  <>
                    {!item.suppressed && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy !== null || confirm !== null}
                        onClick={() => setConfirm("stop")}
                      >
                        <Ban className="size-4" />
                        Stop emailing
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => act("ignore")}
                    >
                      <Check className="size-4" />
                      Done
                    </Button>
                  </>
                )}
              </div>
            </div>

            {bookingLink && (
              <p className="text-muted-foreground text-xs">
                Booking link: <span className="font-mono">{bookingLink}</span>
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
