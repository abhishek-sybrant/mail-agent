import { AiUnavailable, completeJson, providerFor } from "./provider";

export type ReplyClassification = {
  sentiment:
    | "POSITIVE"
    | "NEUTRAL"
    | "NEGATIVE"
    | "MEETING_REQUEST"
    | "OUT_OF_OFFICE"
    | "UNSUBSCRIBE";
  intent_score: number;
  should_stop_sequence: boolean;
  reasoning: string;
};

/**
 * Schema is enforced by the API, so the response is guaranteed to parse and to
 * carry a valid enum value — the downstream routing switch can't be surprised.
 */
const SCHEMA = {
  type: "object",
  properties: {
    sentiment: {
      type: "string",
      enum: [
        "POSITIVE",
        "NEUTRAL",
        "NEGATIVE",
        "MEETING_REQUEST",
        "OUT_OF_OFFICE",
        "UNSUBSCRIBE",
      ],
      description: "The lead's disposition toward the offer.",
    },
    intent_score: {
      type: "integer",
      description: "Buying intent from 0 (none) to 100 (ready to buy).",
    },
    should_stop_sequence: {
      type: "boolean",
      description:
        "True if no further automated email should be sent to this lead.",
    },
    reasoning: {
      type: "string",
      description: "One sentence explaining the classification.",
    },
  },
  required: [
    "sentiment",
    "intent_score",
    "should_stop_sequence",
    "reasoning",
  ],
  additionalProperties: false,
} as const;

const SYSTEM = `You triage inbound replies to cold sales email for a B2B SDR team.

Classify the reply the prospect sent. Be conservative about POSITIVE — genuine
interest means they asked a question, requested information, or proposed next
steps, not mere politeness.

Route as:
- MEETING_REQUEST: they proposed or agreed to a call, demo or meeting.
- POSITIVE: interested, asked about pricing/product, wants more information.
- NEUTRAL: acknowledgement, referral to someone else, "not right now".
- NEGATIVE: not interested, annoyed, or told you to stop contacting them.
- OUT_OF_OFFICE: an automated away message.
- UNSUBSCRIBE: an explicit opt-out or legal removal request.

Set should_stop_sequence true for NEGATIVE and UNSUBSCRIBE, and for any reply
where continuing to email would damage the relationship. Set it false for
OUT_OF_OFFICE — those leads should be re-contacted later.`;

/** Deterministic fallback used when no API key is configured. */
function heuristic(text: string): ReplyClassification {
  const t = text.toLowerCase();
  if (/unsubscribe|remove me|take me off|opt out/.test(t)) {
    return {
      sentiment: "UNSUBSCRIBE",
      intent_score: 0,
      should_stop_sequence: true,
      reasoning: "Matched an explicit opt-out phrase.",
    };
  }
  if (/out of (the )?office|on leave|annual leave|vacation/.test(t)) {
    return {
      sentiment: "OUT_OF_OFFICE",
      intent_score: 0,
      should_stop_sequence: false,
      reasoning: "Looks like an automated away message.",
    };
  }
  if (/not interested|no thanks|stop emailing|don't contact/.test(t)) {
    return {
      sentiment: "NEGATIVE",
      intent_score: 0,
      should_stop_sequence: true,
      reasoning: "Explicit rejection.",
    };
  }
  if (/call|meeting|demo|calendar|schedule|book/.test(t)) {
    return {
      sentiment: "MEETING_REQUEST",
      intent_score: 90,
      should_stop_sequence: true,
      reasoning: "Mentions scheduling a conversation.",
    };
  }
  if (/pricing|price|interested|tell me more|send.*(info|deck)/.test(t)) {
    return {
      sentiment: "POSITIVE",
      intent_score: 75,
      should_stop_sequence: true,
      reasoning: "Asked for more information.",
    };
  }
  return {
    sentiment: "NEUTRAL",
    intent_score: 30,
    should_stop_sequence: false,
    reasoning: "No strong signal either way.",
  };
}

export async function classifyReply(
  replyText: string,
  context?: { name?: string | null; company?: string | null },
): Promise<ReplyClassification> {
  if (providerFor("classify") === "off") return heuristic(replyText);

  try {
    const parsed = await completeJson<ReplyClassification>({
      task: "classify",
      system: SYSTEM,
      maxTokens: 400,
      schema: SCHEMA as unknown as Record<string, unknown>,
      user: [
        context?.name ? `Lead: ${context.name}` : null,
        context?.company ? `Company: ${context.company}` : null,
        "",
        "Their reply:",
        replyText,
      ]
        .filter((l) => l !== null)
        .join("\n"),
    });

    // A local model can return a plausible-looking but invalid label; fall
    // back rather than letting an unknown value reach the routing switch.
    const valid = SCHEMA.properties.sentiment.enum as readonly string[];
    if (!valid.includes(parsed.sentiment)) return heuristic(replyText);

    parsed.intent_score = Math.max(
      0,
      Math.min(100, Number(parsed.intent_score) || 0),
    );
    parsed.should_stop_sequence = Boolean(parsed.should_stop_sequence);
    return parsed;
  } catch (error) {
    if (!(error instanceof AiUnavailable)) throw error;
    console.error("[ai] classification unavailable, using heuristic", error.message);
    return heuristic(replyText);
  }
}
