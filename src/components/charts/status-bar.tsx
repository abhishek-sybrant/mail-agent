"use client";

import { useState } from "react";
import { Table2 } from "lucide-react";
import { fmtNumber } from "@/lib/format";

export type StatusSlice = { label: string; value: number };

/**
 * Lead status mix — one horizontal stacked bar (part-to-whole).
 *
 * Categorical: the statuses are distinct identities, not an ordered scale.
 * Slots are assigned in the palette's fixed order and never cycled. A legend is
 * always present, and the table view covers the light-mode contrast relief rule.
 */
const SLOTS = [
  "var(--s1)",
  "var(--s2)",
  "var(--s3)",
  "var(--s4)",
  "var(--s5)",
  "var(--s6)",
];

export function StatusBar({ slices }: { slices: StatusSlice[] }) {
  const [showTable, setShowTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);

  const total = slices.reduce((a, s) => a + s.value, 0);
  const present = slices.filter((s) => s.value > 0);

  if (total === 0) {
    return (
      <p className="text-muted-foreground py-8 text-center text-sm">
        No leads yet.
      </p>
    );
  }

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
              <th className="pb-2 font-medium">Status</th>
              <th className="pb-2 text-right font-medium">Leads</th>
              <th className="pb-2 text-right font-medium">Share</th>
            </tr>
          </thead>
          <tbody>
            {slices.map((s) => (
              <tr key={s.label} className="border-b last:border-0">
                <td className="py-2">{s.label}</td>
                <td className="py-2 text-right tabular-nums">
                  {fmtNumber(s.value)}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {((s.value / total) * 100).toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <>
          {/* 2px surface gaps do the separating between segments — no strokes. */}
          <div className="flex h-6 w-full gap-[2px] overflow-hidden">
            {present.map((s) => {
              const idx = slices.indexOf(s);
              return (
                <div
                  key={s.label}
                  onMouseEnter={() => setHover(idx)}
                  onMouseLeave={() => setHover(null)}
                  className="h-full first:rounded-l-[4px] last:rounded-r-[4px] transition-opacity"
                  style={{
                    width: `${(s.value / total) * 100}%`,
                    background: SLOTS[idx % SLOTS.length],
                    opacity: hover === null || hover === idx ? 1 : 0.55,
                  }}
                  title={`${s.label}: ${fmtNumber(s.value)}`}
                />
              );
            })}
          </div>

          <div className="mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            {slices.map((s, i) => (
              <div
                key={s.label}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                className="flex items-center gap-2 text-xs"
              >
                <span
                  className="inline-block size-2.5 shrink-0 rounded-[2px]"
                  style={{ background: SLOTS[i % SLOTS.length] }}
                />
                <span className="flex-1" style={{ color: "var(--viz-ink-2)" }}>
                  {s.label}
                </span>
                <span
                  className="font-medium tabular-nums"
                  style={{ color: "var(--viz-ink)" }}
                >
                  {fmtNumber(s.value)}
                </span>
                <span
                  className="w-12 text-right tabular-nums"
                  style={{ color: "var(--viz-muted)" }}
                >
                  {((s.value / total) * 100).toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
