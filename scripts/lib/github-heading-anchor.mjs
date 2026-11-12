/**
 * The anchor GitHub gives a Markdown heading — the one rule for every script
 * that writes or checks a `#fragment` link (INV-SSOT). `docs:linkcheck`
 * (`scripts/check-doc-links.mjs`) checks links against it and the release tool
 * (`scripts/release/cut-release.mjs`) builds CHANGELOG.md links with it, so a
 * link the release tool writes is one the link check accepts.
 *
 * A close approximation of GitHub's slugger, not a byte-for-byte copy; lychee
 * in CI stays authoritative on an exotic heading. Node built-ins only.
 */

/**
 * Reduce a heading's Markdown to its rendered text: strip the `#` markers,
 * unwrap links/images to their text, and drop inline-code backticks. This is
 * what GitHub slugs, not the raw source.
 *
 * @param {string} rawLine
 * @returns {string}
 */
function headingText(rawLine) {
  let t = rawLine.replace(/^\s*#{1,6}\s+/, "").replace(/\s+#+\s*$/, "");
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ""); // images contribute no text
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); // inline links -> text
  t = t.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1"); // reference links -> text
  t = t.replace(/`([^`]*)`/g, "$1"); // inline code -> inner text
  return t;
}

/**
 * GitHub's slug of a heading line (`## Title`) or bare heading text: its
 * rendered text lowercased, with characters other than letters, numbers,
 * spaces, `_` and `-` removed and each space turned into a hyphen.
 * Consecutive separators are NOT collapsed (GitHub does not collapse them
 * either), and repeats are not de-duplicated — a caller that sees the whole
 * file adds GitHub's `-1`/`-2` suffixes.
 *
 * @param {string} heading
 * @returns {string}
 */
export function githubHeadingAnchor(heading) {
  return headingText(heading)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}
