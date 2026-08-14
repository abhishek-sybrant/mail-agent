import { PageHeader } from "@/components/page-header";
import { prisma } from "@/lib/prisma";
import { ActivityList, type ActivityRow } from "./activity-list";

export const dynamic = "force-dynamic";

/**
 * Who did what, and when.
 *
 * Nothing recorded this before: a campaign appeared and there was no way to
 * ask who built it, short of asking around. Every outward-facing action now
 * writes a line here — created, replied, stopped, blocked, forwarded.
 */
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; who?: string }>;
}) {
  const params = await searchParams;
  const action = params.action?.trim() ?? "";
  const who = params.who?.trim() ?? "";

  const where = {
    ...(action ? { action } : {}),
    ...(who === "system" ? { user_id: null } : who ? { user_id: who } : {}),
  };

  const [rows, actions, people, total] = await Promise.all([
    prisma.activityLog.findMany({
      where,
      orderBy: { at: "desc" },
      take: 300,
      include: { user: { select: { id: true, email: true, name: true } } },
    }),
    prisma.activityLog.groupBy({ by: ["action"], _count: { _all: true } }),
    prisma.activityLog.groupBy({ by: ["user_id"], _count: { _all: true } }),
    prisma.activityLog.count(),
  ]);

  const items: ActivityRow[] = rows.map((r) => ({
    id: r.id,
    at: r.at.toISOString(),
    action: r.action,
    subject: r.subject,
    detail: r.detail,
    // The live account wins; the recorded name carries a deleted one.
    who: r.user ? (r.user.name ?? r.user.email) : r.actor,
    whoId: r.user_id,
  }));

  // Names for the "who" filter. One row per person, plus the unattended work.
  const users = await prisma.user.findMany({ select: { id: true, email: true, name: true } });
  const byId = new Map(users.map((u) => [u.id, u.name ?? u.email]));

  return (
    <>
      <PageHeader
        title="Activity"
        description={
          total === 0
            ? "Nothing recorded yet — actions from here on will appear."
            : `${total} action${total === 1 ? "" : "s"} recorded.`
        }
      />
      <div className="max-w-5xl p-8">
        <ActivityList
          items={items}
          action={action}
          who={who}
          actionCounts={actions
            .map((a) => ({ action: a.action, count: a._count._all }))
            .sort((a, b) => b.count - a.count)}
          peopleCounts={people
            .map((p) => ({
              id: p.user_id ?? "system",
              label: p.user_id ? (byId.get(p.user_id) ?? "an account since removed") : "the app itself",
              count: p._count._all,
            }))
            .sort((a, b) => b.count - a.count)}
          total={total}
        />
      </div>
    </>
  );
}
