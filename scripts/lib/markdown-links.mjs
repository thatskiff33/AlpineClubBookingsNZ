/**
 * The Markdown link shapes `check-doc-links.mjs` checks and the release
 * compiler rebases (#5214), defined once so a link the checker validates in a
 * changelog fragment is the same link the compiler rewrites.
 */

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

/**
 * A reference definition, `[label]: target`, at a line start; the target may
 * be `<bracketed, with spaces>` and may sit on the following line. Group 1 is
 * the lead, group 2 the target.
 */
const REF_DEF = /^([ \t]*\[[^\]\n]+\]:[ \t]*\n?[ \t]*)(<[^>\n]*>|\S+)/gm;

/** Every reference-definition target in `text`, as `{ start, target }`. */
export function refDefTargets(text) {
  return [...text.matchAll(REF_DEF)].map((match) => ({
    start: match.index + match[1].length,
    target: match[2],
  }));
}

/** A line that opens or closes a fenced code block, whose links are examples. */
export const FENCE_TOGGLE = /^\s*(```|~~~)/;

/** An inline code span, which may wrap onto the next line but not past a blank one. */
const CODE_SPAN = /`(?:[^`\n]|\n(?![ \t]*(?:\n|$)))*`/g;

/**
 * `text` with fenced blocks and inline code spans blanked to spaces, keeping
 * every line break and offset, so link syntax shown as code is not read as a
 * link and an offset in the result is an offset in `text`.
 */
export function maskCode(text) {
  const blank = (chunk) => chunk.replace(/[^\n]/g, " ");
  const out = [];
  let prose = [];
  let inFence = false;
  const flushProse = () => {
    if (prose.length > 0) out.push(prose.join("\n").replace(CODE_SPAN, blank));
    prose = [];
  };
  for (const line of text.split("\n")) {
    if (FENCE_TOGGLE.test(line) || inFence) {
      if (FENCE_TOGGLE.test(line)) inFence = !inFence;
      flushProse();
      out.push(blank(line));
    } else {
      prose.push(line);
    }
  }
  flushProse();
  return out.join("\n");
}
