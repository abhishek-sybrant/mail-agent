import { headers } from "next/headers";
import { PageHeader } from "@/components/page-header";
import { prisma } from "@/lib/prisma";
import { WebhookSetup, type TestLead } from "./webhook-setup";

export const dynamic = "force-dynamic";

export default async function WebhooksSettingsPage() {
  const secret = process.env.WEBHOOK_SECRET ?? "";

  // Prefer an explicit public URL; fall back to the request host so the page
  // is useful behind a tunnel without extra configuration.
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const baseUrl = (process.env.APP_URL ?? `${proto}://${host}`).replace(
    /\/$/,
    "",
  );

  const leads: TestLead[] = (
    await prisma.lead.findMany({
      where: { suppressed: false },
      orderBy: { created_at: "desc" },
      take: 50,
      select: { id: true, email: true, name: true },
    })
  ).map((l) => ({ id: l.id, email: l.email, name: l.name }));

  return (
    <>
      <PageHeader
        title="Reply webhook"
        description="Wire QuickMail replies into the AI triage pipeline via Zapier."
      />
      <div className="max-w-3xl p-8">
        <WebhookSetup
          baseUrl={baseUrl}
          secret={secret}
          hasSecret={secret.length > 0}
          leads={leads}
        />
      </div>
    </>
  );
}
