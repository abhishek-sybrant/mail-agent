"use client";

import { useState } from "react";
import { Table2, TriangleAlert } from "lucide-react";
import { fmtNumber } from "@/lib/format";

export type BounceRow = {
  name: string;
  rate: number;
  bounces: number;
  sent: number;
};

/**
 * Bounce rate by campaign — emphasis form, not categorical.
 *
 * The story is "which campaigns are over the line", so healthy campaigns sit in
 * the de-emphasis gray and only breaches take a status colour. Status never
 * carries meaning alone here: every breach also gets a warning icon and a
 * "critical"/"elevated" text label.
 */
const CRITICAL = 5;
const WARN = 2;

export function BounceBars({ rows }: { rows: BounceRow[] }) {
  const [showTable, setShowTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);

  const max = Math.max(10, ...rows.map((r) => r.rate));

  const tone = (rate: number) =>
    rate >= CRITICAL
      ? { fill: "var(--st-critical)", label: "critical" }
      : rate >= WARN
        ? { fill: "var(--st-warning)", label: "elevated" }
        : { fill: "var(--viz-deemph)", label: "healthy" };

  return (
    <div className="viz-root">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-4 text-xs">
          <Key fill="var(--st-critical)" label={`Critical ≥${CRITICAL}%`} />
          <Key fill="var(--st-warning)" label={`Elevated ≥${WARN}%`} />
          <Key fill="var(--viz-deemph)" label="Healthy" />
        </div>
        <button
          onClick={() => setShowTable((s) => !s)}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-xs"
        >
          <Table2 className="size-3.5" />
          {showTable ? "Show chart" : "Show table"}
        </button>
      </div>

      {showTable ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted-foreground border-b text-left text-xs">
              <th className="pb-2 font-medium">Campaign</th>
              <th className="pb-2 text-right font-medium">Sent</th>
              <th className="pb-2 text-right font-medium">Bounce events</th>
              <th className="pb-2 text-right font-medium">Rate</th>
              <th className="pb-2 text-right font-medium">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-b last:border-0">
                <td className="max-w-[18rem] truncate py-2" title={r.name}>
                  {r.name}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {fmtNumber(r.sent)}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {fmtNumber(r.bounces)}
                </td>
                <td className="py-2 text-right font-medium tabular-nums">
                  {r.rate.toFixed(1)}%
                </td>
                <td className="py-2 text-right capitalize">
                  {tone(r.rate).label}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="space-y-2.5">
          {rows.map((r, i) => {
            const t = tone(r.rate);
            const pct = (r.rate / max) * 100;
            return (
              <div
                key={r.name}
                className="relative"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              >
                <div className="mb-1 flex items-baseline justify-between gap-4 text-xs">
                  <span
                    className="flex min-w-0 items-center gap-1.5"
                    style={{ color: "var(--viz-ink-2)" }}
                  >
                    {r.rate >= CRITICAL && (
                      <TriangleAlert
                        className="size-3.5 shrink-0"
                        style={{ color: "var(--st-critical)" }}
                      />
                    )}
                    <span className="truncate" title={r.name}>
                      {r.name}
                    </span>
                  </span>
                  <span
                    className="shrink-0 font-medium tabular-nums"
                    style={{ color: "var(--viz-ink)" }}
                  >
                    {r.rate.toFixed(1)}%
                  </span>
                </div>

                <div className="relative h-5">
                  <div
                    className="absolute inset-0 rounded-sm"
                    style={{ background: "var(--viz-grid)" }}
                  />
                  {/* 5% threshold reference — a hairline, never dashed. */}
                  <div
                    className="absolute top-0 bottom-0 w-px"
                    style={{
                      left: `${(CRITICAL / max) * 100}%`,
                      background: "var(--viz-axis)",
                    }}
                  />
                  <div
                    className="absolute top-0 bottom-0 left-0 rounded-r-[4px] transition-all"
                    style={{
                      width: `${Math.max(pct, 0.4)}%`,
                      background: t.fill,
                      opacity: hover === null || hover === i ? 1 : 0.55,
                    }}
                  />
                </div>

                {hover === i && (
                  <div
                    className="pointer-events-none absolute right-0 -bottom-1 z-10 translate-y-full rounded-md border px-2 py-1 text-xs whitespace-nowrap shadow-sm"
                    style={{
                      background: "var(--viz-surface)",
                      color: "var(--viz-ink)",
                      borderColor: "var(--viz-axis)",
                    }}
                  >
                    {fmtNumber(r.bounces)} bounce events of{" "}
                    {fmtNumber(r.sent)} sends · {t.label}
                  </div>
                )}
              </div>
            );
          })}
          <p className="pt-1 text-xs" style={{ color: "var(--viz-muted)" }}>
            Hairline marks the {CRITICAL}% threshold where mailbox providers
            begin throttling a sending domain.
          </p>
        </div>
      )}
    </div>
  );
}

function Key({ fill, label }: { fill: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="inline-block size-2.5 rounded-[2px]"
        style={{ background: fill }}
      />
      <span style={{ color: "var(--viz-ink-2)" }}>{label}</span>
    </span>
  );
}
