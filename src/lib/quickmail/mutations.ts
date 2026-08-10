import { prisma } from "@/lib/prisma";
import { query } from "./client";

/**
 * QuickMail write operations.
 *
 * Shapes here were verified against the live schema by introspection — the
 * mutation names, input field names and payload fields are exact.
 */

export const CREATE_CAMPAIGN = `
  mutation CreateCampaign($input: CreateCampaignInput!) {
    createCampaign(input: $input) { campaign { id name appUrl } }
  }
`;

export const CREATE_EMAIL_STEP = `
  mutation CreateEmailStep($input: CreateEmailStepInput!) {
    createEmailStep(input: $input) { step { id } }
  }
`;

export const CREATE_WAIT_STEP = `
  mutation CreateWaitStep($input: CreateWaitStepInput!) {
    createWaitStep(input: $input) { clientMutationId }
  }
`;

export const SET_ACCOUNTS = `
  mutation SetAccounts($input: SetCampaignEmailAccountsInput!) {
    setCampaignEmailAccounts(input: $input) { clientMutationId }
  }
`;

/**
 * Sending schedule. Verified input shape:
 *   timeZone     String            IANA, e.g. "America/New_York"
 *   businessDays { sunday..saturday: Boolean! }
 *   timeRanges   [{ day: DayOfWeekEnum!, startTime: String!, endTime: String! }]
 * DayOfWeekEnum values are lowercase: sunday | monday | ... | saturday.
 */
export const UPDATE_AUTOMATION = `
  mutation UpdateAutomation($input: UpdateCampaignAutomationInput!) {
    updateCampaignAutomation(input: $input) { clientMutationId }
  }
`;

export const CREATE_LEADS = `
  mutation CreateLeads($input: CreateLeadsInput!) {
    createLeads(input: $input) { leads { id email } }
  }
`;

export const ADD_LEADS_TO_CAMPAIGN = `
  mutation AddLeads($input: AddLeadsToCampaignInput!) {
    addLeadsToCampaign(input: $input) {
      campaign { id }
      leads { id email }
    }
  }
`;

/** QuickMail's own lead shape — note it wants first/last split, not a full name. */
export type QmLeadInput = {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  title?: string | null;
  role?: string | null;
  phone?: string | null;
  location?: string | null;
  score?: number | null;
};

/**
 * How many addresses are worth looking up one at a time.
 *
 * QuickMail's `leads` query is a text search, not a bulk lookup, so this costs
 * one request per address — and the shared rate limiter paces requests about
 * 1.15s apart. 500 addresses is roughly ten minutes with the HTTP request held
 * open the whole time, which is what a stuck "Create and start sending" spinner
 * actually was.
 *
 * Past this, the lookup is skipped and createLeads decides. That risks a
 * duplicate lead record in QuickMail; ten minutes of silence is worse, and the
 * cache below means the cost falls away as the same people are re-enrolled.
 */
const LOOKUP_BUDGET = 60;

/**
 * Looks up which of these emails QuickMail already knows about, so we don't
 * create duplicate lead records on re-enrolment.
 *
 * Answers come from the local mirror first: every id learned here is written
 * back to `Lead.quickmail_lead_id`, so a second campaign to the same people
 * costs nothing.
 */
export async function findExistingLeads(emails: string[]): Promise<{
  found: Map<string, string>;
  lookedUp: number;
  skipped: number;
}> {
  const wanted = emails.map((e) => e.trim().toLowerCase());
  const found = new Map<string, string>();

  // 1 — whatever we already know, for free.
  const cached = await prisma.lead.findMany({
    where: { email: { in: wanted }, NOT: { quickmail_lead_id: null } },
    select: { email: true, quickmail_lead_id: true },
  });
  for (const c of cached) {
    if (c.quickmail_lead_id) found.set(c.email.toLowerCase(), c.quickmail_lead_id);
  }

  const unknown = wanted.filter((e) => !found.has(e));
  const toLookUp = unknown.slice(0, LOOKUP_BUDGET);

  // 2 — ask QuickMail about the rest, within budget.
  const learned: { email: string; id: string }[] = [];
  for (const email of toLookUp) {
    try {
      const data = await query<{
        leads: { nodes: { id: string; email: string }[] };
      }>(`query Find($text: String) { leads(text: $text, first: 5) { nodes { id email } } }`, {
        text: email,
      });

      const hit = data.leads.nodes.find(
        (n) => n.email.toLowerCase() === email,
      );
      if (hit) {
        found.set(email, hit.id);
        learned.push({ email, id: hit.id });
      }
    } catch {
      // A failed lookup just means we'll try to create it — createLeads is
      // the authority, and a duplicate there is better than a dropped lead.
    }
  }

  // 3 — remember, so the next campaign to these people skips step 2 entirely.
  for (const l of learned) {
    await prisma.lead
      .updateMany({ where: { email: l.email }, data: { quickmail_lead_id: l.id } })
      .catch(() => undefined);
  }

  return {
    found,
    lookedUp: toLookUp.length,
    skipped: Math.max(0, unknown.length - toLookUp.length),
  };
}
