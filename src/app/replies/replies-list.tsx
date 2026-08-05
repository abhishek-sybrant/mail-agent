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
  Mail,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { fmtDateTime } from "@/lib/format";

export type ReplyItem = {
  logId: string;
  leadId: string;
  name: string | null;
  email: string;
  company: string | null;
  title: string | null;
  intent: number;
  sentiment: string | null;
  incoming: string;
  receivedAt: string;
  /** Subject of the campaign's first email, so the reply can thread. */
  subject: string | null;
  campaign: { id: string; name: string; quickmailId: string | null } | null;
  needsStopDecision: boolean;
  suppressed: boolean;
  handledAction: string | null;
  handledAt: string | null;
};

/** Sentiment gets an icon and a word, never a colour on its own. */
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
}: {
  items: ReplyItem[];
  bookingLink: string | null;
}) {
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="text-muted-foreground space-y-2 py-16 text-center text-sm">
          <p>No replies captured yet.</p>
          <p className="text-xs">
            Replies arrive through the{" "}
            <Link href="/settings/webhooks" className="underline">
              reply webhook
            </Link>
            . QuickMail&apos;s API has no query for inbound mail, so nothing shows
            here until the webhook is reachable.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {items.map((item) => (
        <ReplyCard key={item.logId} item={item} bookingLink={bookingLink} />
      ))}
    </div>
  );
}

