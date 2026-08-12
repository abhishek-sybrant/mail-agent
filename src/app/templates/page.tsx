import { PageHeader } from "@/components/page-header";
import { prisma } from "@/lib/prisma";
import { KINDS } from "@/lib/template-kinds";
import { TemplateStudio, type TemplateRow } from "./template-studio";

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const rows = await prisma.template.findMany({
    orderBy: [{ kind: "asc" }, { category: "asc" }, { step: "asc" }],
  });

  const templates: TemplateRow[] = rows.map((t) => ({
    id: t.id,
    name: t.name,
    subject: t.subject,
    body: t.body,
    step: t.step,
    kind: t.kind,
    category: t.category,
    source: t.source,
  }));

  // Service lines already in use, so the editor can offer them instead of
  // making someone retype a name that has to match exactly to group.
  const lines = [
    ...new Set(rows.map((t) => t.category).filter((c): c is string => Boolean(c))),
  ].sort();

  const counted = KINDS.map(
    (k) => `${templates.filter((t) => t.kind === k.value).length} ${k.short}`,
  ).join(" · ");

  return (
    <>
      <PageHeader title="Templates" description={counted} />
      <div className="p-8">
        <TemplateStudio templates={templates} serviceLines={lines} />
      </div>
    </>
  );
}
