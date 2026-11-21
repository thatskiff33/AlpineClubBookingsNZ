/**
 * Where changelog fragments live, and how their links survive being compiled
 * out of that directory (#5214). Shared by the release compiler and the
 * fragment-shape census, which refuses at PR time a link the compiler would
 * refuse at the release cut.
 */
import path from "node:path";

/** Directory holding one Markdown fragment per merged PR. */
export const FRAGMENTS_DIRNAME = "changelog.d";

// The link shapes `scripts/check-doc-links.mjs` checks: inline links and
// images, and reference definitions at the start of a line.
const INLINE_LINK = /(!?\[[^\]]*\]\(\s*)(<[^>]+>|[^)\s]+)/g;
const REF_DEF = /^(\s*\[[^\]]+\]:\s*)(\S+)/;
const FENCE = /^\s*(```|~~~)/;

/**
 * A fragment is written in `changelog.d/`, so a relative link in it resolves
 * from there (`../docs/X.md`); the compiled copy lives at the repository root,
 * where the same text would point outside the repo (#5214). Rewrite one link
 * target so it resolves from the root. External, absolute and same-page
 * targets are returned unchanged.
 */
export function rebaseFragmentLink(target, fragmentName = "(fragment)") {
  const bracketed = target.startsWith("<") && target.endsWith(">");
  const inner = bracketed ? target.slice(1, -1) : target;
  // A scheme (`https:`, `mailto:`), protocol-relative, root-absolute or
  // same-page target already means the same thing from any directory.
  if (inner === "" || /^[a-z][a-z0-9+.-]*:/i.test(inner) || /^[/#?]/.test(inner)) {
    return target;
  }
  const split = inner.search(/[#?]/);
  const pathPart = split === -1 ? inner : inner.slice(0, split);
  const suffix = split === -1 ? "" : inner.slice(split);
  const rebased = path.posix.normalize(path.posix.join(FRAGMENTS_DIRNAME, pathPart));
  if (rebased === ".." || rebased.startsWith("../")) {
    throw new Error(
      `${FRAGMENTS_DIRNAME}/${fragmentName} links "${target}", which points outside the repository; ` +
        "fix the link before compiling.",
    );
  }
  const result = `${rebased}${suffix}`;
  return bracketed ? `<${result}>` : result;
}

/**
 * Rewrite every relative link in a fragment body so it resolves from the
 * repository root (`rebaseFragmentLink`). Link syntax inside fenced blocks and
 * inline code spans is an example, not a link, and is left alone.
 */
export function rebaseFragmentLinks(body, fragmentName) {
  let inFence = false;
  return body
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      // Blank out inline code spans (same length, so offsets still match the
      // real line) and splice each rebased target back into the real line.
      const masked = line.replace(/`[^`]*`/g, (span) => " ".repeat(span.length));
      const edits = [...masked.matchAll(INLINE_LINK)];
      const ref = masked.match(REF_DEF);
      if (ref) edits.push(ref);
      let out = line;
      for (const match of edits.sort((a, b) => b.index - a.index)) {
        const [, lead, target] = match;
        const start = match.index + lead.length;
        out = out.slice(0, start) + rebaseFragmentLink(target, fragmentName) + out.slice(start + target.length);
      }
      return out;
    })
    .join("\n");
}
