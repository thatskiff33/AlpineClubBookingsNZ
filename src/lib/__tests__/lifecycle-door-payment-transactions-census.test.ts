/**
 * EVERY EDIT DOOR THAT ASKS "IS THIS WHOLE-LODGE BOOKING STILL UNPAID?" LOADS
 * THE ROWS THE ANSWER NEEDS, AND POSTS WHAT A $0 SETTLE CONFIRMS (#4019 review,
 * `INV-PAY-143`).
 *
 * `isUnpaidConfirmedWholeLodge` (`booking-payment-flow.ts`) tells an abandoned
 * card attempt from a capture by the payment's `PaymentTransaction` rows, and
 * fails closed without them: a door that loaded `payment: true` alone would
 * read an abandoned attempt as paid and stop clamping or settling it. Its input
 * type requires `transactions`, and `applyLifecycleTransitions` takes
 * `LoadedBookingForLifecycle`, which carries them, so a TYPED caller that drops
 * them no longer compiles. But every door reaches those types through an
 * `as unknown as` cast of its own Prisma payload, which no compiler checks.
 * So this reads each door's source and requires, in the SAME function as each
 * reader call (the door's transaction body, not anywhere in the file):
 *
 * - a `payment: { include: { transactions: { orderBy: [...LEDGER_ROWS_OLDEST_FIRST] } } }`
 *   load (the order `INV-PAY-133` gives the ledger);
 * - a `postStoredBookingConfirmationLedgerLines(...)` call that runs only when
 *   the unpaid whole-lodge answer is true: a whole-lodge booking reaching PAID
 *   at $0 through an edit bypasses the ordinary settle, which is what posts its
 *   confirmation lines. Exactly two shapes count as that guard (`GUARD_SHAPES`):
 *   1. the THEN branch of `if (<guard>) { ... post ... }`;
 *   2. a statement after a guard clause `if (!(<guard>)) return;` (or `throw`)
 *      in the same block.
 *   `<guard>` reads the answer (`isUnpaidConfirmedWholeLodge(...)`, or the
 *   local the date door stores it in) through nothing but `&&` and parentheses:
 *   under a `!`, a `||` or a `?:` it no longer proves the answer was true. The
 *   walk from the post to its guard stops at any function boundary, so a
 *   closure defined under the guard (and perhaps never called) does not count.
 *
 * The door set is pinned EXACTLY: a new caller of either function fails here
 * until it is added, which is the moment to give it both.
 *
 * The guest-acceptance re-price door (`booking-guest-acceptance-reprice.ts`)
 * is UNREACHABLE today for an officer-priced whole-lodge booking: that booking
 * came from a booking request, and `isQuotePricedBooking` returns
 * `QUOTE_PRICED` before the lifecycle runs. It is pinned anyway, because the
 * exclusive-hold route can put `wholeLodgeHold` on a CONFIRMED booking that
 * came from no request, and because the next door to call the lifecycle should
 * not have to rediscover the rule.
 *
 * `pnpm run test:related` cannot select this file (it imports none of the
 * doors); run it by name with `pnpm run test:named`.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  relativeSource,
  sourceFiles,
} from "@/lib/__tests__/support/booking-guest-night-writer-scan";

/** The callees whose answer depends on the payment's transaction rows. */
const UNPAID_READERS = new Set(["applyLifecycleTransitions", "isUnpaidConfirmedWholeLodge"]);
/** Where the two are defined or re-exported, not called on a door's load. */
const DEFINERS = new Set([
  "src/lib/booking-payment-flow.ts",
  "src/lib/booking-modify-settlement.ts",
  "src/lib/booking-modify.ts",
]);
const EXPECTED_DOORS = [
  "src/lib/booking-batch-modification-service.ts",
  "src/lib/booking-date-modification-service.ts",
  "src/lib/booking-guest-acceptance-reprice.ts",
  "src/lib/booking-guest-removal-service.ts",
];
const TRANSACTIONS_LOAD = "payment:{include:{transactions:{orderBy:[...LEDGER_ROWS_OLDEST_FIRST]}}}";
const CONFIRMATION_POSTER = "postStoredBookingConfirmationLedgerLines";
/** The unpaid whole-lodge answer, called or stored in a local. */
const UNPAID_GUARD = /unpaidConfirmedWholeLodge/i;
/** The two guard shapes this census accepts, for its failure message. */
const GUARD_SHAPES =
  "inside `if (<guard>) { ... }`, or after `if (!(<guard>)) return;` (or `throw`) in the same block, " +
  "where <guard> reads isUnpaidConfirmedWholeLodge(...) through nothing but `&&` and parentheses";

