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
 * Looks up which of these emails QuickMail already knows about, so we don't
 * create duplicate lead records on re-enrolment.
 */
export async function findExistingLeads(
  emails: string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();

  // The leads query is a text search rather than a bulk lookup, so this walks
  // one address at a time. Fine for the batch sizes a single campaign uses.
  for (const email of emails) {
    try {
      const data = await query<{
        leads: { nodes: { id: string; email: string }[] };
      }>(`query Find($text: String) { leads(text: $text, first: 5) { nodes { id email } } }`, {
        text: email,
      });

      const hit = data.leads.nodes.find(
        (n) => n.email.toLowerCase() === email.toLowerCase(),
      );
      if (hit) found.set(email.toLowerCase(), hit.id);
    } catch {
      // A failed lookup just means we'll try to create it — createLeads is
      // the authority, and a duplicate there is better than a dropped lead.
    }
  }

  return found;
}
