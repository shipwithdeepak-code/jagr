/**
 * Personal data removal for customer text (support conversations, survey answers) before it is stored,
 * shown as evidence, or sent to an AI planner. Conservative: it removes contact details and anything
 * that looks like a payment card or credential; it does not try to remove names.
 */

const PATTERNS: [RegExp, string][] = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email removed]'],
  [/\bhttps?:\/\/\S+/gi, '[link removed]'],
  // Payment cards: 13–19 digits with optional spaces/dashes.
  [/\b(?:\d[ -]?){12,18}\d\b/g, '[number removed]'],
  // Phone numbers: +, then 8–15 digits with separators.
  [/(?:\+|\b00)\d[\d ().-]{7,}\d\b/g, '[phone removed]'],
  [/\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g, '[phone removed]'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b|\bgh[pousr]_[0-9A-Za-z]{20,}\b|\bxox[abprs]-[0-9A-Za-z-]{10,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[secret removed]'],
];

export function redactPersonalData(text: string): string {
  let out = text;
  for (const [re, marker] of PATTERNS) out = out.replace(re, marker);
  return out;
}

/** Strip HTML tags and entities from provider rich text. */
export function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
