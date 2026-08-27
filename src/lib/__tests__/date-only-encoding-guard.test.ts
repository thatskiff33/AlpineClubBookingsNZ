import fs from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";
import ts from "typescript";
import { beforeAll, describe, expect, it, vi } from "vitest";

import eslintConfig, {
  DATE_GUARD_ARMS,
  MANDATORY_SRC_RESTRICTIONS,
  SRC_RESTRICTION_EXEMPTIONS,
} from "../../../eslint.config.mjs";
import { DATE_ONLY_IN_DATETIME_COLUMN } from "./support/date-only-reviewed-fields";
import {
  auditEnforcedGuardCoverage,
  auditResolvedGuardCoverage,
  PRODUCTION_GUARD_ROSTER,
} from "./support/eslint-guard-coverage";

/**
 * #2684 — the date-only ENCODING guard, second arm.
 *
 * ENFORCES INV-DATE-019 — the flat prohibition on truncating a `DateTime` — over
 * the columns INV-DATE-026 establishes as calendar days, whose UTC midnight is an
 * encoding rather than a moment (INV-DATE-010). All three are in
 * `docs/invariants/booking-dates-and-capacity.md`, and INV-DATE-026 is the one
 * that names this file, for the `DATE_ONLY_IN_DATETIME_COLUMN` entry it fails
 * when the entry outlives its fix. It and the `no-restricted-syntax` rules in
 * `eslint.config.mjs` are the two enforcement arms, which is this file's own
 * claim and not something an invariant asserts (#3080 — an earlier version said
 * INV-DATE-010 and INV-DATE-019 named them, and neither does). Every assertion
 * repeats the id in its failure message so whoever trips one is handed the rule
 * rather than having to go and find it (#2691).
 *
 * THE TWO ARMS DIVIDE ALONG WHAT EACH CAN SEE.
 *
 * Lint sees SYNTAX, exhaustively: no file in `src/` may hand-write
 * `toISOString().slice(0, 10)` or any of its spellings. That closes the
 * duplication, and it is airtight because it needs to know nothing about the
 * value.
 *
 * It cannot see MEANING, and meaning is the whole defect. `formatDateOnly` is
 * correct for a `@db.Date` column, whose UTC midnight is the ENCODING of a CLUB
 * calendar day (INV-DATE-010 — the rule's own word, because the day is the
 * club's and not New Zealand's), and wrong for a bare `DateTime`, which is a real
 * instant whose UTC day is the PREVIOUS New Zealand day for roughly the first
 * half of every NZ day (INV-DATE-019). The two are identical in syntax. A Xero
 * invoice due date and a finance export were both a day early for exactly this
 * reason (#2697), and nothing syntactic could have told them apart.
 *
 * So this file classifies by COLUMN TYPE, read out of `prisma/schema.prisma`
 * itself, and requires every encoding of an instant — or of the raw clock — to
 * be a listed, reasoned decision rather than an accident. It also pins the lint
 * config's own composition, because flat config replaces a rule's option list
 * silently and a guard that can be deleted by a neighbouring block is not one.
 */

const ROOT = process.cwd();

// ---------------------------------------------------------------------------
// The canonical encoders
// ---------------------------------------------------------------------------

/**
 * The date-only encoders. Each takes a value the caller asserts is a CALENDAR
 * DAY and returns its `yyyy-MM-dd` (or `yyyy-MM`) form by reading the UTC clock
 * face — correct exactly when the assertion holds.
 *
 * `formatDateOnlyForTimeZone`, `todayDateOnlyForTimeZone`, `getTodayDateOnly`
 * and the kernel's `clubCalendarDateOf` are deliberately absent: those ASK the
 * club's calendar rather than assuming the value already is one, so they are the
 * fix this guard points at, never the thing it flags.
 *
 * THIS CENSUS KEYS ON CALLEE NAMES, SO THE SET MUST LEAD EVERY RENAME.
 * A rename that lands before the name is listed leaves a window in which this
 * whole file is VACUOUS — the census classifies nothing, every assertion below
 * passes over an empty list, and the failure its docblock exists to prevent
 * happens silently. **The sequencing rule, for whoever moves call sites next:**
 *
 *   1. add the new encoder's name here;
 *   2. run this suite and confirm the reviewed and offender sets are UNCHANGED
 *      (an empty diff is the evidence — a moved count means the new name is
 *      already live somewhere and needs explaining, not waving through);
 *   3. only then rename the call sites.
 *
 * That is the order this entry followed for CT-2's kernel (#2990, epic #2988):
 * `calendarDateOfDateOnlyInstant` is the kernel's exact analogue of
 * `formatDateOnly` — `Instant` is a bare `Date` (`club-time/types.ts`), so it
 * carries no type protection, and its own docblock says "hand it a real
 * `DateTime` and you get that column's UTC day, which is the `INV-DATE-019`
 * defect". `eslint.config.mjs` has been sending new code to it since CT-2, so
 * this was already a live gap and not only a future one. CT-6 (#2991) moves the
 * call sites; the name is here first so there is no window.
 *
 * THREE KERNEL EXPORTS THAT LOOK LIKE ENCODERS AND ARE NOT, since the next
 * reader will wonder. `calendarMonthOf`, `parseCalendarDate` and
 * `requireCalendarDate` take a `CalendarDate` or a `YYYY-MM-DD` string — a value
 * that already IS a calendar day — so no `Date` and no serialised instant can
 * reach the defect through them, and listing them would widen the rename ban
 * with no defect class behind it. The kernel's raw UTC read is
 * `utcDateOnlyString` in `club-time/intl.ts`, which the barrel does not export
 * and nothing outside `club-time/` imports; if that ever changes it belongs
 * here.
 */
const CANONICAL_ENCODERS = new Set([
  // `@/lib/date-only` — the compatibility adapters CT-6 (#2991) retires.
  "formatDateOnly",
  "formatMonthOnly",
  "dateOnlyFromIsoString",
  // `@/lib/club-time` — the kernel (CT-2, #2990).
  "calendarDateOfDateOnlyInstant",
]);

/**
 * Calls that hand a value straight through without changing WHICH value it is.
 *
 * The kernel's encoder takes an `Instant`, and a caller holding a plain `Date`
 * or a string reaches it through `requireInstant(...)`. That is the same read
 * one call later, exactly like the `new Date(...)` reparse and the ISO
 * serialisation this scanner already follows, so it must not hide the field
 * being read — `calendarDateOfDateOnlyInstant(requireInstant(booking.createdAt))`
 * is `INV-DATE-019` written the long way round.
 *
 * `requireStoredCalendarDay` is the strict third (#3082): it PROVES the `Date`
 * carries no time of day — necessary for a `@db.Date` encoding and NOT
 * sufficient, since a real instant landing on exactly UTC midnight passes it —
 * and returns that same value. It reports the SHAPE, not
 * the outcome — a source line asking for a `createdAt` to be encoded as a
 * calendar day is the defect whether it throws at runtime or answers, and it has
 * to be visible here rather than found by a production stack trace.
 */
const INSTANT_PASS_THROUGHS = new Set([
  "parseInstant",
  "requireInstant",
  // #3082's strict sibling. It PROVES the `Date` is a `@db.Date` encoding rather
  // than a moment and returns that same value, so it changes what is guaranteed
  // and not which value is read. Without an entry here it would be the
  // `formatDate` blind spot one call further round: a rule that exists to refuse
  // an instant would be the thing hiding one from this census.
  "requireStoredCalendarDay",
]);

/**
 * Shared helpers that DECODE a stored calendar day and immediately RE-ENCODE it
 * — the mirror image of {@link INSTANT_PASS_THROUGHS}, and here for the same
 * reason: without an entry the scanner cannot see what is being handed in.
 *
 * `storedDateOnly` is `dateOnlyInstantOf(calendarDateOfDateOnlyInstant(value))`.
 * The canonical encoder is in there, but it FEEDS ANOTHER CALL rather than being
 * the result, and `localEncoderAliases` deliberately refuses to follow that
 * shape — a function that normalises is naming a decision, not hiding one, and
 * treating every normaliser as a bare rename would ban `parseDateOnly(formatDateOnly(x))`
 * wrappers wholesale. Correct for the ALIAS BAN, and wrong for the CENSUS: the
 * 32 call sites written through this helper were classified as nothing at all,
 * so `storedDateOnly(booking.createdAt)` — a real instant read as its UTC day,
 * which is `INV-DATE-019` — would have been invisible here.
 *
 * NOT A REGRESSION BEING BLESSED: the six file-local clones this helper replaced
 * (CT-4, #2870) were never classified either, and neither was
 * `normalizeDateOnlyForTimeZone` before them. This closes a hole that predates
 * the hoist; the hoist is only what made one entry able to close it.
 *
 * A LISTED NAME COUNTS ONLY WHERE IT IS DECLARED, which is what stops the set
 * being a blanket permission: an unrelated local `storedDateOnly` in some other
 * module is not silently followed, because {@link declaredRenormalisersIn} looks
 * for the declaration rather than the call. The staleness assertion further down
 * fails an entry that names nothing in the tree, so this cannot rot into a set
 * of dead names the way a bare exclusion list does.
 *
 * THE SEQUENCING RULE for {@link CANONICAL_ENCODERS} applies here too, for the
 * same reason: the census keys on the NAME, so add the new name here before
 * renaming the function, or there is a window in which 32 sites are unclassified
 * again.
 */
const DATE_ONLY_RENORMALISERS = new Set([
  "storedDateOnly",
  // `pricing.ts`'s own strict-contract variant of the same expression (F2,
  // #3076). Its docblock says this census "cannot cover this site" because the
  // receiver at the DEFINITION is a bare parameter — true, and it stops there.
  // Its CALL SITES are field accesses, and those are exactly what this set makes
  // reachable, so `normalizeBookingDate(guest.stayStart)` is now classified and a
  // future `normalizeBookingDate(booking.createdAt)` would be reported.
  "normalizeBookingDate",
]);

/** The helper module itself — the sanctioned home for the raw truncation. */
const ENCODER_MODULE = "src/lib/date-only.ts";

// ---------------------------------------------------------------------------
// Reviewed exceptions
// ---------------------------------------------------------------------------

/**
 * `DateTime` columns that nevertheless hold a DATE-ONLY value, with the write
 * that proves it — the list this file consults before calling a bare-`DateTime`
 * truncation a defect.
 *
 * It LIVES in `./support/date-only-reviewed-fields.ts` rather than here, because
 * #2860 added a second consumer: the member-merge screen classifies the same
 * columns per field (`src/lib/member-merge-field-kinds.ts`) for a renderer this
 * file's scanner cannot see — it resolves field names out of the argument
 * expression, and that screen's values arrive as `unknown` with the field as a
 * runtime string. `member-merge-field-kinds.test.ts` binds that declaration to
 * this list so the two cannot drift into disagreeing about what a column means.
 * The support module's docblock has the full reasoning.
 */

