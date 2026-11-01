/**
 * EVERY CAPTURE-LEDGER READ, CLASSIFIED BY ITS ORDER (#4132, `INV-PAY-133`).
 *
 * `INV-PAY-133` says a payment's `PaymentTransaction` rows have ONE order:
 * `createdAt`, then `insertionSeq` (the column an owned sequence fills in
 * insertion order), and that the order has one home, `LEDGER_ROWS_OLDEST_FIRST`
 * / `LEDGER_ROWS_NEWEST_FIRST` in `payment-ledger-order.ts`. `createdAt` alone
 * is not an order: rows written in one transaction tie, and PostgreSQL returns
 * tied rows in heap order, which an UPDATE of an indexed column (a row
 * becoming `SUCCEEDED`) quietly changes. A cuid `id` is not an insertion order
 * either (#4129's reverted tiebreak).
 *
 * So this reads every non-test source file and finds each ledger read: a
 * `paymentTransaction.findMany` / `findFirst` / `findFirstOrThrow`, and each
 * `transactions` relation read nested in a `Payment` query (`transactions:
 * true`, or `transactions: { select | include | where | orderBy | take }`;
 * a `_count` of them is not a read). Then:
 *
 * - an `orderBy` must be one of the two constants. Any other order - on
 *   `createdAt` alone, on `id`, on anything - fails, with no exemption list;
 * - a MULTI-ROW read with no `orderBy` (a `findMany`, or a relation read) must
 *   be declared in `UNORDERED_ROW_SETS` with the reason its consumer cannot
 *   depend on the row order. A new unordered read feeding a fold, a plan or a
 *   "first/last" pick fails here until someone orders it or says why not;
 * - an unordered `findFirst` must be a lookup of one row - a unique key
 *   (`id`, `stripePaymentIntentId`) with a string literal in its `where`, or
 *   a named, reasoned site in EXISTENCE_READS / UNIQUE_EXPRESSION_READS /
 *   UNPROVEN_FIRST_READS. Selecting `id` alone proves no existence-only use;
 * - an in-memory `.sort` over ledger rows whose comparator reads `createdAt`
 *   must also read the tiebreak (the shared comparators do);
 * - raw SQL that orders `PaymentTransaction` by `"createdAt"` must also name
 *   `"insertionSeq"`.
 *
 * `pnpm run test:related` CANNOT SELECT THIS FILE: it has no import edge to the
 * tree it scans. Run it by name with `pnpm run test:named`.
 *
 * ## What it cannot see
 *
 * - A read through an aliased delegate (`const rows = tx.paymentTransaction;
 *   rows.findMany(...)`).
 * - An in-memory sort whose receiver is not named for transactions, captures
 *   or the ledger (`rows.sort(...)` over ledger rows), or whose comparator is a
 *   named function that reads `createdAt` alone. The sorts over ledger rows
 *   that exist use `compareLedgerRowsOldestFirst` / `compareLedgerRowsNewestFirst`.
 * - A first-row pick in memory (`.find`, `[0]`) over an unordered read: the
 *   unordered reads themselves are declared, each with why order cannot matter.
 *
 * The walk REFUSES what it cannot read rather than passing it: a query passed
 * whole (`findMany(query)`), a spread in the query object, a shorthand
 * `orderBy`, and an `orderBy` it cannot read as one of the constants.
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

const ORDER_HOME = "src/lib/payment-ledger-order.ts";
const LEDGER_ORDERS = new Set(["LEDGER_ROWS_OLDEST_FIRST", "LEDGER_ROWS_NEWEST_FIRST"]);
const READ_METHODS = new Set(["findMany", "findFirst", "findFirstOrThrow"]);
const RELATION_READ_KEYS = new Set(["select", "include", "where", "orderBy", "take"]);

/**
 * Multi-row ledger reads with no `orderBy`, by `file > function` (a module-level
 * select is named by its `const`), with why the row order cannot change what
 * they decide.
 */
