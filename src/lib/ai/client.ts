import Anthropic from "@anthropic-ai/sdk";

/**
 * Shared Claude client.
 *
 * Every AI feature in this app is optional — if ANTHROPIC_API_KEY isn't set,
 * callers fall back to deterministic templates rather than failing.
 */
export const MODEL = "claude-opus-4-8";

let cached: Anthropic | null = null;

export function isAiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export function anthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  cached ??= new Anthropic();
  return cached;
}

/** Pulls the concatenated text out of a response, ignoring thinking blocks. */
export function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}