/**
 * Call sites that encode a real instant, or the raw clock, as a calendar day.
 *
 * EVERY ENTRY HERE IS A LIVE DEFECT, not a permitted pattern. #2684 decision 2
 * says this map ships EMPTY, and it very nearly does: it carried nineteen
 * entries while #2834 was still unmerged, eighteen of them that issue's own Xero
 * document dates, and rebasing onto a base containing #2834 made the staleness
 * assertion below name all eighteen so they could be DELETED rather than
 * re-anchored. What remains is one site, in its own filed issue, and whether
 * that is acceptable or whether **#2839** must land first is the owner's call —
 * it is flagged in the pull request rather than settled here.
 *
 * AN ENTRY IS THE DEFECT IT BLESSES, AND NO LINE NUMBER AT ALL. An entry used to
 * be keyed `file:line`, and that key was load-bearing in both directions: move
 * the line and the entry went stale AND the now-unanchored site failed the
 * offender check. So this list forbade every lane from changing a route's line
 * count above the anchor, and the CT-4a lane reported paying exactly that: it
 * held `members/import/route.ts` to its 764 lines by deleting an import from one
 * block and re-adding it in another to net to zero, purely to keep line 654
 * where it was. A guard that fires on an unrelated pull request with a baffling
 * error is not a guard, so the key is now the thing being excused rather than
 * where it happens to sit: `file` + `kind` + `field` + the normalised
 * EXPRESSION handed to the encoder.
 *
 * Adding a line above the site no longer touches the key; changing what the
 * site ENCODES does, and that is the feature — an excuse written for
 * `row.cancelledAt` must not survive being pointed at something else. Changing
 * `formatDateOnly(new Date())` to `formatDateOnly(params.cancelledAt)` is a
 * different defect of a different KIND on a different value, and every one of
 * those three is part of the key.
 *
 * THE CALLEE IS DELIBERATELY NOT PART OF THE KEY. What was reviewed is the
 * VALUE and why encoding it is safe; which of the interchangeable canonical
 * encoders does the encoding is not what the reasoning turns on. Leaving the
 * callee out is also what lets CT-6 (#2991) rename call sites onto the kernel
 * without re-anchoring reviewed entries — the same churn the line number caused,
 * one layer up. A rename to a NON-canonical encoder is a different matter: the
 * site stops being classified at all, the entry matches nothing, and the
 * staleness assertion says so.
 *
 * `occurrences` exists because a key that is not a line number can match more
 * than one site. Two identical encodings of the same expression in the same file
 * are two decisions, and one review should not silently acquire the second, so
 * the count is declared (default 1) and asserted.
 *
 * WHY THE #2834 FAMILY WAS INVISIBLE, since the reason outlives the entries.
 * `xero-invoice-helpers` exported `formatDate`, one line delegating to the
 * canonical encoder. Roughly eighteen Xero document dates reached the forbidden
 * pattern through it, so neither a grep for the truncation spellings nor #2682's
 * regex census could see a single one. One rename defeated the entire existing
 * control. That is why this file follows wrappers — same-file, imported, and
 * hand-written — rather than only inspecting call sites, why an exported bare
 * rename is refused outright further down, and why #2684 deleted the wrapper.
 */
type ReviewedEncoding = {
  /** The file the site lives in. Not the line — see the docblock above. */
  file: string;
  /** What the scanner must still classify this site as. */
  kind: "clock" | "instant";
  /** For an instant read, the field name that must still be the one read. */
  field?: string;
  /**
   * The expression handed to the encoder, exactly as written. Compared after
   * whitespace normalisation, so reformatting or wrapping the call does not
   * invalidate the review and changing the value does.
   */
  value: string;
  /** How many sites in `file` this one entry covers. Defaults to 1. */
  occurrences?: number;
  why: string;
};

/**
 * Whitespace-normalised source text — the form every key is compared in.
 *
 * Collapsing runs of whitespace is what makes the key survive Prettier
 * reflowing a long call across three lines, which a raw source line could not.
 */
function normaliseExpression(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const KNOWN_INSTANT_ENCODING_DEFECTS: ReviewedEncoding[] = [
  // "Details last confirmed by X on <date>" on the profile page (#2284 S3).
  // `Member.detailsConfirmedAt` is stamped `now` when a delegate confirms, so
  // its UTC day is yesterday's for a confirmation made before NZ midday — the
  // member is shown a date one day before the one they acted on. Nothing
  // accounting-side reads it and no Xero document carries it, so #2834 does not
  // cover it: it is filed as **#2839** and fixed there, not here. This branch is
  // an enforcement change, and changing what a member sees is a product
  // behaviour change that belongs in its own reviewed pull request (#2684
  // required implementation step 5).
  // #2839 is FIXED by this branch — `detailsConfirmedAt` now derives its day
  // through `formatDateOnlyForTimeZone`, so its entry is deleted rather than
  // re-anchored. That is the mechanism working: a site that stops encoding an
  // instant is no longer classified at all, so its entry matches nothing and has
  // to be read again — "moved" and "fixed" cannot be confused.
  //
  // The list is empty, which is what #2684 decision 2 asks for — but do not read
  // that as the class being closed. A review of #2839 found the member-merge
  // comparison screen renders instants through a generic runtime-type formatter
  // (#2860, PR #2862). It is absent here only because this census keys on the
  // canonical encoders, and that renderer reaches the pattern by its own route.
  // When #2862 lands, the class is closed; until then the empty list means
  // "nothing this census can see", not "nothing left".
];

/**
 * Instant-typed field names read back as a calendar day where the VALUE at that
 * site is known to be date-only, even though the column is mixed.
 */
const REVIEWED_INSTANT_READS: ReviewedEncoding[] = [
  {
    file: "src/app/api/admin/members/import/route.ts",
    kind: "instant",
    field: "cancelledAt",
    value: "row.cancelledAt",
    why: "Member.cancelledAt is mixed — the admin cancellation flow writes `now`, but the CSV import writes a parsed date-only value, and this audit-metadata line reads back the value the import itself just parsed",
  },
];

/**
 * Exported one-line renames of a canonical encoder that are nevertheless allowed
 * — the narrow counterpart to the alias ban further down, which exists because
 * `xero-invoice-helpers` once exported `formatDate` and hid roughly eighteen
 * Xero document dates behind it.
 *
 * The ban is structural: it refuses `f(param) => encoder(param)` because that
 * shape adds a name and nothing else. It cannot see a name that IS the
 * information — and CT-5 (#2869, PR #3013) deliberately built one such pair,
 * `xeroDocumentDateFromDateOnlyColumn(value)` beside
 * `xeroDocumentDateFromInstant(value, zone)`, so that the Xero boundary states
 * which of the two temporal concepts each document date carries instead of
 * leaving every caller to decide. Refusing that pair would push callers back to
 * choosing between the two encoders inline, which is the mistake the pair
 * prevents.
 *
 * So it is recorded here rather than waved through by loosening the rule, and
 * the entry is checked against the scanner both ways: an entry that no longer
 * names a live exported rename must be DELETED, so this list cannot rot into
 * blanket permission the way a bare exclusion does.
 */
const REVIEWED_ENCODER_RENAMES: Array<{ alias: string; why: string }> = [
  {
    alias: "src/lib/xero-provider-dates.ts: xeroDocumentDateFromDateOnlyColumn",
    why: "CT-5's Xero temporal boundary: this and `xeroDocumentDateFromInstant` are a deliberate pair whose NAMES carry the date-only/instant distinction the provider boundary has to state, so the wrapper is the decision rather than a rename hiding one (#2869; INV-DATE-010 / INV-DATE-019)",
  },
];

// ---------------------------------------------------------------------------
// Prisma schema — the authority on what a field MEANS
// ---------------------------------------------------------------------------

type FieldIndex = Map<string, string[]>;

function readSchemaDateFields(): { dateOnly: FieldIndex; instant: FieldIndex } {
  const source = fs.readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
  const dateOnly: FieldIndex = new Map();
  const instant: FieldIndex = new Map();
  let model: string | null = null;

  for (const line of source.split("\n")) {
    const opening = line.match(/^\s*model\s+(\w+)\s*\{/);
    if (opening) {
      model = opening[1];
      continue;
    }
    if (/^\s*\}/.test(line)) {
      model = null;
      continue;
    }
    if (!model) continue;

    const field = line.match(/^\s*(\w+)\s+DateTime\??(\[\])?\s*(.*)$/);
    if (!field) continue;

    const bucket = /@db\.Date\b/.test(field[3] ?? "") ? dateOnly : instant;
    if (!bucket.has(field[1])) bucket.set(field[1], []);
    bucket.get(field[1])!.push(model);
  }

  return { dateOnly, instant };
}

const { dateOnly: DATE_ONLY_FIELDS, instant: INSTANT_FIELDS } = readSchemaDateFields();

// ---------------------------------------------------------------------------
// Source scan
// ---------------------------------------------------------------------------

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "node_modules") {
        listSourceFiles(full, out);
      }
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function parse(rel: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    rel,
    text,
    ts.ScriptTarget.Latest,
    true,
    rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** `new Date()` / `new Date(Date.now() …)` — the raw clock. */
function isClockRead(node: ts.Node): boolean {
  if (!ts.isNewExpression(node)) return false;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "Date") return false;
  if (!node.arguments || node.arguments.length === 0) return true;
  return /\bDate\.now\(\s*\)/.test(node.arguments[0].getText());
}

/** `x.toISOString()` / `x["toJSON"]()` — the ISO SERIALISATION of `x`. */
function isoSerialisationReceiver(n: ts.Node): ts.Expression | null {
  if (!ts.isCallExpression(n)) return null;
  const callee = n.expression;
  if (
    ts.isPropertyAccessExpression(callee) &&
    (callee.name.text === "toISOString" || callee.name.text === "toJSON")
  ) {
    return callee.expression;
  }
  if (
    ts.isElementAccessExpression(callee) &&
    ts.isStringLiteralLike(callee.argumentExpression) &&
    (callee.argumentExpression.text === "toISOString" ||
      callee.argumentExpression.text === "toJSON")
  ) {
    return callee.expression;
  }
  return null;
}

/** `requireInstant(x)` / `parseInstant(x)` / `requireStoredCalendarDay(x, …)` — returns `x`, or null. */
function instantPassThroughArgument(node: ts.Node): ts.Expression | null {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : null;
  if (name === null || !INSTANT_PASS_THROUGHS.has(name)) return null;
  return node.arguments[0] ?? null;
}

/**
 * The property name a value was read from, looking through the wrappers that do
 * not change WHICH field is being read: non-null assertions, parentheses, casts,
 * a `new Date(...)` reparse, an ISO SERIALISATION, the kernel's
 * `requireInstant`/`parseInstant` pass-through, and the `??` / `||` fallbacks
 * a nullable column is usually read behind. Anything else (a local, a call
 * result, a parameter) returns null and is left alone — this guard reports what
 * it can PROVE.
 */
function readFieldNames(node: ts.Node, depth = 0): string[] {
  if (depth > 6) return [];
  let n: ts.Node = node;
  while (
    ts.isNonNullExpression(n) ||
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n)
  ) {
    n = n.expression;
  }
  // `dateOnlyFromIsoString(booking.createdAt.toISOString())` — an instant fed
  // through this guard's OWN sanctioned helper. It was lint-clean (no bare
  // truncation) and census-green (a CallExpression classified as nothing), which
  // made the string encoder a documented route around the very rule it belongs
  // to. Serialising an instant does not stop it being an instant, so the read is
  // followed through it.
  const serialised = isoSerialisationReceiver(n);
  if (serialised) return readFieldNames(serialised, depth + 1);
  if (
    ts.isNewExpression(n) &&
    ts.isIdentifier(n.expression) &&
    n.expression.text === "Date" &&
    n.arguments?.length === 1 &&
    !isClockRead(n)
  ) {
    return readFieldNames(n.arguments[0], depth + 1);
  }
  // `requireInstant(booking.createdAt)` — the kernel's own Date-to-Instant
  // pass-through, which is how a caller holding a plain column value reaches
  // `calendarDateOfDateOnlyInstant`. It changes the type and not the value.
  const passedThrough = instantPassThroughArgument(n);
  if (passedThrough) return readFieldNames(passedThrough, depth + 1);
  if (
    ts.isBinaryExpression(n) &&
    (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      n.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return [...readFieldNames(n.left, depth + 1), ...readFieldNames(n.right, depth + 1)];
  }
  if (ts.isConditionalExpression(n)) {
    return [
      ...readFieldNames(n.whenTrue, depth + 1),
      ...readFieldNames(n.whenFalse, depth + 1),
    ];
  }
  if (ts.isPropertyAccessExpression(n)) return [n.name.text];
  return [];
}

