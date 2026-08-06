import type { Metadata } from "next";
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

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await auth();

  // Signed-out users only ever see /login, which renders without the shell.
  const [pending, replies] = session?.user
    ? await Promise.all([
        // STOP_SEQUENCE lives in /replies, so it must not inflate this badge.
        prisma.approval.count({
          where: { status: "PENDING", type: { not: "STOP_SEQUENCE" } },
        }),
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
