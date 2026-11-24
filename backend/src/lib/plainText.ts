/**
 * Turns the stored template body into clean, plain-text email copy.
 *
 * Templates used to be HTML with a card-shaped layout around the message.
 * Only the message itself should reach the recipient now: no wrapper, no
 * header/footer chrome, no buttons — just the words and the link.
 *
 * The same converter is used for the seeded defaults and at send time, so an
 * older HTML template already saved in the database still produces clean text.
 */

const CHROME = [
  /^Crane Discovery & Vendor Portal$/i,
  /^Sanghvi Movers Limited$/i,
  /^crossrentel?\b.*Crane sourcing/i,
  /^This message was sent by the SML Crane Portal\b/i,
  /^Please do not reply to this email\b/i,
  /^responses are not read; use the portal links above\b/i,
  /^If the button does not work\b/i,
];

// Stands in for <br/> while source newlines are collapsed. HTML ignores
// ordinary newlines, but we need to keep the intentional line breaks.
const BREAK = "\u0000";

function isChrome(line: string): boolean {
  return CHROME.some((pattern) => pattern.test(line));
}

export function htmlToPlainText(input: string, hasHtml = /<\/?[a-z][^>]*>/i.test(input)): string {
  let source = input
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, BREAK);

  // Source-code wrapping inside an HTML tag is not a line break in the email.
  if (hasHtml) source = source.replace(/\r?\n/g, " ");

  return source
    // Table rows read as "Label: value" rather than columns of cells.
    .replace(/<\/td>\s*<td\b[^>]*>/gi, ": ")
    .replace(/<td\b[^>]*>/gi, "")
    .replace(/<\/td>/gi, "")
    .replace(/<li\b[^>]*>/gi, "- ")
    // Paragraphs, blocks and lists get a blank line after them.
    .replace(/<\/(p|div|h[1-6]|table|ul|ol|section)>/gi, "\n\n")
    // Items inside a list or table stay tight together.
    .replace(/<\/(li|tr)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&middot;/gi, "·")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)))
    .replace(new RegExp(BREAK, "g"), "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    // Keep empty lines: they are the paragraph breaks. Only drop chrome.
    .filter((line) => !isChrome(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    // Old "button" templates left the label and URL as separate paragraphs.
    // Keep the link directly under its label.
    .replace(/([^\n:]{2,40})\n\n(https?:\/\/\S+)/g, "$1:\n$2")
    .trim();
}
