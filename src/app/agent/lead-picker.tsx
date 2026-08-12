"use client";

import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Database,
  FileSpreadsheet,
  Loader2,
  Search,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { fmtNumber } from "@/lib/format";

export type PickedLeads = { ids: string[]; label: string };

/**
 * Three ways to choose who gets the campaign:
 *   1. pick from leads already in the database (48k synced from QuickMail)
 *   2. upload a spreadsheet now
 *   3. pull from an external database over a connection string
 */
export function LeadPicker({
  titleKeywords,
  onPicked,
}: {
  titleKeywords: string[];
  onPicked: (picked: PickedLeads) => void;
}) {
  const [tab, setTab] = useState("select");

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList className="w-full">
        <TabsTrigger value="select" className="flex-1 gap-1.5">
          <Search className="size-3.5" />
          Select leads
        </TabsTrigger>
        <TabsTrigger value="upload" className="flex-1 gap-1.5">
          <Upload className="size-3.5" />
          Upload
        </TabsTrigger>
        <TabsTrigger value="db" className="flex-1 gap-1.5">
          <Database className="size-3.5" />
          From database
        </TabsTrigger>
      </TabsList>

      <TabsContent value="select" className="pt-4">
        <SelectExisting titleKeywords={titleKeywords} onPicked={onPicked} />
      </TabsContent>
      <TabsContent value="upload" className="pt-4">
        <UploadSheet onPicked={onPicked} />
      </TabsContent>
      <TabsContent value="db" className="pt-4">
        <FromDatabase />
      </TabsContent>
    </Tabs>
  );
}

type LeadRow = {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  title: string | null;
  status: string;
  intent: number;
};

