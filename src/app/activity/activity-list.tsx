"use client";

import Link from "next/link";
import {
  Ban,
  Bot,
  CheckCircle2,
  Forward,
  PenSquare,
  Send,
  ShieldCheck,
  Timer,
  UserRound,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { actionLabel } from "@/lib/activity-labels";
import { fmtDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export type ActivityRow = {
  id: string;
  at: string;
  action: string;
  subject: string;
  detail: string | null;
  /** Null when the hourly sync did it rather than a person. */
  who: string | null;
  whoId: string | null;
};

/** An icon per action, so the column scans without reading every line. */
const ICON: Record<string, typeof Send> = {
  "campaign.create": Send,
  "campaign.trigger": Timer,
  "reply.send": Send,
  "prospect.stop": Ban,
  "thread.done": CheckCircle2,
  "thread.forward": Forward,
  "block.add": Ban,
  "block.remove": ShieldCheck,
  "manager.add": UserRound,
  "manager.pause": UserRound,
  "manager.remove": UserRound,
  "template.save": PenSquare,
  "approval.decide": CheckCircle2,
  "sync.switch": Timer,
};

/** The ones worth colouring: anything that reaches a real person. */
const OUTWARD = new Set(["campaign.create", "reply.send", "thread.forward"]);

export function ActivityList({
  items,
  action,
  who,
  actionCounts,
  peopleCounts,
  total,
}: {
  items: ActivityRow[];
  action: string;
  who: string;
  actionCounts: { action: string; count: number }[];
  peopleCounts: { id: string; label: string; count: number }[];
  total: number;
}) {
  const href = (over: Record<string, string>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ action, who, ...over })) if (v) p.set(k, v);
    const qs = p.toString();
    return `/activity${qs ? `?${qs}` : ""}`;
  };

  return (
    <div className="space-y-4">
      {/* Who, then what. Both live in the URL so a view can be shared. */}
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={href({ who: "" })}
          className={cn(
            "rounded-full px-3 py-1 text-xs",
            who === ""
              ? "bg-primary text-primary-foreground font-medium"
              : "hover:bg-accent border",
          )}
        >
          Everyone <span className="ml-1 tabular-nums">{total}</span>
        </Link>
        {peopleCounts.map((p) => (
          <Link
            key={p.id}
            href={href({ who: p.id })}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs",
              who === p.id
                ? "bg-primary text-primary-foreground font-medium"
                : "hover:bg-accent border",
            )}
          >
            {p.id === "system" ? (
              <Bot className="size-3.5" />
            ) : (
              <UserRound className="size-3.5" />
            )}
            {p.label} <span className="tabular-nums">{p.count}</span>
          </Link>
        ))}
      </div>

      {actionCounts.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Link
            href={href({ action: "" })}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-[11px]",
              action === "" ? "border-primary text-primary font-medium" : "hover:bg-accent",
            )}
          >
            All actions
          </Link>
          {actionCounts.map((a) => (
            <Link
              key={a.action}
              href={href({ action: a.action })}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-[11px]",
                action === a.action
                  ? "border-primary text-primary font-medium"
                  : "hover:bg-accent",
              )}
            >
              {actionLabel(a.action)} <span className="tabular-nums">{a.count}</span>
            </Link>
          ))}
        </div>
      )}

      {items.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground py-16 text-center text-sm">
            Nothing recorded here yet.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="divide-y p-0">
            {items.map((r) => {
              const Icon = ICON[r.action] ?? CheckCircle2;
              return (
                <div key={r.id} className="flex items-start gap-3 px-4 py-3">
                  <Icon
                    className={cn(
                      "mt-0.5 size-4 shrink-0",
                      OUTWARD.has(r.action) ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">
                      <span className="font-medium">
                        {r.who ?? "The hourly sync"}
                      </span>{" "}
                      {!r.whoId && r.who && (
                        <span className="text-muted-foreground text-xs">
                          (account removed){" "}
                        </span>
                      )}
                      <span className="text-muted-foreground">
                        {actionLabel(r.action).toLowerCase()}
                      </span>{" "}
                      <span className="font-medium break-all">{r.subject}</span>
                    </p>
                    {r.detail && (
                      <p className="text-muted-foreground text-xs">{r.detail}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {!r.who && (
                      <Badge variant="outline" className="text-xs">
                        automatic
                      </Badge>
                    )}
                    <span className="text-muted-foreground text-xs whitespace-nowrap">
                      {fmtDateTime(r.at)}
                    </span>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {items.length >= 300 && (
        <p className="text-muted-foreground text-xs">
          Showing the most recent 300. Narrow by person or action to see further
          back.
        </p>
      )}
    </div>
  );
}
