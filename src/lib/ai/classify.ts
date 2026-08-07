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
- MEETING_REQUEST: they proposed or agreed to a call, demo or meeting, or gave
  their availability or phone number.
- POSITIVE: interested, asked about pricing or the product, wants more
  information, said yes to something you offered.
- NEUTRAL: acknowledgement, referral to a colleague, an internal note, or a
  deferral that invites contact later.
- NEGATIVE: not interested, annoyed, told you to stop, or a polite brush-off
  such as "we handle that in-house" or "we already have a vendor".
- OUT_OF_OFFICE: any automated away message, including "no longer with the
  company" and "no longer monitoring this inbox".
- UNSUBSCRIBE: an explicit request to be removed from the list.

Decide in this order, because replies often carry more than one signal:
1. An explicit removal request is UNSUBSCRIBE even when wrapped in a rejection.
   "Not interested, please remove me from your list" is UNSUBSCRIBE.
2. An automated away message is OUT_OF_OFFICE whatever else it quotes.
3. "Not right now, try me next quarter" is NEUTRAL, not NEGATIVE — they invited
   a later conversation, and barring them throws away a live prospect.
4. Only then judge interest.

Watch for these, which are routinely misread:
- The word "interested" can be hostile: "I'm interested in why you keep
  emailing me. Stop." is NEGATIVE.
- "We already booked a vendor" is NEGATIVE, not a meeting.
- "Please remove the broken link" is not an opt-out.
- Casual or non-native phrasing still counts: "hi its looking interested" is
  POSITIVE.
- Being handed to a colleague is NEUTRAL, not POSITIVE.

