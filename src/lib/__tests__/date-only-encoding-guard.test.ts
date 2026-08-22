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
  resolveRestrictedSyntax,
} from "./support/eslint-guard-coverage";

/**
 * #2684 — the date-only ENCODING guard, second arm.
 *
 * ENFORCES INV-DATE-010 and INV-DATE-019
 * (`docs/invariants/booking-dates-and-capacity.md`), which name this file and
 * the `no-restricted-syntax` rules in `eslint.config.mjs` as their two
 * enforcement arms. Every assertion repeats the id in its failure message so
 * whoever trips one is handed the rule rather than having to go and find it
 * (#2691).
 *
 * THE TWO ARMS DIVIDE ALONG WHAT EACH CAN SEE.
 *
 * Lint sees SYNTAX, exhaustively: no file in `src/` may hand-write
 * `toISOString().slice(0, 10)` or any of its spellings. That closes the
 * duplication, and it is airtight because it needs to know nothing about the
 * value.
 *
 * It cannot see MEANING, and meaning is the whole defect. `formatDateOnly` is
 * correct for a `@db.Date` column, whose UTC midnight is the ENCODING of an NZ
 * calendar day (INV-DATE-010), and wrong for a bare `DateTime`, which is a real
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
 * The date-only encoders in `src/lib/date-only.ts`. Each takes a value the
 * caller asserts is a CALENDAR DAY and returns its `yyyy-MM-dd` (or `yyyy-MM`)
 * form by reading the UTC clock face — correct exactly when the assertion holds.
 *
 * `formatDateOnlyForTimeZone`, `todayDateOnlyForTimeZone` and `getTodayDateOnly`
 * are deliberately absent: those ASK the club's calendar rather than assuming
 * the value already is one, so they are the fix this guard points at, never the
 * thing it flags.
 */
const CANONICAL_ENCODERS = new Set([
  "formatDateOnly",
  "formatMonthOnly",
  "dateOnlyFromIsoString",
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
 * AN ENTRY IS A LINE PLUS THE DEFECT IT BLESSES, never a bare line. The line
 * alone was enough to make this list lie: changing a site from
 * `formatDateOnly(new Date())` to `formatDateOnly(params.cancelledAt)` is a
 * different defect of a different KIND, and the suite stayed green because the
 * entry blessed whatever happened to sit on line N. The recorded `kind` (and,
 * for an instant read, the `field`) is asserted against what the scanner
 * actually classified, so a site that changes what it does stops being covered.
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
  /** What the scanner must still classify this site as. */
  kind: "clock" | "instant";
  /** For an instant read, the field name that must still be the one read. */
  field?: string;
  why: string;
};

const KNOWN_INSTANT_ENCODING_DEFECTS: Record<string, ReviewedEncoding> = {
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
  // instant has no line left to anchor to, so "moved" and "fixed" cannot be
  // confused.
  //
  // The list is empty, which is what #2684 decision 2 asks for — but do not read
  // that as the class being closed. A review of #2839 found the member-merge
  // comparison screen renders instants through a generic runtime-type formatter
  // (#2860, PR #2862). It is absent here only because this census keys on the
  // canonical encoders, and that renderer reaches the pattern by its own route.
  // When #2862 lands, the class is closed; until then the empty list means
  // "nothing this census can see", not "nothing left".
};

/**
 * Instant-typed field names read back as a calendar day where the VALUE at that
 * site is known to be date-only, even though the column is mixed.
 */
const REVIEWED_INSTANT_READS: Record<string, ReviewedEncoding> = {
  "src/app/api/admin/members/import/route.ts:654": {
    kind: "instant",
    field: "cancelledAt",
    why: "Member.cancelledAt is mixed — the admin cancellation flow writes `now`, but the CSV import writes a parsed date-only value, and this audit-metadata line reads back the value the import itself just parsed",
  },
};

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

/**
 * The property name a value was read from, looking through the wrappers that do
 * not change WHICH field is being read: non-null assertions, parentheses, casts,
 * a `new Date(...)` reparse, an ISO SERIALISATION, and the `??` / `||` fallbacks
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

type Encoding = {
  site: string;
  kind: "clock" | "instant";
  field?: string;
  snippet: string;
};

/**
 * Resolve a module specifier to the file it names, so a wrapper imported from
 * another module can be followed. `@/x` is the `src/` alias; `./x` and `../x`
 * are relative. Anything else (a package) is not ours and returns null.
 */
function resolveModule(fromRel: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = path.posix.join("src", specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.posix.join(path.posix.dirname(fromRel), specifier);
  } else {
    return null;
  }
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (fs.existsSync(path.join(ROOT, candidate))) return candidate;
  }
  return null;
}

