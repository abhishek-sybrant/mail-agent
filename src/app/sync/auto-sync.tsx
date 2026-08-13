"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Check,
  Clock,
  Loader2,
  Minus,
  Play,
  Square,
  Timer,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchErrorMessage } from "@/lib/fetch-error";
import { cn } from "@/lib/utils";

export type PartResult = {
  part: string;
  ok: boolean;
  detail: string;
  ms: number;
  error?: string;
  skipped?: boolean;
};

export type SwitchState = {
  key: string;
  label: string;
  blurb: string;
  offWarning: string;
  on: boolean;
  changedAt: string | null;
};

export type SyncStatus = {
  intervalMs: number;
  running: boolean;
  nextDueAt: string | null;
  switches: SwitchState[];
  last: {
    trigger: string;
    started_at: string;
    finished_at: string | null;
    ok: boolean;
    parts: PartResult[];
  } | null;
};

/** "42:17", or "0:09" — mm:ss, because an hourly timer never needs hours. */
function countdown(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours === 1 ? "an hour ago" : `${hours} hours ago`;
}

export function AutoSync({ initial }: { initial: SyncStatus }) {
  const router = useRouter();
  const [status, setStatus] = useState(initial);
  const [busy, setBusy] = useState(false);

  /**
   * Rendered only after mount.
   *
   * The remaining time is derived from the clock, so a server-rendered value
   * is stale by the time it reaches the browser and React would report a
   * hydration mismatch. Null until mounted, then it ticks.
   */
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    // No due time means no pass has completed yet; that is derived below
    // rather than stored, so there is nothing to tick.
    if (!status.nextDueAt) return;

    const at = new Date(status.nextDueAt).getTime();
    /**
     * Only the interval sets state — never the effect body.
     *
     * A synchronous first call would render twice on mount, and the value it
     * produced could not be computed during render anyway: it depends on the
     * clock, which differs between the server and the browser and would fail
     * hydration. The cost is that the countdown shows a placeholder for its
     * first second.
     */
    const t = setInterval(() => setRemaining(at - Date.now()), 1000);
    return () => clearInterval(t);
  }, [status.nextDueAt]);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/sync/run");
    if (res.ok) setStatus(await res.json());
  }, []);

  /**
   * Once the countdown passes zero the timer inside the server is about to
   * pick the pass up — within a minute, since that is how often it wakes. Poll
   * gently so the panel shows the new run rather than a stuck "0:00".
   */
  useEffect(() => {
    if (remaining === null || remaining > 0 || busy) return;
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [remaining, busy, refresh]);

  const [flipping, setFlipping] = useState<string | null>(null);

  async function flip(s: SwitchState) {
    setFlipping(s.key);
    try {
      const res = await fetch("/api/sync/switches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: s.key, on: !s.on }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not change that");

      setStatus((prev) => ({ ...prev, switches: json.switches }));
      if (s.on) {
        toast.warning(`${s.label} stopped.`, {
          description: s.offWarning,
          duration: 7000,
        });
      } else {
        toast.success(`${s.label} started — it runs again on the next pass.`);
      }
      router.refresh();
    } catch (error) {
      toast.error(fetchErrorMessage(error));
    } finally {
      setFlipping(null);
    }
  }

  async function runNow() {
    setBusy(true);
    try {
      const res = await fetch("/api/sync/run", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Sync failed");

      setStatus(json);
      const failed = (json.run.parts as PartResult[]).filter((p) => !p.ok);
      if (failed.length === 0) {
        toast.success("Sync complete — every part finished");
      } else {
        toast.warning(
          `${failed.length} of ${json.run.parts.length} parts failed: ${failed
            .map((p) => p.part)
            .join(", ")}`,
        );
      }
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Sync failed");
    } finally {
      setBusy(false);
    }
  }

  const every = Math.round(status.intervalMs / 60_000);
  // A missing due time means nothing has completed yet, so a pass is due now.
  const due = !status.nextDueAt || (remaining !== null && remaining <= 0);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Timer className="size-4" />
          Automatic sync
        </CardTitle>
        <span className="text-muted-foreground text-xs">every {every} min</span>
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-muted-foreground text-xs">
              {busy || status.running
                ? "Running now"
                : due
                  ? "Due — starting within a minute"
                  : "Next pass in"}
            </p>
            <p className="text-4xl font-semibold tabular-nums">
              {busy || status.running ? (
                <Loader2 className="size-8 animate-spin" />
              ) : due ? (
                "0:00"
              ) : remaining === null ? (
                "—:—"
              ) : (
                countdown(remaining)
              )}
            </p>
            {status.last && (
              <p className="text-muted-foreground mt-1 flex items-center gap-1 text-xs">
                <Clock className="size-3" />
                last run {ago(status.last.started_at)} ({status.last.trigger})
              </p>
            )}
          </div>

          <Button onClick={runNow} disabled={busy || status.running}>
            {busy || status.running ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Timer className="size-4" />
            )}
            Sync everything now
          </Button>
        </div>

        {/**
         * Per-part stops.
         *
         * Each one turns off a single job and leaves the timer running: the
         * only way to silence the forwarding used to be killing the whole
         * pass, which also stopped campaign windows being applied on time.
         */}
        <div className="divide-y rounded-md border">
          {status.switches.map((s) => (
            <div key={s.key} className="flex items-start gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {s.label}
                  {!s.on && (
                    <span className="text-destructive text-xs font-normal">
                      stopped
                    </span>
                  )}
                </p>
                <p className="text-muted-foreground text-xs">
                  {s.on ? s.blurb : s.offWarning}
                </p>
              </div>
              <Button
                size="sm"
                variant={s.on ? "outline" : "default"}
                disabled={flipping === s.key}
                onClick={() => flip(s)}
              >
                {flipping === s.key ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : s.on ? (
                  <Square className="size-4" />
                ) : (
                  <Play className="size-4" />
                )}
                {s.on ? "Stop" : "Start"}
              </Button>
            </div>
          ))}
        </div>

        {status.last ? (
          <div className="divide-y rounded-md border">
            {status.last.parts.map((p) => (
              <div key={p.part} className="flex items-start gap-3 px-3 py-2">
                {p.skipped ? (
                  <Minus className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                ) : p.ok ? (
                  <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                ) : (
                  <AlertCircle className="text-destructive mt-0.5 size-4 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{p.part}</p>
                  <p
                    className={cn(
                      "text-xs",
                      p.ok ? "text-muted-foreground" : "text-destructive",
                    )}
                  >
                    {p.error ?? p.detail}
                  </p>
                </div>
                {p.ms > 0 && (
                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                    {p.ms < 1000 ? `${p.ms}ms` : `${Math.round(p.ms / 1000)}s`}
                  </span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground rounded-md border border-dashed px-3 py-6 text-center text-sm">
            No pass has run yet. The first one starts within a minute of the
            server coming up.
          </p>
        )}

        <p className="text-muted-foreground text-xs">
          Each pass applies due campaign windows, mirrors campaigns and
          mailboxes, pulls the newest reply threads, labels and forwards them,
          then walks a slice of the lead list. The reply pull needs Edge open
          and signed in to QuickMail — the other parts do not.
        </p>
      </CardContent>
    </Card>
  );
}
