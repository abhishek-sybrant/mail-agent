"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  Loader2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
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

type Preview = {
  columns: string[];
  mapping: Record<string, string>;
  total_rows: number;
  valid: number;
  invalid: number;
  duplicates_in_file: number;
  role_addresses: number;
  free_mailboxes: number;
  preview: { email: string; name: string | null; company: string | null }[];
  rejected: { row: number; email: string; reason: string }[];
};

const FIELDS = [
  { key: "email", label: "Email", required: true },
  { key: "name", label: "Full name", required: false },
  { key: "first_name", label: "First name", required: false },
  { key: "last_name", label: "Last name", required: false },
  { key: "company", label: "Company", required: false },
  { key: "title", label: "Job title", required: false },
  { key: "phone", label: "Phone", required: false },
  { key: "location", label: "Location", required: false },
];

const NONE = "__none__";

export function ImportWizard() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"scan" | "import" | null>(null);

  async function send(dryRun: boolean) {
    if (!file) return;
    setBusy(dryRun ? "scan" : "import");

    const form = new FormData();
    form.set("file", file);
    form.set("dryRun", String(dryRun));
    if (Object.keys(mapping).length > 0) {
      form.set("mapping", JSON.stringify(mapping));
    }

    try {
      const res = await fetch("/api/leads/upload", {
        method: "POST",
        body: form,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Upload failed");

      if (dryRun) {
        setPreview(json);
        setMapping(json.mapping);
        toast.success(`Scanned ${json.total_rows} rows`);
      } else {
        toast.success(
          `Imported ${json.imported} leads · ${json.invalid} rejected`,
        );
        setFile(null);
        setPreview(null);
        router.push("/leads");
        router.refresh();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  function onPick(f: File | null) {
    setFile(f);
    setPreview(null);
    setMapping({});
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Choose a file</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              onPick(e.dataTransfer.files[0] ?? null);
            }}
            className="hover:bg-accent/50 flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed py-10 transition-colors"
          >
            <FileSpreadsheet className="text-muted-foreground size-8" />
            <p className="text-sm font-medium">
              {file ? file.name : "Drop a file here, or click to browse"}
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
            onChange={(e) => onPick(e.target.files?.[0] ?? null)}
          />

          <Button onClick={() => send(true)} disabled={!file || busy !== null}>
            {busy === "scan" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Upload className="size-4" />
            )}
            Scan &amp; validate
          </Button>
        </CardContent>
      </Card>

      {preview && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">2. Map the columns</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              {FIELDS.map((field) => (
                <div key={field.key} className="space-y-1.5">
                  <Label className="text-xs">
                    {field.label}
                    {field.required && (
                      <span className="ml-1 text-red-600">*</span>
                    )}
                  </Label>
                  <Select
                    value={mapping[field.key] ?? NONE}
                    onValueChange={(v) =>
                      setMapping((m) => {
                        const next = { ...m };
                        if (v === NONE) delete next[field.key];
                        else next[field.key] = v;
                        return next;
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Not mapped" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Not mapped</SelectItem>
                      {preview.columns.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">3. List health</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-4">
                <Stat label="Rows" value={preview.total_rows} />
                <Stat label="Valid" value={preview.valid} tone="good" />
                <Stat
                  label="Rejected"
                  value={preview.invalid}
                  tone={preview.invalid > 0 ? "bad" : undefined}
                />
                <Stat label="Duplicates" value={preview.duplicates_in_file} />
              </div>

              {(preview.role_addresses > 0 || preview.free_mailboxes > 0) && (
                <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50/60 p-3 text-xs dark:border-amber-900 dark:bg-amber-950/30">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                  <div className="space-y-0.5 text-amber-800 dark:text-amber-300">
                    {preview.role_addresses > 0 && (
                      <p>
                        <strong>{preview.role_addresses}</strong> role addresses
                        (info@, sales@…) — these rarely reply and raise complaint
                        rates.
                      </p>
                    )}
                    {preview.free_mailboxes > 0 && (
                      <p>
                        <strong>{preview.free_mailboxes}</strong> personal
                        mailboxes (gmail, outlook…) rather than company domains.
                      </p>
                    )}
                  </div>
                </div>
              )}

              {preview.rejected.length > 0 && (
                <div className="rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-20">Row</TableHead>
                        <TableHead>Address</TableHead>
                        <TableHead>Rejected because</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.rejected.map((r) => (
                        <TableRow key={`${r.row}-${r.email}`}>
                          <TableCell className="tabular-nums">{r.row}</TableCell>
                          <TableCell className="font-mono text-xs">
                            {r.email || "(empty)"}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-xs">
                            {r.reason}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              <Button
                onClick={() => send(false)}
                disabled={busy !== null || preview.valid === 0}
              >
                {busy === "import" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="size-4" />
                )}
                Import {preview.valid} leads
              </Button>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "good" | "bad";
}) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p
        className={
          "text-2xl font-semibold tabular-nums " +
          (tone === "good"
            ? "text-emerald-600 dark:text-emerald-400"
            : tone === "bad"
              ? "text-red-600 dark:text-red-400"
              : "")
        }
      >
        {fmtNumber(value)}
      </p>
    </div>
  );
}
