"use client";

import { useState } from "react";
import { Table2 } from "lucide-react";
import { fmtNumber } from "@/lib/format";

export type FunnelStage = { label: string; value: number };

/**
 * Delivery funnel — horizontal bars on an ordinal single-hue ramp.
 *
 * Ordinal rather than categorical: the stages are one ordered sequence, not
 * five independent identities. Ramp validated light and dark with --ordinal.
 */
const RAMP = ["var(--f1)", "var(--f2)", "var(--f3)", "var(--f4)", "var(--f5)"];

export function FunnelChart({ stages }: { stages: FunnelStage[] }) {
  const [showTable, setShowTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);

  const top = Math.max(1, stages[0]?.value ?? 1);

  return (
    <div className="viz-root">
      <div className="mb-3 flex items-center justify-end">
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
              <th className="pb-2 font-medium">Stage</th>
              <th className="pb-2 text-right font-medium">Events</th>
              <th className="pb-2 text-right font-medium">% of sends</th>
              <th className="pb-2 text-right font-medium">Step conversion</th>
            </tr>
          </thead>
          <tbody>
            {stages.map((s, i) => {
              const prev = i > 0 ? stages[i - 1].value : s.value;
              return (
                <tr key={s.label} className="border-b last:border-0">
                  <td className="py-2">{s.label}</td>
                  <td className="py-2 text-right tabular-nums">
                    {fmtNumber(s.value)}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {((s.value / top) * 100).toFixed(1)}%
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {i === 0
                      ? "—"
                      : `${prev > 0 ? ((s.value / prev) * 100).toFixed(1) : "0.0"}%`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <div className="space-y-2.5">
          {stages.map((s, i) => {
            const pct = (s.value / top) * 100;
            return (
              <div
                key={s.label}
                className="relative"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              >
                <div className="mb-1 flex items-baseline justify-between text-xs">
                  <span style={{ color: "var(--viz-ink-2)" }}>{s.label}</span>
                  {/* Direct label on every bar: only 5 marks, and it satisfies
                      the relief rule for the lighter ramp steps. */}
                  <span
                    className="font-medium tabular-nums"
                    style={{ color: "var(--viz-ink)" }}
                  >
                    {fmtNumber(s.value)}
                    <span
                      className="ml-2 font-normal"
                      style={{ color: "var(--viz-muted)" }}
                    >
                      {pct.toFixed(1)}%
                    </span>
                  </span>
                </div>

                <div
                  className="h-5 w-full overflow-hidden rounded-sm"
                  style={{ background: "var(--viz-grid)" }}
                >
                  <div
                    className="h-full rounded-r-[4px] transition-all"
                    style={{
                      width: `${Math.max(pct, 0.4)}%`,
                      background: RAMP[i % RAMP.length],
                      opacity: hover === null || hover === i ? 1 : 0.55,
                    }}
                  />
                </div>

                {hover === i && i > 0 && (
                  <div
                    className="pointer-events-none absolute right-0 -bottom-1 z-10 translate-y-full rounded-md border px-2 py-1 text-xs shadow-sm"
                    style={{
                      background: "var(--viz-surface)",
                      color: "var(--viz-ink)",
                      borderColor: "var(--viz-axis)",
                    }}
                  >
                    {(
                      (s.value / Math.max(1, stages[i - 1].value)) *
                      100
                    ).toFixed(1)}
                    % of {stages[i - 1].label.toLowerCase()}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