const UNORDERED_ROW_SETS: Record<string, string> = {
  "src/lib/additional-ask-reissue.ts > foldWaitingReissuedAsks":
    "hands the ADDITIONAL rows to isRecoveryReplaySettled, which asks only whether SOME row carries an " +
    "intent or was written after the recovery (`.some`), never which row comes first.",
  "src/lib/additional-ledger-gap.ts > netCollectedPaymentSelect":
    "the Net Collected select's ADDITIONAL rows are summed (`summarizeAdditionalLedgerGap`'s reduce over " +
    "captured rows); a sum does not depend on the order.",
  "src/lib/admin-payments-service.ts > listAdminPayments":
    "the payments board reads each row's updatedAt for the latest activity (a max) and sums for the " +
    "ledger gap; neither depends on the order.",
  "src/lib/booking-ledger-settlement-sync.ts > syncBookingLedgerSettlements":
    "the settlement sync posts one line per captured row and per refund, keyed by the row's id " +
    "(planSettlementLines); the set of lines, not their order, is what is posted.",
  "src/lib/booking-payment-cleanup.ts > queueSupersededAdditionalIntentCancellationRows":
    "queues a durable cancellation for EVERY superseded pending or declined ADDITIONAL intent; each is keyed by its " +
    "own intent, so the order only changes the order they are queued in.",
  "src/lib/booking-payment-cleanup.ts > queueSupersededPrimaryIntentCancellations":
    "queues a durable cancellation for EVERY superseded pending PRIMARY intent; each is keyed by its own " +
    "intent, so the order only changes the order they are queued in.",
  "src/lib/cancel-flattened-payment-backfill.ts > CANDIDATE_PAYMENT_SELECT":
    "reads only each row's status to ask whether ANY row was captured (`.some`).",
  "src/lib/cron-confirm-pending.ts > cancelSupersededLinkIntentsBestEffort":
    "cancels EVERY other in-flight link intent, best effort, each by its own intent id; the order only " +
    "changes the order the cancellations are sent in.",
  "src/lib/internet-banking-payment-cron.ts > releaseOneHold":
    "reads only each row's status for paymentHasCaptureEvidence, which asks whether ANY row was captured.",
  "src/lib/internet-banking-settlement-evidence.ts > INTERNET_BANKING_SETTLEMENT_EVIDENCE_SELECT":
    "internetBankingSettlementEvidence asks whether ANY captured INTERNET_BANKING PRIMARY row is on the " +
    "current invoice (`.some`). The census store spreads only its inner select under its own ordered read.",
  "src/lib/late-capture-refund-approval.ts > assertLateCaptureHandBackStillOwed":
    "finds the ONE row whose intent the task's reason names; stripePaymentIntentId is unique, so at most " +
    "one row can match.",
  "src/lib/ordinary-ask-mint.ts > findIntentMintedForOrdinaryAsk":
    "reads only which candidate intents are already recorded (a Set of intent ids).",
  "src/lib/orphaned-applied-credit-backfill.ts > CANDIDATE_BOOKING_SELECT":
    "reads only each row's status to ask whether ANY row was captured (`.some`).",
  "src/lib/refund-allocation-unwind.ts > unwindableHandBackCents":
    "#4162: sums each row's refunded total less its card refunds; a sum does not depend on the order " +
    "(the unwind itself orders its rows, oldest first).",
  "src/lib/manual-settlement-intent-hygiene.ts > enqueueManualSettlementIntentCancellations":
    "cancels EVERY live Stripe intent on the payment except the one named to spare (an intent id, unique); " +
    "the order only changes the order the cancellations are queued in, and the adopted ones it records are a set (#4320).",
  "src/lib/manual-settlement-intent-hygiene.ts > withdrawManualSettlementIntentCancellations":
    "#4320: reads the payable intents' ids only as a set for the recovery-row read's `in` filter; the rows it " +
    "deletes are read ordered (createdAt) from the recovery table.",
  "src/lib/xero-applied-credit-ledger-state.ts > appliedCreditSettledByCancel":
    "reads only each row's status for paymentHasCaptureEvidence, which asks whether ANY row was captured.",
  "src/lib/xero-inbound/modification-note-refunds.ts > paymentsCountingInvoiceCorrections":
    "receiptCountsInvoiceCorrections asks whether every captured IB receipt carries a stored-figure " +
    "reason (`.every` / `.filter`), not which comes first.",
  "src/lib/xero-inbound/modification-note-refunds.ts > uncapturedPrimaryStatus":
    "asks whether ANY row was captured, then latestTransactionOfKind, which compares createdAt and " +
    "insertionSeq itself and so returns the same row in any input order.",
  "src/lib/xero-inbound/settle-from-cash.ts > decideInternetBankingReceiptFigure":
    "planInternetBankingCashSettlement filters and sums the rows (the IB primary rows, the ledger's " +
    "refunded total, the captured non-IB cash); no figure depends on the order.",
};

