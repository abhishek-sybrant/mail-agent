import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { generateTemplate, type TemplateKind } from "@/lib/ai/generate";
import { badRequest, optionalString, readJson } from "@/lib/webhook";

const KINDS = [
  "FIRST_MAIL",
  "FOLLOW_UP",
  "POSITIVE_REPLY",
  "NEGATIVE_REPLY",
] as const;

/**
 * POST /api/templates/generate
 *
 * Body: { prompt: string, kind?: TemplateKind, category?: string, save?: boolean }
 *
 * Turns a plain-language brief into a subject + body. Nothing is persisted
 * unless `save` is set, so the user can regenerate freely. `kind` decides what
 * sort of email gets written — a follow-up and a reply to a rejection are not
 * the same email with a different label.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const prompt = optionalString(parsed.data.prompt);
  if (!prompt) return badRequest("`prompt` is required");

  // Subjects the user has already turned down, so a re-roll differs.
  const reject = Array.isArray(parsed.data.reject)
    ? parsed.data.reject.filter((v): v is string => typeof v === "string").slice(0, 6)
    : [];

  const kind = (KINDS as readonly string[]).includes(String(parsed.data.kind))
    ? (parsed.data.kind as TemplateKind)
    : "FIRST_MAIL";
  const category = optionalString(parsed.data.category);

  try {
    const generated = await generateTemplate(prompt, reject, kind);

    if (parsed.data.save === true) {
      const saved = await prisma.template.create({
        data: {
          name: generated.name,
          subject: generated.subject,
          body: generated.body,
          preview: generated.preview,
          kind,
          category,
          ai_prompt: prompt,
          source: "AI",
        },
      });
      return NextResponse.json({ ok: true, template: saved, saved: true });
    }

    // Hand the kind back so an unsaved draft keeps it through the editor.
    return NextResponse.json({
      ok: true,
      template: { ...generated, kind, category },
      saved: false,
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 502 },
    );
  }
}
