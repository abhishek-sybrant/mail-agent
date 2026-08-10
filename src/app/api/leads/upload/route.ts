import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { partitionSuppressed } from "@/lib/suppression";
import { guessMapping, parseUpload } from "@/lib/import/parse";
import { splitName, validateEmail } from "@/lib/import/validate";

export const maxDuration = 60;

type Mapping = Record<string, string>;

/**
 * POST /api/leads/upload  (multipart/form-data)
 *
 * fields: file, mapping (optional JSON), dryRun ("true" to preview only)
 *
 * A dry run returns the guessed column mapping plus per-row validation so the
 * user can see exactly what would be imported — and what would be rejected —
 * before anything is written.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "`file` is required" }, { status: 400 });
  }

  const dryRun = form.get("dryRun") === "true";

  let parsed;
  try {
    parsed = await parseUpload(file);
  } catch (error) {
    return NextResponse.json(
      { error: `Could not read the file: ${(error as Error).message}` },
      { status: 400 },
    );
  }

  const mappingRaw = form.get("mapping");
  const mapping: Mapping =
    typeof mappingRaw === "string" && mappingRaw
      ? (JSON.parse(mappingRaw) as Mapping)
      : guessMapping(parsed.columns);

  if (!mapping.email) {
    return NextResponse.json(
      {
        error: "No email column found. Map one explicitly.",
        columns: parsed.columns,
      },
      { status: 400 },
    );
  }

  const pick = (row: Record<string, unknown>, field: string) => {
    const col = mapping[field];
    if (!col) return null;
    const value = row[col];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };

  const seen = new Set<string>();
  const accepted: {
    email: string;
    name: string | null;
    first_name: string | null;
    last_name: string | null;
    company: string | null;
    title: string | null;
    phone: string | null;
    location: string | null;
    warnings: string[];
  }[] = [];
  const rejected: { row: number; email: string; reason: string }[] = [];
  let duplicates = 0;

  parsed.rows.forEach((row, i) => {
    const verdict = validateEmail(pick(row, "email"));

    if (!verdict.valid) {
      rejected.push({
        row: i + 2, // +2 so it lines up with the spreadsheet row number
        email: verdict.email || String(pick(row, "email") ?? ""),
        reason: verdict.reason ?? "Invalid",
      });
      return;
    }

    if (seen.has(verdict.email)) {
      duplicates++;
      return;
    }
    seen.add(verdict.email);

    const full = pick(row, "name");
    const split = splitName(full);

    accepted.push({
      email: verdict.email,
      name:
        full ??
        ([pick(row, "first_name"), pick(row, "last_name")]
          .filter(Boolean)
          .join(" ") ||
          null),
      first_name: pick(row, "first_name") ?? split.first,
      last_name: pick(row, "last_name") ?? split.last,
      company: pick(row, "company"),
      title: pick(row, "title"),
      phone: pick(row, "phone"),
      location: pick(row, "location"),
      warnings: verdict.warnings,
    });
  });

  const summary = {
    filename: file.name,
    kind: parsed.kind,
    columns: parsed.columns,
    mapping,
    total_rows: parsed.rows.length,
    valid: accepted.length,
    invalid: rejected.length,
    duplicates_in_file: duplicates,
    role_addresses: accepted.filter((a) =>
      a.warnings.some((w) => w.startsWith("Role")),
    ).length,
    free_mailboxes: accepted.filter((a) =>
      a.warnings.some((w) => w.startsWith("Personal")),
    ).length,
  };

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      ...summary,
      preview: accepted.slice(0, 10),
      rejected: rejected.slice(0, 25),
    });
  }

  const batch = await prisma.importBatch.create({
    data: {
      filename: file.name,
      source: parsed.kind,
      total_rows: parsed.rows.length,
      imported: 0,
      duplicates,
      invalid: rejected.length,
    },
  });

  // Filter against addresses already in the database — the in-file dedupe
  // above can't see those, and the unique index would abort the whole insert.
  const existing = await prisma.lead.findMany({
    where: { email: { in: accepted.map((a) => a.email) } },
    select: { email: true },
  });
  const known = new Set(existing.map((e) => e.email));
  const fresh = accepted.filter((a) => !known.has(a.email));

  /**
   * Flag known-dead addresses as they arrive.
   *
   * The row is still created — losing the contact record would hide the fact
   * that this file contains addresses we already know bounced — but it comes in
   * pre-suppressed so it can never be picked for a campaign. Without this a
   * re-uploaded spreadsheet resurrects every bad address with a clean
   * `suppressed: false`, which is how the same addresses came to bounce dozens
   * of times each.
   */
  const { blocked } = await partitionSuppressed(fresh.map((a) => a.email));
  const barred = new Map(blocked.map((b) => [b.email, b]));

  const created = await prisma.lead.createMany({
    data: fresh.map((a) => {
      const hit = barred.get(a.email.trim().toLowerCase());
      return {
        email: a.email,
        name: a.name,
        first_name: a.first_name,
        last_name: a.last_name,
        company: a.company,
        title: a.title,
        phone: a.phone,
        location: a.location,
        source: parsed.kind,
        import_batch_id: batch.id,
        ...(hit
          ? {
              suppressed: true,
              suppressed_reason: `On the suppression list (${hit.reason}, ${hit.hits}x)`,
              status: hit.reason === "BOUNCE" ? ("BOUNCED" as const) : ("DNC" as const),
              ai_intent_score: 0,
            }
          : {}),
      };
    }),
  });

  // A repeat means this file re-introduced an address already known to be dead.
  if (barred.size > 0) {
    await prisma.suppression.updateMany({
      where: { email: { in: [...barred.keys()] } },
      data: { hits: { increment: 1 } },
    });
  }

  await prisma.importBatch.update({
    where: { id: batch.id },
    data: {
      imported: created.count,
      duplicates: duplicates + (accepted.length - created.count),
    },
  });

  /**
   * The ids of everyone in this file, so the caller can enrol exactly them.
   *
   * Looked up by address rather than by `import_batch_id`, because a row that
   * already existed keeps its original batch and would be missed — upload a
   * file of two addresses where one is already known and a batch-id query
   * returns one of the two. The user uploaded two and means two.
   *
   * Suppressed addresses are excluded here rather than at enrolment, so the
   * count offered matches the count that will actually send.
   */
  const inFile = await prisma.lead.findMany({
    where: { email: { in: accepted.map((a) => a.email) }, suppressed: false },
    select: { id: true },
  });

  return NextResponse.json({
    ok: true,
    dryRun: false,
    batch_id: batch.id,
    ...summary,
    imported: created.count,
    already_existed: accepted.length - created.count,
    suppressed_on_arrival: barred.size,
    // Every usable address from the file — new and pre-existing alike.
    lead_ids: inFile.map((l) => l.id),
    rejected: rejected.slice(0, 25),
  });
}
