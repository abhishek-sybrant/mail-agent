/**
 * Locale-stable formatting.
 *
 * `toLocaleString()` with no locale uses whatever the runtime's locale is —
 * which is the *server's* during SSR and the *browser's* after hydration. On
 * this machine that rendered 399,024 as "3,99,024" on the server (Indian
 * digit grouping) and "399,024" on the client, and React threw a hydration
 * error for the mismatched text.
 *
 * Pinning the locale makes both sides agree. Dates additionally pin the time
 * zone, since a server in one zone and a browser in another produce different
 * clock times for the same instant.
 */

const LOCALE = "en-GB";

/** Thousands-separated integer, identical on server and client. */
export function fmtNumber(n: number): string {
  return n.toLocaleString(LOCALE);
}

/**
 * Absolute date+time. Rendered in UTC so it cannot drift between server and
 * browser; the trailing marker keeps that honest rather than implying local.
 */
export function fmtDateTime(value: Date | string | number): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return (
    d.toLocaleString(LOCALE, {
      timeZone: "UTC",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }) + " UTC"
  );
}
