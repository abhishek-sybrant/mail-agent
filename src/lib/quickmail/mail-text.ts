/**
 * Turning real email into something readable.
 *
 * Replies arrive as full HTML documents — Outlook and Gmail both send a page,
 * not a paragraph — and each one carries the entire quoted thread beneath it.
 * Rendering that raw gives a wall of Office namespace declarations followed by
 * every previous message. Both problems are handled here so the sync, the AI
 * draft and the UI all agree on what a reply says.
 */

/**
 * Decodes HTML entities.
 *
 * QuickMail returns names and subjects entity-encoded, so a prospect called
 * O'Connor arrives as "O&#x27;Connor" and renders that way in a React text node
 * — React escapes on output, so nothing downstream will ever fix it. It has to
 * be decoded on the way in.
 */
export function decodeEntities(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    // Last, or it would double-decode "&amp;#x27;".
    .replace(/&amp;/g, "&")
    .trim();
}

/** Strips an HTML mail down to its text. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    // A closing <p> is a paragraph break; a closing <div> is only a line break.
    // Outlook wraps every single line in its own div, so treating those as
    // paragraphs double-spaces the entire message.
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/(div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Markers that begin a quoted thread.
 *
 * Anchored to the start of a line, because "From:" appears mid-sentence often
 * enough that an unanchored match eats real content.
 */
const QUOTE_MARKERS: RegExp[] = [
  /^On .{5,200}\bwrote:\s*$/im,
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^_{5,}\s*$/m,
  /^From:\s*.+$/im,
  /^Sent:\s*.+$/im,
  /^\s*>\s?.+$/m,
  /^Le .{5,120}\ba écrit\s*:\s*$/im,
];

/**
 * Returns just the new part of a reply — what the person actually typed.
 *
 * Falls back to the whole message when no quote marker is found, and refuses a
 * cut that would leave almost nothing: a signature-only top block would
 * otherwise throw away the entire reply.
 */
export function stripQuoted(text: string): string {
  if (!text) return "";

  let cut = text.length;
  for (const marker of QUOTE_MARKERS) {
    const m = marker.exec(text);
    if (m && m.index < cut) cut = m.index;
  }

  const head = text.slice(0, cut).trim();
  return head.length >= 20 ? head : text.trim();
}

/** Text of a reply, quote removed, capped for prompts and previews. */
export function replyText(
  message: { body_text?: string | null; body_html?: string | null },
  max = 4000,
): string {
  const full = message.body_text?.trim() || htmlToText(message.body_html);
  return stripQuoted(full).slice(0, max);
}
