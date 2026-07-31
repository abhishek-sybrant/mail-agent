import { PageHeader } from "@/components/page-header";
import { aiStatus } from "@/lib/ai/provider";
import { BuildWizard } from "./build-wizard";

export const dynamic = "force-dynamic";

export default async function BuildCampaignPage() {
  const status = await aiStatus();

  return (
    <>
      <PageHeader
        title="Build a campaign"
        description="Describe it in a sentence, answer a few questions, and the app assembles it."
      />
      <div className="max-w-3xl p-8">
        <BuildWizard
          aiReady={status.reachable}
          aiDetail={status.detail}
          aiModel={status.model}
        />
      </div>
    </>
  );
}
