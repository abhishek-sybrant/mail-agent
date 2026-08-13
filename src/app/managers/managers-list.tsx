"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Mail, Pause, Play, Plus, Trash2, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchErrorMessage } from "@/lib/fetch-error";

export type ManagerRow = {
  id: string;
  email: string;
  name: string | null;
  active: boolean;
  note: string | null;
};

export type ForwardSwitch = {
  key: string;
  label: string;
  blurb: string;
  offWarning: string;
  on: boolean;
};

export function ManagersList({
  managers,
  forwarding,
  queued,
  batch,
}: {
  managers: ManagerRow[];
  forwarding: ForwardSwitch | null;
  queued: number;
  batch: number;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function post(body: Record<string, unknown>, key: string, method = "POST") {
    setBusy(key);
    try {
      const res = await fetch("/api/managers", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      startTransition(() => router.refresh());
      return json;
    } finally {
      setBusy(null);
    }
  }

  async function add() {
    if (!email.trim()) return;
    try {
      await post({ email, name: name.trim() || undefined }, "add");
      toast.success(`${email.trim()} will receive forwarded replies.`);
      setEmail("");
      setName("");
    } catch (error) {
      toast.error(fetchErrorMessage(error));
    }
  }

  async function toggle(m: ManagerRow) {
    try {
      await post({ id: m.id, active: !m.active }, m.id);
      toast.success(
        m.active
          ? `${m.email} paused — nothing new will be sent to them.`
          : `${m.email} will receive replies again.`,
      );
    } catch (error) {
      toast.error(fetchErrorMessage(error));
    }
  }

  async function remove(m: ManagerRow) {
    try {
      await post({ id: m.id }, m.id, "DELETE");
      toast.success(`${m.email} removed.`);
    } catch (error) {
      toast.error(fetchErrorMessage(error));
    }
  }

  async function flipForwarding() {
    if (!forwarding) return;
    setBusy("switch");
    try {
      const res = await fetch("/api/sync/switches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: forwarding.key, on: !forwarding.on }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not change that");
      if (forwarding.on) {
        toast.warning("Forwarding stopped.", {
          description: forwarding.offWarning,
          duration: 7000,
        });
      } else {
        toast.success("Forwarding started — it resumes on the next sync pass.");
      }
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(fetchErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  const active = managers.filter((m) => m.active).length;

  return (
    <div className="max-w-3xl space-y-6">
      {/**
       * The forwarding stop lives here, beside the people it sends to.
       *
       * It was on the Sync tab, which is where the machinery is rather than
       * where the decision is: stopping it is about who is receiving mail, not
       * about how often the sync runs.
       */}
      {forwarding && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-4 py-4">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-sm font-medium">
                Forwarding replies
                {forwarding.on ? (
                  <Badge
                    variant="outline"
                    className="border-emerald-600/30 text-xs text-emerald-700"
                  >
                    on
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-destructive text-xs">
                    stopped
                  </Badge>
                )}
              </p>
              <p className="text-muted-foreground text-xs">
                {forwarding.on
                  ? `Up to ${batch} per sync pass, newest first. ${queued} waiting.`
                  : forwarding.offWarning}
              </p>
            </div>
            <Button
              variant={forwarding.on ? "outline" : "default"}
              disabled={busy === "switch"}
              onClick={flipForwarding}
            >
              {busy === "switch" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : forwarding.on ? (
                <Pause className="size-4" />
              ) : (
                <Play className="size-4" />
              )}
              {forwarding.on ? "Stop forwarding" : "Start forwarding"}
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Add a manager</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="m-email" className="text-xs">
                Email
              </Label>
              <Input
                id="m-email"
                value={email}
                placeholder="someone@sybrant.com"
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") add();
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="m-name" className="text-xs">
                Name (optional)
              </Label>
              <Input
                id="m-name"
                value={name}
                placeholder="Abhishek S"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") add();
                }}
              />
            </div>
          </div>
          <Button onClick={add} disabled={!email.trim() || busy === "add"}>
            {busy === "add" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Add
          </Button>
          <p className="text-muted-foreground text-xs">
            Every active manager gets the same message — the first on the To
            line, the rest copied — so the thread stays shared rather than each
            getting a private copy.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">
            {managers.length === 0
              ? "Nobody yet"
              : `${active} receiving${
                  managers.length > active ? `, ${managers.length - active} paused` : ""
                }`}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {managers.length === 0 ? (
            <p className="text-muted-foreground px-4 pb-6 text-sm">
              Add someone above and new replies start reaching them on the next
              sync pass. Until then nothing is forwarded — replies still arrive
              and are still classified, they just wait.
            </p>
          ) : (
            <div className="divide-y">
              {managers.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    {m.name ? (
                      <UserRound className="text-muted-foreground size-4 shrink-0" />
                    ) : (
                      <Mail className="text-muted-foreground size-4 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <p
                        className={
                          m.active
                            ? "truncate text-sm font-medium"
                            : "text-muted-foreground truncate text-sm font-medium line-through"
                        }
                      >
                        {m.name ? `${m.name} · ${m.email}` : m.email}
                      </p>
                      {m.note && (
                        <p className="text-muted-foreground truncate text-xs">
                          {m.note}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    {!m.active && (
                      <Badge variant="outline" className="text-xs">
                        paused
                      </Badge>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy === m.id}
                      onClick={() => toggle(m)}
                    >
                      {busy === m.id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : m.active ? (
                        <Pause className="size-4" />
                      ) : (
                        <Play className="size-4" />
                      )}
                      {m.active ? "Pause" : "Resume"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      disabled={busy === m.id}
                      onClick={() => remove(m)}
                      title="Remove entirely — pausing is usually what you want"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