type DoorScan = { readers: string[]; loadsTransactions: boolean; postsConfirmation: boolean };

/** The innermost function around `node`: the door's own scope. */
function enclosingFunction(node: ts.Node): ts.Node {
  for (let at = node.parent; at; at = at.parent) {
    if (ts.isFunctionLike(at)) return at;
  }
  return node.getSourceFile();
}

/** Does `expr` being true prove the unpaid whole-lodge answer true? Only `&&` and parentheses may sit between. */
function provesUnpaid(expr: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expr)) return provesUnpaid(expr.expression);
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return provesUnpaid(expr.left) || provesUnpaid(expr.right);
  }
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) return expr.expression.text === "isUnpaidConfirmedWholeLodge";
  return ts.isIdentifier(expr) && UNPAID_GUARD.test(expr.text);
}

/** `if (!(<guard>)) return;` (or `throw`), with no else: what follows it in the block runs only when the guard holds. */
function isGuardClause(statement: ts.Statement): boolean {
  if (!ts.isIfStatement(statement) || statement.elseStatement) return false;
  const condition = statement.expression;
  if (!ts.isPrefixUnaryExpression(condition) || condition.operator !== ts.SyntaxKind.ExclamationToken) return false;
  const exits = (s: ts.Statement): boolean =>
    ts.isReturnStatement(s) || ts.isThrowStatement(s) ||
    (ts.isBlock(s) && s.statements.length === 1 && exits(s.statements[0]!));
  return provesUnpaid(condition.operand) && exits(statement.thenStatement);
}

/** Does `node` run only once the unpaid whole-lodge answer is true, within `scope` (`GUARD_SHAPES`)? */
function guardedByUnpaidWholeLodge(node: ts.Node, scope: ts.Node): boolean {
  for (let child = node, at = node.parent; at && at !== scope; child = at, at = at.parent) {
    // A closure defined under the guard runs whenever it is called, if ever.
    if (ts.isFunctionLike(at)) return false;
    if (ts.isIfStatement(at) && at.thenStatement === child && provesUnpaid(at.expression)) return true;
    if (ts.isBlock(at) || ts.isSourceFile(at)) {
      const index = at.statements.indexOf(child as ts.Statement);
      if (at.statements.slice(0, Math.max(index, 0)).some(isGuardClause)) return true;
    }
  }
  return false;
}

/**
 * Scoped to the function that asks: the load and the guarded post must sit in
 * the SAME function as the reader call (the door's transaction body), and the
 * post must run only under an `if` that reads the unpaid whole-lodge answer
 * (`isUnpaidConfirmedWholeLodge(...)`, or the local the date door stores it in).
 * A load in another function, or a poster call outside the guard, does not count.
 */
