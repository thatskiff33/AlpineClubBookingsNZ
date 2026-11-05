/**
 * EVERY `MemberCredit` READ ORDERED BY `createdAt`, CLASSIFIED (#4013,
 * `INV-PAY-127`).
 *
 * `INV-PAY-127` says a member's credit lots are used in ONE order, oldest first
 * with the lower `id` first between two lots stamped with the same instant, and
 * that the order has one home: `CREDIT_LOT_USE_ORDER` in
 * `xero-applied-credit-plan.ts`. `createdAt` alone is not an order — two lots
 * written in one transaction, or under the frozen test clock, tie, and
 * PostgreSQL returns tied rows in whatever order its plan meets them. That is
 * how #4013's H1 case used a noteless lot first on one run and a noted one on
 * the next.
 *
 * So this reads every non-test source file and:
 *
 * - finds each Prisma read of `memberCredit` that names an `orderBy`. A read
 *   whose order is `CREDIT_LOT_USE_ORDER` must be a declared lot-use reader;
 *   any other order that mentions `createdAt` must be declared as NOT a use
 *   order, with the reason;
 * - finds every call of the planner, `planAppliedCreditAllocation`, and
 *   requires it to be the engine's one call, fed by `gatherAppliedCreditLots` —
 *   so a lot read with NO `orderBy` cannot reach the planner unseen;
 * - finds raw SQL that orders `MemberCredit` by `createdAt` without `"id"`.
 *
 * `pnpm run test:related` CANNOT SELECT THIS FILE: it has no import edge to the
 * tree it scans. Run it by name with `pnpm run test:named`.
 *
 * ## What it cannot see
 *
 * - A read through an aliased delegate (`const credits = tx.memberCredit;
 *   credits.findMany(...)`).
 * - A nested relation read that orders lots (`include: { credits: { orderBy:
 *   { createdAt: "asc" } } }` on a `Member` read): only `memberCredit.<read>`
 *   calls are walked.
 * - An `orderBy` imported from another module under a name other than
 *   `CREDIT_LOT_USE_ORDER`.
 *
 * None exists today. The walk REFUSES what it cannot read rather than passing
 * it: a query passed whole (`findMany(query)`), a spread in the query object, a
 * shorthand `orderBy`, and an `orderBy` identifier it cannot resolve in the same
 * file. Raw SQL is matched by text.
 *
 * **Re-measure by running this test. Add an entry only with its reason.**
 */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  relativeSource,
  sourceFiles,
} from "@/lib/__tests__/support/booking-guest-night-writer-scan";

const USE_ORDER = "CREDIT_LOT_USE_ORDER";
const ORDER_HOME = "src/lib/xero-applied-credit-plan.ts";
const READ_METHODS = new Set(["findMany", "findFirst", "findFirstOrThrow"]);
const PLANNER = "planAppliedCreditAllocation";
const LOT_LOADER = "gatherAppliedCreditLots";
/** The planner's one caller, by `file > function`. */
const PLANNER_CALLER = "src/lib/xero-applied-credit-allocation.ts > allocateAppliedCreditForBooking";

/** Reads that hand lots to the allocation planner, by `file > function`. */
const LOT_USE_READERS: Record<string, string> = {
  "src/lib/xero-applied-credit-allocation.ts > gatherAppliedCreditLots":
    "the allocation engine's lot loader: the planner takes lots in the order " +
    "given, so this order decides which note is allocated and what is minted.",
  "src/lib/xero-credit-note-spent-outside-flag.ts > memberCreditLots":
    "#4220: the early warning replays the engine's draw (`freeCreditLots`, " +
    "`plannedDrawFromLot`) to learn how much lands on a spent note's lot, so it " +
    "must read the lots in the engine's order; it plans and writes nothing.",
};

/** Reads that order credit rows by `createdAt` for something other than using them. */
const NOT_A_USE_ORDER: Record<string, string> = {
  "src/lib/member-credit.ts > getMemberCreditHistory":
    "the member's credit history, newest first, for display; nothing is " +
    "allocated or minted from it.",
  "src/lib/member-credit.ts > getAdminMemberCreditHistory":
    "the admin view of the same history, newest first, for display only.",
  "src/lib/credit-release-ask-sweep.ts > enqueueCreditReleaseAsks":
    "lists the released-credit rows waiting for a request, oldest first, to enqueue one durable row " +
    "each (keyed by the release's own id); no lot is used or allocated from it.",
  "src/lib/xero-account-credit-note-stamp.ts > stampCancellationCreditXeroNote":
    "#4685/#4705: picks which equal cancellation credit an account-credit note is recorded on, oldest " +
    "first, when nothing names its credit - a row queued before #4685, or an inbound note no outbox " +
    "row ties to a credit; it links a note, and no lot is used, allocated or minted from it.",
  "src/lib/edit-financial-review-account-credit.ts > creditSliceStillOwedAfterCancellation":
    "reads at most two cancellation-restore rows and refuses when there are " +
    "two, so which row comes first cannot change the answer.",
};

