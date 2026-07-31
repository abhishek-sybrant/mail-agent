import { DAYS, TIMEZONES, type CampaignSpec, type Day } from "./campaign-spec";

/**
 * Pulls hard settings out of the prompt before the model sees it.
 *
 * Days, clock times, zones, dates and counts are exactly the things a regex
 * gets right every time and a small model gets wrong intermittently —
 * qwen2.5:3b dropped all five from "Mon to Fri, 9:00 to 17:00,
 * America/New_York, sharing everyone, 50 leads per day". So we parse them here
 * and let the model do only what it is good at: writing the copy.
 */

const DAY_ALIASES: Record<string, Day> = {
  mon: "monday", monday: "monday",
  tue: "tuesday", tues: "tuesday", tuesday: "tuesday",
  wed: "wednesday", weds: "wednesday", wednesday: "wednesday",
  thu: "thursday", thur: "thursday", thurs: "thursday", thursday: "thursday",
  fri: "friday", friday: "friday",
  sat: "saturday", saturday: "saturday",
  sun: "sunday", sunday: "sunday",
};

const WEEKDAYS: Day[] = ["monday", "tuesday", "wednesday", "thursday", "friday"];

const ZONE_HINTS: [RegExp, string][] = [
  [/\b(pacific|pst|pdt)\b/i, "America/Los_Angeles"],
  [/\b(mountain|mst|mdt)\b/i, "America/Denver"],
  [/\b(central time|cst|cdt)\b/i, "America/Chicago"],
  [/\b(eastern|est|edt|new.?york)\b/i, "America/New_York"],
  [/\b(london|bst|uk time)\b/i, "Europe/London"],
  [/\b(cet|cest|paris|berlin|central european)\b/i, "Europe/Paris"],
  [/\b(gulf|dubai|gst)\b/i, "Asia/Dubai"],
  // "indian" is how people usually write it, and \bindia\b does not match it.
  [/\b(ist|indian?|kolkata|calcutta)\b/i, "Asia/Kolkata"],
  [/\b(sydney|aest|aedt)\b/i, "Australia/Sydney"],
];

const MONTHS =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

/** ISO, "May 20th", or "20 May" — with or without a year. */
const DATE_RE = `(\\d{4}-\\d{2}-\\d{2}|(?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s*\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})(?:,?\\s*\\d{4})?)`;

/** "9", "9am", "09:00", "5pm", "17:00" → "HH:MM" */
function toHHMM(raw: string): string | null {
  const m = raw.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;

  let hour = Number(m[1]);
  const min = m[2] ?? "00";
  const mer = m[3];

  if (hour > 23) return null;
  if (mer === "pm" && hour < 12) hour += 12;
  if (mer === "am" && hour === 12) hour = 0;

  return `${String(hour).padStart(2, "0")}:${min}`;
}

/**
 * A clock time sitting right after a date, as in "starts 3 Aug at 9am".
 * Scoped to a short window so it can't grab the daily send window instead.
 */
