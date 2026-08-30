/**
 * Telling code from prose: source with its comments blanked out, newlines
 * preserved, plus the two other forms a scanner in this tree ever needs.
 *
 * THE ONE DEFINITION IN THE TREE, and since #3164 a rule ENFORCES that rather
 * than review doing it: 53 test files and one CI script import this module, and
 * `ssot/no-local-comment-stripper` in `eslint.config.mjs` reports a second
 * scanner wherever one is written, in the editor.
 *
 * #3132's own claim to have converged the tree was true of the copies spelled
 * `stripComments` and of nothing else. Measured on the day it landed, SEVEN more
 * were alive under the name `withoutComments`, and #3164 then found twenty-one
 * more with no name at all — written inline as a `.replace()` chain in a census
 * — because a sweep keyed on a symbol cannot see an expression. That is why the
 * rule keys on what a function DOES, and why the count above roughly doubled
 * without a single new census being written.
 *
 * THREE FORMS LIVE HERE, and that is the point of the module rather than an
 * accident of where things landed. `stripComments` keeps strings and removes
 * comments; `stripCommentsAndStrings` (#3164 moved it here from the Xero census
 * that wrote it) also blanks the CONTENTS of every string, so a rule cannot fire
 * on prose inside a quoted example; `stripCssComments` reads CSS, the one other
 * language sharing JavaScript's block delimiter. A caller picks a form. It does
 * not write a fourth.
 *
 * Two lists in `eslint.config.mjs` say what is not a copy.
 * `COMMENT_STRIPPER_ALLOWLIST` holds the scanners that are a different CONCEPT —
 * SQL comments, a comment EXTRACTOR, and the guard's own fixture file.
 * `UNCONVERGED_COMMENT_SCANNERS` is a ratchet of four files. THREE of them walk
 * source and report offsets into the ORIGINAL text, which no form here can
 * serve: the first preserves newlines but not columns, and the second replaces
 * each string with a two-character `""`. The form that would serve those three
 * is an offset-preserving blanker (#3180), and it belongs HERE when it is
 * written rather than three more times out there. The fourth entry does not
 * share that property and its own reason says so — a list's shared sentence has
 * to be true of every row, or the row it is false about is the one nobody
 * re-reads.
 *
 * It is shared rather than copied for a reason that cost this repository a real
 * blind spot (#3123). `club-time-escape-hatch-census.test.ts` strips comments
 * before counting; `club-time-boundary-guard.test.ts`'s staleness leg used to
 * read RAW source. The two claim to be independent instruments measuring the
 * same thing, and for that claim to hold they have to measure it the same way.
 * They did not. This repository documents each defect at the site where it
 * removed it, so the strings these scanners grep for are densest in exactly the
 * files that no longer commit the defect — and `member-guest-delegate-page.ts`
 * kept its environment-zone exemption alive on the strength of a docblock
 * explaining the defect that had already been fixed. A guard a postmortem can
 * satisfy is not a guard.
 *
 * The census's own history is the other half of the argument. Counting raw text
 * reported 14 files reading a host clock face and 96 naming `APP_TIME_ZONE`; the
 * real numbers were 0 and 9. A census that counts its own postmortems reports
 * the epic's success as its failure.
 *
 * ## One left-to-right pass, not a pair of regular expressions
 *
 * A measured defect rather than tidiness. An earlier form stripped block
 * comments first and then line comments, leaving `//` alone after a colon so a
 * `https://…` inside a string survived. That ordering means a block-comment
 * opener written inside a LINE comment opens a block comment which the regex
 * then closes at the next block-comment terminator anywhere below — and
 * `src/app/(admin)/layout.tsx` contains exactly that shape. Stripping it removed
 * 4,739 of its 6,290 characters, including the `<AppProviders>` the check exists
 * to prove.
 *
 * Newlines are preserved rather than deleted so a reported line number still
 * points at the real line. String literals are tracked because `"https://x"`
 * contains a `//` that is not a comment, and template literals because they can
 * contain both — and because a call inside a `${...}` interpolation is real code
 * that a scanner blanking whole templates would miss. Backticks are MATCHED
 * rather than lexed, which is why this is not the #2166 failure: a
 * `ts.createScanner` lexer cannot resume a template literal after a `${…}`
 * substitution, so the closing brace-backtick of a `className={...}` template
 * opened a bogus literal that ran forward into a JSX comment and the
 * `describeReason={false}` that comment quoted was counted as a real opt-out.
 * Measured on that exact file, this scanner agrees with a full TypeScript parse
 * on every count `view-only-banner-contract.test.ts` makes.
 *
 * ## Regex literals
 *
 * They are recognised, and the previous version of this docblock was WRONG to
 * say they need not be. It claimed the shape "does not occur in this repository,
 * and it cannot be written by accident, because an unescaped `/` ends a regex".
 * The ESCAPED form is the common one: `.replace(/\//g, "_")` puts two slashes
 * adjacent, which a scanner without the branch below reads as a line comment and
 * follows to the end of the line, DELETING REAL CODE. Measured across `src/`
 * before the fix, that silently truncated lines in a dozen files —
 * `google-oauth.ts`, `club-time-zone.ts`, `calendar-events.ts`,
 * `website-footer-shell.tsx`, three `page.tsx` files and more — and
 * `xero-contacts.ts`, which writes `.replace(/"/g, "")`, desynchronised for the
 * remaining thousand lines, so every docblock after it was emitted as CODE.
 *
 * That last one is not a new discovery. The #2869 review found it and fixed it in
 * `xero-provider-date-boundary-census.test.ts` ALONE, which is `INV-SSOT-004`
 * exactly: one of two instruments repaired, and the other left reading the same
 * tree by a different method. The predicates below were that census's, shared
 * with this scanner by #3132; #3164 finished the move by bringing the census's
 * whole second form here too, so the two instruments are now one module with two
 * entry points and cannot drift apart again. The predicates are private for that
 * reason — nothing outside this file needs them any more.
 *
 * TWO JSX SHAPES ARE CARVED OUT of the regex branch (#3191 fix round), and they
 * are the only ones: `</Tag>` and a self-closing ` />` after a value token. Both
 * used to open a phantom regex that ran forward to the next `/` on the line and
 * DELETED the code between - measured on `finance-fees-sections.tsx`, where it
 * hid two `.fieldProps` spreads and made an accessibility-wiring contract report
 * a half-wired file that is wired correctly. The condition and its controls are
 * on `startsRegexLiteral` and in `xero-provider-date-boundary-census.test.ts`.
 *
 * It is still not a full parser, and what it does not attempt is stated so
 * nobody has to rediscover it: it does not check that a regex is well-formed,
 * and a `/` following a string literal (`"abc" / 2`) is read as opening a regex
 * rather than dividing. Neither shape occurs on the scanned surface, and both
 * fail toward keeping text rather than deleting it — which is the safe direction
 * for an instrument whose job is to stop a guard passing vacuously.
 *
 * Two imprecisions are pinned rather than hidden, and they fail in opposite
 * directions.
 *
 * An odd apostrophe in JSX prose (`<p>It's the club clock</p>`) opens a string
 * that never closes, so a comment after it is NOT stripped. That over-reports,
 * which is visible as a failure rather than as a false pass, and
 * `member-public-club-time-convergence.test.ts` asserts both halves of it.
 *
 * The other one under-reports, so it is the one to know about. JSX TEXT is
 * neither code nor a string literal, so a `//` written in prose inside an
 * element is read as a line comment and the rest of that line is deleted.
 * Measured live in two files: `backups-client.tsx` renders
 * `postgresql://…/shadow_db` as text, and `xero-completion-steps.tsx` renders
 * `<strong>https://</strong> site, and this deployment`, where everything from
 * the double slash to the end of the line goes. Nothing is currently mis-scanned
 * as a result — no rule in the tree looks for anything on those lines — but a
 * call site sharing a line with such prose would be invisible.
 *
 * There is no cheap fix. Telling JSX text from code needs a real parse, and the
 * obvious heuristic (ignore `//` after a `:`) is the two-regex trick whose
 * removal is documented above. A full TypeScript parse gets this right and is
 * 21x slower — measured at 5,977 ms against 284 ms over 3,873 files, which is
 * why three censuses that used the parser now use this and one of them dropped
 * from ~16 s to ~1 s. The parser has its own complementary blind spot: it misses
 * comments trailing the last token, which this scanner strips correctly. Both
 * remaining gaps, and the fact that neither instrument dominates, are tracked
 * rather than asserted away.
 */

