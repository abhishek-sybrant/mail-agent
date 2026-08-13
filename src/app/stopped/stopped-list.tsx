"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AtSign, Ban, Globe, Loader2, RotateCcw, Search } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { fmtDateTime } from "@/lib/format";

export type BlockedItem = {
  id: string;
  value: string;
  kind: "email" | "domain";
  reason: string;
  source: string;
  hits: number;
  note: string | null;
  since: string;
  /**
   * Which system holds the block.
   *
   * "local" governs what this app enrols. "quickmail" is a block someone made
   * there, or a prospect who unsubscribed themselves — no local row exists for
   * it. Only "both" actually stops a person everywhere, so the distinction is
   * worth showing rather than flattening into one list.
   */
  where: "local" | "quickmail" | "both";
};

/**
 * Turns the raw QuickMail failure into something with a next step.
 *
 * Domain blocks reach QuickMail through the attached browser, so the usual
 * failure is that Edge is closed or was started without the debugging flag.
 * "The attached browser is not signed in to QuickMail" is accurate and useless
 * to someone who does not know a browser was involved.
 */
function describeQuickMailFailure(raw: string | null | undefined): string {
  const message = raw ?? "reason unknown";
  if (/debuggable browser|not signed in|CDP|9222/i.test(message)) {
    return "the QuickMail browser session is not connected. Reopen Edge with the debugging flag and sign in, then block it again to sync";
  }
  if (/dry run/i.test(message)) {
    return "QUICKMAIL_DRY_RUN is on, so nothing was written there";
  }
  return message.replace(/\.$/, "");
}

const REASON_LABEL: Record<string, string> = {
  BOUNCE: "Bounced",
  COMPLAINT: "Spam complaint",
  UNSUBSCRIBE: "Asked to unsubscribe",
  NEGATIVE_REPLY: "Said no",
  MANUAL: "Added by hand",
};