/**
 * Names bound to a clock read in the function (or module) enclosing `node`.
 *
 * `const d = new Date(); formatDateOnly(d)` is the SAME defect as
 * `formatDateOnly(new Date())` and was invisible to this scanner, which only
 * recognised the clock written inline as the encoder's argument. #2834 happens
 * to have fixed the two sites that wore this shape — but once the reviewed list
 * empties, an extracted local is the spelling under which the whole class walks
 * straight back in, and it is what a developer writes innocently while pulling a
 * repeated `new Date()` out of a function.
 *
 * Scoped to the nearest enclosing function so a `new Date()` in a NEIGHBOURING
 * function cannot make an unrelated identifier look like a clock read.
 */
function clockBoundNames(node: ts.Node): Set<string> {
  let scope: ts.Node = node;
  while (
    scope.parent &&
    !ts.isFunctionDeclaration(scope) &&
    !ts.isFunctionExpression(scope) &&
    !ts.isArrowFunction(scope) &&
    !ts.isMethodDeclaration(scope) &&
    !ts.isSourceFile(scope)
  ) {
    scope = scope.parent;
  }

  const names = new Set<string>();
  const walk = (n: ts.Node) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      isClockRead(n.initializer)
    ) {
      names.add(n.name.text);
    }
    ts.forEachChild(n, walk);
  };
  walk(scope);
  return names;
}

/** Does this expression, or anything it falls back to, read the raw clock? */
function readsClock(node: ts.Node, depth = 0, bound?: Set<string>): boolean {
  if (depth > 6) return false;
  const clockNames = bound ?? clockBoundNames(node);
  let n: ts.Node = node;
  while (
    ts.isNonNullExpression(n) ||
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n)
  ) {
    n = n.expression;
  }
  if (isClockRead(n)) return true;
  // A local standing in for the clock: `const now = new Date();`.
  if (ts.isIdentifier(n) && clockNames.has(n.text)) return true;
  // `now.toISOString()` handed to the string encoder is the same read one
  // serialisation later.
  const serialised = isoSerialisationReceiver(n);
  if (serialised) return readsClock(serialised, depth + 1, clockNames);
  // `requireInstant(new Date())` — the clock one pass-through later.
  const passedThrough = instantPassThroughArgument(n);
  if (passedThrough) return readsClock(passedThrough, depth + 1, clockNames);
  if (
    ts.isBinaryExpression(n) &&
    (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      n.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return (
      readsClock(n.left, depth + 1, clockNames) ||
      readsClock(n.right, depth + 1, clockNames)
    );
  }
  if (ts.isConditionalExpression(n)) {
    return (
      readsClock(n.whenTrue, depth + 1, clockNames) ||
      readsClock(n.whenFalse, depth + 1, clockNames)
    );
  }
  return false;
}

/** `X.split("T")` — returns `X`, or null. */
function splitOnTReceiver(node: ts.Node): ts.Expression | null {
  if (!ts.isCallExpression(node)) return null;
  if (!ts.isPropertyAccessExpression(node.expression)) return null;
  if (node.expression.name.text !== "split") return null;
  const arg = node.arguments[0];
  if (!arg) return null;
  const isT =
    (ts.isStringLiteralLike(arg) && arg.text === "T") ||
    (ts.isRegularExpressionLiteral(arg) && /^\/T\/[a-z]*$/.test(arg.text));
  return isT ? node.expression.expression : null;
}

/** Names bound to an ISO serialisation in the function enclosing `node`. */
function isoBoundReceivers(node: ts.Node): Map<string, ts.Expression> {
  let scope: ts.Node = node;
  while (
    scope.parent &&
    !ts.isFunctionDeclaration(scope) &&
    !ts.isFunctionExpression(scope) &&
    !ts.isArrowFunction(scope) &&
    !ts.isMethodDeclaration(scope) &&
    !ts.isSourceFile(scope)
  ) {
    scope = scope.parent;
  }
  const out = new Map<string, ts.Expression>();
  const walk = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const receiver = isoSerialisationReceiver(n.initializer);
      if (receiver) out.set(n.name.text, receiver);
    }
    ts.forEachChild(n, walk);
  };
  walk(scope);
  return out;
}

/**
 * The value a HAND-WRITTEN date-only encoding is applied to, or null.
 *
 * `X.toISOString().slice(0, 10)`, `X.toISOString().split("T")[0]`, and the same
 * with `.at(0)` / `.shift()` / `substring` / `substr` — plus the two-step form
 * that hid from everything, `const iso = X.toISOString(); iso.slice(0, 10)`.
 *
 * Recognising these is what stops a wrapper being an escape hatch. The census
 * used to follow only DELEGATIONS to a canonical encoder, so a wrapper whose
 * body wrote the truncation itself was neither followed (its call sites went
 * unclassified) nor refused as an exported alias — which is `formatDate`
 * reconstituted, and harder to spot than the original.
 */
function handWrittenEncodingReceiver(leaf: ts.Expression): ts.Expression | null {
  const throughLocal = (candidate: ts.Expression): ts.Expression | null => {
    const direct = isoSerialisationReceiver(candidate);
    if (direct) return direct;
    if (ts.isIdentifier(candidate)) {
      return isoBoundReceivers(leaf).get(candidate.text) ?? null;
    }
    return null;
  };

  // `parts[0]`
  if (
    ts.isElementAccessExpression(leaf) &&
    ts.isNumericLiteral(leaf.argumentExpression) &&
    leaf.argumentExpression.text === "0"
  ) {
    const split = splitOnTReceiver(leaf.expression);
    if (split) return throughLocal(split) ?? split;
  }

  if (ts.isCallExpression(leaf) && ts.isPropertyAccessExpression(leaf.expression)) {
    const method = leaf.expression.name.text;
    const receiver = leaf.expression.expression;
    if (method === "slice" || method === "substring" || method === "substr") {
      return throughLocal(receiver);
    }
    if (method === "at" || method === "shift") {
      const split = splitOnTReceiver(receiver);
      if (split) return throughLocal(split) ?? split;
    }
    if (method === "replace") {
      return throughLocal(receiver);
    }
  }

  return null;
}

/**
 * Functions in this file that are a BARE DELEGATION to a canonical encoder —
 * `f(value) => formatDateOnly(value)`, the encoder called on the function's own
 * parameter and nothing else — or that write the same encoding out by hand.
 *
 * They are resolved so a call site written through one is classified as if it
 * called the encoder directly. This is not stylistic tidiness: an alias is
 * exactly how a whole class of defects stayed invisible. `xero-invoice-helpers`
 * exported `formatDate` — one line, one delegation — and thirty-three Xero
 * document dates behind it were never seen by any date audit, sixteen of them
 * encoding the raw clock. A wrapper that ADDS meaning (`getBookingInvoiceIssueDate`,
 * which passes `booking.checkIn`, not its own parameter) is not a delegation and
 * is left alone; it is naming a decision rather than hiding one.
 */
function localEncoderAliases(sf: ts.SourceFile): {
  names: Set<string>;
  exported: string[];
} {
  const names = new Set<string>();
  const exported: string[] = [];

  /** `param`, `new Date(param)`, `param!`, `(param as Date)` — a pass-through. */
  const reducesToParam = (node: ts.Node, paramNames: Set<string>, depth = 0): boolean => {
    if (depth > 4) return false;
    let n: ts.Node = node;
    while (
      ts.isNonNullExpression(n) ||
      ts.isParenthesizedExpression(n) ||
      ts.isAsExpression(n)
    ) {
      n = n.expression;
    }
    if (
      ts.isNewExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "Date" &&
      n.arguments?.length === 1
    ) {
      return reducesToParam(n.arguments[0], paramNames, depth + 1);
    }
    return ts.isIdentifier(n) && paramNames.has(n.text);
  };

  /**
   * A function is a DELEGATION when what it RETURNS is a canonical-encoder call
   * handed one of its own parameters — `return formatDateOnly(value)`, or the
   * same behind the null guard a nullable column is usually read through,
   * `return value ? formatDateOnly(new Date(value)) : null`. Such a function adds
   * a name and nothing else, so its call sites read as if the encoder were never
   * involved, which is precisely how a class of defects goes unaudited.
   *
   * Three shapes are deliberately NOT delegations, because each is doing
   * something the caller would otherwise have to decide:
   *
   *  - the encoder feeds another call rather than being the result
   *    (`return parseDateOnly(formatDateOnly(value))` normalises a Xero payload
   *    date to a date-only `Date` — a conversion, not a rename);
   *  - the argument is a FIELD of the parameter rather than the parameter
   *    (`getBookingInvoiceIssueDate(booking)` passes `booking.checkIn`, which is
   *    the function asserting WHICH value is a lodge night);
   *  - the encoder result is used for something else entirely
   *    (`lockRosterDate` builds an advisory-lock key out of it).
   */
  const returnedExpressions = (body: ts.ConciseBody): ts.Expression[] => {
    if (!ts.isBlock(body)) return [body];
    const out: ts.Expression[] = [];
    const walk = (n: ts.Node) => {
      if (
        n !== body &&
        (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n))
      ) {
        return;
      }
      if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
      ts.forEachChild(n, walk);
    };
    walk(body);
    return out;
  };

  /** Every leaf a returned expression can evaluate to, through `?:`, `??`, `||`. */
  const resultLeaves = (node: ts.Expression, depth = 0): ts.Expression[] => {
    if (depth > 4) return [node];
    let n: ts.Expression = node;
    while (
      ts.isNonNullExpression(n) ||
      ts.isParenthesizedExpression(n) ||
      ts.isAsExpression(n)
    ) {
      n = n.expression;
    }
    if (ts.isConditionalExpression(n)) {
      return [...resultLeaves(n.whenTrue, depth + 1), ...resultLeaves(n.whenFalse, depth + 1)];
    }
    if (
      ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        n.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      return [...resultLeaves(n.left, depth + 1), ...resultLeaves(n.right, depth + 1)];
    }
    return [n];
  };

  const NOT_A_DELEGATION = { resolvable: false, rename: false };

  const delegatedParam = (
    body: ts.ConciseBody | undefined,
    params: readonly ts.ParameterDeclaration[],
  ): { resolvable: boolean; rename: boolean } => {
    if (!body || params.length === 0) return NOT_A_DELEGATION;
    const paramNames = new Set(
      params
        .filter((p) => ts.isIdentifier(p.name))
        .map((p) => (p.name as ts.Identifier).text),
    );
    if (paramNames.size === 0) return NOT_A_DELEGATION;

    const leaves = returnedExpressions(body).flatMap((e) => resultLeaves(e));
    const isEncoderCall = (leaf: ts.Expression) =>
      ts.isCallExpression(leaf) &&
      ts.isIdentifier(leaf.expression) &&
      CANONICAL_ENCODERS.has(leaf.expression.text);

    /** What this leaf encodes — through a named encoder or written out. */
    const encodedValue = (leaf: ts.Expression): ts.Expression | null => {
      if (isEncoderCall(leaf)) {
        return (leaf as ts.CallExpression).arguments[0] ?? null;
      }
      return handWrittenEncodingReceiver(leaf);
    };

    // A null/empty guard is the only thing a RENAME may add. Anything else in
    // the result — a branch that trims a string, narrows an `unknown`, or hands
    // off to another helper — makes the function a normaliser rather than a
    // rename, and normalising is a decision worth its own name.
    const isTrivial = (leaf: ts.Expression) =>
      leaf.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(leaf) && leaf.text === "undefined") ||
      ts.isStringLiteral(leaf) ||
      ts.isNumericLiteral(leaf);

    const encoderLeaves = leaves.filter((leaf) => encodedValue(leaf) != null);
    const passThrough = encoderLeaves.filter((leaf) => {
      const value = encodedValue(leaf);
      return value != null && reducesToParam(value, paramNames);
    });

    return {
      // GENEROUS, for the census: any function that hands a caller's own value
      // to an encoder — named OR hand-written — is worth following, so the
      // receiver at its call sites gets classified. Resolving one that turns out
      // to be harmless costs a reviewed list entry; failing to resolve one costs
      // a defect nobody sees.
      resolvable: passThrough.length > 0,
      // STRICT, for the ban: only a pure rename. A normaliser earns its name.
      rename:
        encoderLeaves.length > 0 &&
        encoderLeaves.length === passThrough.length &&
        leaves.every((leaf) => encodedValue(leaf) != null || isTrivial(leaf)),
    };
  };

  const isExported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);

  const record = (name: string, verdict: { resolvable: boolean; rename: boolean }, exportedHere: boolean) => {
    if (verdict.resolvable) names.add(name);
    if (verdict.rename && exportedHere) exported.push(name);
  };

  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      record(node.name.text, delegatedParam(node.body, node.parameters), isExported(node));
    }
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          d.initializer != null &&
          (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
        ) {
          record(
            d.name.text,
            delegatedParam(d.initializer.body, d.initializer.parameters),
            isExported(node),
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);

  return { names, exported };
}

