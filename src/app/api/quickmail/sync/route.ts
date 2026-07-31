import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isConfigured } from "@/lib/quickmail/client";
import { syncCampaigns, syncLeads } from "@/lib/quickmail/sync";
import { readJson } from "@/lib/webhook";

export const maxDuration = 300;

/**
 * POST /api/quickmail/sync
 *
 * Body: { what: "leads" | "campaigns", cursor?: string, maxPages?: number }
 *
 * Read-only against QuickMail — this only ever pulls. It writes to the local
 * database, never back to the workspace, so it's safe to run at any time
 * regardless of the dry-run setting.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isConfigured()) {
    return NextResponse.json(
      { error: "QUICKMAIL_API_KEY is not set" },
      { status: 400 },
    );
  }

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const what = parsed.data.what === "campaigns" ? "campaigns" : "leads";

  try {
    if (what === "campaigns") {
      return NextResponse.json({ ok: true, what, ...(await syncCampaigns()) });
    }

    const cursor =
      typeof parsed.data.cursor === "string" ? parsed.data.cursor : null;
    const maxPages =
      typeof parsed.data.maxPages === "number" ? parsed.data.maxPages : 8;

    const result = await syncLeads({ cursor, maxPages });
    return NextResponse.json({ ok: true, what, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 502 },
    );
  }
}
