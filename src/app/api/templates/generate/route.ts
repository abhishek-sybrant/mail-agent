import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { generateTemplate } from "@/lib/ai/generate";
import { badRequest, optionalString, readJson } from "@/lib/webhook";

/**
 * POST /api/templates/generate
 *
 * Body: { prompt: string, save?: boolean }
 *
 * Turns a plain-language brief into a subject + body. Nothing is persisted
 * unless `save` is set, so the user can regenerate freely.
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

  try {
    const generated = await generateTemplate(prompt, reject);

    if (parsed.data.save === true) {
      const saved = await prisma.template.create({
        data: {
          name: generated.name,
          subject: generated.subject,
          body: generated.body,
          ai_prompt: prompt,
        },
      });
      return NextResponse.json({ ok: true, template: saved, saved: true });
    }

    return NextResponse.json({ ok: true, template: generated, saved: false });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 502 },
    );
  }
}
