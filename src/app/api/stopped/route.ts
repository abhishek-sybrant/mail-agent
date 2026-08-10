import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { suppress, suppressDomain, unsuppress } from "@/lib/suppression";
import { badRequest, optionalString, readJson } from "@/lib/webhook";

/**
 * POST /api/stopped
 *
 * Body: { action: "block" | "unblock", value, scope?: "email" | "domain", reason? }
 *
 * Adds to or removes from the block list. Blocking here is a deliberate manual
 * act, so unlike a reply-driven stop there is no QuickMail side effect — this
 * governs what our campaigns enrol. A person barred here can still be sitting in
 * a QuickMail sequence someone started by hand.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const action = optionalString(parsed.data.action);
  const value = optionalString(parsed.data.value)?.trim();
  if (!value) return badRequest("`value` is required");

  if (action === "unblock") {
    const result = await unsuppress(value);
    if (!result.removedAddress && !result.removedDomain) {
      return NextResponse.json({ error: `${value} is not blocked` }, { status: 404 });
    }
    return NextResponse.json({ ok: true, ...result });
  }

  if (action !== "block") return badRequest("`action` must be block or unblock");

  // A value with no "@" and a dot can only be a domain; otherwise trust scope.
  const looksLikeDomain = !value.includes("@") && value.includes(".");
  const scope =
    optionalString(parsed.data.scope) === "domain" || looksLikeDomain
      ? "domain"
      : "email";

  const reason =
    (optionalString(parsed.data.reason) as
      | "BOUNCE"
      | "COMPLAINT"
      | "UNSUBSCRIBE"
      | "NEGATIVE_REPLY"
      | "MANUAL"
      | undefined) ?? "MANUAL";

  try {
    if (scope === "domain") {
      const d = await suppressDomain({
        domain: value,
        reason,
        source: "manual",
        note: optionalString(parsed.data.note),
      });
      return NextResponse.json({ ok: true, scope, ...d });
    }

    if (!value.includes("@")) {
      return badRequest(`"${value}" is not an email address`);
    }

    const r = await suppress({
      email: value,
      reason,
      source: "manual",
      note: optionalString(parsed.data.note),
    });
    return NextResponse.json({ ok: true, scope, ...r });
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : "Could not block that");
  }
}
