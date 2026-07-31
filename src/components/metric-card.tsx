import type { LucideIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Severity } from "@/lib/quickmail/queries";
import { fmtNumber } from "@/lib/format";

const TONE: Record<Severity, string> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  critical: "text-red-600 dark:text-red-400",
};

export function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
  severity = "ok",
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon: LucideIcon;
  severity?: Severity;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-muted-foreground text-sm font-medium">
          {label}
        </CardTitle>
        <Icon className={cn("size-4", severity === "ok" ? "text-muted-foreground" : TONE[severity])} />
      </CardHeader>
      <CardContent>
        <p className="text-3xl font-semibold tabular-nums">
          {typeof value === "number" ? fmtNumber(value) : value}
        </p>
        {hint && (
          <p className={cn("mt-1 text-xs", severity === "ok" ? "text-muted-foreground" : TONE[severity])}>
            {hint}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