function SelectExisting({
  titleKeywords,
  onPicked,
}: {
  titleKeywords: string[];
  onPicked: (p: PickedLeads) => void;
}) {
  const [keywords, setKeywords] = useState(titleKeywords.join(", "));
  const [q, setQ] = useState("");
  const [excludeSuppressed, setExclude] = useState(true);
  const [busy, setBusy] = useState(false);
  const [total, setTotal] = useState(0);
  const [capped, setCapped] = useState(false);
  const [leads, setLeads] = useState<LeadRow[]>([]);

  /**
   * Everything picked so far, across every search — the whole row, not just the
   * id, so someone chosen under an earlier search can still be named on screen.
   *
   * This used to be rebuilt from each search's results, which meant picking
   * Dhilak and then searching for Pranav silently dropped Dhilak: the only way
   * to select two people was to find a query that returned both.
   */
  const [picked, setPicked] = useState<Map<string, LeadRow>>(new Map());
  const firstLoad = useRef(true);

  async function load() {
    setBusy(true);
    try {
      const titles = keywords
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const res = await fetch("/api/leads/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          titles,
          q: q.trim(),
          exclude_suppressed: excludeSuppressed,
          limit: 500,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Lookup failed");

      const rows: LeadRow[] = json.leads ?? [];
      setTotal(json.count);
      setCapped(json.capped);
      setLeads(rows);

      /**
       * Only the opening list arrives pre-ticked.
       *
       * That first view is the broad audience, where removing a few is the
       * common action. Once someone types a search they are hunting for
       * specific people, so results arrive unticked and earlier picks are left
       * alone — otherwise every search would silently add its whole result set.
       */
      if (firstLoad.current) {
        firstLoad.current = false;
        setPicked(new Map(rows.map((l) => [l.id, l])));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggle(lead: LeadRow) {
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(lead.id)) next.delete(lead.id);
      else next.set(lead.id, lead);
      return next;
    });
  }

  function remove(id: string) {
    setPicked((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }

  // The header checkbox governs the rows on screen, not the whole selection.
  const visibleOn = leads.filter((l) => picked.has(l.id)).length;
  const allOn = leads.length > 0 && visibleOn === leads.length;

  // Picked under an earlier search, so not in the current results. Shown as
  // chips — without them a selection that is off screen looks like it was lost.
  const offscreen = [...picked.values()].filter(
    (p) => !leads.some((l) => l.id === p.id),
  );

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">Job-title keywords (comma separated)</Label>
          <Input
            value={keywords}
            placeholder="lease administration, property manager"
            onChange={(e) => setKeywords(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load()}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Name, email or company</Label>
          <div className="flex gap-2">
            <Input
              value={q}
              placeholder="cbre, woolworths, sarah…"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && load()}
            />
            <Button
              variant="outline"
              size="icon"
              onClick={load}
              disabled={busy}
              aria-label="Search leads"
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Search className="size-4" />
              )}
            </Button>
          </div>
        </div>
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-xs">
        <input
          type="checkbox"
          className="size-3.5"
          checked={excludeSuppressed}
          onChange={(e) => {
            setExclude(e.target.checked);
          }}
        />
        Exclude bounced and suppressed leads
        <span className="text-muted-foreground">
          — both boxes narrow the list; leave them blank to match everyone
        </span>
      </label>

      {/*
        Picks that the current search does not show. Without this, selecting
        Dhilak and then searching for Pranav looks like Dhilak was dropped —
        which is exactly what used to happen.
      */}
      {offscreen.length > 0 && (
        <div className="bg-muted/40 rounded-lg border p-2.5">
          <p className="text-muted-foreground mb-1.5 text-xs">
            Also selected, not in these results:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {offscreen.map((p) => (
              <span
                key={p.id}
                className="bg-background inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-1 pl-2.5 text-xs"
              >
                <span className="max-w-52 truncate">{p.name ?? p.email}</span>
                <button
                  type="button"
                  onClick={() => remove(p.id)}
                  aria-label={`Remove ${p.name ?? p.email}`}
                  className="hover:bg-accent text-muted-foreground hover:text-foreground rounded-full p-0.5"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* The actual leads, so individuals can be removed before sending */}
      <div className="rounded-lg border">
        <div className="bg-muted/40 flex items-center gap-2 border-b px-3 py-2 text-xs">
          <input
            type="checkbox"
            className="size-3.5"
            checked={allOn}
            onChange={(e) => {
              const on = e.target.checked;
              setPicked((prev) => {
                const next = new Map(prev);
                // Applies to the rows on screen only, leaving other picks intact.
                for (const l of leads) {
                  if (on) next.set(l.id, l);
                  else next.delete(l.id);
                }
                return next;
              });
            }}
          />
          <span className="font-medium">
            {fmtNumber(visibleOn)} of {fmtNumber(leads.length)} shown
          </span>
          <span className="text-primary font-medium">
            · {fmtNumber(picked.size)} selected in total
          </span>
          {capped && (
            <span className="text-muted-foreground">
              · {fmtNumber(total)} match, showing first {leads.length}
            </span>
          )}
          {!capped && total > 0 && (
            <span className="text-muted-foreground">
              · {fmtNumber(total)} match
            </span>
          )}
        </div>

        <div className="max-h-72 overflow-y-auto">
          {busy && leads.length === 0 && (
            <p className="text-muted-foreground p-6 text-center text-sm">
              Loading leads…
            </p>
          )}
          {!busy && leads.length === 0 && (
            <p className="text-muted-foreground p-6 text-center text-sm">
              No leads match. Try a broader keyword, or clear both boxes.
            </p>
          )}
          {leads.map((l) => (
            <label
              key={l.id}
              className="hover:bg-accent flex cursor-pointer items-center gap-2 border-b px-3 py-1.5 text-xs last:border-0"
            >
              <input
                type="checkbox"
                className="size-3.5 shrink-0"
                checked={picked.has(l.id)}
                onChange={() => toggle(l)}
              />
              <span className="w-40 shrink-0 truncate font-medium">
                {l.name ?? "—"}
              </span>
              <span className="text-muted-foreground w-56 shrink-0 truncate">
                {l.email}
              </span>
              <span className="text-muted-foreground min-w-0 flex-1 truncate">
                {l.title ?? l.company ?? ""}
              </span>
              {l.intent > 0 && (
                <Badge variant="secondary" className="shrink-0 tabular-nums">
                  {l.intent}
                </Badge>
              )}
            </label>
          ))}
        </div>
      </div>

      <Button
        disabled={picked.size === 0}
        onClick={() =>
          onPicked({
            ids: [...picked.keys()],
            // Names the people when there are few enough to read, since two
            // hand-picked leads read very differently from a bulk audience.
            label:
              picked.size <= 3
                ? [...picked.values()].map((p) => p.name ?? p.email).join(", ")
                : `${fmtNumber(picked.size)} leads selected${
                    capped ? ` (of ${fmtNumber(total)} matching)` : ""
                  }`,
          })
        }
      >
        <CheckCircle2 className="size-4" />
        Use {fmtNumber(picked.size)} selected
      </Button>
    </div>
  );
}

function UploadSheet({ onPicked }: { onPicked: (p: PickedLeads) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<{
    valid: number;
    invalid: number;
    imported?: number;
  } | null>(null);

  async function send(dryRun: boolean) {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("dryRun", String(dryRun));

      const res = await fetch("/api/leads/upload", { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Upload failed");

      setSummary({ valid: json.valid, invalid: json.invalid, imported: json.imported });

      if (!dryRun) {
        /**
         * Use the ids the upload returns — the people in this file.
         *
         * This used to ask /api/leads/select for a generic top-500 with no
         * filter, which has nothing to do with the upload: it returned 500
         * unrelated prospects ordered by intent score while the label said
         * "1 leads imported from in.xlsx". The campaign then enrolled 500
         * strangers, and the pre-flight lookup for them — one paced request
         * each — held the request open for about ten minutes.
         */
        const ids: string[] = json.lead_ids ?? [];
        const usable = ids.length;

        toast.success(
          usable === json.imported
            ? `Imported ${json.imported} leads`
            : `${usable} leads ready — ${json.imported} new, ${json.already_existed ?? 0} already known` +
                (json.suppressed_on_arrival
                  ? `, ${json.suppressed_on_arrival} blocked`
                  : ""),
        );

        onPicked({
          ids,
          label: `${usable} lead${usable === 1 ? "" : "s"} from ${file.name}`,
        });
      } else {
        toast.success(`${json.valid} valid, ${json.invalid} rejected`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          setFile(e.dataTransfer.files[0] ?? null);
          setSummary(null);
        }}
        className="hover:bg-accent/50 flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed py-8 transition-colors"
      >
        <FileSpreadsheet className="text-muted-foreground size-7" />
        <p className="text-sm font-medium">
          {file ? file.name : "Drop a file, or click to browse"}
        </p>
        <p className="text-muted-foreground text-xs">
          Excel (.xlsx, .xls), CSV, TSV or JSON
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls,.csv,.tsv,.json,.txt"
        className="hidden"
        onChange={(e) => {
          setFile(e.target.files?.[0] ?? null);
          setSummary(null);
        }}
      />

      {summary && (
        <p className="text-sm">
          <strong>{summary.valid}</strong> valid ·{" "}
          <span className="text-red-600 dark:text-red-400">
            {summary.invalid} rejected
          </span>
          <span className="text-muted-foreground">
            {" "}
            — every rejected address is a bounce that never happens
          </span>
        </p>
      )}

      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => send(true)}
          disabled={!file || busy}
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          Validate first
        </Button>
        <Button size="sm" onClick={() => send(false)} disabled={!file || busy}>
          Import &amp; use
        </Button>
      </div>
    </div>
  );
}

function FromDatabase() {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-xs">Connection string</Label>
        <Input placeholder="postgresql://user:pass@host:5432/crm" disabled />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Query</Label>
        <Input
          placeholder="SELECT email, first_name, company FROM contacts WHERE ..."
          disabled
        />
      </div>

      <Separator />

      <div className="rounded-md border border-amber-300 bg-amber-50/60 p-3 text-xs dark:border-amber-900 dark:bg-amber-950/30">
        <p className="font-medium text-amber-800 dark:text-amber-300">
          Not connected yet
        </p>
        <p className="mt-1 text-amber-800/90 dark:text-amber-300/90">
          This needs a database to point at, plus a decision on which driver to
          bundle (Postgres, MySQL or SQL Server) and read-only credentials. Tell
          me which system holds your contacts and I&apos;ll wire it up.
        </p>
        <p className="mt-2 text-amber-800/90 dark:text-amber-300/90">
          Until then the <strong>Upload</strong> tab covers the same ground —
          export a query to CSV and drop it in, with validation on the way.
        </p>
      </div>

      <Badge variant="secondary">Planned</Badge>
    </div>
  );
}
