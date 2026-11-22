/**
 * The Markdown link shapes `check-doc-links.mjs` checks and the release
 * compiler rebases (#5214), defined once so a link the checker validates in a
 * changelog fragment is the same link the compiler rewrites.
 */
import { scanMarkdownFenceLines } from "./markdown-blocks.mjs";

/**
 * The `(target` that follows a link's or image's closing `]`: spaces and at
 * most one line break, then `<anything but > or a line break>` or a run
 * without whitespace or `)`. Group 1 is the lead, group 2 the target.
 */
const DESTINATION = /^\(([ \t]*\n?[ \t]*)(<[^>\n]*>|[^)\s]+)/;

/** A line break followed by a blank line: link text never spans a paragraph. */
const PARAGRAPH_BREAK = /^\n[ \t]*(?:\n|$)/;

/**
 * Every inline link and image target in `text`, as `{ start, target }` with
 * `start` the target's offset, in text order. `text` may be one line or a
 * whole document: a link whose text wraps onto the next line, or whose
 * target sits on the line after `](`, is found (#5214).
 *
 * Brackets are matched as a stack, so each `](` pairs with its own `[`: an
 * image used as a link (`[![alt](a.png)](b.md)`) and a link inside an image's
 * alt text (`![see [x](y.md)](a.png)`) both yield two targets at two distinct
 * offsets. A target stops at whitespace or `)`, so `[x](a.md "title")` yields
 * `a.md`. Callers blank out code first; a backslash-escaped bracket is text.
 */
export function inlineLinkTargets(text) {
  const found = [];
  const openers = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
    } else if (ch === "\n") {
      if (PARAGRAPH_BREAK.test(text.slice(i))) openers.length = 0;
    } else if (ch === "[") {
      openers.push(i);
    } else if (ch === "]" && openers.length > 0) {
      openers.pop();
      const dest = text[i + 1] === "(" ? DESTINATION.exec(text.slice(i + 1)) : null;
      if (!dest) continue;
      found.push({ start: i + 2 + dest[1].length, target: dest[2] });
      // Skip the target itself, so a `[` or `]` inside it is not a bracket.
      i += dest[0].length;
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** A link title: `"…"`, `'…'` or `(…)`, on the target's line. */
const TITLE = String.raw`(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\))`;

/**
 * A reference definition, `[label]: target`, at a line start; the target may
 * be `<bracketed, with spaces>` and may sit on the following line. The target
 * must end its line, optionally followed by a title, as CommonMark requires:
 * otherwise a prose line such as `[Label]: some text`, or a bare `[note]:`
 * followed by a sentence, would lend a word of prose as the target (#5214).
 * Group 1 is the lead, group 2 the target.
 */
// A paragraph continuation line, as in "- Fixed the thing\n  [Label]: text", is
// not told apart from a definition (CommonMark does not let a definition
// interrupt a paragraph), so such a line is rebased too.
const REF_DEF = new RegExp(
  String.raw`^([ \t]*\[[^\]\n]+\]:[ \t]*\n?[ \t]*)(<[^>\n]*>|\S+)(?=[ \t]*\r?$|[ \t]+${TITLE}[ \t]*\r?$)`,
  "gm",
);

/** Every reference-definition target in `text`, as `{ start, target }`. */
export function refDefTargets(text) {
  return [...text.matchAll(REF_DEF)].map((match) => ({
    start: match.index + match[1].length,
    target: match[2],
  }));
}

/** An inline code span, which may wrap onto the next line but not past a blank one. */
const CODE_SPAN = /`(?:[^`\n]|\n(?![ \t]*(?:\n|$)))*`/g;

/**
 * `text` with fenced blocks and inline code spans blanked to spaces, keeping
 * every line break and offset, so link syntax shown as code is not read as a
 * link and an offset in the result is an offset in `text`. Which lines are
 * code is decided by the shared block scanner (`scanMarkdownFenceLines`), so
 * a fence closes only on its own marker and length (#5214): a `~~~` line
 * inside a backtick fence stays code.
 */
export function maskCode(text) {
  const blank = (chunk) => chunk.replace(/[^\n]/g, " ");
  const proseLines = new Set(scanMarkdownFenceLines(text).scannable.map(({ number }) => number));
  const out = [];
  let prose = [];
  const flushProse = () => {
    if (prose.length > 0) out.push(prose.join("\n").replace(CODE_SPAN, blank));
    prose = [];
  };
  text.split("\n").forEach((line, index) => {
    if (proseLines.has(index + 1)) {
      prose.push(line);
    } else {
      flushProse();
      out.push(blank(line));
    }
  });
  flushProse();
  return out.join("\n");
}