/** The last character of `code` that is not whitespace, or `""`. */
function lastSignificant(code: string): string {
  for (let index = code.length - 1; index >= 0; index -= 1) {
    if (!/\s/.test(code[index])) return code[index];
  }
  return "";
}

/** Tokens after which a `/` opens a REGEX rather than dividing. */
const REGEX_POSITION_KEYWORD =
  /\b(?:return|typeof|instanceof|case|in|of|do|else|void|delete|new|yield|await)\s*$/;

/**
 * Does a `/` at this point open a regex literal?
 *
 * THIS IS NOT PEDANTRY, IT IS A MEASURED DEFECT (#2869 review).
 * `xero-contacts.ts` writes `.replace(/"/g, "")` inside a template
 * interpolation. Treating that quote as a string opener desynchronised the
 * scanner for the remaining thousand lines of the file, so every docblock after
 * it was emitted as CODE — and the census then reported its own explanation of
 * the original defect AS the defect. The version of that file which claimed
 * "nothing on the scanned surface writes a regex containing a quote" was untrue
 * when it was written.
 *
 * The rule is the ordinary one: a `/` divides when it follows a value, and opens
 * a regex otherwise. `//` and comment openers are handled before this is
 * reached, and an empty regex is unwritable in JavaScript, so the two cannot
 * collide.
 */
