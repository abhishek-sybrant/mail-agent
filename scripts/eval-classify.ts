/**
 * Measures reply-classification accuracy against hand-labelled real replies.
 *
 *   npm run eval-classify                 # current configured provider
 *   npm run eval-classify -- --heuristic  # the offline fallback only
 *   npm run eval-classify -- --provider=anthropic
 *
 * The cases below are real inbound replies from this account, labelled by
 * reading them. Without this, "the classifier is better now" is an opinion —
 * a reply reading "hi its looking interested" was being filed as NEUTRAL and
 * nothing caught it.
 *
 * Read-only.
 */
import "dotenv/config";
import { classifyReply, heuristicClassify } from "../src/lib/ai/classify";

type Case = { text: string; expect: string; note?: string };

/**
 * Real replies, shortened. Grouped by what makes them hard, because an average
 * over easy cases hides exactly the failures that matter.
 */
const CASES: Case[] = [
  // --- plainly interested, phrased casually -------------------------------
  { text: "hi its looking interested", expect: "POSITIVE", note: "broken English" },
  { text: "Yes, your response is fine. Thanks", expect: "POSITIVE" },
  { text: "This looks interesting - we abstract about 400 leases a year manually. Can you share pricing?", expect: "POSITIVE" },
  { text: "Interested, though I'm not the decision maker. What does onboarding look like?", expect: "POSITIVE" },
  { text: "Sure, send over the sample abstract.", expect: "POSITIVE" },
  { text: "sounds good, share more details", expect: "POSITIVE" },

  // --- meetings -----------------------------------------------------------
  { text: "Sounds good, can we set up a call next Tuesday afternoon?", expect: "MEETING_REQUEST" },
  { text: "Sounds useful - can we book a demo call next Tuesday?", expect: "MEETING_REQUEST" },
  { text: "Happy to chat. Tuesday or Wednesday afternoon works for me.", expect: "MEETING_REQUEST" },

  // --- opt-outs -----------------------------------------------------------
  { text: "Please remove me from your email list. Susan Crawford", expect: "UNSUBSCRIBE" },
  { text: "Please take me off your distribution list.", expect: "UNSUBSCRIBE" },
  { text: "Please unsubscribe", expect: "UNSUBSCRIBE" },
  { text: "Kindly take me off from your email list.", expect: "UNSUBSCRIBE" },
  { text: "Please remove me from your email blast. I don't have a need for your service.", expect: "UNSUBSCRIBE" },
  { text: "Not interested, please remove me from your mailing list.", expect: "UNSUBSCRIBE", note: "rejection AND opt-out — opt-out wins" },

  // --- rejections ---------------------------------------------------------
  { text: "NO. DO NOT SEND AGAIN. Best, Kirk Ehrhart, CPA", expect: "NEGATIVE" },
  { text: "Stop emailing me please.", expect: "NEGATIVE" },
  { text: "I am not interested, thank you", expect: "NEGATIVE" },
  { text: "We are not interested in your services. Regards", expect: "NEGATIVE" },
  { text: "We have in house IT that handles this thanks", expect: "NEGATIVE" },
  { text: "Not required as we handle everything in-house and have the required tools", expect: "NEGATIVE" },
  { text: "We are not looking to partner with anyone at this time. We handle all the below in house.", expect: "NEGATIVE" },

  // --- auto-replies -------------------------------------------------------
  { text: "I am currently out of the office with limited access to emails. I will respond as soon as I can.", expect: "OUT_OF_OFFICE" },
  { text: "Thank you for contacting Dominion Properties. Michael OConnor is no longer with the company.", expect: "OUT_OF_OFFICE", note: "left the company" },
  { text: "I am out of the office until 12 August.", expect: "OUT_OF_OFFICE" },
  { text: "Vacation Mail. I am on leave and will revert on my return.", expect: "OUT_OF_OFFICE" },

  // --- genuinely neutral --------------------------------------------------
  { text: "Hi Raghu, Looping in the relevant team members who handle this. Thanks, Sergey", expect: "NEUTRAL", note: "referral" },
  { text: "Thanks, not the right person here - try our ops team.", expect: "NEUTRAL", note: "referral" },
  { text: "Apologies - I am running 5 mins late.", expect: "NEUTRAL" },
  { text: "Received.", expect: "NEUTRAL" },

  // --- found by sampling real replies, not written from imagination -------
  { text: "Joe Gill is no longer with Balboa Retail Partners. Please reach out to another member of the Balboa team.", expect: "OUT_OF_OFFICE", note: "company named, not the word 'company'" },
  { text: "I will be spending full time in the field and will no longer be monitoring this email inbox. Please send all inquiries to ohp@example.com.", expect: "OUT_OF_OFFICE", note: "'please send' must not read as interest" },
  { text: "Can you please connect on call ? 9883626306 is my number", expect: "MEETING_REQUEST" },
  { text: "We can certainly plan some time to connect next week. Would you mind sharing more details?", expect: "MEETING_REQUEST" },
  { text: "Few questions: 1: Do you have hardware to record data? 2: What price do you offer this service at?", expect: "POSITIVE", note: "asking price, phrased unusually" },
  { text: "Hello Please go ahead and share the pricing details.", expect: "POSITIVE" },
  { text: "YES, please with the cost, thanks", expect: "POSITIVE" },
  { text: "Initial message is very simple, no need for pricing details. We gave a simple message to Deepak.", expect: "NEUTRAL", note: "'no need' about copy, not a rejection" },
  { text: "I am out of the office on PTO but will do my best to respond in a timely manner.", expect: "OUT_OF_OFFICE" },
  { text: "Hi Pooja, Let’s connect on Friday at 5:00 pm. Below is the google meeting link for the call.", expect: "MEETING_REQUEST", note: "curly apostrophe — Outlook autocorrects them" },
  { text: "Thank you for your email, I am away from the office from July 9th returning July 16th.", expect: "OUT_OF_OFFICE" },
  { text: "We don’t need this, we have our own team.", expect: "NEGATIVE", note: "curly apostrophe in don’t" },

  // --- traps --------------------------------------------------------------
  { text: "Not interested right now, but try me again next quarter.", expect: "NEUTRAL", note: "deferral, not a rejection" },
  { text: "I'm interested in understanding why you keep emailing me. Stop.", expect: "NEGATIVE", note: "the word interested, but hostile" },
  { text: "We already booked a vendor for this, thanks.", expect: "NEGATIVE", note: "'booked' must not read as a meeting" },
  { text: "Can you remove the pricing page link, it 404s? Otherwise this looks useful.", expect: "POSITIVE", note: "'remove' is not an opt-out" },
];