/**
 * Raw SQL allowed to order `MemberCredit` by `createdAt` without an `"id"`
 * tie-break, by repo-relative file, with why. Empty: none does today.
 */
const RAW_SQL_WITHOUT_TIE_BREAK: Record<string, string> = {};

type Site = { key: string; order: "use" | "createdAt" | "other" | "unreadable" };

function enclosingFunctionName(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name) {
      return current.name.getText();
    }
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && ts.isVariableDeclaration(current.parent)) {
      return current.parent.name.getText();
    }
  }
  return "<module>";
}

function enclosingFunctionNode(node: ts.Node): ts.Node | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) return current;
  }
  return undefined;
}

/** The text an `orderBy` initializer stands for, following a same-file `const`. */
function orderText(initializer: ts.Expression, source: ts.SourceFile): string | null {
  if (!ts.isIdentifier(initializer)) return initializer.getText(source);
  if (initializer.text === USE_ORDER) return USE_ORDER;
  let resolved: string | null = null;
  const find = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === initializer.text && node.initializer) {
      resolved = node.initializer.getText(source);
    }
    ts.forEachChild(node, find);
  };
  find(source);
  return resolved;
}

function classify(call: ts.CallExpression, source: ts.SourceFile): Site["order"] | null {
  const [arg] = call.arguments;
  if (!arg) return null;
  if (!ts.isObjectLiteralExpression(arg)) return "unreadable";
  // A spread could carry an `orderBy`, and `{ orderBy }` names a binding this
  // walk does not follow: neither is read as "no order".
  if (arg.properties.some((property) => ts.isSpreadAssignment(property))) return "unreadable";
  if (arg.properties.some((property) => ts.isShorthandPropertyAssignment(property) && property.name.text === "orderBy")) {
    return "unreadable";
  }
  const orderBy = arg.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && property.name.getText(source) === "orderBy",
  );
  if (!orderBy) return null;
  const text = orderText(orderBy.initializer, source);
  if (text === null) return "unreadable";
  if (text === USE_ORDER || /^\[\s*\.\.\.CREDIT_LOT_USE_ORDER\s*\]$/.test(text)) return "use";
  return /\bcreatedAt\b/.test(text) ? "createdAt" : "other";
}

type PlannerCall = { key: string; fedByLoader: boolean };

function scanTree(): { sites: Site[]; plannerCalls: PlannerCall[] } {
  const sites: Site[] = [];
  const plannerCalls: PlannerCall[] = [];
  for (const file of sourceFiles()) {
    const code = readFileSync(file, "utf8");
    const readsCredit = code.includes("memberCredit");
    const callsPlanner = code.includes(PLANNER);
    if (!readsCredit && !callsPlanner) continue;
    const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
    const walk = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (
          ts.isPropertyAccessExpression(callee) &&
          READ_METHODS.has(callee.name.text) &&
          ts.isPropertyAccessExpression(callee.expression) &&
          callee.expression.name.text === "memberCredit"
        ) {
          const order = classify(node, source);
          if (order) sites.push({ key: `${relativeSource(file)} > ${enclosingFunctionName(node)}`, order });
        }
        if (ts.isIdentifier(callee) && callee.text === PLANNER) {
          plannerCalls.push({ key: `${relativeSource(file)} > ${enclosingFunctionName(node)}`, fedByLoader: fedByLoader(node, source) });
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  return {
    sites: sites.sort((a, b) => a.key.localeCompare(b.key)),
    plannerCalls: plannerCalls.sort((a, b) => a.key.localeCompare(b.key)),
  };
}

/** Is the planner's first argument a `const` assigned from `await gatherAppliedCreditLots(...)`? */
function fedByLoader(call: ts.CallExpression, source: ts.SourceFile): boolean {
  const [lots] = call.arguments;
  const scope = enclosingFunctionNode(call);
  if (!lots || !ts.isIdentifier(lots) || !scope) return false;
  let fed = false;
  const find = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === lots.text && node.initializer) {
      const init = ts.isAwaitExpression(node.initializer) ? node.initializer.expression : node.initializer;
      fed = ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === LOT_LOADER;
    }
    ts.forEachChild(node, find);
  };
  find(scope);
  return fed;
}

