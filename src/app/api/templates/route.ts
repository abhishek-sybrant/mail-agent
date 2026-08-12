import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { badRequest, optionalString, readJson } from "@/lib/webhook";

/** Kept in step with the TemplateKind enum in the schema. */
const KINDS = [
  "FIRST_MAIL",
  "FOLLOW_UP",
  "POSITIVE_REPLY",
  "NEGATIVE_REPLY",
] as const;
type Kind = (typeof KINDS)[number];

function readKind(value: unknown): Kind | null {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value)
    ? (value as Kind)
    : null;
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ?kind=FOLLOW_UP narrows the list for the campaign builder's step pickers.
  const kind = readKind(new URL(request.url).searchParams.get("kind"));

  const templates = await prisma.template.findMany({
    where: kind ? { kind } : {},
    orderBy: [{ category: "asc" }, { step: "asc" }, { created_at: "desc" }],
  });
  return NextResponse.json({ templates });
}

/** Creates a template, or updates it in place when an `id` is supplied. */
export async function POST(request: Request) {
  /**
   * Writes need a session.
   *
   * This route was the one template endpoint without a check, so anyone who
   * could reach the port could rewrite the approved copy that campaigns send.
   */
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const name = optionalString(parsed.data.name);
  const subject = optionalString(parsed.data.subject);
  const body = optionalString(parsed.data.body);
  const id = optionalString(parsed.data.id);
  const category = optionalString(parsed.data.category);
  const kind = readKind(parsed.data.kind);

  if (!name || !subject || !body) {
    return badRequest("`name`, `subject` and `body` are all required");
  }
  if (parsed.data.kind !== undefined && !kind) {
    return badRequest(`\`kind\` must be one of ${KINDS.join(", ")}`);
  }

  /**
   * An omitted field leaves the stored value alone rather than clearing it.
   * The editor sends the whole draft, but the campaign builder saves without a
   * service line, and that must not wipe the one a .docx brief set.
   */
  const data = {
    name,
    subject,
    body,
    ...(kind ? { kind } : {}),
    ...(category !== null ? { category } : {}),
  };

  const template = id
    ? await prisma.template.update({ where: { id }, data })
    : await prisma.template.create({ data });

  return NextResponse.json({ ok: true, template });
}