function clockNear(text: string, from: number): string | null {
  const slice = text.slice(from, from + 70);
  const m = slice.match(/\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
  return m ? toHHMM(m[1]) : null;
}

/** Best-effort ISO date; returns the raw text if it can't be parsed. */
function normaliseDate(raw: string): string {
  const cleaned = raw.replace(/(\d)(st|nd|rd|th)/gi, "$1").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return cleaned;

  const withYear = /\d{4}/.test(cleaned)
    ? cleaned
    : `${cleaned} ${new Date().getFullYear()}`;
  const d = new Date(withYear);
  if (Number.isNaN(d.getTime())) return raw;
  // Format from local parts — toISOString() converts to UTC and rolls the
  // date back a day for any timezone east of Greenwich.
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parsePrompt(text: string): Partial<CampaignSpec> {
  const t = text.toLowerCase();
  const out: Partial<CampaignSpec> = {};

  // --- calendar window ----------------------------------------------------
  // Done first so the date text can be blanked before time parsing runs —
  // otherwise "2026-08-01 ... 2026-09-15" reads as an 08:00–01:00 window.
  const startM = t.match(
    new RegExp(
      `\\b(?:start(?:s|ing)?|begin(?:s|ning)?|from|launch(?:es|ing)?)\\b[^.]{0,12}?${DATE_RE}`,
      "i",
    ),
  );
  if (startM) {
    out.startDate = normaliseDate(startM[1]);
    out.startAt = clockNear(t, startM.index ?? 0) ?? undefined;
  }

  const endM = t.match(
    new RegExp(
      `\\b(?:until|till|thru|through|ends?|ending|stop(?:s|ping)?|run(?:s|ning)? to)\\b[^.]{0,12}?${DATE_RE}`,
      "i",
    ),
  );
  if (endM) {
    out.endDate = normaliseDate(endM[1]);
    out.endAt = clockNear(t, endM.index ?? 0) ?? undefined;
  }

  // Strip every date-shaped run so nothing downstream mistakes it for a time.
  const noDates = t
    .replace(new RegExp(DATE_RE, "gi"), " ")
    .replace(/\b\d{4}\b/g, " ");

  // --- days ---------------------------------------------------------------
  if (/\ball\s*days\b|\bevery\s*day\b|\b7\s*days\s*(?:a|per)\s*week\b/.test(noDates)) {
    out.days = [...DAYS];
  } else if (/\bweekdays?\b|\bbusiness days\b/.test(noDates)) {
    out.days = [...WEEKDAYS];
  } else {
    const range = noDates.match(
      /\b(mon|tues?|wed(?:s|nes)?|thur?s?|fri|sat|sun)[a-z]*\s*(?:-|–|to|through|until|thru)\s*(mon|tues?|wed(?:s|nes)?|thur?s?|fri|sat|sun)[a-z]*/,
    );
    if (range) {
      const from = DAY_ALIASES[range[1]];
      const to = DAY_ALIASES[range[2]];
      if (from && to) {
        const a = DAYS.indexOf(from);
        const b = DAYS.indexOf(to);
        out.days =
          a <= b ? DAYS.slice(a, b + 1) : [...DAYS.slice(a), ...DAYS.slice(0, b + 1)];
      }
    } else {
      const found = new Set<Day>();
      for (const [alias, day] of Object.entries(DAY_ALIASES)) {
        if (new RegExp(`\\b${alias}\\b`).test(noDates)) found.add(day);
      }
      if (found.size > 0) out.days = DAYS.filter((d) => found.has(d));
    }
  }

  // --- daily sending window -----------------------------------------------
  if (/\ball\s*hours\b|\b24\/7\b|\bround the clock\b/.test(noDates)) {
    out.allHours = true;
    out.fromTime = "00:00";
    out.toTime = "23:59";
  } else {
    // Require a colon or am/pm on at least one side, so bare numbers like
    // "50 to 100" never register as a time range.
    const win = noDates.match(
      /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|–|to|until|till|thru|through)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/,
    );
    if (win && /[:apm]/i.test(win[1] + win[2])) {
      const from = toHHMM(win[1]);
      const to = toHHMM(win[2]);
      if (from && to && from !== to) {
        out.fromTime = from;
        out.toTime = to;
        out.allHours = false;
      }
    }
  }

  // --- timezone -----------------------------------------------------------
  const explicit = TIMEZONES.find((z) =>
    new RegExp(z.value.replace("/", ".?"), "i").test(text),
  );
  if (explicit) {
    out.timezone = explicit.value;
  } else {
    for (const [re, zone] of ZONE_HINTS) {
      if (re.test(text)) {
        out.timezone = zone;
        break;
      }
    }
  }

  // --- sharing ------------------------------------------------------------
  if (/\bonly me\b|\bprivate\b|\bjust me\b/.test(t)) out.sharing = "only_me";
  else if (/\beveryone\b|\bshared\b|\bwhole team\b|\bteam can\b/.test(t))
    out.sharing = "everyone";

  // --- leads per day ------------------------------------------------------
  const perDay = t.match(
    /\b(\d{1,5})\s*(?:leads?|contacts?|prospects?|emails?)?\s*(?:a|per|\/|each)\s*day\b/,
  );
  if (perDay) out.leadsPerDay = Number(perDay[1]);
  else if (/\bno (?:daily )?limit\b|\bunlimited\b/.test(t)) out.leadsPerDay = 0;

  if (/\bstart (?:it )?(?:immediately|now|right away|at once)\b/.test(t)) {
    out.startImmediately = true;
  }

  // --- follow-up delays ---------------------------------------------------
  // "follow up after 4 days, then 7 days" → two waits, in order.
  const delays = [...t.matchAll(/\b(\d{1,2})\s*(?:business\s*)?days?\b/g)]
    .filter((m) => /follow|then|later|after|chase|nudge/.test(t.slice(Math.max(0, m.index! - 40), m.index!)))
    .map((m) => Number(m[1]))
    .filter((n) => n >= 1 && n <= 60);

  if (delays.length > 0) {
    out.followUps = delays.map((waitDays) => ({ waitDays, subject: "", body: "" }));
  }

  return out;
}