export function StoppedList({
  items,
  query,
  kind,
  addressTotal,
  domainTotal,
  repeatOffenders,
  quickmailError,
}: {
  items: BlockedItem[];
  query: string;
  kind: string;
  addressTotal: number;
  domainTotal: number;
  repeatOffenders: number;
  quickmailError?: string | null;
}) {
  const router = useRouter();
  const [search, setSearch] = useState(query);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const href = (over: Record<string, string>) => {
    const p = new URLSearchParams();
    const state: Record<string, string> = { q: query, kind, ...over };
    for (const [k, v] of Object.entries(state)) if (v) p.set(k, v);
    const qs = p.toString();
    return `/stopped${qs ? `?${qs}` : ""}`;
  };

  useEffect(() => {
    if (search === query) return;
    const t = setTimeout(() => router.push(href({ q: search })), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  /** A value with no local part is a domain — the API applies the same rule. */
  const typedIsDomain = value.trim().length > 0 && !value.includes("@");

  async function post(body: Record<string, unknown>, key: string) {
    setBusy(key);
    try {
      const res = await fetch("/api/stopped", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      return json;
    } finally {
      setBusy(null);
    }
  }

  async function block() {
    const v = value.trim();
    if (!v) return;
    try {
      const json = await post({ action: "block", value: v }, "block");
      if (json.scope !== "domain") {
        toast.success(`${json.email} will never be emailed again.`);
      } else if (json.inQuickMail) {
        toast.success(
          `@${json.domain} blocked here and in QuickMail — covers ${json.leadsAffected} known lead${json.leadsAffected === 1 ? "" : "s"}.`,
        );
      } else {
        /**
         * Lead with what succeeded.
         *
         * The block itself is local and always works; only the push to
         * QuickMail needs the attached browser. Opening with the failure made a
         * working action read as a broken one, which is exactly how this was
         * reported.
         */
        toast.warning(`@${json.domain} blocked.`, {
          description: `QuickMail was not updated — ${describeQuickMailFailure(json.quickmail)}. Their own sequences to this domain may still run.`,
          duration: 8000,
        });
      }
      setValue("");
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed");
    }
  }

  async function unblock(item: BlockedItem) {
    try {
      const json = await post({ action: "unblock", value: item.value }, item.id);

      // The QuickMail side is reported for addresses as well now, so a block
      // that only exists there cannot silently survive being unblocked here.
      if (json.quickmail) {
        toast.warning(`${item.value} unblocked here.`, {
          description: `QuickMail still has it blocked — ${describeQuickMailFailure(json.quickmail)}.`,
          duration: 8000,
        });
      } else {
        toast.success(
          json.removedThere > 0
            ? `${item.value} can be emailed again, here and in QuickMail.`
            : `${item.value} can be emailed again.`,
        );
      }
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed");
    }
  }

  return (
    <div className="space-y-4">
      {/**
       * Say when QuickMail's own list is missing.
       *
       * Without this the page would show only the local blocks and read as the
       * complete picture, which is exactly the impression that lets someone
       * email a person QuickMail had already stopped.
       */}
      {quickmailError && (
        <Card className="border-amber-600/30 bg-amber-50/50 dark:bg-amber-950/20">
          <CardContent className="py-3">
            <p className="text-sm font-medium">
              QuickMail&apos;s own blocked list could not be read
            </p>
            <p className="text-muted-foreground text-xs">
              {describeQuickMailFailure(quickmailError)}. Only blocks made here
              are shown below — QuickMail may be blocking more.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Add a block by hand — an address or a whole domain, same box. */}
      <Card>
        <CardContent className="space-y-2 py-4">
          <p className="text-sm font-medium">Block someone</p>
          <div className="flex flex-wrap gap-2">
            <Input
              value={value}
              placeholder="someone@example.com — or just example.com for the whole company"
              className="h-9 min-w-72 flex-1"
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") block();
              }}
            />
            <Button
              size="sm"
              variant="destructive"
              className="h-9"
              disabled={!value.trim() || busy !== null}
              onClick={block}
            >
              {busy === "block" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : typedIsDomain ? (
                <Globe className="size-4" />
              ) : (
                <Ban className="size-4" />
              )}
              {typedIsDomain ? "Block the domain" : "Block this address"}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            {typedIsDomain
              ? "No @ means a domain — this blocks everyone at that company, including addresses we have never seen."
              : "This stops our campaigns enrolling them, and survives a re-import. It does not stop a sequence someone already started in QuickMail."}
          </p>
        </CardContent>
      </Card>

      {/* Filters. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            value={search}
            placeholder="Search blocked addresses and domains…"
            className="h-9 pl-8"
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {[
          { key: "", label: "All", n: addressTotal + domainTotal },
          { key: "emails", label: "Addresses", n: addressTotal },
          { key: "domains", label: "Domains", n: domainTotal },
        ].map(({ key, label, n }) => (
          <Link
            key={key || "all"}
            href={href({ kind: key })}
            className={
              kind === key
                ? "bg-primary text-primary-foreground rounded-full px-3 py-1 text-xs font-medium"
                : "hover:bg-accent rounded-full border px-3 py-1 text-xs"
            }
          >
            {label}
            <span className={kind === key ? "ml-1.5" : "text-muted-foreground ml-1.5"}>
              {n}
            </span>
          </Link>
        ))}
      </div>

      {repeatOffenders > 0 && (
        <div className="rounded-md border border-amber-600/30 bg-amber-600/5 p-3 text-xs">
          <span className="font-medium">
            {repeatOffenders} address{repeatOffenders === 1 ? " has" : "es have"} been
            blocked more than once.
          </span>{" "}
          Each repeat means something re-enrolled an address already known to be dead
          — worth checking where those imports come from.
        </div>
      )}

      {items.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground py-16 text-center text-sm">
            {query
              ? `Nothing blocked matching “${query}”.`
              : "Nothing is blocked yet. Replies you stop, and bounces, land here."}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="divide-y p-0">
            {items.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-4 px-4 py-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  {item.kind === "domain" ? (
                    <Globe className="text-muted-foreground size-4 shrink-0" />
                  ) : (
                    <AtSign className="text-muted-foreground size-4 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {item.kind === "domain" ? `@${item.value}` : item.value}
                    </p>
                    <p className="text-muted-foreground truncate text-xs">
                      {item.where === "quickmail"
                        ? item.note ?? "blocked in QuickMail"
                        : `${REASON_LABEL[item.reason] ?? item.reason} · via ${item.source} · since ${fmtDateTime(item.since)}${item.note ? ` · ${item.note}` : ""}`}
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {/**
                   * No badge for which system holds the block.
                   *
                   * Unblock lifts it in both regardless, so the distinction
                   * was noise on every row for something nobody has to act on.
                   * The row's own line still says when a block came from
                   * QuickMail, which is the part that explains it.
                   */}
                  {item.hits > 1 && (
                    <Badge
                      variant="outline"
                      className="border-amber-600/30 text-xs text-amber-700"
                    >
                      caught {item.hits}×
                    </Badge>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => unblock(item)}
                  >
                    {busy === item.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <RotateCcw className="size-4" />
                    )}
                    Unblock
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
