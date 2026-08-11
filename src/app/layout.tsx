import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Geist, Geist_Mono } from "next/font/google";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { Toaster } from "@/components/ui/sonner";
import { Sidebar } from "@/components/sidebar";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AI SDR Dashboard",
  description: "Outbound campaign orchestration with human-in-the-loop review",
};

/** Paths that render without a session. Kept in step with src/proxy.ts. */
const PUBLIC_PREFIXES = ["/login", "/api/auth", "/api/webhooks", "/api/cron"];

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await auth();

  /**
   * The real authorization check.
   *
   * `auth()` verifies the token's signature; the proxy only sees that a cookie
   * exists. Without this redirect, a cookie containing arbitrary text got past
   * the proxy and every page then rendered its data to an unauthenticated
   * request — 50,000 leads, every reply thread, the block list. It also covers
   * the milder case of a token signed with a rotated AUTH_SECRET, which used to
   * render the app with no navigation instead of asking for a fresh sign-in.
   *
   * Placed in the root layout deliberately: every page renders through it, so
   * no page can forget.
   */
  const pathname = (await headers()).get("x-pathname") ?? "";
  const isPublic = PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
  if (!session?.user && !isPublic) {
    redirect(`/login?callbackUrl=${encodeURIComponent(pathname || "/")}`);
  }

  const [pending, replies] = session?.user
    ? await Promise.all([
        prisma.approval.count({ where: { status: "PENDING" } }),
        // Auto-replies are excluded: they are most of the inbox and none of
        // them need a person.
        prisma.qmConversation.count({ where: { handled_at: null, is_ooo: false } }),
      ])
    : [0, 0];

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full">
        {session?.user && (
          <Sidebar
            pending={pending}
            replies={replies}
            userEmail={session.user.email}
          />
        )}
        <main className="min-w-0 flex-1">{children}</main>
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
