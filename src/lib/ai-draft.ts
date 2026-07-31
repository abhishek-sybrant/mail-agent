/**
 * Mocked AI reply drafting.
 *
 * Deliberately deterministic and dependency-free for now. When this is swapped
 * for a real model call, keep the signature — the Inbox only depends on
 * (lead, incoming message) -> draft string.
 */
export function draftReply(input: {
  name: string | null;
  company: string | null;
  incoming: string;
  intent: number;
}): string {
  const first = input.name?.split(" ")[0] ?? "there";
  const company = input.company ?? "your team";
  const lowered = input.incoming.toLowerCase();

  const asksPricing = /pricing|cost|quote|budget/.test(lowered);
  const asksTiming = /availability|schedule|call|next week|demo/.test(lowered);
  const notDecisionMaker = /not the decision maker|forward|colleague|my boss/.test(
    lowered,
  );

  const lines = [`Hi ${first},`, ""];

  if (notDecisionMaker) {
    lines.push(
      `Totally understand — happy to keep this light. If it's useful, I can send a one-page summary you could forward to whoever owns outbound at ${company}.`,
    );
  } else if (input.intent >= 80) {
    lines.push(
      `Great to hear — sounds like the timing lines up well with what ${company} is working through.`,
    );
  } else {
    lines.push(`Thanks for getting back to me, appreciate it.`);
  }

  if (asksPricing) {
    lines.push(
      "",
      "On pricing: we're usage-based and start at $499/mo for a single sending domain, with volume tiers above that. I'll include the full breakdown in the deck.",
    );
  }

  if (asksTiming) {
    lines.push(
      "",
      "For timing — I have Tuesday and Thursday afternoon open next week. Happy to work around your calendar if neither suits.",
    );
  }

  lines.push(
    "",
    "Would a 15-minute walkthrough be worth it?",
    "",
    "Best,",
    "Alex",
  );

  return lines.join("\n");
}
