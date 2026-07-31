"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  Send,
  TriangleAlert,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type TestLead = { id: string; email: string; name: string | null };

/** Field names our reply endpoint accepts, in the order it checks them. */
const FIELD_MAP = [
  {
    ours: "email",
    required: true,
    zapier: "Prospect Email",
    also: "prospect.email",
    note: "Matched case-insensitively against a lead in this app.",
  },
  {
    ours: "reply_text",
    required: true,
    zapier: "Reply Body / Message",
    also: "message, body, text",
    note: "The words the prospect wrote. This is what Claude classifies.",
  },
  {
    ours: "campaign_id",
    required: false,
    zapier: "Campaign ID",
    also: "prospect.campaign_id",
    note: "Optional. Ignored if it doesn't match a known campaign.",
  },
];

export function WebhookSetup({
  baseUrl,
  secret,
  leads,
  hasSecret,
}: {
  baseUrl: string;
  secret: string;
  leads: TestLead[];
  hasSecret: boolean;
}) {
  const router = useRouter();
  const [showSecret, setShowSecret] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [leadId, setLeadId] = useState(leads[0]?.id ?? "");
  const [sample, setSample] = useState(
    "Thanks for reaching out — this is timely. Can you send pricing and some availability next week?",
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  const replyUrl = `${baseUrl}/api/webhooks/quickmail/reply`;

  async function copy(label: string, value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    toast.success(`${label} copied`);
    setTimeout(() => setCopied(null), 1500);
  }

  async function sendTest() {
    const lead = leads.find((l) => l.id === leadId);
    if (!lead) {
      toast.error("Pick a lead to test against");
      return;
    }

    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/webhooks/quickmail/reply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(hasSecret ? { "x-webhook-secret": secret } : {}),
        },
        body: JSON.stringify({ email: lead.email, reply_text: sample }),
      });
      const json = await res.json();
      setResult({ status: res.status, ...json });

      if (!res.ok) {
        toast.error(json.error ?? "Rejected");
      } else {
        toast.success(`Classified ${json.sentiment} → ${json.action}`);
        router.refresh();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const isLocal = baseUrl.includes("localhost");

  return (
    <div className="space-y-6">
      {isLocal && (
        <Card className="border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30">
          <CardContent className="flex items-start gap-3 pt-6">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <div className="space-y-1 text-sm text-amber-800 dark:text-amber-300">
              <p className="font-medium">
                Zapier cannot reach this URL yet
              </p>
              <p className="text-xs">
                Zapier posts from the public internet, so{" "}
                <code>localhost</code> is unreachable. Expose it with a tunnel
                while testing:
              </p>
              <pre className="bg-background/60 mt-2 rounded-md p-2 text-xs">
                npx cloudflared tunnel --url http://localhost:3001
              </pre>
              <p className="text-xs">
                Then set <code>APP_URL</code> in <code>.env</code> to the URL it
                prints and reload this page.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Endpoint &amp; auth</CardTitle>
          <p className="text-muted-foreground text-xs">
            Paste these into the Zapier action. QuickMail has no native webhook
            settings, so a Zap is the only way replies reach this app.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Method" value="POST" onCopy={copy} copied={copied} />
          <Field label="URL" value={replyUrl} onCopy={copy} copied={copied} />
          <Field
            label="Content-Type"
            value="application/json"
            onCopy={copy}
            copied={copied}
          />

          <div className="space-y-1.5">
            <Label className="text-xs">
              Header — <code>x-webhook-secret</code>
            </Label>
            <div className="flex gap-2">
              <Input
                readOnly
                type={showSecret ? "text" : "password"}
                value={hasSecret ? secret : "(not set)"}
                className="font-mono text-xs"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={() => setShowSecret((s) => !s)}
                aria-label={showSecret ? "Hide secret" : "Show secret"}
              >
                {showSecret ? (
                  <EyeOff className="size-4" />
                ) : (
                  <Eye className="size-4" />
                )}
              </Button>
              <Button
                variant="outline"
                size="icon"
                disabled={!hasSecret}
                onClick={() => copy("Secret", secret)}
                aria-label="Copy secret"
              >
                {copied === "Secret" ? (
                  <Check className="size-4" />
                ) : (
                  <Copy className="size-4" />
                )}
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              {hasSecret
                ? "Requests without this header are rejected with 401. Without it the endpoint would be open to anyone who guesses the URL."
                : "WEBHOOK_SECRET is not set in .env — the endpoint currently accepts unauthenticated requests."}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">2. Trigger &amp; fields</CardTitle>
          <p className="text-muted-foreground text-xs">
            In Zapier: <strong>QuickMail → New Reply</strong> as the trigger,
            then <strong>Webhooks by Zapier → POST</strong> as the action.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Send as</TableHead>
                  <TableHead>Map from (QuickMail)</TableHead>
                  <TableHead>Also accepted</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {FIELD_MAP.map((f) => (
                  <TableRow key={f.ours}>
                    <TableCell className="align-top">
                      <code className="text-xs">{f.ours}</code>
                      {f.required ? (
                        <Badge
                          variant="secondary"
                          className="ml-2 border-transparent bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
                        >
                          required
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="ml-2">
                          optional
                        </Badge>
                      )}
                      <p className="text-muted-foreground mt-1 text-xs">
                        {f.note}
                      </p>
                    </TableCell>
                    <TableCell className="align-top text-xs">
                      {f.zapier}
                    </TableCell>
                    <TableCell className="text-muted-foreground align-top font-mono text-xs">
                      {f.also}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <Separator />

          <div className="space-y-1.5">
            <Label className="text-xs">Resulting payload</Label>
            <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
              {JSON.stringify(
                {
                  email: "{{prospect_email}}",
                  reply_text: "{{reply_body}}",
                  campaign_id: "{{campaign_id}}",
                },
                null,
                2,
              )}
            </pre>
          </div>

          <div className="rounded-md border p-3 text-xs">
            <p className="font-medium">Don&apos;t route bounces through Zapier</p>
            <p className="text-muted-foreground mt-1">
              Your account has 423 bounces against 6 replies. Each bounce would
              consume a Zapier task to tell you something the campaign sync
              already reports accurately. Replies only.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">3. Test it end to end</CardTitle>
          <p className="text-muted-foreground text-xs">
            Fires a real request at the live endpoint, through the same
            classification and routing a Zapier delivery would take.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label className="text-xs">Test against lead</Label>
            <Select value={leadId} onValueChange={setLeadId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a lead" />
              </SelectTrigger>
              <SelectContent>
                {leads.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name ?? l.email} — {l.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-xs">Reply text</Label>
            <Textarea
              rows={3}
              value={sample}
              onChange={(e) => setSample(e.target.value)}
            />
            <div className="flex flex-wrap gap-1.5">
              {[
                ["Positive", "Interested — can you send pricing?"],
                [
                  "Meeting",
                  "Sounds good, can we set up a call next Tuesday afternoon?",
                ],
                ["Negative", "Not interested. Please stop emailing me."],
                ["Unsubscribe", "Remove me from your list immediately."],
                ["Out of office", "I am out of the office until 12 August."],
              ].map(([label, text]) => (
                <Button
                  key={label}
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setSample(text)}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>

          <Button onClick={sendTest} disabled={busy || leads.length === 0}>
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            Send test reply
          </Button>

          {result && (
            <pre className="bg-muted max-h-64 overflow-auto rounded-md p-3 text-xs">
              {JSON.stringify(result, null, 2)}
            </pre>
          )}

          <p className="text-muted-foreground text-xs">
            A positive or meeting reply lands in{" "}
            <strong>Approvals</strong>. A negative or unsubscribe suppresses the
            lead and raises nothing — by design, so nobody chases it.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({
  label,
  value,
  onCopy,
  copied,
}: {
  label: string;
  value: string;
  onCopy: (label: string, value: string) => void;
  copied: string | null;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <div className="flex gap-2">
        <Input readOnly value={value} className="font-mono text-xs" />
        <Button
          variant="outline"
          size="icon"
          onClick={() => onCopy(label, value)}
          aria-label={`Copy ${label}`}
        >
          {copied === label ? (
            <Check className="size-4" />
          ) : (
            <Copy className="size-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