/**
 * The {@link DATE_ONLY_RENORMALISERS} names this file DECLARES, top level.
 *
 * Keyed on the declaration rather than the call so that a listed name is
 * followed only in the module that owns it. `localEncoderAliases` cannot answer
 * this — it refuses the normaliser shape by design — so the two are asked
 * separately and merged.
 */
function declaredRenormalisersIn(sf: ts.SourceFile): string[] {
  const found: string[] = [];
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && DATE_ONLY_RENORMALISERS.has(st.name.text)) {
      found.push(st.name.text);
    }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          DATE_ONLY_RENORMALISERS.has(d.name.text) &&
          d.initializer != null &&
          (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
        ) {
          found.push(d.name.text);
        }
      }
    }
  }
  return found;
}

type Encoding = {
  /** `file:line`, for a human reading a failure. NEVER a key — see above. */
  site: string;
  file: string;
  kind: "clock" | "instant";
  field?: string;
  /** The normalised expression handed to the encoder. Part of the key. */
  value: string;
  snippet: string;
};

/**
 * Does a reviewed entry describe this classified site?
 *
 * All four parts must agree. `field` is compared including its absence, so an
 * entry written for a clock read cannot come to cover an instant read.
 */
function reviewedMatch(entry: ReviewedEncoding, found: Encoding): boolean {
  return (
    found.file === entry.file &&
    found.kind === entry.kind &&
    found.field === entry.field &&
    found.value === normaliseExpression(entry.value)
  );
}

const isReviewedDefect = (found: Encoding) =>
  KNOWN_INSTANT_ENCODING_DEFECTS.some((entry) => reviewedMatch(entry, found));

const isReviewedInstantRead = (found: Encoding) =>
  REVIEWED_INSTANT_READS.some((entry) => reviewedMatch(entry, found));

/** How an entry reads in a failure message. */
const describeReviewed = (entry: ReviewedEncoding) =>
  `${entry.file} — ${entry.kind}` +
  `${entry.field ? ` on .${entry.field}` : ""} — \`${normaliseExpression(entry.value)}\``;

/**
 * Resolve a module specifier to the file it names, so a wrapper imported from
 * another module can be followed. `@/x` is the `src/` alias; `./x` and `../x`
 * are relative. Anything else (a package) is not ours and returns null.
 */
function resolveModule(
  fromRel: string,
  specifier: string,
  known?: ReadonlySet<string>,
): string | null {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = path.posix.join("src", specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.posix.join(path.posix.dirname(fromRel), specifier);
  } else {
    return null;
  }
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    // The sources being scanned first, then the disk. On the tree run the two
    // agree, so this changes nothing there; on a FIXTURE run it is what lets a
    // two-file fixture exercise the cross-module wrapper following, which is
    // otherwise the one part of this scanner with no fixture behind it at all.
    if (known?.has(candidate)) return candidate;
    if (fs.existsSync(path.join(ROOT, candidate))) return candidate;
  }
  return null;
}

/**
 * Every way this tree brings a name in from another of its own modules.
 *
 * `named` is `localName -> { module, importedName }`; `namespaces` is
 * `localName -> module` for the whole-module bindings, whose members are reached
 * as `localName.member(...)`.
 *
 * FOUR SPELLINGS, THREE OF WHICH THIS USED TO MISS. Only the static
 * `import { x } from "…"` form was read, so a wrapper reached any other way was
 * followed by nothing and its call sites went unclassified — the same blind spot
 * as the `formatDate` rename, one syntax along. Measured against this tree: not
 * one `import * as` in non-test `src/` names a local module (they are all
 * packages, which resolve to null here), while the dynamic form is everywhere —
 * 121 `await import(...)` calls, 101 of them destructured and 8 bound whole. So
 * the namespace case costs nothing today and the dynamic case was a live blind
 * spot over a hundred call sites wide. Reading all of them moved the census by
 * NOTHING, which is the measurement that says none of those modules exports a
 * date encoder — not an assumption that none does.
 *
 * TWO SPELLINGS DELIBERATELY LEFT ALONE, having been measured rather than
 * assumed. A single-quoted specifier is already covered — the TypeScript parser
 * reports `StringLiteral.text` with the quotes stripped, so `'…'` and `"…"` are
 * the same node to this code. So is `import def, { x } from "…"`: the named
 * bindings hang off the import clause independently of the default binding, so
 * the braces half has always been read. The DEFAULT binding itself is not
 * followed, and neither is a re-export chain (`export { x } from "./y"`);
 * neither `@/lib/date-only` nor `@/lib/club-time` has a default export, and a
 * default-exported bare encoder rename would still be refused where it is
 * DEFINED, which is where the alias ban looks.
 */
function moduleImports(
  sf: ts.SourceFile,
  rel: string,
  known: ReadonlySet<string>,
): {
  named: Map<string, { module: string; imported: string }>;
  namespaces: Map<string, string>;
} {
  const named = new Map<string, { module: string; imported: string }>();
  const namespaces = new Map<string, string>();

  const addNamed = (local: string, module: string, imported: string) => {
    named.set(local, { module, imported });
  };

  // `import { a, b as c } from "…"` / `import * as ns from "…"`.
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteralLike(st.moduleSpecifier)) {
      continue;
    }
    const target = resolveModule(rel, st.moduleSpecifier.text, known);
    if (!target) continue;
    const bindings = st.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        addNamed(element.name.text, target, (element.propertyName ?? element.name).text);
      }
    } else if (ts.isNamespaceImport(bindings)) {
      namespaces.set(bindings.name.text, target);
    }
  }

  // `const { a, b: c } = await import("…")` and `const ns = await import("…")`,
  // anywhere in the file — a dynamic import is a statement, not a declaration,
  // so it can sit inside any function.
  const dynamicTarget = (node: ts.Expression | undefined): string | null => {
    if (!node) return null;
    let n: ts.Expression = node;
    if (ts.isAwaitExpression(n)) n = n.expression;
    while (ts.isParenthesizedExpression(n)) n = n.expression;
    if (
      !ts.isCallExpression(n) ||
      n.expression.kind !== ts.SyntaxKind.ImportKeyword ||
      n.arguments.length === 0
    ) {
      return null;
    }
    const specifier = n.arguments[0];
    if (!ts.isStringLiteralLike(specifier)) return null;
    return resolveModule(rel, specifier.text, known);
  };

  const walk = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node)) {
      const target = dynamicTarget(node.initializer);
      if (target) {
        if (ts.isIdentifier(node.name)) {
          namespaces.set(node.name.text, target);
        } else if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const imported =
              element.propertyName && ts.isIdentifier(element.propertyName)
                ? element.propertyName.text
                : element.name.text;
            addNamed(element.name.text, target, imported);
          }
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);

  return { named, namespaces };
}

/** Every production source file in `src/`, parsed. The real input. */
function readTreeSources(): Array<{ rel: string; text: string }> {
  return listSourceFiles(path.join(ROOT, "src")).map((file) => ({
    rel: path.relative(ROOT, file).split(path.sep).join("/"),
    text: fs.readFileSync(file, "utf8"),
  }));
}

/**
 * The census, over whatever sources it is handed.
 *
 * Parameterised so the classifier can be exercised on FIXTURES as well as on the
 * tree. Both matter and they answer different questions: the tree run says "no
 * unreviewed encoding exists today", and the fixture run says "and this scanner
 * would notice one". The second is not implied by the first — a scanner that
 * classified nothing at all would pass the tree run perfectly.
 */