function startsRegexLiteral(codeSoFar: string, next: string): boolean {
  const previous = lastSignificant(codeSoFar);
  if (previous === "") return true;
  /*
    THE TWO JSX SHAPES, and they are a MEASURED defect rather than pedantry
    (#3191 fix round). Both delete real code on a single-line element, which is
    the unsafe direction for an instrument whose job is to stop a guard passing
    vacuously - the two imprecisions this module already documents both fail the
    other way, toward keeping text.

    `</Label>` is a closing tag, and `<` is not one of the value tokens below, so
    the old rule opened a regex on it and ran forward to the next `/` - the `/>`
    of a sibling element. `>` is likewise not a value token, so the `/` of that
    `/>` opened another one and ran to the next closing tag. Measured on
    `finance-fees-sections.tsx`, whose fee rows are written one element per line:
    both `{...entranceAmountHint.fieldProps}` spreads were deleted while both
    `.hintProps` spreads survived, so `field-hint.test.tsx`'s three-way count
    read 91 hooks against 89 fieldProps - a half-wiring failure reported against
    a file that is wired correctly.

    Neither condition can hide a real regex literal. A regex written after `<`
    (`a < /x/.test(b)`) is legal JavaScript and does not occur on this surface;
    and `/>` is refused only where a JSX self-close puts a value token before it,
    so `split(/>/)` - whose `/` follows `(` - is untouched, as is `/>=/` after an
    `=`.
  */
  if (previous === "<") return false;
  if (next === ">" && /["'}]/.test(previous)) return false;
  if (/[)\]\w$]/.test(previous)) {
    return REGEX_POSITION_KEYWORD.test(codeSoFar);
  }
  return true;
}

/** The index just past a regex literal that starts at `start`. */
function endOfRegexLiteral(source: string, start: number): number {
  let index = start + 1;
  let inCharacterClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    // A regex literal cannot span lines; if one appears to, the `/` was
    // division after all and giving up here is the containing answer.
    if (char === "\n") return index;
    if (char === "[") inCharacterClass = true;
    else if (char === "]") inCharacterClass = false;
    else if (char === "/" && !inCharacterClass) {
      index += 1;
      while (index < source.length && /[a-z]/.test(source[index])) index += 1;
      return index;
    }
    index += 1;
  }
  return index;
}