/**
 * Unordered `findFirst` reads the walk cannot prove return at most one row (no
 * literal unique key in the `where`), by `file > function > result binding`,
 * with why the row it happens to meet cannot matter.
 */
const UNPROVEN_FIRST_READS: Record<string, string> = {
  "src/lib/saved-card-charge-settle.ts > adoptSavedCardChargeAttemptForIntent > row":
    "looks the attempt row up by `reference`, the saved-card idempotency key, which embeds the row's own id, " +
    "or (#4646) by `id` from the intent's metadata, and re-checks the row's key against its own id and this " +
    "booking (savedCardChargeKeyShape), so only that one row can be adopted.",
};

/**
 * Reviewed id-only reads: the named result is consumed only as existence evidence.
 * A binding distinguishes calls in one function (including Promise.all tuples).
 * These declarations document consumer review, not an automatic data-flow proof.
 */
const EXISTENCE_READS: Record<string, string> = {
  "src/lib/organiser-extra-receipt.ts > syncOrganiserExtraInvoiceCash > primary":
    "#4299: tests !primary to write the combined share's row once, before any extra-invoice cash; no row id is consumed.",
  "src/lib/booking-cancel.ts > paymentEligibleForPaidCancelPath > capturedTransaction":
    "returns Boolean(capturedTransaction) to choose the paid cancellation path; no row id is consumed.",
  "src/lib/booking-cancel.ts > paymentHasCaptureEvidence > capturedTransaction":
    "passes Boolean(capturedTransaction) to paymentShowsCaptureEvidence; no row id is consumed.",
  "src/lib/manual-booking-payment-state.ts > getBookingManualPaymentState > [stampedTransaction, activeLink, mintOperation]":
    "uses stampedTransaction only in Boolean(stampedTransaction || activeLink || mintOperation) for the Xero block.",
  "src/lib/manual-booking-payment-state.ts > getBookingManualPaymentState > [openTask, settledStripe]":
    "tests settledStripe in an else-if to set reverseBlockedReason; no row id is consumed.",
  "src/lib/payment-reconciliation.ts > assertNoXeroInvoiceEvidence > stampedTransaction":
    "tests stampedTransaction to throw the Xero invoice refusal; no row id is consumed.",
  "src/lib/payment-reconciliation.ts > reverseManualBookingPayment > settledStripeTransaction":
    "tests settledStripeTransaction to refuse reversing after a card capture; no row id is consumed.",
  "src/lib/xero-booking-edit-settlement.ts > readInternetBankingReceiptCaptured > captured":
    "returns captured !== null as the receipt-captured boolean; no row id is consumed.",
  "src/lib/xero-inbound/invoice-paid-effects.ts > syncInternetBankingPaymentsForPaidInvoice > existingPrimary":
    "tests !existingPrimary before creating a primary receipt only when none exists; no row id is consumed.",
  "src/lib/xero-inbound/settlement-conflicts.ts > findSecondInstrumentSettlement > bankCashRecorded":
    "tests bankCashRecorded before loading the conflict marker; the selected ledger id is never consumed.",
  "src/lib/xero-operation-retry.ts > retryXeroSyncOperation > recordPayment":
    "wraps this read directly in Boolean to decide recordPayment for the supplementary invoice.",
};

/**
 * Unique-key expressions cannot be proven non-null by this syntax walk. Each
 * declaration records the reviewed guarantee; a new variable/property source
 * fails closed even if its TypeScript spelling looks like a string id.
 */
