/**
 * The Markdown link shapes `check-doc-links.mjs` checks and the release
 * compiler rebases (#5214), defined once so a link the checker validates in a
 * changelog fragment is the same link the compiler rewrites.
 */

/** A link target: `<anything but >>` or a run without whitespace or `)`. */
const TARGET = String.raw`(<[^>]+>|[^)\s]+)`;

/** An inline image, `![alt](target)`; group 1 the lead, group 2 the target. */
const IMAGE = new RegExp(String.raw`(!\[[^\]]*\]\(\s*)` + TARGET, "g");

/**
 * An inline link, `[text](target)`, whose text may hold whole images, so a
 * badge-style `[![alt](a.png)](b.md)` yields the outer `b.md` (#5214). The
 * lookbehind keeps images out; they are matched by `IMAGE`.
 */
const LINK = new RegExp(
  String.raw`((?<!!)\[(?:[^\[\]]|!\[[^\]]*\]\([^)]*\))*\]\(\s*)` + TARGET,
  "g",
);

/**
 * Every inline link and image target on one line, as `{ start, target }`
 * with `start` the target's offset, in line order. A target stops at
 * whitespace or `)`, so `[x](a.md "title")` yields `a.md`. Images and links
 * are matched separately so an image nested in a link yields both targets;
 * one combined pattern would stop at the image's `](` and miss the outer one.
 */
export function inlineLinkTargets(line) {
  const found = [];
  for (const pattern of [IMAGE, LINK]) {
    for (const match of line.matchAll(pattern)) {
      found.push({ start: match.index + match[1].length, target: match[2] });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** Reference definitions at line start, `[label]: target`; groups as above. */
export const REF_DEF = /^(\s*\[[^\]]+\]:\s*)(\S+)/;

/** A line that opens or closes a fenced code block, whose links are examples. */
export const FENCE_TOGGLE = /^\s*(```|~~~)/;
