"use client";

import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Database,
  FileSpreadsheet,
  Loader2,
  Search,
  Upload,
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
  // Deselecting is the common action, so everything loaded starts ticked.
  const [chosen, setChosen] = useState<Set<string>>(new Set());

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

      setTotal(json.count);
      setCapped(json.capped);
      setLeads(json.leads ?? []);
      setChosen(new Set((json.leads ?? []).map((l: LeadRow) => l.id)));
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

  function toggle(id: string) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allOn = leads.length > 0 && chosen.size === leads.length;

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

      {/* The actual leads, so individuals can be removed before sending */}
      <div className="rounded-lg border">
        <div className="bg-muted/40 flex items-center gap-2 border-b px-3 py-2 text-xs">
          <input
            type="checkbox"
            className="size-3.5"
            checked={allOn}
            onChange={(e) =>
              setChosen(e.target.checked ? new Set(leads.map((l) => l.id)) : new Set())
            }
          />
          <span className="font-medium">
            {fmtNumber(chosen.size)} of {fmtNumber(leads.length)} selected
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
                checked={chosen.has(l.id)}
                onChange={() => toggle(l.id)}
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
        disabled={chosen.size === 0}
        onClick={() =>
          onPicked({
            ids: [...chosen],
            label: `${fmtNumber(chosen.size)} leads selected${
              capped ? ` (of ${fmtNumber(total)} matching)` : ""
            }`,
          })
        }
      >
        <CheckCircle2 className="size-4" />
        Use {fmtNumber(chosen.size)} selected
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
        // Pull the freshly imported batch back as concrete lead IDs.
        const sel = await fetch("/api/leads/select", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ titles: [], limit: 500 }),
        });
        const selJson = await sel.json();
        toast.success(`Imported ${json.imported} leads`);
        onPicked({
          ids: selJson.lead_ids ?? [],
          label: `${json.imported} leads imported from ${file.name}`,
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
