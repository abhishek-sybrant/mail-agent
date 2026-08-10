import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { domainOf, suppress, suppressDomain, unsuppress } from "@/lib/suppression";
import { withSession } from "@/lib/quickmail/inbox";
import { addDncDomain, removeDncDomain } from "@/lib/quickmail/dnc";
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

    // A domain is blocked in both systems, so lift it in both. Best-effort:
    // the local list is already clear, and a QuickMail failure is reported
    // rather than rolled back.
    let quickmail: string | null = null;
    if (result.removedDomain) {
      try {
        const r = await withSession((s) => removeDncDomain(s, domainOf(value)));
        if (r.error) quickmail = r.error;
        else if (r.dryRun) quickmail = "dry run — QuickMail was not changed";
      } catch (error) {
        quickmail = error instanceof Error ? error.message : "QuickMail unreachable";
      }
    }

    return NextResponse.json({ ok: true, ...result, quickmail });
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

      // Mirror it into QuickMail's own blocked-domain list, so sequences there
      // stop as well. Best-effort — the local block already holds.
      let quickmail: string | null = null;
      let inQuickMail = false;
      try {
        const r = await withSession((s) => addDncDomain(s, d.domain));
        inQuickMail = r.ok;
        if (r.error) quickmail = r.error;
        else if (r.dryRun) quickmail = "dry run — QuickMail was not changed";
      } catch (error) {
        quickmail = error instanceof Error ? error.message : "QuickMail unreachable";
      }

      return NextResponse.json({ ok: true, scope, ...d, inQuickMail, quickmail });
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