/** Each raw-SQL `ORDER BY` over `MemberCredit` that names `createdAt` and no `"id"`. */
function rawSqlOrdersWithoutTieBreak(): string[] {
  const offenders = new Set<string>();
  const order = /"MemberCredit"[^`]{0,800}?ORDER\s+BY([^`;]*)/gi;
  for (const file of sourceFiles()) {
    const code = readFileSync(file, "utf8");
    if (!code.includes('"MemberCredit"')) continue;
    for (const match of code.matchAll(order)) {
      const clause = match[1] ?? "";
      if (/"createdAt"/.test(clause) && !/"id"/.test(clause)) offenders.add(relativeSource(file));
    }
  }
  return [...offenders].sort();
}

describe("every credit-lot read ordered by createdAt is classified (#4013, INV-PAY-127)", () => {
  const { sites, plannerCalls } = scanTree();

  it("reaches the engine, so an empty or truncated walk fails rather than passes", () => {
    expect(
      sites.map((site) => site.key),
      "INV-PAY-127: the walk did not reach the declared lot-use reader; it is not reading the tree.",
    ).toEqual(expect.arrayContaining(Object.keys(LOT_USE_READERS)));
  });

  it("finds exactly the declared lot-use readers using CREDIT_LOT_USE_ORDER", () => {
    expect(
      sites.filter((site) => site.order === "use").map((site) => site.key),
      "INV-PAY-127: a read ordered by CREDIT_LOT_USE_ORDER hands lots to the planner. " +
        "Declare it in LOT_USE_READERS - and a declared reader that lost the constant fails here too.",
    ).toEqual(Object.keys(LOT_USE_READERS).sort());
  });

  it("finds no other createdAt order on memberCredit than the declared non-use reads", () => {
    expect(
      sites.filter((site) => site.order === "createdAt").map((site) => site.key),
      "INV-PAY-127: a memberCredit read orders by createdAt without CREDIT_LOT_USE_ORDER. " +
        "If it chooses which lots are used, order it by CREDIT_LOT_USE_ORDER (ties fall to the lower id); " +
        "if it does not, declare it in NOT_A_USE_ORDER with the reason.",
    ).toEqual(Object.keys(NOT_A_USE_ORDER).sort());
  });

  it("refuses a read it cannot classify rather than passing it", () => {
    expect(
      sites.filter((site) => site.order === "unreadable").map((site) => site.key),
      "INV-PAY-127: this memberCredit read passes its query whole, spreads into it, or names an orderBy " +
        "the census cannot read. Write the query and its orderBy inline.",
    ).toEqual([]);
  });

  it("lets the planner see lots only from the loader, so an unordered read cannot reach it", () => {
    expect(
      plannerCalls,
      `INV-PAY-127: ${PLANNER} is called only by the engine, with ${LOT_LOADER}'s result - the one read ` +
        "ordered by CREDIT_LOT_USE_ORDER. A second caller, or lots from anywhere else, could arrive in any order.",
    ).toEqual([{ key: PLANNER_CALLER, fedByLoader: true }]);
  });

  it("keeps a reason against every entry", () => {
    for (const [key, reason] of Object.entries({ ...LOT_USE_READERS, ...NOT_A_USE_ORDER, ...RAW_SQL_WITHOUT_TIE_BREAK })) {
      expect(reason.length, `INV-PAY-127: ${key} needs a stated reason`).toBeGreaterThan(40);
    }
  });

  it("keeps the order in one home, with the id tie-break", () => {
    const home = readFileSync(sourceFiles().find((file) => relativeSource(file) === ORDER_HOME)!, "utf8");
    expect(home, `INV-PAY-127: CREDIT_LOT_USE_ORDER in ${ORDER_HOME} must be createdAt asc, then id asc.`).toMatch(
      /export const CREDIT_LOT_USE_ORDER = \[\s*\{ createdAt: "asc" \},\s*\{ id: "asc" \},\s*\]/,
    );
  });

  it("finds no raw SQL that orders MemberCredit by createdAt without an id tie-break", () => {
    expect(
      rawSqlOrdersWithoutTieBreak(),
      'INV-PAY-127: raw SQL orders MemberCredit by "createdAt" with no "id" tie-break. Add one, or declare ' +
        "the file in RAW_SQL_WITHOUT_TIE_BREAK with the reason the order cannot matter.",
    ).toEqual(Object.keys(RAW_SQL_WITHOUT_TIE_BREAK).sort());
  });
});