function scanEncodings(
  sources: Array<{ rel: string; text: string }> = readTreeSources(),
): {
  encodings: Encoding[];
  exportedAliases: string[];
  declaredRenormalisers: string[];
} {
  const encodings: Encoding[] = [];
  const exportedAliases: string[] = [];

  const files = sources.map(({ rel, text }) => ({
    rel,
    text,
    sf: parse(rel, text),
  }));
  const scannedPaths = new Set(files.map((file) => file.rel));

  // Pass 1 — which functions in each file hand a caller's own value to an
  // encoder. Collected for EVERY file, including the helper module, so pass 2
  // can follow one across a module boundary.
  const resolvableByFile = new Map<string, Set<string>>();
  const declaredRenormalisers: string[] = [];
  for (const { rel, sf } of files) {
    const aliases = localEncoderAliases(sf);
    // A listed renormaliser is resolvable in the module that DECLARES it, which
    // then reaches its importers through the same named/namespace/dynamic import
    // resolution every other wrapper uses. See DATE_ONLY_RENORMALISERS.
    for (const name of declaredRenormalisersIn(sf)) {
      aliases.names.add(name);
      declaredRenormalisers.push(name);
    }
    resolvableByFile.set(rel, aliases.names);
    if (rel !== ENCODER_MODULE) {
      for (const name of aliases.exported) exportedAliases.push(`${rel}: ${name}`);
    }
  }

  // Pass 2 — classify call sites, following both same-file and IMPORTED
  // wrappers. Cross-module resolution is what stops the whole exercise being
  // defeated by one rename in a neighbouring file, which is exactly how the
  // Xero `formatDate` helper hid roughly eighteen document dates from #2682's
  // census. One hop is enough: an exported BARE rename is refused outright
  // below, so the only wrappers left to follow are normalisers, and a chain of
  // those would have to be written deliberately.
  for (const { rel, text, sf } of files) {
    if (rel === ENCODER_MODULE) continue;

    const lines = text.split("\n");
    const { named, namespaces } = moduleImports(sf, rel, scannedPaths);
    const encoders = new Set([
      ...CANONICAL_ENCODERS,
      ...(resolvableByFile.get(rel) ?? []),
    ]);
    for (const [local, source] of named) {
      if (resolvableByFile.get(source.module)?.has(source.imported)) encoders.add(local);
    }

    /**
     * Is this callee an encoder? A bare identifier by name, as before — plus
     * `ns.encoder(...)`, where `ns` is a whole-module binding of one of OUR
     * modules. Restricting the qualified form to a resolved local module is what
     * keeps it from matching an unrelated package method that happens to share a
     * name.
     */
    const isEncoderCallee = (callee: ts.Expression): boolean => {
      if (ts.isIdentifier(callee)) return encoders.has(callee.text);
      if (!ts.isPropertyAccessExpression(callee)) return false;
      if (!ts.isIdentifier(callee.expression)) return false;
      const target = namespaces.get(callee.expression.text);
      if (!target) return false;
      const member = callee.name.text;
      return (
        CANONICAL_ENCODERS.has(member) ||
        (resolvableByFile.get(target)?.has(member) ?? false)
      );
    };

    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        isEncoderCallee(node.expression) &&
        node.arguments.length > 0
      ) {
        const arg = node.arguments[0];
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const site = `${rel}:${line}`;
        const snippet = (lines[line - 1] ?? "").trim().slice(0, 120);
        const value = normaliseExpression(arg.getText(sf));

        if (readsClock(arg)) {
          encodings.push({ site, file: rel, kind: "clock", value, snippet });
        } else {
          for (const field of readFieldNames(arg)) {
            if (INSTANT_FIELDS.has(field)) {
              encodings.push({ site, file: rel, kind: "instant", field, value, snippet });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }

  return { encodings, exportedAliases, declaredRenormalisers };
}

const {
  encodings: ENCODINGS,
  exportedAliases: EXPORTED_ALIASES,
  declaredRenormalisers: DECLARED_RENORMALISERS,
} = scanEncodings();

// ---------------------------------------------------------------------------

describe("the Prisma schema is what says whether a value is a day or a moment (#2684)", () => {
  it("reads both kinds of date column out of the schema", () => {
    // A scanner's real failure mode is passing VACUOUSLY: the schema format
    // shifts, both indexes come back empty, and every assertion below goes green
    // over nothing. Pin one known member of each kind rather than only a count.
    expect(
      DATE_ONLY_FIELDS.get("checkIn"),
      "INV-DATE-010 (docs/invariants/booking-dates-and-capacity.md): " +
        "`Booking.checkIn` is the archetypal `@db.Date` lodge night. If this " +
        "guard can no longer see it, the schema parse has broken and every " +
        "classification below is meaningless.",
    ).toContain("Booking");
    expect(
      INSTANT_FIELDS.get("createdAt"),
      "INV-DATE-019: `createdAt` is the archetypal bare `DateTime` instant — " +
        "the one #2697's defect was truncating. If the instant index is empty " +
        "this guard reports nothing, whatever the code does.",
    ).toContain("Booking");
    expect(DATE_ONLY_FIELDS.size).toBeGreaterThanOrEqual(15);
    expect(INSTANT_FIELDS.size).toBeGreaterThanOrEqual(100);
  });

  it("keeps every date field name unambiguous across models", () => {
    // This guard classifies a call site by the FIELD NAME it reads, which is
    // sound only while a name means the same thing everywhere. Today no name is
    // both `@db.Date` on one model and bare `DateTime` on another. A migration
    // that introduced one would make every reading of that name a coin flip, so
    // it fails here rather than silently weakening the rule.
    const ambiguous = [...DATE_ONLY_FIELDS.keys()]
      .filter((name) => INSTANT_FIELDS.has(name))
      .map(
        (name) =>
          `${name}: @db.Date on ${DATE_ONLY_FIELDS.get(name)!.join("/")}, ` +
          `DateTime on ${INSTANT_FIELDS.get(name)!.join("/")}`,
      );

    expect(
      ambiguous,
      "INV-DATE-019: A field name is now a date-only column on one model and a " +
        "real instant on another. This guard classifies by name, so it can no " +
        "longer tell those call sites apart. Rename one side, or teach the " +
        "scanner to resolve the model.",
    ).toEqual([]);
  });
});

describe("an instant is never encoded as a calendar day by accident (#2684)", () => {
  it("finds encoder call sites at all", () => {
    // Same vacuity guard, one level up: if the AST walk stops recognising a
    // call, the two censuses below pass over an empty list.
    expect(
      ENCODINGS.length,
      "The encoder scan found NOTHING. Either every instant encoding really is " +
        "gone (in which case delete the opt-out lists too), or the walk has " +
        "stopped seeing calls and this file is now asserting nothing.",
    ).toBeGreaterThan(0);
  });

  it("walks a real tree, and every file in it that could hold an encoding", () => {
    // THE FLOOR UNDER EVERY "the tree contains nothing unreviewed" assertion in
    // this file. A walk that returned nothing — a moved directory, a renamed
    // root, an exclusion that grew a wildcard — would satisfy all of them
    // perfectly, which is the shape of vacuous pass this repository has shipped
    // before. Measured at 2064 files; the floor is well under that so ordinary
    // churn does not fray it, and far above zero.
    const scanned = listSourceFiles(path.join(ROOT, "src"));
    expect(
      scanned.length,
      "The source walk found almost nothing under src/. Every census below " +
        "would pass over an empty list.",
    ).toBeGreaterThan(1500);

    // AND IT REACHES EVERY FILE THAT COULD CARRY ONE. The walk takes `.ts` and
    // `.tsx`, which is the whole of `src/` today — the only other files there
    // are two stylesheets. A `.mjs`, `.cjs` or `.mts` added later would be
    // scanned by nothing at all, and no assertion here would notice, so the
    // arrival of one is what fails rather than the absence of a rule.
    // `resolveModule` tries the same two extensions, so widening one means
    // widening the other.
    const scriptLike = /\.(m|c)?[jt]sx?$/;
    const unreachable: string[] = [];
    const sweep = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__" && entry.name !== "node_modules") sweep(full);
        } else if (scriptLike.test(entry.name) && !/\.tsx?$/.test(entry.name)) {
          unreachable.push(path.relative(ROOT, full).split(path.sep).join("/"));
        }
      }
    };
    sweep(path.join(ROOT, "src"));

    expect(
      unreachable,
      "A source file under src/ has an extension this census's walk does not " +
        "take, so nothing classifies what it encodes. Add the extension to " +
        "listSourceFiles AND to resolveModule's candidate list — the two have " +
        "to agree, or a module resolves to a file that was never parsed.",
    ).toEqual([]);
  });

  it("routes every clock read through the club's calendar, or records why not", () => {
    const unlisted = ENCODINGS.filter((e) => e.kind === "clock")
      .filter((e) => !isReviewedDefect(e))
      .map((e) => `${e.site} — ${e.snippet}`);

    expect(
      unlisted,
      "INV-DATE-019 (docs/invariants/booking-dates-and-capacity.md): " +
        "A date-only encoder was handed the RAW CLOCK. `formatDateOnly(new Date())` " +
        "is the UTC day, and New Zealand runs 12-13 hours ahead, so for roughly " +
        "the first half of every NZ day that is YESTERDAY — across a month " +
        "boundary it is the wrong accounting period. Ask the club's calendar " +
        "instead: todayDateOnlyForTimeZone() for the string, getTodayDateOnly() " +
        "for the Date (@/lib/date-only). If the site is a known defect awaiting " +
        "its own fix, add it to KNOWN_INSTANT_ENCODING_DEFECTS with the issue.",
    ).toEqual([]);
  });

  it("never truncates a DateTime column without saying why it is safe", () => {
    const unexplained = ENCODINGS.filter((e) => e.kind === "instant")
      .filter(
        (e) =>
          !isReviewedDefect(e) &&
          !isReviewedInstantRead(e) &&
          !(e.field! in DATE_ONLY_IN_DATETIME_COLUMN),
      )
      .map((e) => `${e.site} — .${e.field} — ${e.snippet}`);

    expect(
      unexplained,
      "INV-DATE-019 (docs/invariants/booking-dates-and-capacity.md): " +
        "A bare `DateTime` column was encoded as a calendar day. A `@db.Date` " +
        "value may be read this way — its UTC midnight IS the encoding of an NZ " +
        "day — but a `DateTime` is a real instant, and its UTC day is the " +
        "PREVIOUS New Zealand day all morning. That is the whole of #2697. Use " +
        "formatDateOnlyForTimeZone() from @/lib/date-only, or, if the column is " +
        "one of the ones that holds a date-only value despite its type, add the " +
        "FIELD to DATE_ONLY_IN_DATETIME_COLUMN with the write that proves it.",
    ).toEqual([]);
  });

  it("keeps the reviewed lists honest against the tree", () => {
    // A list entry that no longer matches a real site is worse than no list: it
    // reads as coverage while covering nothing, and the next reader trusts it.
    //
    // ONE ASSERTION DOES BOTH HALVES, because with the line number gone they are
    // the same question. The old pair asked "does something still sit on line N"
    // and then "is it still the same defect"; the key now IS the defect, so an
    // entry that matches nothing has either been fixed (delete it) or been
    // pointed at a different value (re-read it), and the count says which. It
    // also catches the case a line number made impossible: a SECOND site
    // encoding the same expression in the same file, which one review must not
    // silently acquire.
    const problems: string[] = [];
    for (const entry of [
      ...KNOWN_INSTANT_ENCODING_DEFECTS,
      ...REVIEWED_INSTANT_READS,
    ]) {
      const matched = ENCODINGS.filter((found) => reviewedMatch(entry, found));
      const expected = entry.occurrences ?? 1;
      if (matched.length === expected) continue;

      const inFile = ENCODINGS.filter((found) => found.file === entry.file);
      problems.push(
        `${describeReviewed(entry)}: expected ${expected} matching site(s), found ${matched.length}. ` +
          (inFile.length === 0
            ? `Nothing in ${entry.file} is classified as an encoding at all.`
            : `That file now has: ${inFile
                .map(
                  (found) =>
                    `${found.site} ${found.kind}` +
                    `${found.field ? ` on .${found.field}` : ""} \`${found.value}\``,
                )
                .join("; ")}.`),
      );
    }

    expect(
      problems,
      "INV-DATE-019: A reviewed entry no longer describes exactly the sites it " +
        "was written for. Found NONE and the file has no encodings: the defect " +
        "is fixed — delete the entry, which is the list doing its job. Found " +
        "none but the file still has encodings: the site changed what it " +
        "encodes, so the excuse was written for one thing and would now cover " +
        "another — re-read it and update `kind`/`field`/`value` deliberately. " +
        "Found MORE than declared: a second site now encodes the same " +
        "expression in the same file, and one review does not silently stretch " +
        "to cover it — review it and raise `occurrences`, or give it its own " +
        "entry. Note that adding or removing lines above a site is NOT one of " +
        "these cases: the key carries no line number precisely so that an " +
        "unrelated change to a file's length cannot fail here.",
    ).toEqual([]);

    for (const field of Object.keys(DATE_ONLY_IN_DATETIME_COLUMN)) {
      expect(
        INSTANT_FIELDS.has(field),
        `${field} is listed as a date-only value in a DateTime column, but the ` +
          "schema no longer declares it that way. If it is now `@db.Date`, the " +
          "exception has been fixed properly — delete the entry.",
      ).toBe(true);
    }
  });

  /*
    AND THE SCANNER WOULD NOTICE ONE. Every assertion above is "the tree contains
    nothing unreviewed", which a classifier that recognised nothing would pass
    perfectly. These run the same census over FIXTURES, one per shape a review
    proved could walk past it.

    All three were lint-clean AND census-green when they were reported. None of
    them is exotic: the first is what a developer writes while extracting a
    repeated `new Date()`, the second is this guard's own sanctioned helper being
    handed an instant, and the third is `formatDate` rebuilt one statement at a
    time.
  */
  const censusOf = (source: string) =>
    scanEncodings([{ rel: "src/lib/date-guard-fixture.ts", text: source }]);

  /** The same, for a shape that needs a wrapper in a NEIGHBOURING module. */
  const censusOfFiles = (sources: Array<{ rel: string; text: string }>) =>
    scanEncodings(sources);

  it("classifies a clock read that has been extracted into a local", () => {
    const { encodings } = censusOf(
      `import { formatDateOnly } from "@/lib/date-only";
export function stamp() {
  const now = new Date();
  return formatDateOnly(now);
}
`,
    );

    expect(
      encodings.map((e) => e.kind),
      "INV-DATE-019: `const d = new Date(); formatDateOnly(d)` is the same " +
        "defect as `formatDateOnly(new Date())`, and the census used to see " +
        "only the inline spelling. Once the reviewed list is empty, the " +
        "extracted local is the shape under which the whole class walks back in.",
    ).toEqual(["clock"]);
  });

  it("classifies an instant fed through the guard's own string encoder", () => {
    const { encodings } = censusOf(
      `import { dateOnlyFromIsoString } from "@/lib/date-only";
export function due(booking: { createdAt: Date }) {
  return dateOnlyFromIsoString(booking.createdAt.toISOString());
}
`,
    );

    expect(
      encodings.map((e) => `${e.kind}:${e.field}`),
      "INV-DATE-019: Serialising an instant does not stop it being an instant. " +
        "`dateOnlyFromIsoString(x.createdAt.toISOString())` is lint-clean by " +
        "construction — there is no bare truncation in it — so if the census " +
        "cannot see through the serialisation, this guard's own sanctioned " +
        "helper is a documented route around the rule it belongs to.",
    ).toEqual(["instant:createdAt"]);
  });

  it("refuses an exported wrapper that writes the truncation out by hand", () => {
    const { exportedAliases, encodings } = censusOf(
      `export function formatDocumentDate(date: Date): string {
  const iso = date.toISOString();
  return iso.slice(0, 10);
}
export function due(booking: { createdAt: Date }) {
  return formatDocumentDate(booking.createdAt);
}
`,
    );

    expect(
      exportedAliases,
      "INV-DATE-019: This is `formatDate` reconstituted, and harder to spot. " +
        "The alias ban used to recognise only a delegation to a CANONICAL " +
        "encoder, so a wrapper whose body wrote the truncation itself was " +
        "neither refused nor followed — which is exactly the blind spot that " +
        "hid roughly eighteen Xero document dates.",
    ).toEqual(["src/lib/date-guard-fixture.ts: formatDocumentDate"]);

    // And, having recognised it, the census follows it: the instant handed to it
    // one line later is classified as if the encoder were called directly.
    expect(encodings.map((e) => `${e.kind}:${e.field}`)).toEqual([
      "instant:createdAt",
    ]);
  });

  it("follows a shared renormaliser to the value handed in", () => {
    /*
      `storedDateOnly` decodes a stored calendar day and re-encodes it, so the
      canonical encoder inside it FEEDS ANOTHER CALL rather than being the
      result — the one shape `localEncoderAliases` deliberately will not follow.
      Correct for the alias ban and wrong for the census, which is why
      DATE_ONLY_RENORMALISERS exists.

      TWO FILES, because the real arrangement is cross-module: the helper lives in
      `src/lib/stored-calendar-day.ts` and its callers import it. A one-file
      fixture would pass through `resolvableByFile` for the same file and prove
      nothing about the import hop.
    */
    const { encodings } = censusOfFiles([
      {
        rel: "src/lib/renormaliser-fixture.ts",
        text: `import { calendarDateOfDateOnlyInstant, dateOnlyInstantOf } from "@/lib/club-time";
export function storedDateOnly(value: Date): Date {
  return dateOnlyInstantOf(calendarDateOfDateOnlyInstant(value));
}
`,
      },
      {
        rel: "src/lib/renormaliser-caller-fixture.ts",
        text: `import { storedDateOnly } from "./renormaliser-fixture";
export function nights(booking: { checkIn: Date; createdAt: Date }) {
  return [storedDateOnly(booking.checkIn), storedDateOnly(booking.createdAt)];
}
`,
      },
    ]);

    expect(
      encodings.map((e) => `${e.kind}:${e.field}`),
      "INV-DATE-019: `storedDateOnly(booking.createdAt)` reads a real instant as " +
        "its UTC day, one call further round than `calendarDateOfDateOnlyInstant` " +
        "written inline. Before DATE_ONLY_RENORMALISERS the census classified " +
        "nothing written through that helper, so 32 `@db.Date` reads AND any " +
        "instant that joined them were both invisible. `checkIn` is `@db.Date` " +
        "and correctly produces no finding; `createdAt` is a bare `DateTime` and " +
        "must.",
    ).toEqual(["instant:createdAt"]);
  });

  it("lists exactly the renormalisers this tree has, named explicitly", () => {
    /*
      THE CASE BELOW IS DRIVEN FROM THE SET, so deleting an entry also deletes its
      own coverage — a guard whose only measured call comes from its own
      scaffolding, which is the vacuity class this epic keeps re-finding. Measured:
      removing `normalizeBookingDate` from the set left all 31 cases passing.

      So the membership is named here as a literal. A DELETION fails this case; an
      ADDITION without coverage fails the loop below; a rename fails the staleness
      assertion further down. Between the three there is no way to change this set
      quietly.
    */
    expect([...DATE_ONLY_RENORMALISERS].sort()).toEqual([
      "normalizeBookingDate",
      "storedDateOnly",
    ]);
  });

  it("follows EVERY name in the set, not just the first", () => {
    /*
      Removing a name from DATE_ONLY_RENORMALISERS must break something, or the
      entry is decoration. The case above covers `storedDateOnly`; this one covers
      `normalizeBookingDate`, whose guards keep it a separate function in
      `pricing.ts` and whose call sites are therefore classified only because its
      name is listed too. Driven from the set itself, so a name added later
      without a case fails here rather than going unverified.
    */
    for (const name of DATE_ONLY_RENORMALISERS) {
      const { encodings } = censusOfFiles([
        {
          rel: "src/lib/set-driven-fixture.ts",
          text: `import { calendarDateOfDateOnlyInstant, dateOnlyInstantOf } from "@/lib/club-time";
export function ${name}(value: Date): Date {
  return dateOnlyInstantOf(calendarDateOfDateOnlyInstant(value));
}
export function read(booking: { createdAt: Date }) {
  return ${name}(booking.createdAt);
}
`,
        },
      ]);
      expect(
        encodings.map((e) => `${e.kind}:${e.field}`),
        `INV-DATE-019: DATE_ONLY_RENORMALISERS lists \`${name}\`, but the census does ` +
          "not follow it, so every call site written through it is classified as " +
          "nothing. Either the set entry does nothing or the scanner stopped " +
          "reading it.",
      ).toEqual(["instant:createdAt"]);
    }
  });

  it("does not follow an unrelated function that shares a listed name", () => {
    // The set names a FUNCTION, not a spelling. A local helper elsewhere in the
    // tree that happens to be called `storedDateOnly` and does something else
    // must not be followed as if it were the shared one — which is what keys the
    // set on the declaration rather than on the call.
    const { encodings } = censusOfFiles([
      {
        rel: "src/lib/unrelated-caller-fixture.ts",
        text: `import { storedDateOnly } from "some-package";
export function nights(booking: { createdAt: Date }) {
  return storedDateOnly(booking.createdAt);
}
`,
      },
    ]);

    expect(encodings).toEqual([]);
  });

  it("names a renormaliser that really exists in the tree", () => {
    // The mirror of the reviewed-list staleness rule. An entry naming nothing
    // classifies nothing, and reads as coverage while covering nothing.
    expect(
      [...DATE_ONLY_RENORMALISERS].filter(
        (name) => !DECLARED_RENORMALISERS.includes(name),
      ),
      "INV-DATE-019: a DATE_ONLY_RENORMALISERS entry names no function declared " +
        "anywhere under src/. Either the helper was renamed — in which case the " +
        "set must lead the rename, or every call site written through it is " +
        "unclassified in the window — or it was deleted, and the entry should go " +
        "with it.",
    ).toEqual([]);
  });

  it("leaves a wrapper that adds MEANING alone", () => {
    // The ban is on a bare RENAME. A helper that decides WHICH field is a lodge
    // night is naming a decision rather than hiding one, and banning it would
    // push authors back to inlining the encoder at every call site.
    const { exportedAliases } = censusOf(
      `import { formatDateOnly } from "@/lib/date-only";
export function getIssueDate(booking: { checkIn: Date }) {
  return formatDateOnly(booking.checkIn);
}
`,
    );

    expect(exportedAliases).toEqual([]);
  });

  it("classifies an instant handed to the club-time kernel's encoder", () => {
    // The census keys on callee NAMES, so it knows only the encoders it has been
    // told about. CT-6 (#2991) moves call sites onto the kernel; if the name
    // arrived after the rename there would be a window in which this whole file
    // classified nothing and passed perfectly — the exact failure its own
    // docblock says it exists to prevent. The name goes first, and this is what
    // proves it took effect.
    const { encodings } = censusOf(
      `import { calendarDateOfDateOnlyInstant } from "@/lib/club-time";
export function due(booking: { createdAt: Date }) {
  return calendarDateOfDateOnlyInstant(booking.createdAt);
}
`,
    );

    expect(
      encodings.map((e) => `${e.kind}:${e.field}`),
      "INV-DATE-019: `Instant` is a bare `Date` (club-time/types.ts), so the " +
        "kernel's encoder carries no more type protection than formatDateOnly " +
        "did — its own docblock says handing it a real DateTime gives that " +
        "column's UTC day, which is the whole of #2697.",
    ).toEqual(["instant:createdAt"]);
  });

  it("classifies an instant that reaches the kernel through requireInstant", () => {
    // The kernel's encoder takes an `Instant`, so a caller holding a plain
    // column value converts first. That conversion changes the TYPE and not the
    // value, and it must not hide which field is being read.
    const { encodings } = censusOf(
      `import { calendarDateOfDateOnlyInstant, requireInstant } from "@/lib/club-time";
export function due(booking: { createdAt: Date }) {
  return calendarDateOfDateOnlyInstant(requireInstant(booking.createdAt));
}
`,
    );

    expect(encodings.map((e) => `${e.kind}:${e.field}`)).toEqual([
      "instant:createdAt",
    ]);
  });

  it("classifies an instant that reaches the kernel through parseInstant", () => {
    /*
      THE SECOND NAME IN THE SET, which had no fixture at all until #2870's F3
      lane. `requireInstant` above was covered and `parseInstant` was not, so
      dropping it from INSTANT_PASS_THROUGHS left the whole suite green — measured,
      32 of 32 passing. That is the same vacuity DATE_ONLY_RENORMALISERS was given
      a named roster to prevent, in the set this file describes as its mirror
      image, and it was inherited rather than noticed.
    */
    const { encodings } = censusOf(
      `import { calendarDateOfDateOnlyInstant, parseInstant } from "@/lib/club-time";
export function due(booking: { createdAt: Date }) {
  const instant = parseInstant(booking.createdAt);
  return instant ? calendarDateOfDateOnlyInstant(instant) : null;
}
export function dueDirect(booking: { createdAt: Date }) {
  return calendarDateOfDateOnlyInstant(parseInstant(booking.createdAt)!);
}
`,
    );

    expect(
      encodings.map((e) => `${e.kind}:${e.field}`),
      "INV-DATE-019: `parseInstant` is the nullable half of the kernel's " +
        "Date-to-Instant pass-through. It changes the type and not the value, so a " +
        "field read through it must stay visible to this census — otherwise " +
        "`calendarDateOfDateOnlyInstant(parseInstant(booking.createdAt))` is the " +
        "#2697 defect written one call further round.",
    ).toEqual(["instant:createdAt"]);
  });

  it("lists exactly the instant pass-throughs this kernel has, named explicitly", () => {
    /*
      The roster for the SIBLING set, added for the reason its mirror needed one.
      A fixture proves a listed name is followed; only a literal list proves a name
      cannot be quietly DELETED. Measured before this case existed: removing
      `parseInstant` from the set passed 32 of 32.

      If the kernel renames or retires one of these, this case is the thing that
      says so, and the fixture above is the thing that says the survivor still
      works.
    */
    expect([...INSTANT_PASS_THROUGHS].sort()).toEqual([
      "parseInstant",
      "requireInstant",
      "requireStoredCalendarDay",
    ]);
  });

  it("classifies an instant that reaches the kernel through requireStoredCalendarDay", () => {
    /*
      THE THIRD NAME IN THE SET (#3082), with its own fixture for the reason the
      `parseInstant` case above records: a listed name with no fixture can be
      dropped from the set with the whole suite still green.

      This one is worth stating twice over, because it is the pass-through most
      likely to be read as unnecessary. `requireStoredCalendarDay` REFUSES a value
      carrying a UTC time of day, so it looks like the one wrapper through which an
      instant cannot reach the encoder — and `createdAt` here would throw at runtime
      for all but one instant in 86 400 000, the one landing on exactly UTC
      midnight, which passes. The residue is small and it is not the argument: what
      the census reports is the SHAPE, not the outcome. A source line
      asking for a `createdAt` to be encoded as a calendar day is the INV-DATE-019
      defect whether it throws or answers, and it has to be visible here rather
      than discovered by a production stack trace.
    */
    const { encodings } = censusOf(
      `import { calendarDateOfDateOnlyInstant, requireStoredCalendarDay } from "@/lib/club-time";
export function due(booking: { createdAt: Date }) {
  return calendarDateOfDateOnlyInstant(
    requireStoredCalendarDay(booking.createdAt, { subject: "due", instead: "no" }),
  );
}
`,
    );

    expect(
      encodings.map((e) => `${e.kind}:${e.field}`),
      "INV-DATE-019: `requireStoredCalendarDay` is the kernel's strict " +
        "Date-to-Instant pass-through. It changes what is GUARANTEED and not which " +
        "value is read, so a field read through it must stay visible to this " +
        "census.",
    ).toEqual(["instant:createdAt"]);
  });

  it("classifies an encoder reached through a namespace import", () => {
    // `import * as` was invisible twice over: the import was not read, and the
    // call-site walk accepted only a bare identifier as a callee. Nothing in
    // this tree namespace-imports one of its own modules today, which is exactly
    // when a bypass is cheapest to close.
    const { encodings } = censusOf(
      `import * as dateOnly from "@/lib/date-only";
export function due(booking: { createdAt: Date }) {
  return dateOnly.formatDateOnly(booking.createdAt);
}
`,
    );

    expect(encodings.map((e) => `${e.kind}:${e.field}`)).toEqual([
      "instant:createdAt",
    ]);
  });

  it("follows a wrapper imported by a relative, single-quoted specifier", () => {
    // Both halves of that sentence were reported as gaps and neither is one:
    // `resolveModule` has always handled `.`-relative specifiers, and the
    // TypeScript parser reports a specifier's text with the quotes already
    // stripped, so `'…'` and `"…"` are the same node. This is the fixture that
    // says so, rather than the next reviewer having to re-derive it.
    const { encodings, exportedAliases } = censusOfFiles([
      {
        rel: "src/lib/date-guard-fixture-helper.ts",
        text: `import { formatDateOnly } from '@/lib/date-only';
export function documentDate(value: Date): string {
  return formatDateOnly(value);
}
`,
      },
      {
        rel: "src/lib/nested/date-guard-fixture.ts",
        text: `import { documentDate } from '../date-guard-fixture-helper';
export function due(booking: { createdAt: Date }) {
  return documentDate(booking.createdAt);
}
`,
      },
    ]);

    expect(encodings.map((e) => `${e.kind}:${e.field}`)).toEqual([
      "instant:createdAt",
    ]);
    // And the wrapper is still refused where it is defined.
    expect(exportedAliases).toEqual([
      "src/lib/date-guard-fixture-helper.ts: documentDate",
    ]);
  });

  it("follows a wrapper pulled in by a dynamic import, destructured or whole", () => {
    // `const { x } = await import("@/lib/…")` is a spelling this tree already
    // uses at 101 sites (and binds a whole namespace at 8 more), and it was read
    // by nothing here — a wrapper reached that way had its call sites left
    // unclassified, which is the `formatDate` blind spot one syntax along.
    const { encodings } = censusOfFiles([
      {
        rel: "src/lib/date-guard-fixture-helper.ts",
        text: `import { formatDateOnly } from "@/lib/date-only";
export function documentDate(value: Date): string {
  return formatDateOnly(value);
}
`,
      },
      {
        rel: "src/lib/date-guard-fixture.ts",
        text: `export async function due(booking: { createdAt: Date }) {
  const { documentDate } = await import("@/lib/date-guard-fixture-helper");
  return documentDate(booking.createdAt);
}
export async function alsoDue(booking: { updatedAt: Date }) {
  const helper = await import("@/lib/date-guard-fixture-helper");
  return helper.documentDate(booking.updatedAt);
}
`,
      },
    ]);

    expect(encodings.map((e) => `${e.kind}:${e.field}`)).toEqual([
      "instant:createdAt",
      "instant:updatedAt",
    ]);
  });

  it("lets no module hide an encoder behind an exported alias", () => {
    // `xero-invoice-helpers` exported `formatDate`, a one-line delegation to the
    // canonical encoder. Eleven modules imported it, and the thirty-three Xero
    // document dates behind it were invisible to #2682's spelling census —
    // sixteen of them encoding the raw clock straight into the club's accounts.
    // A rename is all it takes to put a class of defects back out of reach, so
    // the rename is what is banned.
    const reviewed = new Set(REVIEWED_ENCODER_RENAMES.map((r) => r.alias));

    // The allowlist is checked in BOTH directions, or it rots into blanket
    // permission: an entry naming a rename the scanner no longer reports is
    // describing something that does not exist, and the next reader reads it as
    // coverage.
    expect(
      REVIEWED_ENCODER_RENAMES.map((r) => r.alias).filter(
        (alias) => !EXPORTED_ALIASES.includes(alias),
      ),
      "A reviewed encoder rename no longer exists as an exported bare " +
        "delegation. If the wrapper is gone, or now adds meaning the scanner " +
        "can see, delete its entry.",
    ).toEqual([]);
    for (const entry of REVIEWED_ENCODER_RENAMES) {
      expect(
        entry.why.length,
        `The reviewed rename ${entry.alias} carries no reason.`,
      ).toBeGreaterThan(20);
    }

    expect(
      EXPORTED_ALIASES.filter((alias) => !reviewed.has(alias)),
      "INV-DATE-019: A module exports a bare delegation to a date-only encoder. " +
        "Callers should import the canonical helper — @/lib/club-time's " +
        "calendarDateOfDateOnlyInstant, or its @/lib/date-only equivalent — by " +
        "its own name, so this guard, and the next person auditing dates, can " +
        "see what is being encoded. A wrapper that adds MEANING (reading a " +
        "specific field, choosing between the date-only and club-timezone " +
        "helpers) is fine and is not what this catches. A wrapper whose NAME is " +
        "the meaning, which this structural check cannot see, goes on " +
        "REVIEWED_ENCODER_RENAMES with its reason — never by loosening the rule.",
    ).toEqual([]);
  });
});

