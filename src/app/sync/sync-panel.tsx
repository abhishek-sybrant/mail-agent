"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Database, Loader2, RefreshCw, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { fmtNumber } from "@/lib/format";

type Progress = {
  totalCount: number;
  done: number;
  imported: number;
  updated: number;
  cursor: string | null;
  hasNext: boolean;
};

/** Pages per request. 10 leads/page, so this is 2,000 leads a round trip. */
const PAGES_PER_CALL = 200;

export function SyncPanel({
  localLeads,
  localCampaigns,
  fromQuickmail,
}: {
  localLeads: number;
  localCampaigns: number;
  fromQuickmail: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"leads" | "campaigns" | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const stop = useRef(false);

  async function call(payload: Record<string, unknown>) {
    const res = await fetch("/api/quickmail/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "Sync failed");
    return json;
  }

  async function syncCampaigns() {
    setBusy("campaigns");
    try {
      const json = await call({ what: "campaigns" });
      toast.success(
        `${json.total} campaigns — ${json.imported} new, ${json.updated} updated`,
      );
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  /** Loops until QuickMail says there are no more pages, or the user stops. */
  async function syncLeads(resume = false) {
    setBusy("leads");
    stop.current = false;

    let cursor = resume ? (progress?.cursor ?? null) : null;
    let done = resume ? (progress?.done ?? 0) : 0;
    let imported = resume ? (progress?.imported ?? 0) : 0;
    let updated = resume ? (progress?.updated ?? 0) : 0;

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (stop.current) {
          toast.message("Stopped — press Resume to carry on where you left off");
          break;
        }

        const json = await call({
          what: "leads",
          cursor,
          maxPages: PAGES_PER_CALL,
        });

        cursor = json.cursor;
        done += json.processed;
        imported += json.imported;
        updated += json.updated;

        setProgress({
          totalCount: json.totalCount,
          done,
          imported,
          updated,
          cursor,
          hasNext: json.hasNext,
        });

        if (!json.hasNext) {
          toast.success(`Sync complete — ${imported} new leads imported`);
          router.refresh();
          break;
        }
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Sync failed");
    } finally {
      setBusy(null);
    }
  }

  const pct = progress
    ? Math.min(100, (progress.done / Math.max(1, progress.totalCount)) * 100)
    : 0;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Leads in local DB" value={localLeads} />
        <Stat label="Synced from QuickMail" value={fromQuickmail} />
        <Stat label="Campaigns mirrored" value={localCampaigns} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="size-4" />
            Import from QuickMail
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <p className="text-sm font-medium">Campaigns</p>
            <p className="text-muted-foreground text-xs">
              Fast — one request. Mirrors names, paused state and stats.
            </p>
            <Button
              variant="outline"
              onClick={syncCampaigns}
              disabled={busy !== null}
            >
              {busy === "campaigns" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Sync campaigns
            </Button>
          </div>

          <Separator />

          <div className="space-y-3">
            <p className="text-sm font-medium">Leads</p>
            <p className="text-muted-foreground text-xs">
              QuickMail caps its API at 10 leads per page, so a full import of
              48,000 leads is roughly 4,800 requests and takes about{" "}
              <strong>85 minutes</strong>. It&apos;s resumable — stopping and
              resuming picks up from the same cursor.
            </p>

            {progress && (
              <div className="space-y-1.5">
                <div className="bg-muted h-2 w-full overflow-hidden rounded-full">
                  <div
                    className="bg-primary h-full transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <p className="text-muted-foreground text-xs tabular-nums">
                  {fmtNumber(progress.done)} /{" "}
                  {fmtNumber(progress.totalCount)} ({pct.toFixed(1)}%) ·{" "}
                  {fmtNumber(progress.imported)} new ·{" "}
                  {fmtNumber(progress.updated)} matched
                </p>
              </div>
            )}

            <div className="flex gap-2">
              <Button
                onClick={() => syncLeads(false)}
                disabled={busy !== null}
              >
                {busy === "leads" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                {progress ? "Restart from beginning" : "Start full import"}
              </Button>

              {progress?.hasNext && busy === null && (
                <Button variant="outline" onClick={() => syncLeads(true)}>
                  Resume
                </Button>
              )}

              {busy === "leads" && (
                <Button
                  variant="outline"
                  onClick={() => {
                    stop.current = true;
                  }}
                >
                  <Square className="size-4" />
                  Stop
                </Button>
              )}
            </div>

            <p className="text-muted-foreground text-xs">
              Read-only — this never writes back to QuickMail. Keep this tab
              open while it runs.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-muted-foreground text-xs">{label}</p>
        <p className="text-3xl font-semibold tabular-nums">
          {fmtNumber(value)}
        </p>
      </CardContent>
    </Card>
  );
}
