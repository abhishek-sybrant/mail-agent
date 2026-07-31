/**
 * The settings a QuickMail campaign needs, mirroring their create form.
 *
 * What the API can actually set (verified by introspection):
 *   createCampaign            → name, sharing
 *   updateCampaignAutomation  → timeZone, businessDays, timeRanges
 *   createEmailStep           → subject, body, tracking, draft, paused
 *   createWaitStep            → unit, value, business
 *
 * Four things have NO API equivalent — `startImmediately`, `leadsPerDay`,
 * `startDate` and `endDate`. Searching every input type in the schema turns up
 * only TimeRangeInput.startTime/endTime, which are daily clock times, not
 * calendar dates. We collect them so the brief is complete, then surface them
 * as manual steps rather than pretending they were applied.
 */

export const DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type Day = (typeof DAYS)[number];

export type FollowUp = {
  /** Business days to wait after the previous step. */
  waitDays: number;
  /** Blank subject means QuickMail replies on the existing thread. */
  subject: string;
  body: string;
};

export type CampaignSpec = {
  name: string;
  sharing: "everyone" | "only_me";
  days: Day[];
  timezone: string;
  fromTime: string;
  toTime: string;
  allHours: boolean;
  startImmediately: boolean;
  leadsPerDay: number | null;
  subject: string;
  body: string;
  /**
   * Inbox preheader — the grey text shown after the subject in most clients.
   * Left empty, clients fall back to the first line of the body, which usually
   * reads as "Hi Dhilak,". QuickMail calls this `preview`.
   */
  preview: string;
  /** Comma-separated. QuickMail takes these as `cced` / `bcced` strings. */
  cc: string;
  bcc: string;
  /** The whole sequence after the first email, in order. */
  followUps: FollowUp[];
  /**
   * Calendar window, each with a clock time — a date alone is ambiguous about
   * when on that day the campaign begins or stops. Collected for the brief;
   * not settable via the API.
   */
  startDate: string | null;
  startAt: string | null;
  endDate: string | null;
  endAt: string | null;
  /** Job-title keywords used to pre-filter leads. */
  titleKeywords: string[];
  /**
   * How finished the campaign should be when it lands in QuickMail.
   *   paused → draft steps; open each one in QuickMail before it can run
   *   ready  → copy finalised, steps paused; one click there starts it
   *   live   → sending on the next scheduled slot, no further confirmation
   * A campaign with a start date is held paused whatever this says.
   */
  launchMode: "paused" | "ready" | "live";
};

export const DEFAULT_SPEC: CampaignSpec = {
  name: "",
  sharing: "everyone",
  days: ["monday", "tuesday", "wednesday", "thursday", "friday"],
  timezone: "America/New_York",
  fromTime: "08:00",
  toTime: "18:00",
  allHours: false,
  startImmediately: false,
  leadsPerDay: null,
  subject: "",
  body: "",
  preview: "",
  cc: "",
  bcc: "",
  followUps: [],
  startDate: null,
  startAt: "09:00",
  endDate: null,
  endAt: "17:00",
  launchMode: "live",
  titleKeywords: [],
};

/** Offered in the timezone dropdown; the value is what QuickMail stores. */
export const TIMEZONES = [
  { label: "(GMT-08:00) Pacific Time (US & Canada)", value: "America/Los_Angeles" },
  { label: "(GMT-07:00) Mountain Time (US & Canada)", value: "America/Denver" },
  { label: "(GMT-06:00) Central Time (US & Canada)", value: "America/Chicago" },
  { label: "(GMT-05:00) Eastern Time (US & Canada)", value: "America/New_York" },
  { label: "(GMT+00:00) London", value: "Europe/London" },
  { label: "(GMT+01:00) Central European Time", value: "Europe/Paris" },
  { label: "(GMT+04:00) Gulf Standard Time", value: "Asia/Dubai" },
  { label: "(GMT+05:30) India Standard Time", value: "Asia/Kolkata" },
  { label: "(GMT+10:00) Sydney", value: "Australia/Sydney" },
];

export type AgentQuestion = {
  id: keyof CampaignSpec | "leadSource";
  question: string;
  /** checkbox = many, radio = one of a few, select = one from a long list. */
  kind: "checkbox" | "radio" | "select" | "time" | "number";
  options?: { value: string; label: string; hint?: string }[];
  value?: unknown;
};

/**
 * Everything the agent still needs before a campaign can be assembled.
 * Returning questions rather than guessing keeps the human in the loop.
 */
export function missingFields(spec: Partial<CampaignSpec>): AgentQuestion[] {
  const out: AgentQuestion[] = [];

  if (!spec.name?.trim()) {
    out.push({
      id: "name",
      question: "What should the campaign be called?",
      kind: "radio",
      options: [],
    });
  }

  if (!spec.days || spec.days.length === 0) {
    out.push({
      id: "days",
      question: "Which days should it send on?",
      kind: "checkbox",
      options: DAYS.map((d) => ({
        value: d,
        label: d[0].toUpperCase() + d.slice(1),
        hint: d === "saturday" || d === "sunday" ? "weekend" : undefined,
      })),
    });
  }

  if (!spec.timezone) {
    out.push({
      id: "timezone",
      question: "Which timezone are those hours in?",
      kind: "select",
      options: TIMEZONES.map((t) => ({ value: t.value, label: t.label })),
    });
  }

  if (!spec.fromTime || !spec.toTime) {
    out.push({
      id: "fromTime",
      question: "What sending window?",
      kind: "time",
      options: [
        { value: "08:00-18:00", label: "08:00 – 18:00", hint: "business hours" },
        { value: "09:00-17:00", label: "09:00 – 17:00" },
        { value: "07:00-20:00", label: "07:00 – 20:00", hint: "wider" },
        { value: "all", label: "All hours" },
      ],
    });
  }

  if (spec.sharing === undefined) {
    out.push({
      id: "sharing",
      question: "Who can see and edit this campaign?",
      kind: "radio",
      options: [
        { value: "everyone", label: "Everyone" },
        { value: "only_me", label: "Only me" },
      ],
    });
  }

  if (spec.leadsPerDay === undefined) {
    out.push({
      id: "leadsPerDay",
      question: "How many leads should start per day?",
      kind: "number",
      options: [
        { value: "25", label: "25 / day", hint: "gentle — protects the domain" },
        { value: "50", label: "50 / day" },
        { value: "100", label: "100 / day" },
        { value: "0", label: "No limit" },
      ],
    });
  }

  return out;
}
