import Link from "next/link";
import { Bot, MessageSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { bounceSeverity, rate, type QmCampaign } from "@/lib/quickmail/queries";
import { cn } from "@/lib/utils";
import { fmtDateTime, fmtNumber } from "@/lib/format";

export type AgentBuilt = {
  /** Local Campaign id — what the detail page is keyed on. */
  id: string;
  name: string;
  createdAt: Date;
  quickmailId: string | null;
  conversationId: string | null;
  messageCount: number;
  prompt: string | null;
};

/**
 * Campaigns the AI agent built, listed apart from the rest.
 *
 * Separate rather than a badge in the main table because these are the ones
 * worth opening: each carries the conversation that specified it, which is the
 * only record of what was actually asked for. The main table is fed from
 * QuickMail's mirror and has no local id, so its rows cannot link anywhere.
 */
export function AgentCampaigns({
  built,
  qm,
}: {
  built: AgentBuilt[];
  qm: QmCampaign[];
}) {
  if (built.length === 0) return null;

  const byQmId = new Map(qm.map((c) => [c.id, c]));

  return (
    <Card className="border-primary/30 bg-primary/[0.03]">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Bot className="text-primary size-4" />
          Built by the AI agent
          <Badge variant="secondary">{built.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <p className="text-muted-foreground mb-3 text-xs">
          Open one to see its settings and the conversation that produced it.
        </p>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campaign</TableHead>
                <TableHead>Asked for</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Sent</TableHead>
                <TableHead className="text-right">Bounce&nbsp;%</TableHead>
                <TableHead className="text-right">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {built.map((b) => {
                const stats = b.quickmailId ? byQmId.get(b.quickmailId) : undefined;
                const br = stats
                  ? rate(stats.stats.bounces, stats.stats.total)
                  : null;
                return (
                  <TableRow key={b.id} className="hover:bg-accent/50">
                    <TableCell className="max-w-[16rem] font-medium">
                      <Link
                        href={`/campaigns/${b.id}`}
                        className="block truncate hover:underline"
                        title={b.name}
                      >
                        {b.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground max-w-[20rem] text-xs">
                      <span className="flex items-center gap-1.5">
                        {b.messageCount > 0 && (
                          <MessageSquare className="size-3 shrink-0" />
                        )}
                        <span className="truncate" title={b.prompt ?? ""}>
                          {b.prompt ?? "no chat recorded"}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell>
                      {stats ? (
                        <Badge variant={stats.paused ? "outline" : "default"}>
                          {stats.paused ? "Paused" : "Live"}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs">
                          not synced
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {stats ? fmtNumber(stats.stats.total) : "—"}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-right tabular-nums",
                        br !== null &&
                          bounceSeverity(br) === "critical" &&
                          "font-semibold text-red-600 dark:text-red-400",
                        br !== null &&
                          bounceSeverity(br) === "warn" &&
                          "text-amber-600 dark:text-amber-400",
                      )}
                    >
                      {br !== null ? `${br.toFixed(1)}%` : "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right text-xs">
                      {fmtDateTime(b.createdAt)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
