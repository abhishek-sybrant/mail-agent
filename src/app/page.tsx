import Link from "next/link";
import {
  AlertTriangle,
  Eye,
  MailWarning,
  MessageSquare,
  MousePointerClick,
  Send,
  TriangleAlert,
} from "lucide-react";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { BounceBars } from "@/components/charts/bounce-bars";
import { FunnelChart } from "@/components/charts/funnel";
import { StatusBar } from "@/components/charts/status-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { prisma } from "@/lib/prisma";
import { cachedCampaigns, relativeTime } from "@/lib/quickmail/cached";
import { isConfigured } from "@/lib/quickmail/client";
import {
  aggregate,
  bounceSeverity,
  rate,
  replySeverity,
  type QmCampaign,
} from "@/lib/quickmail/queries";
import { cn } from "@/lib/utils";
import { fmtNumber } from "@/lib/format";

export const dynamic = "force-dynamic";

const LEAD_STATUSES = [
  "UNCONTACTED",
  "EMAILED",
  "REPLIED",
  "BOUNCED",
  "DNC",
  "MEETING_BOOKED",
] as const;

export default async function DashboardPage() {
  if (!isConfigured()) return <NotConfigured />;

  // Read the local mirror, never the API — see lib/quickmail/cached.ts.
  const { campaigns, syncedAt } = await cachedCampaigns();
  if (campaigns.length === 0) return <NeedsSync />;

  const statusCounts = await prisma.lead.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  const statusMap = new Map(
    statusCounts.map((s) => [s.status as string, s._count._all]),
  );

  const totals = aggregate(campaigns);
  const bounceRate = rate(totals.bounces, totals.total);
  const replyRate = rate(totals.replies, totals.delivered);
  const openRate = rate(totals.opens, totals.delivered);
  const clickRate = rate(totals.clicks, totals.delivered);

  const atRisk = campaigns
    .map((c) => ({ c, br: rate(c.stats.bounces, c.stats.total) }))
    .filter(({ br, c }) => br >= 5 && c.stats.total >= 20)
    .sort((a, b) => b.br - a.br);
  const atRiskShown = atRisk.slice(0, 5);

  // 271 campaigns have sent mail; charting every one is unreadable and slow.
  // Cap at the worst 15 and state the cap rather than silently truncating.
  const allBounceRows = campaigns
    .filter((c) => c.stats.total >= 50)
    .map((c) => ({
      name: c.name,
      rate: rate(c.stats.bounces, c.stats.total),
      bounces: c.stats.bounces,
      sent: c.stats.total,
    }))
    .sort((a, b) => b.rate - a.rate);
  const bounceRows = allBounceRows.slice(0, 15);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`Across ${campaigns.length} QuickMail campaigns · synced ${relativeTime(syncedAt)}`}
        action={
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link href="/sync">Sync</Link>
            </Button>
            <Button asChild>
              <Link href="/campaigns/new">Create campaign</Link>
            </Button>
          </div>
        }
      />

      <div className="space-y-6 p-8">
        {atRisk.length > 0 && (
          <Card className="border-red-300 bg-red-50/60 dark:border-red-900 dark:bg-red-950/30">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base text-red-700 dark:text-red-400">
                <TriangleAlert className="size-4" />
                Deliverability at risk
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-sm text-red-700/90 dark:text-red-300/90">
                {atRisk.length} campaign{atRisk.length === 1 ? "" : "s"} above a
                5% bounce rate. Mailbox providers throttle or block sending
                domains at this level — pause and clean these lists before
                sending more.
              </p>
              {atRiskShown.map(({ c, br }) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between gap-4 border-t border-red-200 py-2 text-sm dark:border-red-900"
                >
                  <span className="truncate font-medium">{c.name}</span>
                  <span className="shrink-0 font-semibold tabular-nums text-red-700 dark:text-red-400">
                    {br.toFixed(1)}% · {fmtNumber(c.stats.bounces)} bounce
                    events
                  </span>
                </div>
              ))}

              {atRisk.length > atRiskShown.length && (
                <p className="border-t border-red-200 pt-2 text-xs font-medium text-red-700/90 dark:border-red-900 dark:text-red-300/90">
                  Showing the worst {atRiskShown.length}.{" "}
                  {atRisk.length - atRiskShown.length} more campaigns are also
                  above 5%.
                </p>
              )}
            </CardContent>
          </Card>
        )}

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <MetricCard
            label="Send events"
            value={totals.total}
            hint={`${fmtNumber(totals.delivered)} delivered`}
            icon={Send}
          />
          <MetricCard
            label="Bounce events"
            value={totals.bounces}
            hint={`${bounceRate.toFixed(1)}% of sends — not unique addresses`}
            icon={MailWarning}
            severity={bounceSeverity(bounceRate)}
          />
          <MetricCard
            label="Reply events"
            value={totals.replies}
            hint={`${replyRate.toFixed(2)}% of delivered`}
            icon={MessageSquare}
            severity={replySeverity(replyRate)}
          />
          <MetricCard
            label="Open events"
            value={totals.opens}
            hint={`${openRate.toFixed(1)}% of delivered`}
            icon={Eye}
          />
          <MetricCard
            label="Click events"
            value={totals.clicks}
            hint={`${clickRate.toFixed(1)}% of delivered`}
            icon={MousePointerClick}
          />
          <MetricCard
            label="Unsubscribe events"
            value={totals.unsubscribes}
            hint={`${totals.repliesPositive} replies marked positive`}
            icon={MessageSquare}
          />
        </div>

        <p className="text-muted-foreground -mt-2 text-xs">
          These count <strong>events, not people</strong>. A lead enrolled in
          several campaigns is counted once per send, so a dead address that
          sits in 40 lists produces 40 bounce events. QuickMail&apos;s own
          dashboard de-duplicates to unique contacts, which is why its figures
          are much smaller — both are correct, they answer different questions.
        </p>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Delivery funnel</CardTitle>
              <p className="text-muted-foreground text-xs">
                Event counts across all {campaigns.length} campaigns.
              </p>
            </CardHeader>
            <CardContent>
              <FunnelChart
                stages={[
                  { label: "Sent", value: totals.total },
                  { label: "Delivered", value: totals.delivered },
                  { label: "Opened", value: totals.opens },
                  { label: "Clicked", value: totals.clicks },
                  { label: "Replied", value: totals.replies },
                ]}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Lead status mix</CardTitle>
              <p className="text-muted-foreground text-xs">
                Local database, including everything synced from QuickMail.
              </p>
            </CardHeader>
            <CardContent>
              <StatusBar
                slices={LEAD_STATUSES.map((s) => ({
                  label: s.replace("_", " ").toLowerCase(),
                  value: statusMap.get(s) ?? 0,
                }))}
              />
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Bounce rate by campaign</CardTitle>
            <p className="text-muted-foreground text-xs">
              Worst {bounceRows.length} of {allBounceRows.length} campaigns
              with 50+ sends. Anything red is actively damaging your sending
              domains.
            </p>
          </CardHeader>
          <CardContent>
            <BounceBars rows={bounceRows} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">
              Busiest campaigns
            </CardTitle>
            <Button variant="outline" size="sm" asChild>
              <Link href="/campaigns">View all</Link>
            </Button>
          </CardHeader>
          <CardContent>
            <CampaignTable
              campaigns={[...campaigns]
                .sort(
                  (a, b) =>
                    Number(a.paused) - Number(b.paused) ||
                    b.stats.total - a.stats.total,
                )
                .slice(0, 20)}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}