// Does every glob in a block's list name a TEST path?
//
// Its own named function because the subtle failure is easy to write and
// impossible to see: asserting against the JOINED label (does `files.join()`
// contain "__tests__") passes for a two-glob list whose FIRST glob is a
// production path under `src/lib` and whose second is a `__tests__` one. Such a
// block reads as a tests-only exemption and disarms the whole of `src/lib`.
// EVERY glob must qualify, never the concatenation.
function isTestOnlyGlobList(files: readonly string[]): boolean {
  return (
    files.length > 0 &&
    files.every(
      (pattern) => pattern.includes("__tests__") || pattern.includes(".test."),
    )
  );
}

/*
  THE GUARD'S REACH, declared once and asserted through ESLint itself.

  `src/**` and `scripts/**` carry the encoding restrictions; `src/lib/date-only.ts`
  is the encoder's own home and `prisma/**` holds two seed files that cannot obey
  it, both recorded on SRC_RESTRICTION_EXEMPTIONS. The zoned-formatter rule has no
  exemption anywhere.

  Returning `[]` for a path outside the reach matters: the shared roster carries
  `scripts/x.ts` and `prisma/seed-x.ts` for the money guard, and requiring the
  date arms of `prisma/` would report a problem the config is right about.
*/
const DATE_GUARD_EXEMPT_PATHS = (file: string) =>
  file === "src/lib/date-only.ts" || file.startsWith("prisma/");

