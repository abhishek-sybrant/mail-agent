import Anthropic from "@anthropic-ai/sdk";

/**
 * One interface, three backends: Claude, a local Ollama model, or nothing.
 *
 * Feature code calls `complete()` / `completeJson()` and never learns which
 * engine answered. Selection is per task, so classification can run locally
 * while drafting uses a hosted model.
 *
 * Benchmarked on this machine (CPU inference, no GPU):
 *   qwen2.5:3b   5/5 classifications correct, valid JSON, ~9s
 *   qwen3:8b     195s, leaked a preamble and dropped an instructed link
 *   qwen2.5:14b  exceeded a 5-minute timeout
 * Hence the small default — bigger is slower *and* worse here.
 */

export type Provider = "anthropic" | "gemini" | "ollama" | "off";
export type Task = "classify" | "draft" | "generate" | "plan" | "agent";

const CLAUDE_MODEL = "claude-opus-4-8";
const DEFAULT_OLLAMA_MODEL = "qwen2.5:3b";
/** Gemini 2.0 Flash-Lite was shut down 2026-06-01; 3.5 is the current tier. */
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

export function geminiModel(): string {
  return process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
}

function ollamaUrl(): string {
  return (process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/$/, "");
}

export function ollamaModel(): string {
  return process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL;
}

/**
 * Resolves the backend for a task.
 *
 * `AI_PROVIDER_<TASK>` wins, then `AI_PROVIDER`, then a sensible auto choice:
 * Claude if a key exists, otherwise Ollama if configured, otherwise off.
 */
export function providerFor(task: Task): Provider {
  const explicit =
    process.env[`AI_PROVIDER_${task.toUpperCase()}`] ?? process.env.AI_PROVIDER;

  if (
    explicit === "anthropic" ||
    explicit === "gemini" ||
    explicit === "ollama" ||
    explicit === "off"
  ) {
    return explicit;
  }
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OLLAMA_URL || process.env.OLLAMA_MODEL) return "ollama";
  return "off";
}

export type CompleteOptions = {
  system: string;
  user: string;
  task: Task;
  maxTokens?: number;
  temperature?: number;
  /** JSON Schema. Both backends enforce it, so the result parses. */
  schema?: Record<string, unknown>;
};

export class AiUnavailable extends Error {}

/** Local models sometimes emit reasoning traces or fenced code around JSON. */
function clean(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

async function callAnthropic(o: CompleteOptions): Promise<string> {
  const client = new Anthropic();
  const res = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: o.maxTokens ?? 2048,
    system: o.system,
    ...(o.schema
      ? { output_config: { format: { type: "json_schema" as const, schema: o.schema } } }
      : {}),
    messages: [{ role: "user", content: o.user }],
  });

  if (res.stop_reason === "refusal") throw new AiUnavailable("Model declined");

  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/**
 * How long to wait on one provider call, and how many times to try.
 *
 * Gemini intermittently accepts a request and then never responds — the socket
 * just stays open. Without a deadline the API route waits on it for its whole
 * 300s maxDuration and the UI sits on "Thinking..." forever. A bounded wait
 * plus a retry turns that into a slow success instead of a hang, because the
 * hang is per-connection: the same prompt usually answers in about a second on
 * the next attempt. Transient 429/500/503 ("high demand") retry the same way.
 *
 * Deadlines are therefore PER PROVIDER, because the two fail in opposite ways.
 *
 * Gemini fails fast-or-never, so a SHORT deadline plus retries is strictly
 * fastest. Measured end-to-end on the campaign-extraction prompt:
 *   30s x 3 attempts -> 62s to succeed
 *   15s x 4 attempts -> 50s
 *    8s x 5 attempts -> 13s
 * A healthy Gemini call returns in about 1.2s, so 8s leaves ample margin.
 *
 * Ollama is the reverse: it always answers, just slowly, because this is CPU
 * inference. The benchmark at the top of this file measured qwen2.5:3b at ~9s,
 * so the 8s figure tuned for Gemini aborted every local call before the model
 * could finish — it burned the retries and made drafting look broken. Nothing
 * about a local request needs abandoning quickly, so it gets a generous ceiling
 * and fewer attempts. Tune either via AI_TIMEOUT_MS / AI_ATTEMPTS.
 */