function scanDoor(file: string, code: string): DoorScan {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const readers = new Set<string>();
  const scopes = new Set<ts.Node>();
  const findReaders = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && UNPAID_READERS.has(node.expression.text)) {
      readers.add(node.expression.text);
      scopes.add(enclosingFunction(node));
    }
    ts.forEachChild(node, findReaders);
  };
  findReaders(source);
  const scopeHas = (scope: ts.Node, test: (node: ts.Node) => boolean): boolean => {
    let found = false;
    const visit = (node: ts.Node) => {
      if (found) return;
      if (test(node)) found = true;
      else ts.forEachChild(node, visit);
    };
    ts.forEachChild(scope, visit);
    return found;
  };
  const isTransactionsLoad = (node: ts.Node) =>
    ts.isPropertyAssignment(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === "payment" &&
    node.getText(source).replace(/\s+/g, "") === TRANSACTIONS_LOAD;
  const all = [...scopes];
  return {
    readers: [...readers].sort(),
    loadsTransactions: all.length > 0 && all.every((scope) => scopeHas(scope, isTransactionsLoad)),
    postsConfirmation: all.length > 0 && all.every((scope) => scopeHas(scope, (node) =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === CONFIRMATION_POSTER &&
      guardedByUnpaidWholeLodge(node, scope))),
  };
}

function scanTree(): Map<string, DoorScan> {
  const doors = new Map<string, DoorScan>();
  for (const file of sourceFiles()) {
    const relative = relativeSource(file);
    if (DEFINERS.has(relative)) continue;
    const code = readFileSync(file, "utf8");
    if (![...UNPAID_READERS].some((name) => code.includes(`${name}(`))) continue;
    const scan = scanDoor(relative, code);
    if (scan.readers.length > 0) doors.set(relative, scan);
  }
  return doors;
}