export function CampaignTable({ campaigns }: { campaigns: QmCampaign[] }) {
  // Live first, then busiest — a paused campaign is rarely what you're after.
  const sorted = [...campaigns].sort(
    (a, b) =>
      Number(a.paused) - Number(b.paused) || b.stats.total - a.stats.total,
  );

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Campaign</TableHead>
            <TableHead>State</TableHead>
            <TableHead className="text-right">Enrolled</TableHead>
            <TableHead className="text-right">Sent</TableHead>
            <TableHead className="text-right">Open&nbsp;%</TableHead>
            <TableHead className="text-right">Reply&nbsp;%</TableHead>
            <TableHead className="text-right">Bounce&nbsp;%</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((c) => {
            const br = rate(c.stats.bounces, c.stats.total);
            const sev = bounceSeverity(br);
            return (
              <TableRow key={c.id}>
                <TableCell className="max-w-[22rem] font-medium">
                  <span className="block truncate" title={c.name}>
                    {c.name}
                  </span>
                </TableCell>
                <TableCell>
                  <Badge
                    variant="secondary"
                    className={cn(
                      "border-transparent",
                      c.paused
                        ? "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                        : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
                    )}
                  >
                    {c.paused ? "Paused" : "Live"}
                  </Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {fmtNumber((c.leadStatus?.total ?? 0))}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {fmtNumber(c.stats.total)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {rate(c.stats.opens, c.stats.delivered).toFixed(1)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {rate(c.stats.replies, c.stats.delivered).toFixed(2)}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right font-medium tabular-nums",
                    sev === "critical" && "text-red-600 dark:text-red-400",
                    sev === "warn" && "text-amber-600 dark:text-amber-400",
                  )}
                >
                  {br.toFixed(1)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function NotConfigured() {
  return (
    <>
      <PageHeader title="Dashboard" />
      <div className="p-8">
        <Card>
          <CardContent className="text-muted-foreground py-12 text-center text-sm">
            Set <code className="text-foreground">QUICKMAIL_API_KEY</code> in{" "}
            <code className="text-foreground">.env</code> to load live data.
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function NeedsSync() {
  return (
    <>
      <PageHeader title="Dashboard" />
      <div className="p-8">
        <Card className="border-amber-300 dark:border-amber-900">
          <CardContent className="space-y-3 py-10 text-center">
            <AlertTriangle className="mx-auto size-5 text-amber-600" />
            <p className="text-sm font-medium">No campaign data yet</p>
            <p className="text-muted-foreground text-xs">
              Pull your campaigns in from QuickMail to populate the dashboard.
            </p>
            <Button asChild size="sm">
              <Link href="/sync">Go to sync</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
