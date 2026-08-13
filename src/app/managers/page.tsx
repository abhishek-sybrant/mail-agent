import { PageHeader } from "@/components/page-header";
import { prisma } from "@/lib/prisma";
import { listManagers } from "@/lib/managers";
import { forwardScope } from "@/lib/forward-reply";
import { switchStates } from "@/lib/sync/switches";
import { ManagersList } from "./managers-list";

export const dynamic = "force-dynamic";

/**
 * Who receives forwarded replies, and whether they are being sent at all.
 *
 * Both live here rather than split between .env and the Sync tab: stopping the
 * forwarding is a decision about the people on this page, not about how often
 * the sync runs.
 */
export default async function ManagersPage() {
  const scope = forwardScope();

  const [managers, switches, queued] = await Promise.all([
    listManagers(),
    switchStates(),
    prisma.qmConversation.count({
      where: {
        handled_at: null,
        forwarded_at: null,
        messages: { some: { direction: "IN" } },
        ...(scope === "all" ? {} : { is_ooo: false }),
      },
    }),
  ]);

  const forwarding = switches.find((s) => s.key === "sync.forward") ?? null;
  const batch = Math.min(Math.max(Number(process.env.FORWARD_BATCH) || 5, 1), 100);
  const active = managers.filter((m) => m.active).length;
  const stopped = Boolean(forwarding && !forwarding.on);

  return (
    <>
      <PageHeader
        title="Managers"
        description={
          // Stopped outranks everyone's individual state: with the switch off
          // nobody receives anything, whatever their own row says.
          stopped
            ? `Forwarding is stopped — nobody is receiving, and ${queued} ${queued === 1 ? "reply is" : "replies are"} waiting.`
            : active === 0
              ? "Nobody is receiving forwarded replies yet."
              : `${active} ${active === 1 ? "person receives" : "people receive"} every real reply, ${queued} still waiting.`
        }
      />
      <div className="p-8">
        <ManagersList
          managers={managers}
          forwarding={forwarding}
          queued={queued}
          batch={batch}
        />
      </div>
    </>
  );
}
