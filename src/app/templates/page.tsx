import { PageHeader } from "@/components/page-header";
import { prisma } from "@/lib/prisma";
import { TemplateStudio, type TemplateRow } from "./template-studio";

export const dynamic = "force-dynamic";

export type TemplateGroup = {
  category: string;
  geography: string[];
  industry: string[];
  templates: TemplateRow[];
};

/** Parses the JSON columns written by the .docx importer, tolerating nulls. */
function jsonList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export default async function TemplatesPage() {
  const rows = await prisma.template.findMany({
    orderBy: [{ category: "asc" }, { step: "asc" }, { created_at: "desc" }],
  });

  // Group by service line so the three-email sequences stay together, with
  // anything hand-written or AI-generated collected at the end.
  const map = new Map<string, TemplateGroup>();

  for (const t of rows) {
    const category = t.category ?? "Uncategorised";
    if (!map.has(category)) {
      map.set(category, {
        category,
        geography: jsonList(t.geography),
        industry: jsonList(t.industry),
        templates: [],
      });
    }
    map.get(category)!.templates.push({
      id: t.id,
      name: t.name,
      subject: t.subject,
      body: t.body,
      step: t.step,
      category: t.category,
      source: t.source,
    });
  }

  const groups = [...map.values()].sort((a, b) =>
    a.category === "Uncategorised"
      ? 1
      : b.category === "Uncategorised"
        ? -1
        : a.category.localeCompare(b.category),
  );

  return (
    <>
      <PageHeader
        title="Templates"
        description={`${rows.length} templates across ${groups.length} service lines`}
      />
      <div className="p-8">
        <TemplateStudio groups={groups} />
      </div>
    </>
  );
}