const UNIQUE_EXPRESSION_READS: Record<string, string> = {
  "src/lib/credit-release-ask-close.ts > closeCreditReleaseAsksPaidInXero > ask":
    "stripePaymentIntentId uses payment.additionalPaymentIntentId after the !additionalPaymentIntentId branch continues, excluding null (#4253).",
  "src/lib/booking-payment-cleanup.ts > failOutstandingAdditionalAskInClaim > additionalTransaction":
    "stripePaymentIntentId uses paymentIntentId after the !paymentIntentId branch returns, excluding null (#4316: moved from the cancel's claim).",
  "src/lib/card-refund-paid-another-way-xero.ts > paidAnotherWayXeroRoute > capture":
    "stripePaymentIntentId uses lateCaptureIntent after the lateCaptureIntent === null branch returns.",
  "src/lib/duplicate-capture-guard.ts > judgeCaptureOnPaidBooking > recordedSettler":
    "id uses input.recordedSettlerId inside its own truthiness ternary, so the read runs only on a non-null primary key (#4211).",
  "src/lib/late-capture-refund-credit-note.ts > creditBackLateCaptureRefunds > capture":
    "stripePaymentIntentId uses the function's required paymentIntentId: string parameter, never a nullable value.",
  "src/lib/late-capture-repair-refund-record.ts > recordAndNoteRepairedLateCaptureRefunds > transaction":
    "stripePaymentIntentId uses a key from refundedByIntent, a Map<string, number> populated only with truthy intent ids.",
  "src/lib/xero-kept-late-capture-invoice.ts > createXeroKeptLateCaptureInvoice > capture":
    "stripePaymentIntentId uses paymentIntentId from the validated kept-capture queued payload, whose intent id is a required string.",
  "src/lib/xero-supplementary-invoice-late-capture.ts > releaseXeroSupplementaryInvoiceForCapturedPaymentIntent > captured":
    "stripePaymentIntentId uses the function's required paymentIntentId: string parameter, never a nullable value.",
  "src/lib/xero-waiting-invoice-reaper.ts > decideWaitingOperation > transaction":
    "stripePaymentIntentId uses params.paymentIntentId, a required string in this function's parameter type.",
};

/**
 * In-memory sorts of ledger rows (a receiver named for transactions, captures
 * or the ledger) whose comparator reads `createdAt` without the tiebreak, by
 * `file > function`, with why a tie cannot matter. A newest-first slicer that
 * sorts on `createdAt` alone takes a tie in the order it was read (#4132 money
 * review F1, `xero-booking-repair-classify.ts`): use
 * `compareLedgerRowsOldestFirst` / `compareLedgerRowsNewestFirst`.
 */
const CREATED_AT_ONLY_COMPARATORS: Record<string, string> = {};

/** Raw SQL allowed to order `PaymentTransaction` by `"createdAt"` without `"insertionSeq"`, by file, with why. */
const RAW_SQL_WITHOUT_INSERTION_SEQ: Record<string, string> = {
  "src/lib/diagnostics/tools/packs/finance-search.ts":
    'orders PAYMENTS (`p."createdAt", p."id"`), not ledger rows: PaymentTransaction appears only in an ' +
    "EXISTS filter, and the read is a read-only diagnostics search that decides no money.",
};

type Order = "ledger" | "other" | "none" | "unreadable";
/** For an unordered `findFirst`: how the walk knows at most one row can answer, if it does. */
type Lookup = "unique-literal" | "unique-expression" | "id-only" | "unproven";
type Site = { key: string; kind: "read" | "relation"; method: string; order: Order; lookup?: Lookup; lookupKey?: string };

/** Columns a `findFirst` may name in its `where` to be read as a lookup of at most one row. */
const UNIQUE_KEYS = new Set(["id", "stripePaymentIntentId"]);

/** Only a string literal proves a non-null unique-key value without type/data-flow analysis. */
function classifyLookup(query: ts.Expression | undefined): Lookup {
  if (!query || !ts.isObjectLiteralExpression(query)) return "unproven";
  const where = property(query, "where")?.initializer;
  if (where && ts.isObjectLiteralExpression(where)) {
    const values = where.properties.flatMap((candidate) =>
      ts.isPropertyAssignment(candidate) && UNIQUE_KEYS.has(candidate.name.getText())
        ? [candidate.initializer]
        : [],
    );
    if (values.some((value) => ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) {
      return "unique-literal";
    }
    if (values.some((value) =>
      ts.isIdentifier(value) || ts.isPropertyAccessExpression(value),
    )) return "unique-expression";
  }
  const select = property(query, "select")?.initializer;
  if (select && ts.isObjectLiteralExpression(select) && select.properties.length === 1 &&
    property(select, "id")?.initializer.kind === ts.SyntaxKind.TrueKeyword) {
    return "id-only";
  }
  return "unproven";
}

/** Nearest result binding, without crossing into the variable holding an enclosing function. */
function resultBinding(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isVariableDeclaration(current)) return current.name.getText().replace(/\s+/g, " ");
    if (ts.isFunctionLike(current)) break;
  }
  return "<unbound>";
}

