import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Optimistic route guard. Renamed from `middleware.ts` — Next.js 16 calls this
 * Proxy; the behaviour is unchanged.
 *
 * This is NOT the authorization boundary, and must not be treated as one. Next's
 * own guidance is explicit that Proxy "should not be used as a full session
 * management or authorization solution" — it runs before the request completes
 * and only sees the cookie jar, so it cannot tell a real session token from a
 * string someone typed into devtools.
 *
 * It used to be the only check, which meant `authjs.session-token=anything`
 * was enough to read 50,000 leads: the cookie existed, the request was waved
 * through, and every page rendered its data because nothing downstream looked
 * again. The real check now lives in the root layout, which calls `auth()` and
 * verifies the token's signature. This stays as the cheap redirect that saves a
 * render for the common signed-out case.
 */
const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth",
  // Webhooks can't carry a session cookie; they authenticate with
  // WEBHOOK_SECRET inside the route (see lib/webhook.ts).
  "/api/webhooks",
  // The scheduler tick authenticates with CRON_SECRET inside the route.
  "/api/cron",
  "/_next",
];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  /**
   * The layout needs to know which path it is rendering so it can let /login
   * through while redirecting everything else. A layout has no other way to
   * read this, and a client-supplied header could lie — so it is overwritten
   * here on every request rather than merged.
   */
  const headers = new Headers(request.headers);
  headers.set("x-pathname", pathname);

  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next({ request: { headers } });
  }

  if (
    !request.cookies.has("authjs.session-token") &&
    !request.cookies.has("__Secure-authjs.session-token")
  ) {
    const url = new URL("/login", request.url);
    url.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
