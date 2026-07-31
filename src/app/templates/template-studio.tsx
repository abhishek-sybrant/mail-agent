"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FileText,
  Loader2,
  Save,
  Sparkles,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type TemplateRow = {
  id: string;
  name: string;
  subject: string;
  body: string;
  step: number | null;
  category: string | null;
  source: string | null;
};

export type TemplateGroup = {
  category: string;
  geography: string[];
  industry: string[];
  templates: TemplateRow[];
};

const VARIABLES = [
  { token: "{{firstName}}", hint: "Lead's first name" },
  { token: "{{lastName}}", hint: "Lead's last name" },
  { token: "{{companyName}}", hint: "Lead's company" },
  { token: "{{senderName}}", hint: "Your name" },
];

const BLANK: TemplateRow = {
  id: "",
  name: "",
  subject: "",
  body: "",
  step: null,
  category: null,
  source: null,
};

export function TemplateStudio({ groups }: { groups: TemplateGroup[] }) {
  const router = useRouter();
  const first = groups[0]?.templates[0] ?? BLANK;

  const [draft, setDraft] = useState<TemplateRow>(first);
  const [open, setOpen] = useState<Set<string>>(
    new Set(groups[0] ? [groups[0].category] : []),
  );
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [, startTransition] = useTransition();

  function set<K extends keyof TemplateRow>(key: K, value: TemplateRow[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function toggleGroup(category: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }

  async function generate() {
    if (!prompt.trim()) {
      toast.error("Describe the email you want first");
      return;
    }
    setGenerating(true);
    try {
      const res = await fetch("/api/templates/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Generation failed");
      setDraft({ ...BLANK, ...json.template });
      toast.success("Draft generated — review before saving");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed");
    } finally {
      setGenerating(false);
    }
  }

  async function save() {
    if (!draft.name || !draft.subject || !draft.body) {
      toast.error("Name, subject and body are all required");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: draft.id || undefined,
          name: draft.name,
          subject: draft.subject,
          body: draft.body,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Save failed");
      setDraft({ ...draft, ...json.template });
      toast.success("Template saved");
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const preview = (text: string) =>
    text
      .replaceAll("{{firstName}}", "Sarah")
      .replaceAll("{{lastName}}", "Chen")
      .replaceAll("{{companyName}}", "Northwind Analytics")
      .replaceAll("{{senderName}}", "Alex");

  return (
    <div className="grid gap-6 xl:grid-cols-[290px_minmax(0,1fr)_300px]">
      {/* Sequences, grouped by service line */}
      <Card className="h-fit">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Service lines</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 px-2">
          {groups.map((g) => {
            const expanded = open.has(g.category);
            return (
              <div key={g.category}>
                <button
                  onClick={() => toggleGroup(g.category)}
                  className="hover:bg-accent flex w-full items-start gap-1.5 rounded-md px-2 py-2 text-left text-sm"
                >
                  {expanded ? (
                    <ChevronDown className="mt-0.5 size-3.5 shrink-0" />
                  ) : (
                    <ChevronRight className="mt-0.5 size-3.5 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block leading-snug font-medium">
                      {g.category}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {g.templates.length} emails
                      {g.geography.length > 0 &&
                        ` · ${g.geography.length} regions`}
                    </span>
                  </span>
                </button>

                {expanded && (
                  <div className="mt-0.5 mb-1 ml-4 space-y-0.5 border-l pl-2">
                    {g.templates.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => setDraft(t)}
                        className={cn(
                          "w-full rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                          draft.id === t.id
                            ? "bg-primary/10 text-primary font-medium"
                            : "hover:bg-accent",
                        )}
                        title={t.subject}
                      >
                        <span className="flex items-center gap-1.5">
                          {t.step && (
                            <span className="bg-muted shrink-0 rounded px-1 tabular-nums">
                              {t.step}
                            </span>
                          )}
                          <span className="min-w-0 flex-1 truncate">
                            {t.subject}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          <Separator className="my-2" />
          <Button
            variant="ghost"
            className="w-full justify-start"
            onClick={() => setDraft(BLANK)}
          >
            <FilePlus2 className="size-4" />
            New template
          </Button>
        </CardContent>
      </Card>

      {/* Editor */}
      <div className="min-w-0 space-y-6">
        <Card className="border-primary/30">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Sparkles className="text-primary size-4" />
              Generate with AI
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              rows={3}
              value={prompt}
              placeholder="Cold email to heads of lease administration at US commercial real estate firms. Angle: manual abstraction eats 20 hours a week. Ask for a 15-minute call."
              onChange={(e) => setPrompt(e.target.value)}
            />
            <Button variant="secondary" onClick={generate} disabled={generating}>
              {generating ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Wand2 className="size-4" />
              )}
              Generate draft
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              {draft.id ? "Edit template" : "New template"}
              {draft.category && (
                <Badge variant="secondary">{draft.category}</Badge>
              )}
              {draft.step && <Badge variant="outline">Step {draft.step}</Badge>}
              {draft.source === "DOCX" && (
                <Badge variant="outline" className="gap-1">
                  <FileText className="size-3" />
                  from brief
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Internal name</Label>
              <Input
                id="name"
                value={draft.name}
                placeholder="Manual Lease Abstraction — Email 1"
                onChange={(e) => set("name", e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="subject">Subject line</Label>
              <Input
                id="subject"
                value={draft.subject}
                placeholder="Accurate Lease Abstraction Delivered at Scale"
                onChange={(e) => set("subject", e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="body">Body</Label>
              <Textarea
                id="body"
                value={draft.body}
                rows={16}
                className="font-mono text-sm"
                placeholder="Hi {{firstName}}, …"
                onChange={(e) => set("body", e.target.value)}
              />
            </div>

            <Button onClick={save} disabled={saving}>
              {saving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}
              Save template
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Variables + preview */}
      <div className="min-w-0 space-y-6">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Merge tags</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {VARIABLES.map((v) => (
              <button
                key={v.token}
                onClick={() => set("body", `${draft.body}${v.token}`)}
                className="hover:bg-accent flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left"
              >
                <code className="text-primary text-xs">{v.token}</code>
                <span className="text-muted-foreground truncate text-xs">
                  {v.hint}
                </span>
              </button>
            ))}
            <p className="text-muted-foreground pt-1 text-xs">
              QuickMail resolves these at send time.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Preview</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm font-medium break-words">
              {preview(draft.subject) || "No subject yet"}
            </p>
            <Separator className="my-3" />
            <pre className="text-muted-foreground max-h-96 overflow-y-auto font-sans text-xs break-words whitespace-pre-wrap">
              {preview(draft.body) || "Nothing to preview yet."}
            </pre>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