/** Named imports in `sf`, as `localName -> { module, importedName }`. */
function namedImports(
  sf: ts.SourceFile,
  rel: string,
): Map<string, { module: string; imported: string }> {
  const out = new Map<string, { module: string; imported: string }>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const bindings = st.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const target = resolveModule(rel, st.moduleSpecifier.text);
    if (!target) continue;
    for (const element of bindings.elements) {
      out.set(element.name.text, {
        module: target,
        imported: (element.propertyName ?? element.name).text,
      });
    }
  }
  return out;
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
): { encodings: Encoding[]; exportedAliases: string[] } {
  const encodings: Encoding[] = [];
  const exportedAliases: string[] = [];

  const files = sources.map(({ rel, text }) => ({
    rel,
    text,
    sf: parse(rel, text),
  }));

  // Pass 1 — which functions in each file hand a caller's own value to an
  // encoder. Collected for EVERY file, including the helper module, so pass 2
  // can follow one across a module boundary.
  const resolvableByFile = new Map<string, Set<string>>();
  for (const { rel, sf } of files) {
    const aliases = localEncoderAliases(sf);
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
    const encoders = new Set([
      ...CANONICAL_ENCODERS,
      ...(resolvableByFile.get(rel) ?? []),
    ]);
    for (const [local, source] of namedImports(sf, rel)) {
      if (resolvableByFile.get(source.module)?.has(source.imported)) encoders.add(local);
    }

    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        encoders.has(node.expression.text) &&
        node.arguments.length > 0
      ) {
        const arg = node.arguments[0];
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const site = `${rel}:${line}`;
        const snippet = (lines[line - 1] ?? "").trim().slice(0, 120);

        if (readsClock(arg)) {
          encodings.push({ site, kind: "clock", snippet });
        } else {
          for (const field of readFieldNames(arg)) {
            if (INSTANT_FIELDS.has(field)) {
              encodings.push({ site, kind: "instant", field, snippet });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }

  return { encodings, exportedAliases };
}

const { encodings: ENCODINGS, exportedAliases: EXPORTED_ALIASES } = scanEncodings();

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

  it("routes every clock read through the club's calendar, or records why not", () => {
    const unlisted = ENCODINGS.filter((e) => e.kind === "clock")
      .filter((e) => !(e.site in KNOWN_INSTANT_ENCODING_DEFECTS))
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
          !(e.site in KNOWN_INSTANT_ENCODING_DEFECTS) &&
          !(e.site in REVIEWED_INSTANT_READS) &&
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
    const live = new Set(ENCODINGS.map((e) => e.site));
    const stale = [
      ...Object.keys(KNOWN_INSTANT_ENCODING_DEFECTS),
      ...Object.keys(REVIEWED_INSTANT_READS),
    ].filter((site) => !live.has(site));

    expect(
      stale,
      "These sites are listed as reviewed or as known defects but no longer " +
        "exist (or have moved line). If the defect is FIXED, delete the entry — " +
        "that is the list doing its job. If the code merely moved, re-anchor it.",
    ).toEqual([]);

    // AND THAT IT IS STILL THE SAME DEFECT ON THAT LINE. Anchoring on the line
    // alone blessed whatever the line happened to say: swapping
    // `formatDateOnly(new Date())` for `formatDateOnly(params.cancelledAt)` is a
    // clock read replaced by an instant read — a different defect, of a
    // different kind, on a different value — and the suite passed. The entry
    // records what it is excusing, and that is what is checked.
    const drifted: string[] = [];
    for (const [site, reviewed] of [
      ...Object.entries(KNOWN_INSTANT_ENCODING_DEFECTS),
      ...Object.entries(REVIEWED_INSTANT_READS),
    ]) {
      const found = ENCODINGS.filter((e) => e.site === site);
      const matches = found.filter(
        (e) =>
          e.kind === reviewed.kind &&
          (reviewed.field === undefined || e.field === reviewed.field),
      );
      if (matches.length === 0) {
        drifted.push(
          `${site}: listed as ${reviewed.kind}` +
            `${reviewed.field ? ` on .${reviewed.field}` : ""}, but the tree now has ` +
            (found.length === 0
              ? "no classified encoding there"
              : found
                  .map((e) => `${e.kind}${e.field ? ` on .${e.field}` : ""}`)
                  .join(" / ")),
        );
      }
    }

    expect(
      drifted,
      "INV-DATE-019: A reviewed entry no longer describes what its line does. " +
        "The excuse was written for one defect and is now covering another — " +
        "which is exactly how a blanket line-number opt-out stops being a " +
        "record and becomes a hole. Re-read the site, and either update the " +
        "entry's `kind`/`field` deliberately or delete it.",
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

  it("lets no module hide an encoder behind an exported alias", () => {
    // `xero-invoice-helpers` exported `formatDate`, a one-line delegation to the
    // canonical encoder. Eleven modules imported it, and the thirty-three Xero
    // document dates behind it were invisible to #2682's spelling census —
    // sixteen of them encoding the raw clock straight into the club's accounts.
    // A rename is all it takes to put a class of defects back out of reach, so
    // the rename is what is banned.
    expect(
      EXPORTED_ALIASES,
      "INV-DATE-019: A module exports a bare delegation to a date-only encoder. " +
        "Callers should import the canonical helper from @/lib/date-only by its " +
        "own name, so this guard — and the next person auditing dates — can see " +
        "what is being encoded. A wrapper that adds MEANING (reading a specific " +
        "field, choosing between the date-only and club-timezone helpers) is " +
        "fine and is not what this catches.",
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

  it("keeps all three toLocale* arms on nzst-date.ts (CT-2, #2990)", async () => {
    /*
      `src/lib/nzst-date.ts` held the six frozen `Intl.DateTimeFormat` constants
      the club's rendering seam was built from, and was listed in the narrowed
      block that drops the `toLocale*` arms. CT-2 made every one of those
      functions a one-line delegation to `@/lib/club-time`, so it formats nothing
      and needs no exemption — and it was taken off that list.

      NOTHING ASSERTED THAT REMOVAL. The roster audit above requires only the
      encoding and zoned-formatter arms, so putting the file back on the exempt
      list would restore a hand-rolled `toLocaleDateString` to the seam with the
      whole suite green. This is the pin: the rendering arms must resolve HERE,
      like any other library module, until CT-6 (#2991) deletes the file.
    */
    const resolved = await resolveRestrictedSyntax(
      eslint,
      ROOT,
      "src/lib/nzst-date.ts",
    );
    expect(resolved.severity).toBe(2);
    const missing = DATE_GUARD_ARMS.rendering.filter(
      (selector) => !resolved.selectors.includes(selector),
    );
    expect(
      missing,
      "INV-DATE-015: `src/lib/nzst-date.ts` has been put back on a block that drops the " +
        "toLocale* rendering arms. It delegates to @/lib/club-time and formats nothing, so " +
        "it needs no exemption; an exemption here is how a hand-rolled toLocale* gets back " +
        "into the club's rendering seam without lint noticing.",
    ).toEqual([]);
  });

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
