"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  FilePlus2,
  FileText,
  Loader2,
  Mail,
  MailPlus,
  Save,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
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
import { fetchErrorMessage } from "@/lib/fetch-error";
import { MERGE_TAGS, previewTags, unknownTags } from "@/lib/merge-tags";
import { KINDS, kindMeta, type TemplateKind } from "@/lib/template-kinds";
import { cn } from "@/lib/utils";

export type TemplateRow = {
  id: string;
  name: string;
  subject: string;
  body: string;
  step: number | null;
  kind: TemplateKind;
  category: string | null;
  source: string | null;
};

/** Icons live here because this side is React; the rest is shared plain data. */
const ICONS: Record<TemplateKind, typeof Mail> = {
  FIRST_MAIL: Mail,
  FOLLOW_UP: MailPlus,
  POSITIVE_REPLY: ThumbsUp,
  NEGATIVE_REPLY: ThumbsDown,
};

const RISK_STYLE: Record<string, string> = {
  safe: "text-emerald-700 dark:text-emerald-400",
  care: "text-amber-700 dark:text-amber-400",
  avoid: "text-muted-foreground",
};

function blank(kind: TemplateKind): TemplateRow {
  return {
    id: "",
    name: "",
    subject: "",
    body: "",
    step: null,
    kind,
    category: null,
    source: null,
  };
}