async function main() {
  const useHeuristic = process.argv.includes("--heuristic");
  const providerArg = process.argv.find((a) => a.startsWith("--provider="));
  if (providerArg) process.env.AI_PROVIDER_CLASSIFY = providerArg.split("=")[1];

  console.log(
    `${CASES.length} cases · ${useHeuristic ? "heuristic only" : `provider=${process.env.AI_PROVIDER_CLASSIFY ?? process.env.AI_PROVIDER}`}\n`,
  );

  let correct = 0;
  const failures: string[] = [];

  for (const c of CASES) {
    const got = useHeuristic
      ? heuristicClassify(c.text)
      : await classifyReply(c.text, { name: null, company: null });

    const ok = got.sentiment === c.expect;
    if (ok) correct++;
    else {
      failures.push(
        `  expected ${c.expect.padEnd(16)} got ${got.sentiment.padEnd(16)} "${c.text.slice(0, 70)}"` +
          (c.note ? `\n      (${c.note})` : ""),
      );
    }
    process.stdout.write(ok ? "." : "X");
  }

  const pct = Math.round((correct / CASES.length) * 100);
  console.log(`\n\n${correct}/${CASES.length} correct (${pct}%)`);
  if (failures.length) {
    console.log("\nfailures:");
    console.log(failures.join("\n"));
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