function ReplyCard({
  item,
  bookingLink,
}: {
  item: ReplyItem;
  bookingLink: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(!item.handledAt && item.needsStopDecision);
  const [draft, setDraft] = useState("");
  const [variation, setVariation] = useState(0);
  const [drafting, setDrafting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [, startTransition] = useTransition();

  const tone = TONE[item.sentiment ?? "NEUTRAL"] ?? TONE.NEUTRAL;
  const firstName = item.name?.trim().split(/\s+/)[0] ?? "there";
  const subject = item.subject ? `Re: ${item.subject}` : "Re: my earlier note";

  async function generate(next: number) {
    setDrafting(true);
    try {
      const res = await fetch("/api/replies/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ log_id: item.logId, variation: next }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Draft failed");
      setDraft(json.draft);
      setVariation(next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Draft failed");
    } finally {
      setDrafting(false);
    }
  }

  async function act(action: "replied" | "stop" | "ignore") {
    setBusy(action);
    try {
      const res = await fetch("/api/replies/act", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ log_id: item.logId, action }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");

      toast.success(
        action === "stop"
          ? `${item.email} will not be emailed again`
          : action === "replied"
            ? "Marked as replied"
            : "Marked as ignored",
      );
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed");
    } finally {
      setBusy(null);
      setConfirmStop(false);
    }
  }

  /**
   * Hands the finished reply to the real mailbox.
   *
   * There is no send button, because there is nothing behind one: QuickMail's
   * API has no send-email mutation. The reply has to leave the actual sending
   * inbox anyway — sending it from somewhere else would break the thread and
   * the reply-to address.
   */
  const mailto = `mailto:${encodeURIComponent(item.email)}?subject=${encodeURIComponent(
    subject,
  )}&body=${encodeURIComponent(draft)}`;

  /**
   * Google Calendar's event composer, with the prospect already invited.
   *
   * No date is passed on purpose: the composer opens on "now" and the reviewer
   * picks the slot, rather than the app guessing a time from prose like "next
   * week sometime" and quietly getting it wrong.
   */
  const calendarUrl =
    "https://calendar.google.com/calendar/render?action=TEMPLATE" +
    `&text=${encodeURIComponent(`${item.company ?? item.name ?? item.email} — intro call`)}` +
    `&add=${encodeURIComponent(item.email)}` +
    `&details=${encodeURIComponent(
      [
        `Intro call with ${item.name ?? item.email}${item.company ? ` (${item.company})` : ""}.`,
        item.campaign ? `Campaign: ${item.campaign.name}` : null,
        "",
        "Their reply:",
        item.incoming.slice(0, 800),
      ]
        .filter((line) => line !== null)
        .join("\n"),
    )}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(draft);
      toast.success("Draft copied");
    } catch {
      toast.error("Could not copy — select the text instead");
    }
  }

  return (
    <Card className={item.handledAt ? "opacity-60" : undefined}>
      <CardContent className="space-y-4 py-5">
        {/* Header row — clicking anywhere on it opens the reply. */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-start justify-between gap-4 text-left"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {item.name ?? item.email}
              {item.title ? (
                <span className="text-muted-foreground font-normal">
                  {" · "}
                  {item.title}
                </span>
              ) : null}
            </p>
            <p className="text-muted-foreground mt-0.5 truncate text-xs">
              {item.email}
              {item.company ? ` · ${item.company}` : ""} ·{" "}
              {fmtDateTime(item.receivedAt)}
            </p>
            {!open && (
              <p className="text-muted-foreground mt-2 line-clamp-1 text-xs">
                {item.incoming}
              </p>
            )}
          </div>

          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <Badge variant="outline" className={tone.className}>
              {tone.label}
            </Badge>
            {item.needsStopDecision && !item.handledAt && (
              <Badge variant="outline" className="border-amber-600/30 text-amber-700">
                Needs a decision
              </Badge>
            )}
            {item.suppressed && (
              <Badge variant="outline" className="text-muted-foreground">
                <CircleSlash className="size-3" />
                Suppressed
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

            <div className="bg-muted/40 rounded-md border p-4">
              <p className="text-muted-foreground mb-2 text-[11px] font-medium tracking-wide uppercase">
                Their reply
                {item.campaign ? (
                  <>
                    {" · "}
                    <Link
                      href={`/campaigns/${item.campaign.id}`}
                      className="normal-case hover:underline"
                    >
                      {item.campaign.name}
                    </Link>
                  </>
                ) : null}
              </p>
              <p className="text-sm whitespace-pre-wrap">{item.incoming}</p>
            </div>

            {/* The stop decision. Asked once, and only once, per reply. */}
            {item.needsStopDecision && !item.handledAt && (
              <div className="rounded-md border border-amber-600/30 bg-amber-600/5 p-4">
                <p className="text-sm font-medium">
                  {firstName} does not want to hear from us
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  Stopping adds {item.email} to the suppression list, so no campaign
                  can email this address again — including after a fresh import. The
                  campaign keeps running for everyone else.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {confirmStop ? (
                    <>
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
                        Yes, stop emailing {firstName}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() => setConfirmStop(false)}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setConfirmStop(true)}
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
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Draft + handoff. */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-muted-foreground flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase">
                  <Sparkles className="size-3.5" />
                  AI draft
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
                  {draft ? "Try another" : "Draft a reply"}
                </Button>
              </div>

              {draft ? (
                <>
                  <p className="text-muted-foreground text-xs">
                    Subject: <span className="font-medium">{subject}</span>
                  </p>
                  <Textarea
                    value={draft}
                    rows={12}
                    className="text-sm"
                    onChange={(e) => setDraft(e.target.value)}
                  />
                  {item.sentiment === "MEETING_REQUEST" && !bookingLink && (
                    <p className="text-muted-foreground text-xs">
                      No BOOKING_LINK is set, so the draft proposes times instead of
                      linking a calendar.
                    </p>
                  )}
                </>
              ) : (
                <p className="text-muted-foreground text-xs">
                  Nothing drafted yet. Drafts are generated on request, not on page
                  load.
                </p>
              )}
            </div>

            <Separator />

            <div className="flex flex-wrap items-center gap-2">
              {/* Rendered only with a draft: `disabled` does nothing to an <a>. */}
              {draft && (
                <>
                  <Button size="sm" asChild>
                    <a href={mailto}>
                      <Mail className="size-4" />
                      Open in mail client
                    </a>
                  </Button>
                  <Button size="sm" variant="outline" onClick={copy}>
                    <Copy className="size-4" />
                    Copy
                  </Button>
                </>
              )}
              {/* Not offered for someone who asked to be left alone. */}
              {!item.suppressed && item.sentiment !== "UNSUBSCRIBE" && (
                <Button size="sm" variant="outline" asChild>
                  <a href={calendarUrl} target="_blank" rel="noreferrer">
                    <CalendarPlus className="size-4" />
                    Schedule in Google Calendar
                  </a>
                </Button>
              )}

              <div className="ml-auto flex gap-2">
                {!item.handledAt && (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy !== null}
                      onClick={() => act("replied")}
                    >
                      {busy === "replied" ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Check className="size-4" />
                      )}
                      I&apos;ve replied
                    </Button>
                    {/* The flagged case has its own callout above; this covers
                        every other reply, where a human decides to stop. */}
                    {!item.needsStopDecision && !item.suppressed && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() =>
                          confirmStop ? act("stop") : setConfirmStop(true)
                        }
                      >
                        {busy === "stop" ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Ban className="size-4" />
                        )}
                        {confirmStop ? "Confirm stop" : "Stop emailing"}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => act("ignore")}
                    >
                      Ignore
                    </Button>
                  </>
                )}
              </div>
            </div>

            {bookingLink && (
              <p className="text-muted-foreground text-xs">
                Booking link in use: <span className="font-mono">{bookingLink}</span>
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