export function TemplateStudio({
  templates,
  serviceLines,
}: {
  templates: TemplateRow[];
  serviceLines: string[];
}) {
  const router = useRouter();

  const [kind, setKind] = useState<TemplateKind>("FIRST_MAIL");
  const [draft, setDraft] = useState<TemplateRow>(
    templates.find((t) => t.kind === "FIRST_MAIL") ?? blank("FIRST_MAIL"),
  );
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [, startTransition] = useTransition();

  const shown = useMemo(
    () => templates.filter((t) => t.kind === kind),
    [templates, kind],
  );

  const meta = kindMeta(draft.kind);

  function set<K extends keyof TemplateRow>(key: K, value: TemplateRow[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  /** Switching category also moves the editor, so the two never disagree. */
  function pickKind(next: TemplateKind) {
    setKind(next);
    setDraft(templates.find((t) => t.kind === next) ?? blank(next));
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
        // The kind decides what gets written, not just where it is filed.
        body: JSON.stringify({
          prompt,
          kind: draft.kind,
          category: draft.category ?? undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Generation failed");
      setDraft({ ...blank(draft.kind), ...json.template, category: draft.category });
      toast.success("Draft generated — review before saving");
    } catch (error) {
      toast.error(fetchErrorMessage(error));
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
          kind: draft.kind,
          category: draft.category ?? "",
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Save failed");
      setDraft({ ...draft, ...json.template });
      setKind(json.template.kind);
      toast.success("Template saved");
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(fetchErrorMessage(error, "Save failed"));
    } finally {
      setSaving(false);
    }
  }

  // Anything {{…}} that QuickMail does not know is sent to the prospect as
  // written, so it is worth catching here rather than in someone's inbox.
  const stray = unknownTags(`${draft.subject}\n${draft.body}`);

  return (
    <div className="space-y-6">
      {/* The four categories */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {KINDS.map((k) => {
          const Icon = ICONS[k.value];
          const count = templates.filter((t) => t.kind === k.value).length;
          const active = kind === k.value;
          return (
            <button
              key={k.value}
              onClick={() => pickKind(k.value)}
              className={cn(
                "rounded-lg border p-3 text-left transition-colors",
                active
                  ? "border-primary bg-primary/5"
                  : "hover:border-muted-foreground/30 hover:bg-accent",
              )}
            >
              <span className="flex items-center gap-2">
                <Icon
                  className={cn("size-4", active && "text-primary")}
                />
                <span className="flex-1 text-sm font-medium">{k.label}</span>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {count}
                </span>
              </span>
              <span className="text-muted-foreground mt-1 block text-xs leading-snug">
                {k.blurb}
              </span>
            </button>
          );
        })}
      </div>

      <div className="grid gap-6 xl:grid-cols-[290px_minmax(0,1fr)_300px]">
        {/* Templates in the selected category */}
        <Card className="h-fit">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">
              {kindMeta(kind).label}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 px-2">
            {shown.length === 0 && (
              <p className="text-muted-foreground px-2 py-6 text-center text-xs">
                Nothing here yet. Write one below, or describe it and let the AI
                draft it.
              </p>
            )}

            {shown.map((t) => (
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
                <span className="block truncate">{t.subject}</span>
                {t.category && (
                  <span className="text-muted-foreground block truncate text-[11px]">
                    {t.category}
                    {t.step ? ` · step ${t.step}` : ""}
                  </span>
                )}
              </button>
            ))}

            <Separator className="my-2" />
            <Button
              variant="ghost"
              className="w-full justify-start"
              onClick={() => setDraft(blank(kind))}
            >
              <FilePlus2 className="size-4" />
              New {kindMeta(kind).short} template
            </Button>
          </CardContent>
        </Card>

        {/* Editor */}
        <div className="min-w-0 space-y-6">
          <Card className="border-primary/30">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Sparkles className="text-primary size-4" />
                Write it with AI
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                rows={3}
                value={prompt}
                placeholder={
                  draft.kind === "FIRST_MAIL"
                    ? "Heads of lease administration at US commercial real estate firms. Angle: manual abstraction eats 20 hours a week. Ask for a 15-minute call."
                    : draft.kind === "FOLLOW_UP"
                      ? "Chase the lease abstraction opener. New angle: a client cut turnaround from 6 days to 1."
                      : draft.kind === "POSITIVE_REPLY"
                        ? "They asked what our turnaround looks like. Answer, then offer Tuesday or Wednesday afternoon."
                        : "They said the budget is gone for this year. Accept it, leave the door open for next year."
                }
                onChange={(e) => setPrompt(e.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                Writing a <strong>{meta.label.toLowerCase()}</strong>: {meta.hint}
              </p>
              <Button
                variant="secondary"
                onClick={generate}
                disabled={generating}
              >
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
                <Badge variant="secondary">{meta.label}</Badge>
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
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Category</Label>
                  <div className="grid grid-cols-2 gap-1.5">
                    {KINDS.map((k) => (
                      <button
                        key={k.value}
                        onClick={() => set("kind", k.value)}
                        className={cn(
                          "rounded-md border px-2 py-1.5 text-xs transition-colors",
                          draft.kind === k.value
                            ? "border-primary bg-primary/10 text-primary font-medium"
                            : "hover:bg-accent",
                        )}
                      >
                        {k.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="line">Service line</Label>
                  <Input
                    id="line"
                    list="service-lines"
                    value={draft.category ?? ""}
                    placeholder="Manual Lease Abstraction"
                    onChange={(e) => set("category", e.target.value || null)}
                  />
                  <datalist id="service-lines">
                    {serviceLines.map((l) => (
                      <option key={l} value={l} />
                    ))}
                  </datalist>
                  <p className="text-muted-foreground text-xs">
                    Optional. Groups a template with the offer it belongs to.
                  </p>
                </div>
              </div>

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
                  placeholder="Hi {{lead.first_name}}, …"
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

        {/* Merge tags + preview */}
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Merge tags</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {/**
               * QuickMail's own list, grouped as their picker groups it, with
               * how well each one is actually backed by data. A tag with
               * nothing behind it resolves to empty text — "Hi ," — so the
               * colour is the point, not decoration.
               */}
              {(["Lead", "Company", "Mailbox"] as const).map((group) => (
                <div key={group} className="space-y-1">
                  <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                    {group}
                  </p>
                  {MERGE_TAGS.filter((t) => t.group === group).map((t) => (
                    <button
                      key={t.token}
                      title={t.note}
                      onClick={() => set("body", `${draft.body}${t.token}`)}
                      className="hover:bg-accent block w-full rounded-md px-2 py-1 text-left"
                    >
                      <span className="flex items-center justify-between gap-2">
                        <code className={cn("text-xs", RISK_STYLE[t.risk])}>
                          {t.token}
                        </code>
                        <span className="text-muted-foreground shrink-0 text-[11px]">
                          {t.risk === "safe"
                            ? "safe"
                            : t.risk === "care"
                              ? "check"
                              : "avoid"}
                        </span>
                      </span>
                      <span className="text-muted-foreground block text-[11px] leading-snug">
                        {t.note}
                      </span>
                    </button>
                  ))}
                </div>
              ))}

              <p className="text-muted-foreground border-t pt-2 text-xs">
                QuickMail fills these at send time. Anything else in double
                braces is sent to the prospect exactly as written.
              </p>
            </CardContent>
          </Card>

          {stray.length > 0 && (
            <Card className="border-destructive/40">
              <CardContent className="py-3">
                <p className="text-destructive text-sm font-medium">
                  {stray.length === 1 ? "This tag is not" : "These tags are not"}{" "}
                  a QuickMail tag
                </p>
                <p className="text-muted-foreground text-xs">
                  {stray.join(", ")} — QuickMail does not recognise{" "}
                  {stray.length === 1 ? "it" : "them"}, so{" "}
                  {stray.length === 1 ? "it" : "they"} would be sent to the
                  prospect exactly like that. Use one from the list above.
                </p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Preview</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm font-medium break-words">
                {previewTags(draft.subject) || "No subject yet"}
              </p>
              <Separator className="my-3" />
              <pre className="text-muted-foreground max-h-96 overflow-y-auto font-sans text-xs break-words whitespace-pre-wrap">
                {previewTags(draft.body) || "Nothing to preview yet."}
              </pre>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
