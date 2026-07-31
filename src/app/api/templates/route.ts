import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { badRequest, optionalString, readJson } from "@/lib/webhook";

export async function GET() {
  const templates = await prisma.template.findMany({
    orderBy: { created_at: "desc" },
  });
  return NextResponse.json({ templates });
}

/** Creates a template, or updates it in place when an `id` is supplied. */
export async function POST(request: Request) {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const name = optionalString(parsed.data.name);
  const subject = optionalString(parsed.data.subject);
  const body = optionalString(parsed.data.body);
  const id = optionalString(parsed.data.id);

  if (!name || !subject || !body) {
    return badRequest("`name`, `subject` and `body` are all required");
  }

  const template = id
    ? await prisma.template.update({
        where: { id },
        data: { name, subject, body },
      })
    : await prisma.template.create({ data: { name, subject, body } });

  return NextResponse.json({ ok: true, template });
}