describe("INV-PAY-143: whole-lodge unpaid readers load transactions and post confirmation lines", () => {
  const doors = scanTree();

  it("pins the exact set of edit doors that call the unpaid readers", () => {
    expect(
      [...doors.keys()].sort(),
      "INV-PAY-143: a new caller of applyLifecycleTransitions / isUnpaidConfirmedWholeLodge must load the payment's transactions and post confirmation lines; add it here once it does",
    ).toEqual(EXPECTED_DOORS);
  });

  it.each(EXPECTED_DOORS)("%s loads the payment with its ordered transactions", (door) => {
    expect(
      doors.get(door)?.loadsTransactions,
      `INV-PAY-143: ${door} must load \`payment: { include: { transactions: { orderBy: [...LEDGER_ROWS_OLDEST_FIRST] } } }\` - without the rows isUnpaidConfirmedWholeLodge reads an abandoned card attempt as paid`,
    ).toBe(true);
  });

  it.each(EXPECTED_DOORS)("%s posts confirmation lines after a whole-lodge settle at zero dollars", (door) => {
    expect(
      doors.get(door)?.postsConfirmation,
      `INV-PAY-143: ${door} must call ${CONFIRMATION_POSTER} when a whole-lodge edit settles at $0, guarded ${GUARD_SHAPES}`,
    ).toBe(true);
  });

  it("recognises a door that dropped either half (the scanner has teeth)", () => {
    const dropped = scanDoor(
      "fixture.ts",
      "async function door(tx) {\n" +
        "  const b = await tx.booking.findUnique({ include: { payment: true } });\n" +
        "  await applyLifecycleTransitions(tx, { booking: b });\n" +
        "}\n",
    );
    expect(dropped).toEqual({ readers: ["applyLifecycleTransitions"], loadsTransactions: false, postsConfirmation: false });
    const wired = scanDoor(
      "fixture.ts",
      "async function door(tx) {\n" +
        "  const b = await tx.booking.findUnique({ include: { payment: { include: { transactions: { orderBy: [...LEDGER_ROWS_OLDEST_FIRST] } } } } });\n" +
        "  const lifecycle = await applyLifecycleTransitions(tx, { booking: b });\n" +
        "  if (lifecycle.zeroDollarAutoPaid && isUnpaidConfirmedWholeLodge(b)) await postStoredBookingConfirmationLedgerLines(tx, b.id);\n" +
        "}\n",
    );
    expect(wired).toEqual({ readers: ["applyLifecycleTransitions", "isUnpaidConfirmedWholeLodge"], loadsTransactions: true, postsConfirmation: true });
  });

  it("refuses a poster call outside the unpaid guard, and a load in another function", () => {
    const unguarded = scanDoor(
      "fixture.ts",
      "async function door(tx) {\n" +
        "  const b = await tx.booking.findUnique({ include: { payment: { include: { transactions: { orderBy: [...LEDGER_ROWS_OLDEST_FIRST] } } } } });\n" +
        "  const lifecycle = await applyLifecycleTransitions(tx, { booking: b });\n" +
        "  if (isUnpaidConfirmedWholeLodge(b)) { log(); } else { await postStoredBookingConfirmationLedgerLines(tx, b.id); }\n" +
        "  await postStoredBookingConfirmationLedgerLines(tx, b.id);\n" +
        "}\n",
    );
    expect(unguarded.postsConfirmation, "an unguarded or else-branch post is not the door's post").toBe(false);
    const elsewhere = scanDoor(
      "fixture.ts",
      "const load = (tx) => tx.booking.findUnique({ include: { payment: { include: { transactions: { orderBy: [...LEDGER_ROWS_OLDEST_FIRST] } } } } });\n" +
        "async function door(tx, b) {\n" +
        "  const lifecycle = await applyLifecycleTransitions(tx, { booking: b });\n" +
        "  if (lifecycle.zeroDollarAutoPaid && isUnpaidConfirmedWholeLodge(b)) await postStoredBookingConfirmationLedgerLines(tx, b.id);\n" +
        "}\n",
    );
    expect(elsewhere).toMatchObject({ loadsTransactions: false, postsConfirmation: true });
  });

  /** A door whose lifecycle call is followed by `body`, for the guard-shape fixtures. */
  const doorWith = (body: string) =>
    scanDoor(
      "fixture.ts",
      "async function door(tx) {\n" +
        "  const b = await tx.booking.findUnique({ include: { payment: { include: { transactions: { orderBy: [...LEDGER_ROWS_OLDEST_FIRST] } } } } });\n" +
        "  const lifecycle = await applyLifecycleTransitions(tx, { booking: b });\n" +
        body +
        "\n}\n",
    ).postsConfirmation;
  const POST = "await postStoredBookingConfirmationLedgerLines(tx, b.id);";

  it.each([
    ["a negated guard", `  if (!(lifecycle.zeroDollarAutoPaid && isUnpaidConfirmedWholeLodge(b))) { ${POST} }`],
    ["a guard under ||", `  if (lifecycle.zeroDollarAutoPaid || !isUnpaidConfirmedWholeLodge(b)) ${POST}`],
    ["a guard under ?:", `  if (lifecycle.zeroDollarAutoPaid ? isUnpaidConfirmedWholeLodge(b) : true) ${POST}`],
    ["a closure defined under the guard", `  if (lifecycle.zeroDollarAutoPaid && isUnpaidConfirmedWholeLodge(b)) { const later = async () => { ${POST} }; }`],
    ["a guard clause that does not exit", `  if (!(lifecycle.zeroDollarAutoPaid && isUnpaidConfirmedWholeLodge(b))) { log(); }\n  ${POST}`],
  ])("refuses %s", (_label, body) => {
    expect(doorWith(body)).toBe(false);
  });

  it.each([
    ["the then-branch of a stored answer", `  const unpaidConfirmedWholeLodge = isUnpaidConfirmedWholeLodge(b);\n  if (zeroDollarAutoPaid && unpaidConfirmedWholeLodge) { ${POST} }`],
    ["a guard clause that returns", `  if (!(lifecycle.zeroDollarAutoPaid && isUnpaidConfirmedWholeLodge(b))) return;\n  ${POST}`],
    ["a guard clause that throws", `  if (!(lifecycle.zeroDollarAutoPaid && isUnpaidConfirmedWholeLodge(b))) { throw new Error("x"); }\n  ${POST}`],
  ])("accepts %s", (_label, body) => {
    expect(doorWith(body)).toBe(true);
  });
});
