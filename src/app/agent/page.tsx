import { PageHeader } from "@/components/page-header";
import { prisma } from "@/lib/prisma";
import { aiStatus } from "@/lib/ai/provider";
import { cachedMailboxes } from "@/lib/quickmail/cached";
import { AgentChat } from "./agent-chat";

export const dynamic = "force-dynamic";

export default async function AgentPage() {
  const [status, { mailboxes }, templates] = await Promise.all([
    aiStatus("agent"),
    cachedMailboxes(),
    prisma.template.findMany({
      orderBy: [{ category: "asc" }, { step: "asc" }],
      select: {
        id: true,
        name: true,
        subject: true,
        body: true,
        category: true,
        step: true,
      },
    }),
  ]);

  return (
    <>
      <PageHeader
        title="AI Agent"
        description="Describe a campaign in plain language and the agent assembles it."
      />
      <div className="max-w-3xl px-8 pb-4">
        <AgentChat
          aiReady={status.reachable}
          aiDetail={status.detail}
          aiModel={status.model}
          mailboxes={mailboxes}
          templates={templates}
        />
      </div>
    </>
  );
}
