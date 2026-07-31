"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ExternalLink,
  Loader2,
  Plus,
  Rocket,
  ShieldCheck,
  Trash2,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { fmtNumber } from "@/lib/format";

export type Mailbox = { id: string; email: string };
export type TemplateOption = {
  id: string;
  name: string;
  subject: string;
  body: string;
};
export type SelectableLead = {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  status: string;
  intent: number;
};

type FollowUp = { wait_days: number; subject: string; body: string };

const NONE = "__none__";

export function CampaignForm({
  mailboxes,
  templates,
  leads,
  workspaceId,
  dryRunDefault,
  envLocked,
}: {
  mailboxes: Mailbox[];
  templates: TemplateOption[];
  leads: SelectableLead[];
  workspaceId: string | null;
  dryRunDefault: boolean;
  /** QUICKMAIL_DRY_RUN=true in .env — the live toggle can't override it. */
  envLocked: boolean;
}) {
  const router = useRouter();

  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [mailboxSel, setMailboxSel] = useState<Set<string>>(new Set());
  const [leadSel, setLeadSel] = useState<Set<string>>(new Set());
  const [leadQuery, setLeadQuery] = useState("");
  const [dryRun, setDryRun] = useState(dryRunDefault);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  // Search the whole database, not just the first page the server sent.
  // Filtering the initial 500 client-side made the other 47,000+ unreachable.
  const [visibleLeads, setVisibleLeads] = useState<SelectableLead[]>(leads);
  const [matchCount, setMatchCount] = useState(leads.length);
  const [capped, setCapped] = useState(false);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const handle = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch("/api/leads/select", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q: leadQuery.trim(), limit: 500 }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Search failed");

        setVisibleLeads(
          (json.leads ?? []).map(
            (l: {
              id: string;
              email: string;
              name: string | null;
              company: string | null;
              status: string;
              intent: number;
            }) => ({
              id: l.id,
              email: l.email,
              name: l.name,
              company: l.company,
              status: l.status,
              intent: l.intent,
            }),
          ),
        );
        setMatchCount(json.count ?? 0);
        setCapped(Boolean(json.capped));
      } catch {
        // Leave the previous results on screen rather than blanking the list.
      } finally {
        setSearching(false);
      }
    }, 300);

    return () => clearTimeout(handle);
  }, [leadQuery]);

  function applyTemplate(id: string) {
    if (id === NONE) return;
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setSubject(t.subject);
    setBody(t.body);
    if (!name) setName(t.name);
    toast.success(`Loaded "${t.name}"`);
  }

  function toggle(set: Set<string>, id: string, apply: (s: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    apply(next);
  }

  async function submit() {
    if (!name || !subject || !body) {
      toast.error("Name, subject and body are required");
      return;
    }
    if (mailboxSel.size === 0) {
      toast.error("Select at least one sending mailbox");
      return;
    }

    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/quickmail/campaigns/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Lets the UI toggle override the server default per request.
          "x-dry-run": String(dryRun),
        },
        body: JSON.stringify({
          name,
          subject,
          body,
          workspace_id: workspaceId,
          email_account_ids: [...mailboxSel],
          lead_ids: [...leadSel],
          follow_ups: followUps.filter((f) => f.body.trim()),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");

      setResult(json);
      toast.success(
        json.dryRun
          ? "Dry run complete — nothing written"
          : `Created in QuickMail · ${json.leads_enrolled} leads enrolled`,
      );
      if (!json.dryRun) router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  // Selection survives across searches, so count the set itself rather
  // than intersecting with whatever page is on screen.
  const eligible = leadSel.size;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">1. Campaign &amp; copy</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cname">Campaign name</Label>
              <Input
                id="cname"
                value={name}
                placeholder="AI Lease Abstraction — RE Companies — Aug"
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            {templates.length > 0 && (
              <div className="space-y-2">
                <Label>Start from a template</Label>
                <Select onValueChange={applyTemplate}>
                  <SelectTrigger>
                    <SelectValue placeholder="Write from scratch" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Write from scratch</SelectItem>
                    {templates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <Separator />

            <div className="space-y-2">
              <Label htmlFor="csubject">Subject</Label>
              <Input
                id="csubject"
                value={subject}
                placeholder="Quick question about {{companyName}}"
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="cbody">Body</Label>
              <Textarea
                id="cbody"
                rows={12}
                value={body}
                className="font-mono text-sm"
                placeholder="Hi {{firstName}}, …"
                onChange={(e) => setBody(e.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                QuickMail resolves <code>{"{{firstName}}"}</code> and{" "}
                <code>{"{{companyName}}"}</code> at send time.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">
              2. Follow-ups ({followUps.length})
            </CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setFollowUps((f) => [
                  ...f,
                  { wait_days: 3, subject: "", body: "" },
                ])
              }
            >
              <Plus className="size-4" />
              Add step
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            {followUps.length === 0 && (
              <p className="text-muted-foreground text-sm">
                No follow-ups. Most replies come from the second or third touch.
              </p>
            )}

            {followUps.map((f, i) => (
              <div key={i} className="space-y-3 rounded-lg border p-4">
                <div className="flex items-center gap-3">
                  <Label className="text-xs">Wait</Label>
                  <Input
                    type="number"
                    min={1}
                    value={f.wait_days}
                    className="w-20"
                    onChange={(e) =>
                      setFollowUps((prev) =>
                        prev.map((x, j) =>
                          j === i
                            ? { ...x, wait_days: Number(e.target.value) || 1 }
                            : x,
                        ),
                      )
                    }
                  />
                  <span className="text-muted-foreground text-xs">
                    business days, then send
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    onClick={() =>
                      setFollowUps((prev) => prev.filter((_, j) => j !== i))
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>

                <Input
                  value={f.subject}
                  placeholder="Subject — leave blank to reply on the same thread"
                  onChange={(e) =>
                    setFollowUps((prev) =>
                      prev.map((x, j) =>
                        j === i ? { ...x, subject: e.target.value } : x,
                      ),
                    )
                  }
                />
                <Textarea
                  rows={5}
                  value={f.body}
                  className="font-mono text-sm"
                  placeholder="Following up on the above…"
                  onChange={(e) =>
                    setFollowUps((prev) =>
                      prev.map((x, j) =>
                        j === i ? { ...x, body: e.target.value } : x,
                      ),
                    )
                  }
                />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="size-4" />
              3. Leads ({leadSel.size} selected)
              {searching && (
                <Loader2 className="text-muted-foreground size-3.5 animate-spin" />
              )}
            </CardTitle>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setLeadSel(new Set(visibleLeads.map((l) => l.id)))
                }
              >
                Select all shown
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLeadSel(new Set())}
              >
                Clear
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              value={leadQuery}
              placeholder="Search all 48,000 leads by name, email or company…"
              onChange={(e) => setLeadQuery(e.target.value)}
            />

            <p className="text-muted-foreground text-xs tabular-nums">
              {fmtNumber(matchCount)} match
              {capped && ` · showing first ${visibleLeads.length}`}
            </p>

            {visibleLeads.length === 0 ? (
              <p className="text-muted-foreground py-6 text-center text-sm">
                {leadQuery
                  ? "No leads match that search."
                  : "No contactable leads. Import a list first."}
              </p>
            ) : (
              <div className="max-h-80 space-y-1 overflow-y-auto rounded-lg border p-2">
                {visibleLeads.map((l) => (
                  <label
                    key={l.id}
                    className="hover:bg-accent flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm"
                  >
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={leadSel.has(l.id)}
                      onChange={() => toggle(leadSel, l.id, setLeadSel)}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {l.name ?? l.email}
                      {l.company && (
                        <span className="text-muted-foreground">
                          {" "}
                          · {l.company}
                        </span>
                      )}
                    </span>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {l.email}
                    </span>
                  </label>
                ))}
              </div>
            )}

            <p className="text-muted-foreground text-xs">
              Only UNCONTACTED and EMAILED leads are listed. Bounced, DNC and
              suppressed leads are excluded and cannot be enrolled.
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6">
        <Card
          className={
            dryRun
              ? "border-emerald-300 dark:border-emerald-900"
              : "border-red-400 dark:border-red-800"
          }
        >
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldCheck className="size-4" />
              {dryRun ? "Dry run" : "Live mode"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <label
              className={
                "flex items-center gap-2 text-sm " +
                (envLocked ? "cursor-not-allowed opacity-50" : "cursor-pointer")
              }
            >
              <input
                type="checkbox"
                className="size-4"
                disabled={envLocked}
                checked={!dryRun}
                onChange={(e) => setDryRun(!e.target.checked)}
              />
              Write to QuickMail for real
            </label>

            <p className="text-muted-foreground text-xs">
              {envLocked
                ? "Locked by QUICKMAIL_DRY_RUN=true in .env. Set it to false to enable this."
                : dryRun
                  ? "You'll see the exact mutations that would run. Nothing is written."
                  : "The campaign and leads will be created in your live workspace."}
            </p>

            <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50/60 p-2 text-xs dark:border-amber-900 dark:bg-amber-950/30">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
              <p className="text-amber-800 dark:text-amber-300">
                Even in live mode the campaign is created{" "}
                <strong>paused</strong> with <strong>draft</strong> steps. No
                mail sends until you unpause it inside QuickMail.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">
              Sending mailboxes ({mailboxSel.size})
            </CardTitle>
          </CardHeader>
          <CardContent className="max-h-72 space-y-1 overflow-y-auto">
            {mailboxes.map((m) => (
              <label
                key={m.id}
                className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs"
              >
                <input
                  type="checkbox"
                  className="size-3.5"
                  checked={mailboxSel.has(m.id)}
                  onChange={() => toggle(mailboxSel, m.id, setMailboxSel)}
                />
                <span className="truncate">{m.email}</span>
              </label>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            <Row label="Steps" value={`${1 + followUps.filter((f) => f.body).length}`} />
            <Row label="Leads" value={`${eligible}`} />
            <Row label="Mailboxes" value={`${mailboxSel.size}`} />
            <Separator className="my-2" />
            <Button className="w-full" onClick={submit} disabled={busy}>
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Rocket className="size-4" />
              )}
              {dryRun ? "Preview" : "Create in QuickMail"}
            </Button>
          </CardContent>
        </Card>

        {result && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
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
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}
