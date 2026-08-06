"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Ban,
  CalendarPlus,
  Check,
  CircleSlash,
  Copy,
  Loader2,
  RefreshCw,
  Send,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { fmtDateTime } from "@/lib/format";

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

export function RepliesList({
  items,
  bookingLink,
  liveSending,
  oooHidden,
  handledCount,
  includeOoo,
  includeHandled,
  lastSync,
}: {
  items: ReplyThread[];
  bookingLink: string | null;
  liveSending: boolean;
  oooHidden: number;
  handledCount: number;
  includeOoo: boolean;
  includeHandled: boolean;
  lastSync: string | null;
}) {
  const href = (o: boolean, h: boolean) =>
    `/replies${o || h ? `?${[o ? "ooo=1" : "", h ? "show=all" : ""].filter(Boolean).join("&")}` : ""}`;

  return (
    <div className="space-y-4">
      <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
        <span>
          {lastSync ? `Synced ${fmtDateTime(lastSync)}` : "Never synced"} · run{" "}
          <code className="bg-muted rounded px-1 py-0.5">npm run sync-replies</code> to
          refresh
        </span>
        <span className="ml-auto flex gap-3">
          <Link href={href(!includeOoo, includeHandled)} className="hover:underline">
            {includeOoo ? "Hide" : "Show"} auto-replies
            {!includeOoo && oooHidden > 0 ? ` (${oooHidden})` : ""}
          </Link>
          <Link href={href(includeOoo, !includeHandled)} className="hover:underline">
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
        items.map((item) => (
          <ThreadCard
            key={item.id}
            item={item}
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
  bookingLink,
  liveSending,
}: {
  item: ReplyThread;
  bookingLink: string | null;
  liveSending: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
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
      setVariation(next);
      if (json.sentiment) toast.info(`Classified as ${json.sentiment}`);
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

  async function act(action: "replied" | "stop" | "ignore") {
    setBusy(action);
    try {
      const res = await fetch("/api/replies/act", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: item.id, action }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");

      toast.success(
        action === "stop"
          ? `${item.prospect.email} will not be emailed again`
          : action === "replied"
            ? "Marked as replied"
            : "Marked as ignored",
      );
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed");
    } finally {
      setBusy(null);
      setConfirm(null);
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
    <Card className={item.handledAt ? "opacity-70" : undefined}>
      <CardContent className="space-y-4 py-5">
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

              <Textarea
                value={draft}
                rows={draft ? 12 : 5}
                placeholder="Write a reply, or let the AI draft one."
                className="text-sm"
                onChange={(e) => setDraft(e.target.value)}
              />

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

            <div className="flex flex-wrap items-center gap-2">
              {confirm === "send" ? (
                <>
                  <Button
                    size="sm"
                    disabled={busy !== null}
                    onClick={send}
                    variant="destructive"
                  >
                    {busy === "send" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Send className="size-4" />
                    )}
                    {liveSending
                      ? `Yes, email ${firstName} now`
                      : "Yes, run it (dry run)"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  disabled={
                    !draft.trim() ||
                    !item.canReply ||
                    item.suppressed ||
                    item.doNotContact ||
                    busy !== null
                  }
                  onClick={() => setConfirm("send")}
                >
                  <Send className="size-4" />
                  Send reply
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

              {!item.suppressed && !item.isOoo && (
                <Button size="sm" variant="outline" asChild>
                  <a href={calendarUrl} target="_blank" rel="noreferrer">
                    <CalendarPlus className="size-4" />
                    Schedule
                  </a>
                </Button>
              )}

              <div className="ml-auto flex gap-2">
                {!item.handledAt && (
                  <>
                    {!item.suppressed &&
                      (confirm === "stop" ? (
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={busy !== null}
                          onClick={() => act("stop")}
                        >
                          {busy === "stop" ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Ban className="size-4" />
                          )}
                          Confirm — never email {firstName}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy !== null}
                          onClick={() => setConfirm("stop")}
                        >
                          <Ban className="size-4" />
                          Stop emailing
                        </Button>
                      ))}
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