export function stripComments(source: string): string {
  let out = "";
  let index = 0;
  type Mode = "code" | "line" | "block" | "single" | "double" | "template";
  let mode: Mode = "code";

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (mode === "code") {
      if (character === "/" && next === "/") {
        mode = "line";
        index += 2;
        continue;
      }
      if (character === "/" && next === "*") {
        mode = "block";
        index += 2;
        continue;
      }
      // A regex literal is CODE, and is copied through verbatim so the scanner
      // cannot mistake a slash or a quote inside it for a delimiter. Checked
      // AFTER the two comment openers, so `//` and `/*` never reach here.
      if (character === "/" && startsRegexLiteral(out, next ?? "")) {
        const end = endOfRegexLiteral(source, index);
        out += source.slice(index, end);
        index = end;
        continue;
      }
      if (character === "'") mode = "single";
      else if (character === '"') mode = "double";
      else if (character === "`") mode = "template";
      out += character;
      index++;
      continue;
    }

    if (mode === "line") {
      if (character === "\n") {
        mode = "code";
        out += character;
      }
      index++;
      continue;
    }

    if (mode === "block") {
      if (character === "*" && next === "/") {
        mode = "code";
        index += 2;
        continue;
      }
      if (character === "\n") out += character;
      index++;
      continue;
    }

    // Inside a string or template literal: copy through, honouring escapes.
    out += character;
    if (character === "\\") {
      if (index + 1 < source.length) out += source[index + 1];
      index += 2;
      continue;
    }
    if (
      (mode === "single" && character === "'") ||
      (mode === "double" && character === '"') ||
      (mode === "template" && character === "`")
    ) {
      mode = "code";
    }
    index++;
  }

  return out;
}

// ---------------------------------------------------------------------------
// THE CSS FORM: the one other language sharing JavaScript's block delimiter
// ---------------------------------------------------------------------------

/**
 * CSS with its comments removed.
 *
 * ONE LINE OF CODE, AND IT LIVED IN THREE FILES AT FIVE CALL SITES until #3164:
 * `placeholder-styling-contract`, `app-theme-layout-contract` and
 * `print-light-palette-contract` each wrote the identical `replaceAll`. That is
 * the population `stripComments` itself went from one to eighteen through, so
 * length is not the test of whether something belongs here (`INV-SSOT-004`).
 *
 * WHY CSS CANNOT USE `stripComments`, measured rather than assumed. An earlier
 * note here said the JavaScript scanner reads the slash in `url(a/b)` as opening
 * a regex and eats the line. IT DOES NOT: a regex literal is copied through
 * verbatim, so `url(a/b.png)` and `url(/images/hero.png)` come back byte for
 * byte. The real hazard is the LINE delimiter, which CSS does not have and every
 * absolute URL does. Run over `url(https://cdn.example/x.png)` the scanner sees
 * `//`, opens a line comment and deletes the rest of the line — measured, the
 * whole of `x.png); color: red; }` goes — and `url(//cdn.example/x.png)` goes
 * the same way. Quoting the URL saves it, because a CSS string is a JavaScript
 * string too. Nothing in `globals.css` or `display.css` writes an unquoted
 * absolute URL today, so this is LATENT rather than live: the first one written
 * would silently shrink whichever contract read that file.
 *
 * WHAT THIS DOES NOT HANDLE, and it is the mirror of the hazard above: a block
 * delimiter inside a CSS string (`content: "/*"`) is treated as a comment
 * opener, because this is a single regular expression and not a lexer. No
 * stylesheet in this tree writes one. Both limits fail in opposite directions —
 * the JavaScript scanner over CSS deletes too much on a shape a stylesheet
 * really can grow, this deletes too much only on one no stylesheet here writes.
 */
