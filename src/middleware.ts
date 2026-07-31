import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Route guard.
 *
 * Webhooks are deliberately excluded — QuickMail can't carry a session cookie.
 * Those endpoints authenticate with WEBHOOK_SECRET instead (see lib/webhook.ts).
 */
const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth",
  "/api/webhooks",
  // The scheduler tick authenticates with CRON_SECRET inside the route, so an
  // external scheduler can reach it without a session cookie.
  "/api/cron",
  "/_next",
];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Presence of a session cookie is enough to route; the JWT itself is
  // verified server-side by `auth()` in every page and mutating handler.
  const hasSession =
    request.cookies.has("authjs.session-token") ||
    request.cookies.has("__Secure-authjs.session-token");

  if (!hasSession) {
    const url = new URL("/login", request.url);
    url.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