const DATE_GUARD_APPLIES = (file: string) =>
  (file.startsWith("src/") || file.startsWith("scripts/")) &&
  !DATE_GUARD_EXEMPT_PATHS(file);

const ENCODING_RULE_ID = "INV-DATE-019";
const ZONED_RULE_ID = "INV-DATE-015";

/** A known violation of each arm, linted at every roster path. */
const ENCODING_VIOLATION = "export const day = value.toISOString().slice(0, 10);\n";
const UNZONED_FORMATTER_VIOLATION =
  'export const fmt = new Intl.DateTimeFormat("en-CA");\n';

const BOOTSTRAP_TIMEOUT_MS = 60_000;
const CASE_TIMEOUT_MS = 20_000;

vi.setConfig({
  testTimeout: CASE_TIMEOUT_MS,
  hookTimeout: BOOTSTRAP_TIMEOUT_MS,
});

let eslint: ESLint;

beforeAll(async () => {
  eslint = new ESLint({ cwd: ROOT, warnIgnored: false });
  // Resolving the flat config, the Next presets and every plugin costs seconds
  // and none of it happens until the first `lintText`. Pay it here, and make the
  // warm-up a CANARY: every "reports nothing" expectation below would pass
  // vacuously if the config bootstrap silently produced an empty rule set.
  const results = await eslint.lintText(ENCODING_VIOLATION, {
    filePath: path.join(ROOT, "src/lib/date-guard-fixture.ts"),
  });
  const messages = results.flatMap((result) => result.messages);
  const fatal = messages.filter((message) => message.fatal);
  if (fatal.length > 0) {
    throw new Error(
      `${ENCODING_RULE_ID} canary did not parse, so the coverage audits would have passed vacuously: ${fatal[0]?.message}`,
    );
  }
  const hits = messages.filter(
    (message) =>
      message.ruleId === "no-restricted-syntax" &&
      typeof message.message === "string" &&
      message.message.startsWith(ENCODING_RULE_ID),
  );
  if (hits.length !== 1) {
    throw new Error(
      `${ENCODING_RULE_ID} canary produced ${hits.length} report(s), expected exactly 1. The guard is not running, so every audit below would have been vacuous. Messages seen: ${JSON.stringify(
        messages.map((message) => ({
          ruleId: message.ruleId,
          severity: message.severity,
          message: message.message?.slice(0, 120),
        })),
      )}`,
    );
  }
}, BOOTSTRAP_TIMEOUT_MS);