const TIMEOUTS: Record<Provider, number> = {
  gemini: 8_000,
  ollama: 180_000,
  anthropic: 120_000,
  off: 1_000,
};
const ATTEMPTS: Record<Provider, number> = {
  gemini: 5,
  // A local timeout means the model is genuinely slow; hammering it repeats the
  // same slow work rather than finding a healthier connection.
  ollama: 2,
  anthropic: 3,
  off: 1,
};

/** Env overrides apply to every provider, for debugging. */
function timeoutFor(provider: Provider): number {
  return Number(process.env.AI_TIMEOUT_MS ?? TIMEOUTS[provider]);
}
function attemptsFor(provider: Provider): number {
  return Number(process.env.AI_ATTEMPTS ?? ATTEMPTS[provider]);
}

class Transient extends Error {}

/** fetch with a provider-appropriate deadline; a timeout is retryable. */
async function fetchWithDeadline(
  url: string,
  init: RequestInit,
  provider: Provider,
): Promise<Response> {
  const ms = timeoutFor(provider);
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (error) {
    const name = (error as Error).name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Transient(`${provider} did not respond within ${ms / 1000}s`);
    }
    throw error;
  }
}

/** Retries only what is worth retrying, with a short linear backoff. */
async function withRetries<T>(
  provider: Provider,
  fn: () => Promise<T>,
): Promise<T> {
  const attempts = attemptsFor(provider);
  let last: Error | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof Transient)) throw error;
      last = error;
      console.warn(
        `[ai] ${provider} attempt ${attempt}/${attempts} failed: ${error.message}`,
      );
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }

  throw new AiUnavailable(
    `${provider} failed after ${attempts} attempts: ${last?.message ?? "unknown"}`,
  );
}

/** 429 and 5xx are worth another go; 4xx is our own fault and is not. */
function classifyStatus(status: number, label: string, detail: string): Error {
  const message = `${label} returned ${status}${detail ? `: ${detail.slice(0, 200)}` : ""}`;
  return status === 429 || status >= 500
    ? new Transient(message)
    : new AiUnavailable(message);
}

