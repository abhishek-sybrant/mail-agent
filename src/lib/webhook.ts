import { NextResponse } from "next/server";

/**
 * Shared helpers for the inbound Zapier / QuickMail webhooks.
 *
 * These endpoints are pinged by third parties, so they need to be forgiving
 * about payload shape but strict about the one field we actually key on: email.
 */

export type WebhookResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse };

export function badRequest(message: string, details?: unknown) {
  return NextResponse.json({ error: message, details }, { status: 400 });
}

export function notFound(message: string) {
  return NextResponse.json({ error: message }, { status: 404 });
}

/** Parses a JSON body, returning a 400 response instead of throwing on garbage input. */
export async function readJson(
  request: Request,
): Promise<WebhookResult<Record<string, unknown>>> {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { ok: false, response: badRequest("Body must be a JSON object") };
    }
    return { ok: true, data: body as Record<string, unknown> };
  } catch {
    return { ok: false, response: badRequest("Invalid JSON body") };
  }
}

/** Normalises an email for lookup — QuickMail is inconsistent about casing/whitespace. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.includes("@") ? email : null;
}

export function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * Verifies the shared-secret header, when one is configured.
 * Leaving WEBHOOK_SECRET unset keeps local development frictionless.
 */
export function verifySecret(request: Request): NextResponse | null {
  const expected = process.env.WEBHOOK_SECRET;
  if (!expected) return null;

  const provided = request.headers.get("x-webhook-secret");
  if (provided !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