export function stripCssComments(css: string): string {
  return css.replaceAll(/\/\*[\s\S]*?\*\//g, "");
}

// ---------------------------------------------------------------------------
// THE STRING-BLANKING FORM: comments AND string contents, offsets NOT preserved
// ---------------------------------------------------------------------------

interface ScanResult {
  readonly code: string;
  readonly next: number;
}

/**
 * A template literal, from its opening backtick.
 *
 * The literal TEXT is blanked like any other string, but a `${ … }`
 * interpolation is CODE and is kept — a `new Date(invoice.date)` inside one is
 * exactly as much of a defect as anywhere else. Newlines are preserved so a
 * reported line number still points at the right line.
 */
function scanTemplateLiteral(source: string, start: number): ScanResult {
  let out = '""';
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "\n") {
      out += "\n";
      index += 1;
      continue;
    }
    if (char === "`") {
      return { code: out, next: index + 1 };
    }
    if (char === "$" && source[index + 1] === "{") {
      const inner = scanCode(source, index + 2, true);
      out += ` ${inner.code} `;
      index = inner.next;
      continue;
    }
    index += 1;
  }
  return { code: out, next: index };
}

// `startsRegexLiteral` and `endOfRegexLiteral` above were written for the #2869
// review, in `xero-provider-date-boundary-census.test.ts`, and were shared with
// `stripComments` by #3132. The shared scanner had the very defect they were
// written to fix — `.replace(/\//g, "_")` read as a line comment — so leaving a
// repaired copy in the census and a broken one here was INV-SSOT-004 with the
// two instruments named. #3164 finished the move: the whole second form now
// lives beside the first, and the census imports it.

/**
 * What a string literal becomes once blanked — usually `""`, but the KEY of a
 * bracket access is kept.
 *
 * `invoice["dueDate"]` is a property read spelled with a string, and blanking it
 * would make that spelling invisible to every rule below. An identifier-shaped
 * key inside brackets cannot be prose, so keeping it cannot resurrect the #2813
 * class this stripper exists to prevent.
 */
function keptBracketKey(codeSoFar: string, content: string): string {
  if (lastSignificant(codeSoFar) !== "[") return '""';
  return /^[A-Za-z_$][\w$]*$/.test(content) ? `"${content}"` : '""';
}

/**
 * Code, from `start`, with every comment and string literal replaced by
 * something inert of the same LINE COUNT.
 *
 * `stopAtCloseBrace` is for a template interpolation: it returns at the `}`
 * that closes the interpolation rather than at the end of the source, counting
 * nested braces on the way so an object literal inside one does not end it
 * early.
 */
function scanCode(
  source: string,
  start: number,
  stopAtCloseBrace: boolean,
): ScanResult {
  let out = "";
  let index = start;
  let depth = 0;
  while (index < source.length) {
    const two = source.slice(index, index + 2);
    if (two === "//") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      // Keep the newlines, so a line number after a docblock is still right.
      for (const char of source.slice(index, stop)) {
        if (char === "\n") out += "\n";
      }
      index = stop;
      continue;
    }
    const char = source[index];
    if (char === "`") {
      const template = scanTemplateLiteral(source, index);
      out += template.code;
      index = template.next;
      continue;
    }
    if (char === "/" && startsRegexLiteral(out, source[index + 1] ?? "")) {
      index = endOfRegexLiteral(source, index);
      out += '""';
      continue;
    }
    if (char === '"' || char === "'") {
      const opened = index;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === char) {
          index += 1;
          break;
        }
        if (source[index] === "\n") break;
        index += 1;
      }
      out += keptBracketKey(out, source.slice(opened + 1, index - 1));
      continue;
    }
    if (stopAtCloseBrace) {
      if (char === "{") depth += 1;
      else if (char === "}") {
        if (depth === 0) return { code: out, next: index + 1 };
        depth -= 1;
      }
    }
    out += char;
    index += 1;
  }
  return { code: out, next: index };
}

/**
 * Remove `//` and block comments and the contents of every string, so a rule
 * cannot fire on prose that describes it.
 *
 * Comments, quoted strings, template literals (whose `${…}` interpolations are
 * kept, because those are code) and REGEX LITERALS are all recognised, and the
 * line count is preserved so a reported line number still points at the right
 * line. Regex literals are recognised because one of them broke this — see
 * {@link startsRegexLiteral}.
 */
export function stripCommentsAndStrings(source: string): string {
  return scanCode(source, 0, false).code;
}
