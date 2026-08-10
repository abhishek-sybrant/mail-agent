"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  Ban,
  Bot,
  CheckSquare,
  Inbox,
  LayoutDashboard,
  LogOut,
  MailOpen,
  PenSquare,
  RefreshCw,
  Send,
  Upload,
  Webhook,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/agent", label: "AI Agent", icon: Bot },
  { href: "/campaigns", label: "Campaigns", icon: Send },
  { href: "/leads", label: "Leads", icon: Users },
  { href: "/leads/import", label: "Import file", icon: Upload },
  { href: "/sync", label: "QuickMail sync", icon: RefreshCw },
  { href: "/templates", label: "Templates", icon: PenSquare },
  { href: "/replies", label: "Replies", icon: MailOpen, badge: "replies" as const },
  { href: "/stopped", label: "Stopped", icon: Ban },
  { href: "/approvals", label: "Approvals", icon: CheckSquare, badge: "pending" as const },
  { href: "/inbox", label: "AI Inbox", icon: Inbox },
  { href: "/settings/webhooks", label: "Reply webhook", icon: Webhook },
];

export function Sidebar({
  pending = 0,
  replies = 0,
  userEmail,
}: {
  pending?: number;
  replies?: number;
  userEmail?: string | null;
}) {
  const counts = { pending, replies };
  const pathname = usePathname();

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2 border-b px-5 py-4">
        <Bot className="size-5 text-primary" />
        <div className="leading-tight">
          <p className="text-sm font-semibold">AI SDR</p>
          <p className="text-muted-foreground text-xs">Outbound console</p>
        </div>
      </div>

      <nav className="flex-1 space-y-1 p-3">
        {NAV.map(({ href, label, icon: Icon, badge }) => {
          const count = badge ? counts[badge] : 0;

          // "/leads" must not light up when we're on "/leads/import".
          const active =
            href === "/"
              ? pathname === "/"
              : href === "/leads" || href === "/campaigns"
                ? pathname === href
                : pathname.startsWith(href);

          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <Icon className="size-4" />
              <span className="flex-1">{label}</span>
              {count > 0 && (
                <span className="rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold text-white tabular-nums">
                  {count}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="space-y-2 border-t p-3">
        {userEmail && (
          <p className="text-muted-foreground truncate px-2 text-xs">
            {userEmail}
          </p>
        )}
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="text-muted-foreground hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors"
        >
          <LogOut className="size-4" />
          Sign out
        </button>
      </div>
    </aside>
  );
}