describe("the lint guard reaches every production path, and no block can drop it (#2684)", () => {
  type Restriction = { selector: string; message: string };
  type ConfigEntry = { files?: string[]; rules?: Record<string, unknown> };

  const entries = (eslintConfig as ConfigEntry[]).filter(
    (entry) => entry?.rules?.["no-restricted-syntax"] !== undefined,
  );

  const sameFiles = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((f, i) => f === b[i]);

  it("sees the config it is meant to be pinning", () => {
    // Vacuity guard. If this file stops resolving the config, every assertion
    // below iterates an empty list and reports a clean bill of health.
    expect(
      entries.length,
      "No config block sets `no-restricted-syntax`. Either the rule is gone or " +
        "this test is reading the wrong export — both are failures.",
    ).toBeGreaterThanOrEqual(4);
    expect(
      MANDATORY_SRC_RESTRICTIONS.length,
      "The mandatory restriction set is empty, so requiring it of every block " +
        "requires nothing.",
    ).toBeGreaterThan(0);
  });

  it("keeps the guards this repository has already paid for in the mandatory set", () => {
    // A FLOOR under the array, because every other assertion here measures
    // blocks AGAINST that array — deleting a restriction from it would
    // otherwise make the whole file agree that nothing is missing. Named guards
    // only: one added later needs no edit here, removing one of these does.
    const selectors = MANDATORY_SRC_RESTRICTIONS.map((r: Restriction) => r.selector);
    const required: Array<[string, RegExp]> = [
      ["#2684 date-only truncation", /toISOString\|toJSON/],
      ["#2684 ISO split on T", /'split'/],
      // The four arms added after the first review measured real escapes past
      // the two above. Each is named because each closed a spelling that was
      // proven, by a lint run, to be clean before it existed.
      ["#2684 the split head taken with .at(0) or .shift()", /"(at|shift)"/],
      ["#2684 the time half stripped with .replace()", /"replace"/],
      ["#2684 the truncation assembled through a local", /:has\(VariableDeclarator/],
      ["#2684 a date key built from UTC parts", /getUTCFullYear/],
      ["#2264 an Intl.DateTimeFormat with no timeZone", /DateTimeFormat/],
      ["#2289 raw-SQL result cast", /queryRaw\|executeRaw/],
      // #2685's money guard rides the same array since the two branches were
      // folded onto one path. Naming it here is what makes this file fail if a
      // future edit quietly drops the money group out of the mandatory set —
      // the failure mode the fold exists to prevent.
      ["#2685 an inline parse scaled to cents", /parseFloat\|parseInt/],
      ["#2685 a division by a hundredth", /right\.value=0\.01/],
    ];
    for (const [label, pattern] of required) {
      expect(
        selectors.some((s) => pattern.test(s)),
        `The mandatory restriction set no longer contains the ${label} guard. ` +
          "Every other check in this file measures blocks against that set, so " +
          "removing a restriction from it silently retires the guard everywhere.",
      ).toBe(true);
    }
  });

  /*
    THE STRUCTURAL AUDIT — through ESLint's own config resolution, not glob text.

    This used to walk the config's blocks and decide which ones "cover production"
    by asking whether a glob string began with `src/`. That is a string test on a
    PATTERN rather than a match against a path, and #2685's lane proved three
    ordinary edits walk straight through it: a glob rooted on `**` that names a
    real screen directory, a block with no `files` key at all (flat config applies
    it everywhere), and a severity downgrade to `warn` (which `npm run lint`
    ignores entirely, having no `--max-warnings`).

    `auditResolvedGuardCoverage` asks ESLint what the rule IS at a roster of real
    production paths, so no glob spelling, block ordering, missing `files` key or
    severity can change the answer without changing the result. The roster is
    shared with the money suite: a path belongs in `eslint-guard-coverage.ts`, not
    in one suite's copy of the list.
  */
  it("resolves to the date restrictions at every production path on the shared roster", async () => {
    // Vacuity guard: an empty arm list would make "carries every arm" trivial.
    expect(
      DATE_GUARD_ARMS.encoding.length,
      "The date-only ENCODING arm family is empty, so requiring it of every " +
        "path requires nothing.",
    ).toBeGreaterThanOrEqual(8);
    expect(DATE_GUARD_ARMS.zonedFormatter.length).toBeGreaterThan(0);
    expect(DATE_GUARD_ARMS.rendering.length).toBe(3);

    const problems = await auditResolvedGuardCoverage({
      eslint,
      repoRoot: ROOT,
      requiredSelectorsFor: (file) => [
        // The zoned-formatter rule has no exemption anywhere.
        ...DATE_GUARD_ARMS.zonedFormatter,
        ...(DATE_GUARD_APPLIES(file) ? DATE_GUARD_ARMS.encoding : []),
      ],
    });

    expect(
      problems,
      "INV-DATE-019: The date guard does not resolve to `error` with every arm " +
        "at a production path the roster names. Flat config REPLACES a rule's " +
        "option list rather than merging it, so a block written to lift one " +
        "guard removes the others by omission and lint goes green over an " +
        "unguarded file. Build the value with `srcRestrictedSyntax(...)`, or " +
        "`srcRestrictedSyntaxWithout(GROUP)` when a block genuinely cannot obey " +
        "one guard — and record that in SRC_RESTRICTION_EXEMPTIONS with a reason.",
    ).toEqual([]);
  });

  /*
    THE `nzst-date.ts` PIN LIVED HERE AND WAS DELETED WITH ITS SUBJECT (#3123).

    `src/lib/nzst-date.ts` held the six frozen `Intl.DateTimeFormat` constants the
    club's rendering seam was built from, and was listed in the narrowed block that
    drops the `toLocale*` arms. CT-2 (#2990) made every one of those functions a
    one-line delegation to `@/lib/club-time`, so it formatted nothing and needed no
    exemption — and it came off that list. Nothing asserted that removal, so this
    case existed to pin it: the rendering arms had to resolve there like any other
    library module, "until CT-6 (#2991) deletes the file".

    CT-6 deleted the file. A resolution check against a path that does not exist
    proves nothing about anything — ESLint will happily compute a config for it —
    so keeping the case would have left an assertion that reads as coverage and is
    not. What replaces it is stronger and lives one directory across:
    `club-time/__tests__/club-time-kernel-census.test.ts` asserts the file has not
    come back at all, which is the only exemption that can matter now.
  */

  /*
    THE BEHAVIOURAL AUDIT. The one above compares selector STRINGS; this lints a
    real violation at every roster path, so it also catches an arm that is present
    but no longer matches anything. A config edit that disarms the guard has to
    survive both.
  */
  it("actually fires on a hand-written encoding at every production path", async () => {
    const problems = await auditEnforcedGuardCoverage({
      eslint,
      repoRoot: ROOT,
      violatingCode: ENCODING_VIOLATION,
      messagePrefix: ENCODING_RULE_ID,
      isExempt: DATE_GUARD_EXEMPT_PATHS,
    });

    expect(
      problems,
      "INV-DATE-019: `value.toISOString().slice(0, 10)` is either not reported " +
        "where the guard must apply, or reported on a path the config declares " +
        "exempt. The exempt paths are `src/lib/date-only.ts` (the encoder's own " +
        "home) and `prisma/**` (the two seed files), both on " +
        "SRC_RESTRICTION_EXEMPTIONS — nothing else.",
    ).toEqual([]);
  });

  it("refuses an unzoned Intl.DateTimeFormat everywhere, including scripts and prisma", async () => {
    // The #2264 rule bans `toLocaleDateString()` because it renders in the
    // VIEWER's zone — and then sends the author to an `Intl.DateTimeFormat`,
    // which has the identical defect when no `timeZone` is passed and was clean
    // under every arm. `en-CA` numeric IS `yyyy-MM-dd`, so it is also the
    // obvious workaround for anyone tripping the ban, and it produces a
    // date-only encoding on the reader's calendar rather than the club's.
    const problems = await auditEnforcedGuardCoverage({
      eslint,
      repoRoot: ROOT,
      violatingCode: UNZONED_FORMATTER_VIOLATION,
      messagePrefix: ZONED_RULE_ID,
    });

    expect(
      problems,
      "INV-DATE-015: `new Intl.DateTimeFormat(...)` with no `timeZone` is not " +
        "refused at a path the roster names. This rule has no exemptions: the " +
        "date and money helper modules all pass a timeZone already.",
    ).toEqual([]);
  });

  it("keeps the mandatory set reaching outside src/, which a glob-text walk could not see", async () => {
    // The old audit skipped any block whose globs did not start with `src/`, so
    // the `scripts/` and `prisma/` blocks were never measured at all — and those
    // are exactly the blocks `operatorScriptRestrictedSyntax()` hand-wrote its
    // own shortened list into, four lines under a comment promising that adding
    // an array to the shared list was "the only edit needed". Naming the two
    // paths here is what keeps that closed.
    const outsideSrc = PRODUCTION_GUARD_ROSTER.filter(
      (entry) => !entry.file.startsWith("src/"),
    ).map((entry) => entry.file);

    expect(
      outsideSrc,
      "The shared roster no longer carries a `scripts/` and a `prisma/` path, " +
        "so nothing measures the guards outside `src/`.",
    ).toEqual(expect.arrayContaining(["scripts/x.ts", "prisma/seed-x.ts"]));
  });

  it("switches the rule off only for blocks that are entirely tests", () => {
    const disarmed = entries
      .filter((entry) => entry.rules!["no-restricted-syntax"] === "off")
      .filter((entry) => !isTestOnlyGlobList(entry.files ?? []))
      .map((entry) => JSON.stringify(entry.files));

    expect(
      disarmed,
      "A block switches `no-restricted-syntax` off over globs that are not all " +
        "test paths. Every glob in the list must be a test path — checking the " +
        "concatenation lets one production glob ride along beside a test one " +
        "and disarms every guard for it.",
    ).toEqual([]);

    // Pin the predicate itself, rather than trusting that today's config
    // happens not to contain the mixed shape.
    expect(
      isTestOnlyGlobList(["src/**/__tests__/**/*.ts", "src/**/*.test.ts"]),
    ).toBe(true);
    expect(isTestOnlyGlobList(["src/lib/**/*.ts", "src/**/__tests__/**"])).toBe(
      false,
    );
    expect(isTestOnlyGlobList([])).toBe(false);
  });

  it("keeps every exemption documented, exact, and to a named group", () => {
    const mandatory = new Set(
      (MANDATORY_SRC_RESTRICTIONS as Restriction[]).map((r) => r.selector),
    );

    for (const exemption of SRC_RESTRICTION_EXEMPTIONS) {
      expect(
        exemption.reason?.length ?? 0,
        `The exemption for ${JSON.stringify(exemption.files)} carries no reason.`,
      ).toBeGreaterThan(20);
      expect(
        exemption.omits.length,
        `The exemption for ${JSON.stringify(exemption.files)} omits nothing, so it is not an exemption.`,
      ).toBeGreaterThan(0);
      for (const restriction of exemption.omits as Restriction[]) {
        expect(
          mandatory.has(restriction.selector),
          `${JSON.stringify(exemption.files)} claims an exemption from a restriction that is not mandatory, so it is describing something already unenforced.`,
        ).toBe(true);
      }
      expect(
        entries.some((entry) => sameFiles(exemption.files, entry.files ?? [])),
        `${JSON.stringify(exemption.files)} is exempted but no block has exactly those globs. Widening a block's globs must not carry its exemption along.`,
      ).toBe(true);
    }
  });

  it("exempts only the encoder's own module and the prisma seeds from the encoding restrictions", () => {
    const exemptFromEncoding = SRC_RESTRICTION_EXEMPTIONS.filter((e) =>
      (e.omits as Restriction[]).some((r) =>
        /toISOString\|toJSON|'split'|getUTCFullYear/.test(r.selector),
      ),
    ).map((e) => JSON.stringify(e.files));

    expect(
      exemptFromEncoding,
      "Exactly two paths may be exempt from the #2684 encoding restrictions: " +
        "`src/lib/date-only.ts`, where the truncation is supposed to live, and " +
        "`prisma/**`, whose two seed files synthesise date strings for a " +
        "throwaway database and one of which is contractually import-free. " +
        "`scripts/**` is deliberately NOT among them — it carries the full set, " +
        "and it has zero truncations today. Anything else appearing here is a " +
        "site that was never classified.",
    ).toEqual([
      JSON.stringify(["src/lib/date-only.ts"]),
      JSON.stringify(["prisma/**/*.{ts,tsx}"]),
    ]);
  });
});