/** `file > function`, or the module-level `const` a select is declared in. */
function siteName(node: ts.Node): string {
  let moduleConst: string | null = null;
  for (let current = node.parent; current; current = current.parent) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name) {
      return current.name.getText();
    }
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && ts.isVariableDeclaration(current.parent)) {
      return current.parent.name.getText();
    }
    if (ts.isVariableDeclaration(current) && moduleConst === null) moduleConst = current.name.getText();
  }
  return moduleConst ?? "<module>";
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
  return object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) && candidate.name.getText() === name,
  );
}

/** One of the two constants, bare or spread into an array literal (a type assertion around it is looked through). */
function isLedgerOrder(expression: ts.Expression): boolean {
  let initializer = expression;
  while (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer) || ts.isParenthesizedExpression(initializer)) {
    initializer = initializer.expression;
  }
  if (ts.isIdentifier(initializer)) return LEDGER_ORDERS.has(initializer.text);
  if (ts.isArrayLiteralExpression(initializer) && initializer.elements.length === 1) {
    const [element] = initializer.elements;
    return Boolean(element && ts.isSpreadElement(element) && ts.isIdentifier(element.expression) && LEDGER_ORDERS.has(element.expression.text));
  }
  return false;
}

function classifyQuery(query: ts.Expression | undefined): Order {
  if (!query || !ts.isObjectLiteralExpression(query)) return "unreadable";
  if (query.properties.some((candidate) => ts.isSpreadAssignment(candidate))) return "unreadable";
  if (query.properties.some((candidate) => ts.isShorthandPropertyAssignment(candidate) && candidate.name.text === "orderBy")) {
    return "unreadable";
  }
  const orderBy = property(query, "orderBy");
  if (!orderBy) return "none";
  if (isLedgerOrder(orderBy.initializer)) return "ledger";
  // An identifier the walk cannot resolve to a constant is refused, not trusted.
  return ts.isIdentifier(orderBy.initializer) ? "unreadable" : "other";
}

/** A `transactions` property under `_count: { select: { ... } }` counts rows; it reads none. */
function isUnderCount(node: ts.PropertyAssignment): boolean {
  const select = node.parent?.parent;
  const count = select?.parent?.parent;
  return Boolean(
    select && ts.isPropertyAssignment(select) && select.name.getText() === "select" &&
      count && ts.isPropertyAssignment(count) && count.name.getText() === "_count",
  );
}

