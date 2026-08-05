"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { fmtDateTime } from "@/lib/format";

export type InboxItem = {
  leadId: string;
  name: string | null;
  email: string;
  company: string | null;
  intent: number;
  incoming: string;
  receivedAt: string;
  draft: string;
};

export function InboxList({ items }: { items: InboxItem[] }) {
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="text-muted-foreground py-16 text-center text-sm">
          No replies waiting for review. Inbox zero.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {items.map((item) => (
        <InboxCard key={item.leadId} item={item} />
      ))}
    </div>
  );
}

function InboxCard({ item }: { item: InboxItem }) {
  const router = useRouter();
  const [reply, setReply] = useState(item.draft);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [, startTransition] = useTransition();

  async function approve() {
    setSending(true);
    try {
      const res = await fetch("/api/inbox/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead_id: item.leadId, reply_text: reply }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Send failed");

      setSent(true);
      if (json.sent) {
        toast.success(`Reply sent to ${item.email}`);
      } else {
        toast.warning(
          "Draft saved but not sent — no send webhook is configured. Use the Replies tab to send it from your mailbox.",
        );
      }
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="text-base">{item.name ?? item.email}</CardTitle>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {item.email}
            {item.company ? ` · ${item.company}` : ""} ·{" "}
            {fmtDateTime(item.receivedAt)}
          </p>
        </div>
        <Badge variant="secondary" className="shrink-0">
          Intent {item.intent}
        </Badge>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="bg-muted/50 rounded-lg border p-4">
          <p className="text-muted-foreground mb-2 text-xs font-medium uppercase">
            Their reply
          </p>
          <p className="text-sm whitespace-pre-wrap">{item.incoming}</p>
        </div>

        <Separator />

        <div className="space-y-2">
          <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium uppercase">
            <Sparkles className="size-3.5" />
            AI-drafted reply — edit before sending
          </p>
          <Textarea
            value={reply}
            rows={12}
            disabled={sent}
            className="font-mono text-sm"
            onChange={(e) => setReply(e.target.value)}
          />
        </div>

        <Button onClick={approve} disabled={sending || sent || !reply.trim()}>
          {sending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Check className="size-4" />
          )}
          {sent ? "Sent" : "Approve & Send"}
        </Button>
      </CardContent>
    </Card>
  );
}