Set should_stop_sequence true for NEGATIVE and UNSUBSCRIBE, and for any reply
where continuing the automated drip would damage the relationship — including
POSITIVE and MEETING_REQUEST, where a human takes over. Set it false for
OUT_OF_OFFICE and for deferrals; those leads should be re-contacted later.`;

/** Exported for the accuracy harness — see scripts/eval-classify.ts. */
export function heuristicClassify(text: string): ReplyClassification {
  return heuristic(text);
}

/**
 * Deterministic classifier.
 *
 * Not merely a fallback — with no model reachable this is what actually runs,
 * and it ran on the whole inbox. The original version scored 65% on
 * scripts/eval-classify.ts, filing "hi its looking interested" as neutral and
 * "NO. DO NOT SEND AGAIN." as neutral too.
 *
 * Three things make the difference over single-keyword matching:
 *
 *   Order by cost of being wrong. An opt-out buried in a rejection is still an
 *   opt-out, and an auto-reply can quote anything, so both are settled before
 *   the sentiment rules run.
 *
 *   Phrases, not words. "book" matches "we already booked a vendor"; "remove"
 *   matches "remove the broken link". Each pattern carries enough context to
 *   mean what it looks like.
 *
 *   Handle negation and deferral explicitly. "not interested" and "interested"
 *   share a keyword, and "try me next quarter" is a maybe, not a no — treating
 *   it as a rejection kills a live prospect.
 */
function heuristic(text: string): ReplyClassification {
  /**
   * Curly punctuation is normalised first.
   *
   * Outlook and Gmail autocorrect apostrophes to U+2019, so real replies say
   * "let's" and "don't", and every pattern written with a straight quote missed
   * them. "Let's connect on Friday at 5pm" with a Google Meet link was filing
   * as neutral for exactly this reason.
   */
  const t = text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ");

  const verdict = (
    sentiment: ReplyClassification["sentiment"],
    intent_score: number,
    should_stop_sequence: boolean,
    reasoning: string,
  ): ReplyClassification => ({
    sentiment,
    intent_score,
    should_stop_sequence,
    reasoning: `${reasoning} (matched offline — no AI provider was reachable)`,
  });

  // 1. Opt-out. Checked first: "not interested, please remove me" is both a
  //    rejection and a removal request, and the removal request is the one with
  //    legal weight.
  const OPT_OUT =
    /\bunsubscribe\b|\bopt(ed)? out\b|(remove|take) (me|my (name|email|address)) (off|from)|remove .{0,20}(from )?(your |the )?(mailing|email|distribution|contact|e-?mail) list|(take|remove) .{0,10}off (your|the) .{0,20}list|stop (sending|all) (me )?(any|further|more)?\s*(e-?mails?|communications?)|remove me\b|take me off\b|no longer wish to receive/;
  if (OPT_OUT.test(t)) {
    return verdict("UNSUBSCRIBE", 0, true, "Explicit request to be removed.");
  }

  // 2. Automated away messages, including "no longer with the company", which
  //    is not a rejection — there is simply nobody there.
  const AUTO =
    /out of (the )?office|automatic reply|auto[- ]?reply|on (annual |maternity |paternity |sick )?leave\b|on vacation|on holiday|on pto\b|limited access to (my )?e-?mail|will (respond|reply|revert).{0,40}(return|back in|office)|no longer (with|at) \w+|has left the (company|firm)|is no longer employed|no longer (be )?(monitoring|checking|managing) (this|the|my)|currently away|away from (the|my) (office|desk)|vacation mail/;
  if (AUTO.test(t)) {
    return verdict("OUT_OF_OFFICE", 0, false, "Automated away message.");
  }

  // 3. A deferral is a maybe. Checked before rejection because it shares its
  //    wording — "not interested right now, but try me next quarter" is a lead
  //    worth keeping, and auto-suppressing it throws one away.
  const DEFERRAL =
    /(try|contact|reach out to|check back with|circle back|ping) (me|us) (again )?(in|next|later|after)|next (quarter|year|month)|in (a )?(few|couple of|\d+) (months|weeks|quarters)|revisit (this )?(in|next|later)|keep (me|us) (posted|in mind)|not (right )?now,? but|reach back out/;
  if (DEFERRAL.test(t)) {
    return verdict("NEUTRAL", 40, false, "Interested later, not now.");
  }

  // 4. Rejection. Includes the polite industry-standard brush-offs — "we handle
  //    that in-house", "we already have a vendor" — which the old version read
  //    as neutral and kept emailing.
  const REJECT =
    // "no need" needs an object. Bare, it matched "no need for pricing details
    // in the first message" — a note about copy, not a rejection.
    /\bnot interested\b|\bno,? thank(s| you)\b|\bnot looking\b|\bnot required\b|no need (for (your|this|these|such)|of your|at (this|the) (time|moment))|(don'?t|do not) (have a )?need (for|of)|stop (e-?mailing|contacting|reaching)|(do not|don'?t) (send|contact|e-?mail|reach out)|do not send again|\bnot the right fit\b|(handle|manage|do) (this|it|that|everything|all|these) (internally|in[- ]house)|\bin[- ]house\b|already (have|use|using|booked|selected|working with|partnered|engaged)|we have (a|an|our own)? ?(vendor|provider|solution|system|team|tool)|not (a )?fit|no longer interested|not interested at this time|not looking to (partner|engage|work)|\bpass\b(?! (this|it) (on|along))|\bstop\.?$|\bstop\b(?! by)/;
  if (REJECT.test(t)) {
    return verdict("NEGATIVE", 0, true, "Declined the offer.");
  }

  // 5. Scheduling. "book" alone is not enough — "already booked a vendor" is a
  //    rejection, and rule 4 has already taken it.
  const MEETING =
    /(set|setting) up a (call|meeting|demo|time)|(book|schedule|arrange|organi[sz]e) (a |an )?(call|meeting|demo|chat|time|slot)|(happy|glad|keen) to (chat|talk|connect|jump on)|let'?s (chat|talk|connect|set|schedule|meet)|works for me|are you (free|available)|what time|connect (on|over|via) (a )?(call|phone|zoom|teams)|(call|ring|phone) me (on|at)|plan some time to connect|(forward|send) (me )?the invite|send (me |over )?(a |an )?(calendar|invite|link)|\bcalendly\b|my calendar|(monday|tuesday|wednesday|thursday|friday)[^.]{0,30}(work|good|fine|suit)|available (on|at|this|next)|(call|meeting|demo) (next|this) (week|monday|tuesday|wednesday|thursday|friday)|jump on a (call|quick call)/;
  if (MEETING.test(t)) {
    return verdict("MEETING_REQUEST", 90, true, "Proposed or accepted a meeting.");
  }

  // 6. Referral or acknowledgement — engaged but not themselves a buyer. Ahead
  //    of POSITIVE so "looping in the team" is not read as enthusiasm.
  const REFERRAL =
    /looping in|loop(ing)? .{0,20}in|forward(ing|ed)? (this|your|it) (to|on)|passing (this|it) (on|to|along)|(not|isn'?t) the right person|try (our|the) .{0,20}(team|department)|speak (to|with) .{0,25}(team|department|colleague)|copying|cc'?ing|reach out to .{0,20}(instead|directly)/;
  if (REFERRAL.test(t)) {
    return verdict("NEUTRAL", 35, false, "Referred to someone else.");
  }

  // 7. Interest. "interested" only counts when it is not negated — rule 4 has
  //    already removed "not interested", so a bare match here is genuine.
  const POSITIVE =
    /\binterested\b|\binteresting\b|looks (good|useful|great|promising)|sounds (good|great|interesting|useful)|tell me more|(share|send)( me| over| us)?( the| a| some| more)? ?(pricing|price|details|info|information|deck|sample|proposal|quote|abstract)|how much|what (is|are) (the |your )?(pricing|cost|price)|what price|price do you|do you (offer|have|provide)|(?<!no need for |don'?t need |do not need |without )\bpricing\b|please send|go ahead and (share|send)|with the cost|would like to (know|learn|see|understand)|^(yes|sure|ok(ay)?)\b|\byes,? (please|that|your|we|i)\b|(that|this) (works|helps|is fine)|response is fine|onboarding look|more details/;
  if (POSITIVE.test(t)) {
    return verdict("POSITIVE", 70, true, "Expressed interest or asked for more.");
  }

  return verdict("NEUTRAL", 30, false, "No strong signal either way.");
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
