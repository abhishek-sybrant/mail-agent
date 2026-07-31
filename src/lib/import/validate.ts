/**
 * Pre-send list hygiene.
 *
 * Every address rejected here is a bounce that never happens. Given the
 * account's historic bounce rate, this is the highest-leverage code in the
 * import path — it is deliberately stricter than RFC 5321.
 */

/** Free mailbox providers — valid, but usually noise on a B2B list. */
const FREE_PROVIDERS = new Set([
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "aol.com",
  "icloud.com",
  "protonmail.com",
  "mail.com",
  "gmx.com",
  "yandex.com",
]);

/** Addresses that reach a rota, not a person. High complaint risk, no reply value. */
const ROLE_PREFIXES = new Set([
  "info",
  "admin",
  "support",
  "sales",
  "contact",
  "help",
  "noreply",
  "no-reply",
  "postmaster",
  "webmaster",
  "abuse",
  "billing",
  "careers",
  "jobs",
  "hr",
  "marketing",
  "office",
  "enquiries",
  "inquiries",
]);

/** Spam-trap and throwaway domains — these actively damage sender reputation. */
const DISPOSABLE = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "tempmail.com",
  "throwawaymail.com",
  "trashmail.com",
  "yopmail.com",
  "sharklasers.com",
  "example.com",
  "test.com",
]);

// Deliberately conservative: no quoted local parts, no IP literals, requires a
// dotted domain with a 2+ character TLD.
const SHAPE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export type Verdict = {
  valid: boolean;
  email: string;
  reason?: string;
  warnings: string[];
};

export function validateEmail(input: unknown): Verdict {
  const warnings: string[] = [];

  if (typeof input !== "string") {
    return { valid: false, email: "", reason: "Not a string", warnings };
  }

  const email = input.trim().toLowerCase();

  if (!email) return { valid: false, email, reason: "Empty", warnings };
  if (email.length > 254) {
    return { valid: false, email, reason: "Too long", warnings };
  }
  if (!SHAPE.test(email)) {
    return { valid: false, email, reason: "Malformed address", warnings };
  }

  const [local, domain] = email.split("@");

  if (local.length > 64) {
    return { valid: false, email, reason: "Local part too long", warnings };
  }
  if (email.includes("..")) {
    return { valid: false, email, reason: "Consecutive dots", warnings };
  }
  if (DISPOSABLE.has(domain)) {
    return { valid: false, email, reason: "Disposable domain", warnings };
  }

  // A single-label TLD typo (.con, .cmo, .co m) is the classic bounce source.
  if (/\.(con|cmo|clom|comm|nte|ner|orgg)$/.test(domain)) {
    return { valid: false, email, reason: "Likely TLD typo", warnings };
  }

  const prefix = local.split("+")[0];
  if (ROLE_PREFIXES.has(prefix)) {
    warnings.push("Role address — low reply rate, higher complaint risk");
  }
  if (FREE_PROVIDERS.has(domain)) {
    warnings.push("Personal mailbox rather than a company domain");
  }

  return { valid: true, email, warnings };
}

/** Splits a first/last name out of a single full-name column. */
export function splitName(full: string | null | undefined): {
  first: string | null;
  last: string | null;
} {
  if (!full) return { first: null, last: null };
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}
