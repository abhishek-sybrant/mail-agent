"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Loader2, Send, ShieldOff } from "lucide-react";
import { toast } from "sonner";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { fmtNumber } from "@/lib/format";

export type LeadRow = {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  title: string | null;
  status: string;
  ai_intent_score: number;
  source: string;
  suppressed: boolean;
  created_at: string;
};

const STATUSES = [
  "ALL",
  "UNCONTACTED",
  "EMAILED",
  "REPLIED",
  "BOUNCED",
  "DNC",
  "MEETING_BOOKED",
];

const SENDABLE = ["UNCONTACTED", "EMAILED"];

export type CampaignOption = {
  id: string;
  name: string;
  paused: boolean;
  sent: number;
};

export function LeadsTable({
  leads,
  campaigns,
  query,
  status,
  page,
  pageSize,
  total,
  counts,
}: {
  leads: LeadRow[];
  campaigns: CampaignOption[];
  query: string;
  status: string;
  page: number;
  pageSize: number;
  total: number;
  counts: Record<string, number>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [q, setQ] = useState(query);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"trigger" | null>(null);
  // Live campaigns come first from the server; default to the busiest live one.
  const [campaignId, setCampaignId] = useState(campaigns[0]?.id ?? "");

  /**
   * Pushes a filter change into the URL so the server re-queries.
   *
   * Built from props rather than useSearchParams() on purpose — that hook opts
   * the whole subtree out of server rendering, which left the table empty in
   * the initial HTML.
   */
  function setParam(patch: Record<string, string | null>) {
    const next = new URLSearchParams();
    if (query) next.set("q", query);
    if (status && status !== "ALL") next.set("status", status);
    if (page > 1) next.set("page", String(page));
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    if (!("page" in patch)) next.delete("page");
    startTransition(() => router.push(`/leads?${next.toString()}`));
  }

  // Debounce the search box so typing doesn't fire a query per keystroke.
  useEffect(() => {
    if (q === query) return;
    const t = setTimeout(() => setParam({ q, page: null }), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  const sendable = leads.filter(
    (l) => SENDABLE.includes(l.status) && !l.suppressed,
  );
  const selectedSendable = sendable.filter((l) => selected.has(l.id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /**
   * Enrols into a real QuickMail campaign. No template is needed — the
   * campaign's email steps already live in QuickMail.
   */
  async function pushToCampaign(dryRun: boolean) {
    if (!campaignId) {
      toast.error("Pick a campaign first");
      return;
    }
    setBusy("trigger");
    try {
      const res = await fetch("/api/quickmail/campaigns/enroll", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-dry-run": String(dryRun),
        },
        body: JSON.stringify({
          campaign_id: campaignId,
          lead_ids: selectedSendable.map((l) => l.id),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");

      toast.success(
        json.dryRun
          ? `Preview: ${json.eligible} eligible, ${json.skipped} skipped — nothing written`
          : `Enrolled ${json.enrolled} leads into ${json.campaign}`,
      );
      if (!json.dryRun) {
        setSelected(new Set());
        startTransition(() => router.refresh());
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Search name, email or company…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="max-w-xs"
        />

        <Select
          value={status}
          onValueChange={(v) => setParam({ status: v === "ALL" ? null : v })}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s === "ALL"
                  ? "All statuses"
                  : `${s.replace("_", " ").toLowerCase()}${counts[s] ? ` (${fmtNumber(counts[s])})` : ""}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {pending && (
          <Loader2 className="text-muted-foreground size-4 animate-spin" />
        )}

        <div className="ml-auto flex items-center gap-2">
          <Select value={campaignId} onValueChange={setCampaignId}>
            <SelectTrigger className="w-72">
              <SelectValue placeholder="Choose a campaign" />
            </SelectTrigger>
            <SelectContent>
              {campaigns.length === 0 && (
                <SelectItem value="__none__" disabled>
                  No campaigns synced
                </SelectItem>
              )}
              {campaigns.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  <span className="flex items-center gap-2">
                    <span
                      className={
                        "size-1.5 shrink-0 rounded-full " +
                        (c.paused ? "bg-slate-400" : "bg-emerald-500")
                      }
                    />
                    <span className="truncate">{c.name}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant="outline"
            onClick={() => pushToCampaign(true)}
            disabled={busy !== null || selectedSendable.length === 0}
          >
            Preview
          </Button>
          <Button
            onClick={() => pushToCampaign(false)}
            disabled={busy !== null || selectedSendable.length === 0}
          >
            {busy === "trigger" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            Enrol {selectedSendable.length || ""}
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <input
                  type="checkbox"
                  aria-label="Select all sendable on this page"
                  className="size-4 align-middle"
                  checked={
                    sendable.length > 0 &&
                    selectedSendable.length === sendable.length
                  }
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? new Set(sendable.map((l) => l.id))
                        : new Set(),
                    )
                  }
                />
              </TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Company</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Intent</TableHead>
              <TableHead>Source</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leads.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="text-muted-foreground py-10 text-center text-sm"
                >
                  No leads match this filter.
                </TableCell>
              </TableRow>
            )}

            {leads.map((lead) => {
              const canSend =
                SENDABLE.includes(lead.status) && !lead.suppressed;
              return (
                <TableRow key={lead.id}>
                  <TableCell>
                    <input
                      type="checkbox"
                      aria-label={`Select ${lead.email}`}
                      className="size-4 align-middle"
                      disabled={!canSend}
                      checked={selected.has(lead.id)}
                      onChange={() => toggle(lead.id)}
                    />
                  </TableCell>
                  <TableCell className="max-w-[12rem] truncate font-medium">
                    {lead.name ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground max-w-[16rem] truncate">
                    {lead.email}
                  </TableCell>
                  <TableCell className="max-w-[12rem] truncate">
                    {lead.company ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground max-w-[10rem] truncate text-xs">
                    {lead.title ?? "—"}
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-1.5">
                      <StatusBadge status={lead.status} />
                      {lead.suppressed && (
                        <span title="Suppressed — excluded from all sends">
                          <ShieldOff className="size-3.5 text-amber-600" />
                        </span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {lead.ai_intent_score}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {lead.source.toLowerCase()}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-xs tabular-nums">
          {fmtNumber(from)}–{fmtNumber(to)} of{" "}
          {fmtNumber(total)}
          {selected.size > 0 && ` · ${selected.size} selected`}
        </p>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1 || pending}
            onClick={() => setParam({ page: String(page - 1) })}
          >
            <ChevronLeft className="size-4" />
            Previous
          </Button>
          <span className="text-muted-foreground text-xs tabular-nums">
            {page} / {fmtNumber(lastPage)}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= lastPage || pending}
            onClick={() => setParam({ page: String(page + 1) })}
          >
            Next
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
