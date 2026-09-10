/**
 * src/shared/cleanText.ts — text hygiene before anything reaches the LLM.
 *
 * Everything here is a pure string → string function: no DOM, no chrome.*,
 * so the same code runs in content scripts and the service worker, and is
 * trivially unit-testable (tests/cleanText.test.ts).
 *
 * Why bother: quoted reply history, signatures, and legal footers are
 * token bloat that actively HURTS synthesis — the LLM happily summarizes
 * the confidentiality disclaimer if you let it see one. Strip first, cap
 * second, and mark the cap explicitly so truncation is never silent.
 *
 * Each stripper cuts at the EARLIEST marker it recognizes and returns the
 * text above it. All heuristics are conservative: a false negative (some
 * boilerplate slips through) costs a few tokens; a false positive (real
 * content removed) corrupts the payload. When in doubt, keep the text.
 */

export const MAX_CHARS = 8000;
export const TRUNCATION_MARKER = "\n\n[Swivel: source text truncated at 8,000 characters]";

/**
 * Reply-history headers. `[\s\S]` instead of `.` in the Gmail pattern
 * because innerText often wraps "On <date> <sender> wrote:" across two
 * lines; the lazy bound keeps it from swallowing paragraphs.
 */
const QUOTE_HEADERS: readonly RegExp[] = [
  /^On [\s\S]{1,200}?wrote:\s*$/m, // Gmail / Apple Mail
  /^-{2,}\s*Original Message\s*-{2,}\s*$/im, // Outlook classic
  /^_{6,}\s*$/m, // Outlook divider line
  /^From:\s.+\n(?:Sent|Date):\s.+$/m, // Outlook header block
];

export function stripQuotedHistory(text: string): string {
  let cut = text.length;
  for (const re of QUOTE_HEADERS) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  // Whatever survives the header cut, also drop line-quoted remnants.
  return text
    .slice(0, cut)
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");
}

const SIGNATURE_STARTS: readonly RegExp[] = [
  /^--\s*$/m, // RFC 3676 signature delimiter ("-- ")
  /^Sent from my (iPhone|iPad|Android|Galaxy|Windows|mobile)/im,
];

export function stripSignature(text: string): string {
  let cut = text.length;
  for (const re of SIGNATURE_STARTS) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut);
}

const LEGAL_FOOTERS: readonly RegExp[] = [
  /CONFIDENTIALITY NOTICE/i,
  /^Disclaimer[:.]/im,
  /This (e-?mail|message)( and any attachments)? (is|are|may (be|contain))[\s\S]{0,120}?(confidential|privileged|intended (solely|only))/i,
  /^If you (are not the intended recipient|received this (e-?mail|message) in error)/im,
];

export function stripLegalFooter(text: string): string {
  let cut = text.length;
  for (const re of LEGAL_FOOTERS) {
    const m = re.exec(text);
    if (!m) continue;
    // A footer is trailing boilerplate — it never LEADS a message. Require
    // at least a short sentence of real content before the match, so an
    // email whose opening is ABOUT a disclaimer is preserved. (A position
    // ratio fails here: a short body + long notice puts the notice early
    // by character offset yet it's still the footer.) Bias to keep.
    const precedingLen = text.slice(0, m.index).trim().length;
    if (precedingLen >= 20 && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut);
}

export function collapseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "") // trailing whitespace per line
    .replace(/[ \t]{2,}/g, " ") // runs of spaces/tabs (innerText artifacts)
    .replace(/\n{3,}/g, "\n\n") // 3+ newlines → one blank line
    .trim();
}

/** Hard cap with an explicit, visible marker — truncation is never silent. */
export function truncateWithMarker(text: string, maxChars: number = MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + TRUNCATION_MARKER;
}

/** The full pipeline the hub runs on every extracted body. */
export function cleanEmailText(raw: string): string {
  const normalized = raw.replace(/\r\n?/g, "\n");
  return truncateWithMarker(
    collapseWhitespace(stripLegalFooter(stripSignature(stripQuotedHistory(normalized))))
  );
}
