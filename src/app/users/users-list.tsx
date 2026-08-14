"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Loader2, Plus, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchErrorMessage } from "@/lib/fetch-error";
import { fmtDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export type UserRow = {
  id: string;
  email: string;
  name: string | null;
  role: "ADMIN" | "MEMBER";
  createdAt: string;
  actions: number;
};

export function UsersList({
  users,
  currentUserId,
}: {
  users: UserRow[];
  currentUserId: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [admin, setAdmin] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function call(
    body: Record<string, unknown>,
    key: string,
    method: "POST" | "PATCH" | "DELETE" = "POST",
  ) {
    setBusy(key);
    try {
      const res = await fetch("/api/users", {
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
    try {
      await call(
        { email, name: name.trim() || undefined, password, role: admin ? "ADMIN" : "MEMBER" },
        "add",
      );
      toast.success(`${email.trim()} can sign in now.`);
      setEmail("");
      setName("");
      setPassword("");
      setAdmin(false);
    } catch (error) {
      toast.error(fetchErrorMessage(error));
    }
  }

  async function toggleRole(u: UserRow) {
    try {
      await call({ id: u.id, role: u.role === "ADMIN" ? "MEMBER" : "ADMIN" }, u.id, "PATCH");
      toast.success(
        `${u.email} is now ${u.role === "ADMIN" ? "a member" : "an admin"}.`,
      );
    } catch (error) {
      toast.error(fetchErrorMessage(error));
    }
  }

  async function reset(u: UserRow) {
    const pw = window.prompt(`New password for ${u.email}:`);
    if (!pw) return;
    try {
      await call({ id: u.id, password: pw }, u.id, "PATCH");
      toast.success(`Password changed for ${u.email}. Tell them what it is.`);
    } catch (error) {
      toast.error(fetchErrorMessage(error));
    }
  }

  async function remove(u: UserRow) {
    try {
      await call({ id: u.id }, u.id, "DELETE");
      toast.success(`${u.email} removed. Their activity history is kept.`);
    } catch (error) {
      toast.error(fetchErrorMessage(error));
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Add someone</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="u-email" className="text-xs">
                Email
              </Label>
              <Input
                id="u-email"
                value={email}
                placeholder="someone@sybrant.com"
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="u-name" className="text-xs">
                Name (optional)
              </Label>
              <Input
                id="u-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="u-pw" className="text-xs">
              Password
            </Label>
            <Input
              id="u-pw"
              type="text"
              value={password}
              placeholder="at least 8 characters"
              onChange={(e) => setPassword(e.target.value)}
            />
            {/* Shown, not masked: whoever types it has to pass it on, and a
                masked box they cannot read is how people set a password they
                then get wrong. */}
            <p className="text-muted-foreground text-xs">
              You will need to tell them this — nothing is emailed. They can be
              given a new one here at any time.
            </p>
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-3.5"
              checked={admin}
              onChange={() => setAdmin((v) => !v)}
            />
            Make them an admin
            <span className="text-muted-foreground text-xs">
              — admins can manage accounts; everyone else can use the app
            </span>
          </label>

          <Button
            onClick={add}
            disabled={!email.trim() || !password.trim() || busy === "add"}
          >
            {busy === "add" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Add
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">
            {users.length} account{users.length === 1 ? "" : "s"}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y">
            {users.map((u) => (
              <div
                key={u.id}
                className="flex items-center justify-between gap-4 px-4 py-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  {u.role === "ADMIN" ? (
                    <ShieldCheck className="text-primary size-4 shrink-0" />
                  ) : (
                    <UserRound className="text-muted-foreground size-4 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {u.name ? `${u.name} · ${u.email}` : u.email}
                      {u.id === currentUserId && (
                        <span className="text-muted-foreground font-normal"> — you</span>
                      )}
                    </p>
                    <p className="text-muted-foreground truncate text-xs">
                      {u.actions} action{u.actions === 1 ? "" : "s"} in Activity ·
                      since {fmtDateTime(u.createdAt)}
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <Badge
                    variant="outline"
                    className={cn("text-xs", u.role === "ADMIN" && "border-primary/40 text-primary")}
                  >
                    {u.role === "ADMIN" ? "admin" : "member"}
                  </Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === u.id}
                    onClick={() => toggleRole(u)}
                  >
                    {busy === u.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <ShieldCheck className="size-4" />
                    )}
                    {u.role === "ADMIN" ? "Make member" : "Make admin"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === u.id}
                    onClick={() => reset(u)}
                    title="Set a new password"
                  >
                    <KeyRound className="size-4" />
                  </Button>
                  {u.id !== currentUserId && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      disabled={busy === u.id}
                      onClick={() => remove(u)}
                      title="Remove the account — their activity history is kept"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
