import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const STYLES: Record<string, string> = {
  UNCONTACTED: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  EMAILED: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  REPLIED: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  BOUNCED: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  DNC: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant="secondary"
      className={cn("border-transparent font-medium", STYLES[status])}
    >
      {status}
    </Badge>
  );
}
