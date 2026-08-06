"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, CalendarCheck, Check, Loader2, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { fmtDateTime } from "@/lib/format";

export type ApprovalItem = {
  id: string;
  type: string;
  title: string;
  summary: string | null;
  aiDraft: string;
  incoming: string | null;
  createdAt: string;
  lead: {
    email: string;
    name: string | null;
    company: string | null;
    intent: number;
  } | null;
};

export function ApprovalCard({ item }: { item: ApprovalItem }) {
  const router = useRouter();
  const [draft, setDraft] = useState(item.aiDraft);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function decide(decision: "APPROVED" | "REJECTED") {
    setBusy(decision === "APPROVED" ? "approve" : "reject");
    try {
      const res = await fetch(`/api/approvals/${item.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, reply_text: draft }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");

      setDone(decision);
      toast.success(
        decision === "REJECTED"
          ? item.type === "STOP_SEQUENCE"
            ? "Kept in the sequence"
            : "Dismissed"
          : item.type === "STOP_SEQUENCE"
            ? `${item.lead?.email} will not be emailed again`
            : `Reply sent to ${item.lead?.email}`,
      );
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  const isMeeting = item.type === "MEETING_BOOK";
  /**
   * A stop decision has no draft and sends nothing — approving it bars the
   * address. Same card, different question, so the wording and the buttons both
   * change rather than offering "Approve & Send" for a suppression.
   */
  const isStop = item.type === "STOP_SEQUENCE";

  return (
    <Card className={done ? "opacity-60" : undefined}>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            {isMeeting && <CalendarCheck className="size-4 text-emerald-600" />}
            {item.title}
          </CardTitle>
          <p className="text-muted-foreground mt-0.5 truncate text-xs">
            {item.lead?.email}
            {item.lead?.company ? ` · ${item.lead.company}` : ""} ·{" "}
            {fmtDateTime(item.createdAt)}
          </p>
          {item.summary && (
            <p className="text-muted-foreground mt-1 text-xs italic">
              {item.summary}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge variant="secondary">Intent {item.lead?.intent ?? 0}</Badge>
          {isMeeting && (
            <Badge className="border-transparent bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
              Meeting
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {item.incoming && (
          <div className="bg-muted/50 rounded-lg border p-4">
            <p className="text-muted-foreground mb-2 text-xs font-medium uppercase">
              Their reply
            </p>
            <p className="text-sm whitespace-pre-wrap">{item.incoming}</p>
          </div>
        )}

        <Separator />

        {isStop ? (
          <p className="text-muted-foreground text-xs">
            Stopping adds{" "}
            <span className="text-foreground font-medium">{item.lead?.email}</span> to
            the suppression list. No campaign can email this address again, including
            after a fresh import. Everyone else in the campaign keeps receiving mail.
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium uppercase">
              <Sparkles className="size-3.5" />
              AI draft — edit before approving
            </p>
            <Textarea
              value={draft}
              rows={12}
              disabled={done !== null}
              className="font-mono text-sm"
              onChange={(e) => setDraft(e.target.value)}
            />
          </div>
        )}

        <div className="flex gap-2">
          <Button
            variant={isStop ? "destructive" : "default"}
            onClick={() => decide("APPROVED")}
            disabled={busy !== null || done !== null || (!isStop && !draft.trim())}
          >
            {busy === "approve" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : isStop ? (
              <Ban className="size-4" />
            ) : (
              <Check className="size-4" />
            )}
            {done === "APPROVED"
              ? isStop
                ? "Stopped"
                : "Sent"
              : isStop
                ? "Yes, stop emailing them"
                : "Approve & Send"}
          </Button>

          <Button
            variant="outline"
            onClick={() => decide("REJECTED")}
            disabled={busy !== null || done !== null}
          >
            {busy === "reject" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <X className="size-4" />
            )}
            {isStop ? "Keep them in the sequence" : "Dismiss"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
