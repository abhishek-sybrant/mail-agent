import { PageHeader } from "@/components/page-header";
import { ImportWizard } from "./import-wizard";

export default function ImportPage() {
  return (
    <>
      <PageHeader
        title="Import leads"
        description="Every address is validated before import — invalid ones never reach a campaign."
      />
      <div className="max-w-4xl p-8">
        <ImportWizard />
      </div>
    </>
  );
}