function scanSource(file: string, code: string): Site[] {
  if (!code.includes("paymentTransaction") && !code.includes("transactions")) return [];
  const sites: Site[] = [];
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const key = (node: ts.Node) => `${file} > ${siteName(node)}`;
  const walk = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      READ_METHODS.has(node.expression.name.text) &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === "paymentTransaction"
    ) {
      const method = node.expression.name.text;
      const order = classifyQuery(node.arguments[0]);
      sites.push({
        key: key(node),
        kind: "read",
        method,
        order,
        ...(order === "none" && method !== "findMany" ? { lookup: classifyLookup(node.arguments[0]), lookupKey: `${key(node)} > ${resultBinding(node)}` } : {}),
      });
    }
    if (ts.isPropertyAssignment(node) && node.name.getText() === "transactions" && !isUnderCount(node)) {
      const initializer = node.initializer;
      if (initializer.kind === ts.SyntaxKind.TrueKeyword) {
        sites.push({ key: key(node), kind: "relation", method: "include", order: "none" });
      } else if (
        ts.isObjectLiteralExpression(initializer) &&
        initializer.properties.some((candidate) => candidate.name !== undefined && RELATION_READ_KEYS.has(candidate.name.getText()))
      ) {
        sites.push({ key: key(node), kind: "relation", method: "include", order: classifyQuery(initializer) });
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return sites;
}

function scanTree(): Site[] {
  return sourceFiles().flatMap((file) => scanSource(relativeSource(file), readFileSync(file, "utf8")))
    .sort((a, b) => a.key.localeCompare(b.key));
}

type FirstReadDeclarations = Record<"id-only" | "unique-expression" | "unproven", Record<string, string>>;
const FIRST_READ_DECLARATIONS: FirstReadDeclarations = {
  "id-only": EXISTENCE_READS,
  "unique-expression": UNIQUE_EXPRESSION_READS,
  unproven: UNPROVEN_FIRST_READS,
};

/** Shared by real-tree enforcement and synthetic fixtures: refuse missing, stale or ambiguous declarations. */
function firstReadIssues(sites: Site[], declarations: FirstReadDeclarations = FIRST_READ_DECLARATIONS): string[] {
  const issues: string[] = [];
  for (const lookup of ["id-only", "unique-expression", "unproven"] as const) {
    const keys = sites.filter((site) => site.lookup === lookup).map((site) => site.lookupKey!);
    for (const key of keys) {
      if (!declarations[lookup][key]) issues.push(`undeclared ${lookup}: ${key}`);
    }
    for (const key of Object.keys(declarations[lookup])) {
      if (!keys.includes(key)) issues.push(`stale ${lookup}: ${key}`);
    }
  }
  const keys = sites.filter((site) => site.lookup).map((site) => site.lookupKey!);
  for (const key of new Set(keys)) {
    if (keys.filter((candidate) => candidate === key).length > 1) issues.push(`ambiguous first read: ${key}`);
  }
  return issues.sort();
}

const unique = (keys: string[]) => [...new Set(keys)].sort();

const LEDGER_RECEIVER = /transaction|capture|ledger/i;

/** Each `.sort(...)` over a ledger-row receiver whose comparator reads `createdAt` but not the tiebreak. */
function createdAtOnlyComparators(): string[] {
  const offenders = new Set<string>();
  for (const file of sourceFiles()) {
    const code = readFileSync(file, "utf8");
    if (!code.includes(".sort(") || !code.includes("createdAt")) continue;
    const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
    const walk = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "sort") {
        const [comparator] = node.arguments;
        const receiver = node.expression.expression.getText(source);
        const body = comparator?.getText(source) ?? "";
        if (comparator && LEDGER_RECEIVER.test(receiver) && /\bcreatedAt\b/.test(body) && !/insertionSeq|compareLedgerRows/.test(body)) {
          offenders.add(`${relativeSource(file)} > ${siteName(node)}`);
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  return [...offenders].sort();
}

/** Each raw-SQL `ORDER BY` after `"PaymentTransaction"` that names `"createdAt"` and not `"insertionSeq"`. */
function rawSqlOrdersWithoutInsertionSeq(): string[] {
  const offenders = new Set<string>();
  const order = /"PaymentTransaction"[^`]{0,800}?ORDER\s+BY([^`;]*)/gi;
  for (const file of sourceFiles()) {
    const code = readFileSync(file, "utf8");
    if (!code.includes('"PaymentTransaction"')) continue;
    for (const match of code.matchAll(order)) {
      const clause = match[1] ?? "";
      if (/"createdAt"/.test(clause) && !/"insertionSeq"/.test(clause)) offenders.add(relativeSource(file));
    }
  }
  return [...offenders].sort();
}

describe("every capture-ledger read is ordered by the ledger's order, or declared (#4132, INV-PAY-133)", () => {
  const sites = scanTree();

  it("reaches the ledger's readers, so an empty or truncated walk fails rather than passes", () => {
    expect(
      sites.filter((site) => site.order === "ledger").map((site) => site.key),
      "INV-PAY-133: the walk did not reach the capture ledger's loader or the cancel's fold read; it is not reading the tree.",
    ).toEqual(
      expect.arrayContaining([
        "src/lib/payment-transactions.ts > loadPaymentWithTransactions",
        "src/lib/booking-cancel.ts > performBookingCancellation",
        "src/lib/additional-ask-reduction.ts > readUnpaidPriceAsk",
      ]),
    );
  });

  it("finds no ledger read ordered by anything but LEDGER_ROWS_OLDEST_FIRST / LEDGER_ROWS_NEWEST_FIRST", () => {
    expect(
      sites.filter((site) => site.order === "other").map((site) => site.key),
      "INV-PAY-133: a PaymentTransaction read orders by something other than the ledger's order. createdAt " +
        "alone ties for rows written in one transaction, and an id is not an insertion order: use " +
        "orderBy: [...LEDGER_ROWS_OLDEST_FIRST] or [...LEDGER_ROWS_NEWEST_FIRST] from payment-ledger-order.ts.",
    ).toEqual([]);
  });

  it("refuses a read it cannot classify rather than passing it", () => {
    expect(
      sites.filter((site) => site.order === "unreadable").map((site) => site.key),
      "INV-PAY-133: this PaymentTransaction read passes its query whole, spreads into it, or names an orderBy " +
        "the census cannot read. Write the query and its orderBy inline.",
    ).toEqual([]);
  });

  it("finds exactly the declared multi-row reads with no order", () => {
    expect(
      unique(sites.filter((site) => site.order === "none" && site.method !== "findFirst").map((site) => site.key)),
      "INV-PAY-133: a multi-row PaymentTransaction read has no orderBy. If anything it decides depends on " +
        "which row comes first, order it by LEDGER_ROWS_OLDEST_FIRST / LEDGER_ROWS_NEWEST_FIRST; if not, " +
        "declare it in UNORDERED_ROW_SETS with the reason. A declared read that gained an order fails here too.",
    ).toEqual(Object.keys(UNORDERED_ROW_SETS).sort());
  });

  it("reads every unordered findFirst as a lookup of one row, or declares why", () => {
    expect(
      firstReadIssues(sites),
      "INV-PAY-133: an unordered PaymentTransaction first read needs a literal unique key, or an exact " +
        "named declaration with a reason in EXISTENCE_READS, UNIQUE_EXPRESSION_READS or UNPROVEN_FIRST_READS. " +
        "An id-only select proves no existence-only use; a variable unique key may be null or undefined.",
    ).toEqual([]);
  });

  it("finds no in-memory sort of ledger rows that reads createdAt without the tiebreak", () => {
    expect(
      createdAtOnlyComparators(),
      "INV-PAY-133: a sort over ledger rows compares createdAt alone, so a tie keeps the order it was read in. " +
        "Use compareLedgerRowsOldestFirst / compareLedgerRowsNewestFirst from payment-ledger-order.ts, or " +
        "declare it in CREATED_AT_ONLY_COMPARATORS with the reason a tie cannot matter.",
    ).toEqual(Object.keys(CREATED_AT_ONLY_COMPARATORS).sort());
  });

  it("keeps a reason against every entry", () => {
    for (const [entry, reason] of Object.entries({
      ...UNORDERED_ROW_SETS,
      ...UNPROVEN_FIRST_READS,
      ...EXISTENCE_READS,
      ...UNIQUE_EXPRESSION_READS,
      ...CREATED_AT_ONLY_COMPARATORS,
      ...RAW_SQL_WITHOUT_INSERTION_SEQ,
    })) {
      expect(reason.length, `INV-PAY-133: ${entry} needs a stated reason`).toBeGreaterThan(40);
    }
  });

  it("keeps the order in one home: createdAt, then insertionSeq", () => {
    const home = readFileSync(sourceFiles().find((file) => relativeSource(file) === ORDER_HOME)!, "utf8");
    expect(home, `INV-PAY-133: LEDGER_ROWS_OLDEST_FIRST in ${ORDER_HOME} must be createdAt asc, then insertionSeq asc.`).toMatch(
      /export const LEDGER_ROWS_OLDEST_FIRST = \[\s*\{ createdAt: "asc" \},\s*\{ insertionSeq: "asc" \},\s*\]/,
    );
    expect(home, `INV-PAY-133: LEDGER_ROWS_NEWEST_FIRST in ${ORDER_HOME} must be createdAt desc, then insertionSeq desc.`).toMatch(
      /export const LEDGER_ROWS_NEWEST_FIRST = \[\s*\{ createdAt: "desc" \},\s*\{ insertionSeq: "desc" \},\s*\]/,
    );
  });

  it("finds no raw SQL that orders PaymentTransaction by createdAt without insertionSeq", () => {
    expect(
      rawSqlOrdersWithoutInsertionSeq(),
      'INV-PAY-133: raw SQL orders PaymentTransaction by "createdAt" with no "insertionSeq" tiebreak. Add one, ' +
        "or declare the file in RAW_SQL_WITHOUT_INSERTION_SEQ with the reason the order cannot matter.",
    ).toEqual(Object.keys(RAW_SQL_WITHOUT_INSERTION_SEQ).sort());
  });
});

describe("unordered first-read scanner regressions (#4180, INV-PAY-133)", () => {
  const empty: FirstReadDeclarations = { "id-only": {}, "unique-expression": {}, unproven: {} };
  const scan = (body: string) => scanSource("fixture.ts", `async function example() { ${body} }`);

  it("ignores commented reads while scanning the same parsed source as the real tree", () => {
    expect(scan(`
      // tx.paymentTransaction.findFirst({ select: { id: true } });
      /* const row = await tx.paymentTransaction.findFirst({ where: { stripePaymentIntentId: nullable } }); */
    `)).toEqual([]);
  });

  it("refuses an id-only arbitrary pick whose id is used to update a row", () => {
    const sites = scan(`
      const row = await tx.paymentTransaction.findFirst({
        where: { paymentId, status: "SUCCEEDED" }, select: { id: true },
      });
      if (row) await tx.paymentTransaction.update({ where: { id: row.id }, data: { status: "REFUNDED" } });
    `);
    expect(firstReadIssues(sites, empty)).toEqual(["undeclared id-only: fixture.ts > example > row"]);
  });

  it.each(["someNullable", "payment.additionalPaymentIntentId", "undefined"])(
    "refuses an undeclared unique-key source: %s",
    (value) => {
      const sites = scan(`
        const someNullable: string | null = null;
        const row = await tx.paymentTransaction.findFirst({
          where: { stripePaymentIntentId: ${value} }, select: { amountCents: true },
        });
        return row?.amountCents;
      `);
      expect(firstReadIssues(sites, empty)).toEqual(["undeclared unique-expression: fixture.ts > example > row"]);
    },
  );

  it.each(['"pi_literal"', '`pi_literal`'])("accepts a non-null literal unique-key lookup: %s", (value) => {
    const sites = scan(`const row = await tx.paymentTransaction.findFirst({ where: { stripePaymentIntentId: ${value} } });`);
    expect(sites).toHaveLength(1);
    expect(firstReadIssues(sites, empty)).toEqual([]);
  });

  it.each(["null", "{ not: null }", "{ in: intents }"])("refuses a non-unique predicate: %s", (value) => {
    const sites = scan(`const row = await tx.paymentTransaction.findFirst({ where: { stripePaymentIntentId: ${value} } });`);
    expect(firstReadIssues(sites, empty)).toEqual(["undeclared unproven: fixture.ts > example > row"]);
  });

  it("accepts named existence and guarded-key declarations, but refuses a new pick in the same function", () => {
    const body = `
      const exists = await tx.paymentTransaction.findFirst({ where: { paymentId }, select: { id: true } });
      if (payment.additionalPaymentIntentId) {
        const guarded = await tx.paymentTransaction.findFirst({ where: { stripePaymentIntentId: payment.additionalPaymentIntentId } });
        return Boolean(exists) && guarded?.amountCents;
      }
    `;
    const declarations: FirstReadDeclarations = {
      ...empty,
      "id-only": { "fixture.ts > example > exists": "The consumer tests Boolean(exists), without using an id." },
      "unique-expression": { "fixture.ts > example > guarded": "The enclosing if excludes a null additionalPaymentIntentId." },
    };
    expect(firstReadIssues(scan(body), declarations)).toEqual([]);
    expect(firstReadIssues(scan(body + `
      const chosen = await tx.paymentTransaction.findFirst({ where: { paymentId }, select: { id: true } });
      return chosen?.id;
    `), declarations)).toEqual(["undeclared id-only: fixture.ts > example > chosen"]);
    expect(firstReadIssues(scan(""), declarations)).toEqual([
      "stale id-only: fixture.ts > example > exists",
      "stale unique-expression: fixture.ts > example > guarded",
    ]);
  });

  it("refuses two reads sharing a declared binding instead of hiding one behind deduplication", () => {
    const read = `const row = await tx.paymentTransaction.findFirst({ where: { paymentId }, select: { id: true } });`;
    expect(firstReadIssues(scan(`{ ${read} } { ${read} }`), {
      ...empty, "id-only": { "fixture.ts > example > row": "Only reviewed for existence; duplicate identities must fail." },
    })).toEqual(["ambiguous first read: fixture.ts > example > row"]);
  });
});
