import Link from "next/link";
import { notFound } from "next/navigation";
import { Bot, ExternalLink, MessageSquare, User } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { prisma } from "@/lib/prisma";
import { cachedCampaigns } from "@/lib/quickmail/cached";
import { rate } from "@/lib/quickmail/queries";
import { fmtDateTime, fmtNumber } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * One campaign: its settings, its QuickMail numbers, and — when the AI agent
 * built it — the conversation that specified it.
 *
 * Keyed on the local Campaign id rather than QuickMail's, because only the
 * local row knows which chat produced it. QuickMail stats are read from the
 * cached mirror, never live: the API caps pages at 10 and rate-limits bursts,
 * so a page render must not touch it.
 */
export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: { agentConversation: true, template: true },
  });
  if (!campaign) notFound();

  // Match the QuickMail-side numbers, if this campaign reached QuickMail.
  const { campaigns } = await cachedCampaigns();
  const qm = campaign.quickmail_campaign_id
    ? campaigns.find((c) => c.id === campaign.quickmail_campaign_id)
    : undefined;

  const mailboxIds: string[] = (() => {
    try {
      return JSON.parse(campaign.mailbox_ids ?? "[]") as string[];
    } catch {
      return [];
    }
  })();
  const mailboxes =
    mailboxIds.length > 0
      ? await prisma.qmMailbox.findMany({
          where: { id: { in: mailboxIds } },
          select: { email: true, authorized: true, assignable: true },
        })
      : [];

  const messages = parseMessages(campaign.agentConversation?.messages);
  const spec = parseSpec(campaign.agentConversation?.spec);

  return (
    <>
      <PageHeader
        title={campaign.name}
        description={
          campaign.agentConversation
            ? "Built by the AI agent"
            : "Created in the campaign builder"
        }
        action={
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link href="/campaigns">Back</Link>
            </Button>
            {campaign.qm_app_url && (
              <Button asChild>
                <a href={campaign.qm_app_url} target="_blank" rel="noreferrer">
                  Open in QuickMail <ExternalLink className="ml-1 size-3.5" />
                </a>
              </Button>
            )}
          </div>
        }
      />

      <div className="grid gap-6 p-8 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Campaign</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Source">
              {campaign.agentConversation ? (
                <Badge variant="secondary" className="gap-1">
                  <Bot className="size-3" />
                  AI agent
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1">
                  <User className="size-3" />
                  Manual
                </Badge>
              )}
            </Row>
            <Row label="Local status">{campaign.status}</Row>
            <Row label="In QuickMail">
              {qm ? (qm.paused ? "Paused" : "Live") : "not found in the mirror"}
            </Row>
            <Row label="Created">{fmtDateTime(campaign.created_at)}</Row>
            {campaign.template && (
              <Row label="Template">{campaign.template.name}</Row>
            )}
            {campaign.schedule_state && (
              <Row label="Schedule">
                {campaign.schedule_state}
                {campaign.schedule_note ? ` · ${campaign.schedule_note}` : ""}
              </Row>
            )}
            <Row label="Sending mailboxes">
              {mailboxes.length === 0
                ? "none recorded"
                : mailboxes
                    .map(
                      (m) =>
                        `${m.email}${m.authorized === false ? " (unauthorized)" : ""}`,
                    )
                    .join(", ")}
            </Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">QuickMail numbers</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {qm ? (
              <>
                <Row label="Enrolled">{fmtNumber(qm.leadStatus?.total ?? 0)}</Row>
                <Row label="Sent">{fmtNumber(qm.stats.total)}</Row>
                <Row label="Delivered">{fmtNumber(qm.stats.delivered)}</Row>
                <Row label="Bounces">
                  {fmtNumber(qm.stats.bounces)} ·{" "}
                  {rate(qm.stats.bounces, qm.stats.total).toFixed(1)}%
                </Row>
                <Row label="Replies">
                  {fmtNumber(qm.stats.replies)} ·{" "}
                  {rate(qm.stats.replies, qm.stats.delivered).toFixed(1)}%
                </Row>
              </>
            ) : (
              <p className="text-muted-foreground">
                No cached QuickMail stats. Run a sync, or the campaign may not
                have been created there.
              </p>
            )}
          </CardContent>
        </Card>

        {/*
          The transcript is the point of this page for an agent-built campaign:
          it is the only record of what was actually asked for, as opposed to
          what ended up in QuickMail.
        */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageSquare className="size-4" />
              {campaign.agentConversation
                ? "The conversation that built this"
                : "No agent conversation"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {!campaign.agentConversation && (
              <p className="text-muted-foreground text-sm">
                This campaign was not created through the AI agent, so there is
                no chat to show. Campaigns built before the agent recorded its
                conversations also land here.
              </p>
            )}

            {campaign.agentConversation && (
              <>
                <p className="text-muted-foreground text-xs">
                  {/* One expression: a line break between "message" and "s"
                      renders as "message s". */}
                  {`${messages.length} ${
                    messages.length === 1 ? "message" : "messages"
                  } · last active ${fmtDateTime(campaign.agentConversation.updated_at)}`}
                </p>

                {messages.map((m, i) => (
                  <div
                    key={i}
                    className={
                      m.role === "user" ? "flex justify-end" : "flex gap-2"
                    }
                  >
                    {m.role === "agent" && (
                      <Bot className="text-primary mt-1 size-4 shrink-0" />
                    )}
                    <div
                      className={
                        "max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap " +
                        (m.role === "user"
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted")
                      }
                    >
                      {m.text}
                    </div>
                  </div>
                ))}

                {spec && (
                  <details className="rounded-md border p-3">
                    <summary className="cursor-pointer text-sm font-medium">
                      The settings the agent resolved
                    </summary>
                    <pre className="bg-muted mt-2 max-h-72 overflow-auto rounded-md p-3 text-xs">
                      {JSON.stringify(spec, null, 2)}
                    </pre>
                  </details>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b pb-2 last:border-0">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}

type Msg = { role: "user" | "agent"; text: string };

/** Stored as JSON text; a malformed row must not take the page down. */
function parseMessages(raw: string | undefined): Msg[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Msg[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseSpec(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}