async function callOllama(o: CompleteOptions): Promise<string> {
  const res = await fetchWithDeadline(`${ollamaUrl()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ollamaModel(),
      stream: false,
      // Qwen3 reasons by default, which both slows generation and pollutes
      // the JSON. Off unless someone deliberately turns it back on.
      think: process.env.OLLAMA_THINK === "true",
      ...(o.schema ? { format: o.schema } : {}),
      options: {
        temperature: o.temperature ?? 0,
        num_predict: o.maxTokens ?? 1024,
      },
      messages: [
        { role: "system", content: o.system },
        { role: "user", content: o.user },
      ],
    }),
  }, "ollama");

  if (!res.ok) {
    throw classifyStatus(res.status, "Ollama", await res.text().catch(() => ""));
  }

  const json = (await res.json()) as { message?: { content?: string } };
  return clean(json.message?.content ?? "");
}

async function callGemini(o: CompleteOptions): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new AiUnavailable("GEMINI_API_KEY is not set");

  // Ask for JSON via responseMimeType and describe the shape in the prompt.
  // responseSchema's accepted dialect varies between API versions, so the
  // prompt-plus-validate path is the portable one — completeJson() retries.
  const system = o.schema
    ? `${o.system}

Respond with JSON only, matching this schema exactly:
${JSON.stringify(o.schema)}`
    : o.system;

  const res = await fetchWithDeadline(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel()}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: o.user }] }],
        generationConfig: {
          temperature: o.temperature ?? 0,
          maxOutputTokens: o.maxTokens ?? 2048,
          ...(o.schema ? { responseMimeType: "application/json" } : {}),
        },
      }),
    },
    "gemini",
  );

  if (!res.ok) {
    throw classifyStatus(res.status, "Gemini", await res.text().catch(() => ""));
  }

  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    promptFeedback?: { blockReason?: string };
  };

  if (json.promptFeedback?.blockReason) {
    throw new AiUnavailable(`Gemini blocked: ${json.promptFeedback.blockReason}`);
  }

  const text = (json.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("");

  return clean(text);
}

export async function complete(o: CompleteOptions): Promise<string> {
  const provider = providerFor(o.task);
  if (provider === "off") throw new AiUnavailable("AI is disabled");

  try {
    return await withRetries(provider, () => {
      if (provider === "anthropic") return callAnthropic(o);
      if (provider === "gemini") return callGemini(o);
      return callOllama(o);
    });
  } catch (error) {
    if (error instanceof AiUnavailable) throw error;

    /**
     * "fetch failed" is what a refused connection surfaces as, which tells the
     * user nothing. For a local provider it almost always means the server is
     * not running, so say that instead of the transport error.
     */
    const message = (error as Error).message ?? "unknown";
    if (provider === "ollama" && /fetch failed|ECONNREFUSED/i.test(message)) {
      throw new AiUnavailable(
        `Ollama is not reachable at ${ollamaUrl()} — start it with "ollama serve", ` +
          `or set AI_PROVIDER_GENERATE=gemini in .env to use a hosted model.`,
      );
    }
    throw new AiUnavailable(`${provider} failed: ${message}`);
  }
}

/**
 * Schema-constrained completion with a retry.
 *
 * Claude enforces the schema server-side; Ollama's enforcement is looser, so a
 * single malformed response gets one stricter retry before giving up.
 */
export async function completeJson<T>(o: CompleteOptions): Promise<T> {
  const first = await complete(o);
  try {
    return JSON.parse(first) as T;
  } catch {
    const retry = await complete({
      ...o,
      user: `${o.user}\n\nRespond with valid JSON only — no prose, no code fences.`,
    });
    return JSON.parse(retry) as T;
  }
}

/** Which engine is live for a given task, for display in the UI. */
export async function aiStatus(task: Task = "classify"): Promise<{
  provider: Provider;
  model: string | null;
  reachable: boolean;
  detail: string;
}> {
  const provider = providerFor(task);

  if (provider === "off") {
    return {
      provider,
      model: null,
      reachable: false,
      detail: "No AI configured — deterministic fallbacks in use.",
    };
  }

  if (provider === "anthropic") {
    return {
      provider,
      model: CLAUDE_MODEL,
      reachable: Boolean(process.env.ANTHROPIC_API_KEY),
      detail: "Hosted Claude.",
    };
  }

  if (provider === "gemini") {
    const key = Boolean(process.env.GEMINI_API_KEY);
    return {
      provider,
      model: geminiModel(),
      reachable: key,
      detail: key
        ? "Google Gemini."
        : "GEMINI_API_KEY is not set — get one at aistudio.google.com/apikey",
    };
  }

  try {
    const res = await fetch(`${ollamaUrl()}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    const json = (await res.json()) as { models?: { name: string }[] };
    const installed = (json.models ?? []).map((m) => m.name);
    const model = ollamaModel();
    return {
      provider,
      model,
      reachable: installed.includes(model),
      detail: installed.includes(model)
        ? `Local, running on ${ollamaUrl()}.`
        : `Ollama is up but "${model}" isn't pulled. Available: ${installed.join(", ") || "none"}`,
    };
  } catch {
    return {
      provider,
      model: ollamaModel(),
      reachable: false,
      detail: `Can't reach Ollama at ${ollamaUrl()} — run "ollama serve".`,
    };
  }
}
