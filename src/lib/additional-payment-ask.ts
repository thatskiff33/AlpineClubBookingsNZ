/**
 * THE ONE HOME for the arithmetic behind an additional-payment ask (#3340).
 *
 * Enforces `INV-PAY-047` (the generalised ledger mirror) and `INV-ADDPAY-023`
 * (a retired obligation is never collectable), under `INV-SSOT-001`.
 *
 * Three questions are answered here and nowhere else.
 *
 * 1. **How much is still owed on the ask a payment currently carries?**
 *    `outstandingAdditionalAskCents`. The `Payment.additionalAmountCents` /
 *    `additionalPaymentStatus` pair is the ledger's own record of the ONE live
 *    ask - `reconcilePaymentAggregates` mirrors the latest ADDITIONAL
 *    transaction into it - and `isAdditionalAmountUncollected` is the one
 *    predicate that says whether it has been collected. This module CALLS that
 *    predicate rather than restating it, so the chase, the admin panel and the
 *    sizing below cannot drift apart about whether money is owed.
 *
 * 2. **How big is the ask a price increase raises?** `sizeAdditionalAskCents`.
 *    Minting an ADDITIONAL PaymentIntent retires every other outstanding ask on
 *    the payment (`queueSupersededAdditionalIntentCancellations`), so an ask
 *    sized on this edit's delta alone DELETES the unpaid balance of the ask it
 *    replaces. That is how a $130 booking with $130 paid, then +$70 unpaid, then
 *    +$70 again, ended up asking for $70 and never for the other $70: the first
 *    extra simply ceased to be owed. The ask is therefore the edit's own net
 *    (price delta plus change fee) PLUS the unpaid balance of the ask it
 *    supersedes - everything the member still owes once this edit lands.
 *
 * 3. **What must a settled booking's ledger add up to?**
 *    `bookingLedgerResidualCents` and `BOOKING_LEDGER_IDENTITY_TERMS` -
 *    `INV-PAY-047` written as a signed term table so the TypeScript census and
 *    the operator-run SQL are generated from ONE list rather than written twice.
 *
 * ## Why the ask is built from the superseded ask and not from the price
 *
 * The issue's headline rule reads the outstanding balance straight off the
 * booking: `finalPriceCents - (amountCents - refundedAmountCents) -
 * creditAppliedCents`. On every shape the issue names, and on every one of its
 * acceptance criteria, THE TWO FORMS AGREE - the worked cases are in
 * `__tests__/additional-payment-ask.test.ts`, which asserts the agreement
 * explicitly rather than leaving it as a claim in a comment.
 *
 * They part company only where the club legitimately holds money that is not the
 * booking's price, and there the price-derived form gives it back:
 *
 * - **A policy-tiered reduction** (`INV-MOD-011`) refunds less than the price
 *   came down by, and the retained slice is a POLICY CHARGE, not a prepayment.
 *   `finalPriceCents` drops by the whole delta while `amountCents -
 *   refundedAmountCents` drops by the tiered part only, so the price-derived
 *   outstanding goes negative by exactly the retained slice - and the member's
 *   next increase would be discounted by it.
 * - **A reduction settled as account credit** does the same with no refund at
 *   all: `amountCents` is untouched and the member holds `MemberCredit`
 *   (`creditAppliedCents` records credit applied TO this booking, which is a
 *   different column and the opposite direction).
 * - **A pre-#3340 under-collection** reads as "outstanding" to the price-derived
 *   form, which would fold it into the next ask. That is precisely the
 *   retro-correction the owner ruled out on 8 Sep 2026; the two affected members
 *   are being invoiced by hand.
 *
 * Folding in the ask the ledger actually recorded touches exactly the money that
 * vanished and nothing else. It is also what scope item 1 asks for in its own
 * words - "when a price increase supersedes any outstanding ADDITIONAL
 * transaction, size the new intent on the full outstanding balance" - so where no
 * ask is being superseded the arithmetic is unchanged from before #3340.
 *
 * Pure: no client, no logger, no `server-only`, so the sizing site inside the
 * edit transaction, the census guard, the operator CLI and the tests all import
 * it.
 */
import { isAdditionalAmountUncollected } from "@/lib/additional-payment-chase";

/** The two `Payment` columns that record the one live ask. */
export interface AdditionalAskPayment {
  additionalAmountCents: number;
  additionalPaymentStatus: string | null;
}

/**
 * The unpaid balance of the ask this payment currently carries, in cents; 0 when
 * there is no ask or it has been collected. A `null` payment (a card booking
 * that has never minted a `Payment` row) carries nothing.
 */
export function outstandingAdditionalAskCents(
  payment: AdditionalAskPayment | null | undefined,
): number {
  return isAdditionalAmountUncollected(payment)
    ? payment.additionalAmountCents
    : 0;
}

/**
 * The ask a price-increasing edit raises against a captured card payment: the
 * edit's own net (delta plus change fee) plus the unpaid balance of whatever ask
 * the mint is about to supersede. Never a bare delta - see the module docblock.
 *
 * `priceDiffCents` and `changeFeeCents` are passed separately rather than
 * pre-summed, so a caller cannot quietly hand in a figure that already folded
 * something else in. The result is meaningful only where the caller has
 * established that the edit's net is positive; this is not a refund calculator.
 */
export function sizeAdditionalAskCents({
  priceDiffCents,
  changeFeeCents,
  payment,
}: {
  priceDiffCents: number;
  changeFeeCents: number;
  payment: AdditionalAskPayment | null | undefined;
}): number {
  return priceDiffCents + changeFeeCents + outstandingAdditionalAskCents(payment);
}

/**
 * One row of a settled booking's money, as `INV-PAY-047` reads it. The field
 * names are the Prisma models' own, so a `Booking` + `Payment` pair passes
 * through with no renaming and no chance of two call sites mapping it
 * differently.
 */
export interface BookingLedgerIdentityRow {
  finalPriceCents: number;
  changeFeeCents: number;
  amountCents: number;
  refundedAmountCents: number;
  creditAppliedCents: number;
  additionalAmountCents: number;
  additionalPaymentStatus: string | null;
}

export interface BookingLedgerIdentityTerm {
  /** `+1` adds to what is owed, `-1` records money that answers it. */
  sign: 1 | -1;
  /** Plain English, for the census report and the guard's failure message. */
  label: string;
  /** The term's value for one row. */
  ts: (row: BookingLedgerIdentityRow) => number;
  /**
   * The same term as a PostgreSQL expression over the aliases `b` (`"Booking"`)
   * and `p` (`"Payment"`), quoted the way Prisma names its columns.
   */
  sql: string;
}

/**
 * `INV-PAY-047` as a list of signed terms. The TypeScript and SQL forms below
 * are BOTH folded from this list, so adding or changing a term changes both or
 * neither (`INV-SSOT-001`).
 *
 * The change fee is a term because `Payment.changeFeeCents` is charged through
 * an ask but is never added to `Booking.finalPriceCents` - the edit paths pass
 * `netChargeCents = priceDiffCents + changeFeeCents` and separately write
 * `finalPriceCents = newFinalPriceCents`. Without it the identity would fail on
 * every booking that has ever paid a change fee.
 */
export const BOOKING_LEDGER_IDENTITY_TERMS: readonly BookingLedgerIdentityTerm[] =
  [
    {
      sign: 1,
      label: "the booking's price",
      ts: (row) => row.finalPriceCents,
      sql: 'b."finalPriceCents"',
    },
    {
      sign: 1,
      label: "change fees, which join an ask but never the price",
      ts: (row) => row.changeFeeCents,
      sql: 'p."changeFeeCents"',
    },
    {
      sign: -1,
      label: "money captured",
      ts: (row) => row.amountCents,
      sql: 'p."amountCents"',
    },
    {
      sign: 1,
      label: "money refunded",
      ts: (row) => row.refundedAmountCents,
      sql: 'p."refundedAmountCents"',
    },
    {
      sign: -1,
      label: "account credit applied to the booking",
      ts: (row) => row.creditAppliedCents,
      sql: 'p."creditAppliedCents"',
    },
    {
      sign: -1,
      label: "the uncollected ask",
      ts: (row) => outstandingAdditionalAskCents(row),
      // The SQL twin of `isAdditionalAmountUncollected`: a positive amount whose
      // status is anything but SUCCEEDED. A NULL status on a legacy row counts
      // as uncollected, which `IS DISTINCT FROM` gets right where `<>` would not.
      sql: 'CASE WHEN p."additionalAmountCents" > 0 AND p."additionalPaymentStatus" IS DISTINCT FROM \'SUCCEEDED\' THEN p."additionalAmountCents" ELSE 0 END',
    },
  ];

/**
 * `finalPrice + changeFee - (captured - refunded) - credit - uncollected ask`,
 * in integer cents.
 */
export function bookingLedgerResidualCents(
  row: BookingLedgerIdentityRow,
): number {
  return BOOKING_LEDGER_IDENTITY_TERMS.reduce(
    (sum, term) => sum + term.sign * term.ts(row),
    0,
  );
}

/**
 * What a residual MEANS, named once so the guard, the operator census and the
 * docs cannot describe the same number three different ways.
 *
 * - `balanced` - the books add up.
 * - `unasked` - **the #3340 class**: money the price says is owed that nothing is
 *   asking for. A guard failure, always.
 * - `retained` - the club holds more than the price. Expected after a
 *   policy-tiered reduction (`INV-MOD-011` keeps a slice) or a reduction settled
 *   as account credit, so it is REPORTED to an operator and never failed.
 */
export type BookingLedgerVerdict = "balanced" | "unasked" | "retained";

export function bookingLedgerVerdict(
  residualCents: number,
): BookingLedgerVerdict {
  if (residualCents === 0) return "balanced";
  return residualCents > 0 ? "unasked" : "retained";
}

/**
 * The guard's failure message, built here so the invariant id travels with the
 * arithmetic rather than being retyped at each assertion (`AGENTS.md`, "Keeping
 * the table usable": a guard names the id it enforces).
 */
export function describeBookingLedgerResidual(params: {
  label: string;
  row: BookingLedgerIdentityRow;
  residualCents: number;
}): string {
  const terms = BOOKING_LEDGER_IDENTITY_TERMS.map(
    (term) =>
      `  ${term.sign === 1 ? "+" : "-"} ${term.ts(params.row)}  ${term.label}`,
  ).join("\n");
  return [
    `INV-PAY-047: ${params.label} does not balance.`,
    `Residual ${params.residualCents} cents is money the price says is owed that no ask is collecting (#3340).`,
    terms,
  ].join("\n");
}

/**
 * The residual as one PostgreSQL expression over `b` and `p`, for the
 * operator-run census. Built from the same term list as
 * `bookingLedgerResidualCents`, so it cannot say something different.
 */
export function bookingLedgerResidualSql(): string {
  return BOOKING_LEDGER_IDENTITY_TERMS.map((term, index) => {
    const operator = term.sign === 1 ? "+" : "-";
    const operand = term.sql.startsWith("CASE") ? `(${term.sql})` : term.sql;
    return index === 0 && term.sign === 1 ? operand : `${operator} ${operand}`;
  }).join(" ");
}

/**
 * The booking statuses the identity is NOT asked of, and the payment statuses
 * that mean money was captured.
 *
 * A CANCELLED or BUMPED booking keeps its ask columns unchanged by design
 * (`INV-ADDPAY-023`), so its residual says nothing; and a booking whose payment
 * has captured nothing owes the whole price as its PRIMARY, not as an ask, so the
 * identity has no third term to check there. Both filters are written once and
 * read by the TypeScript census and the SQL alike.
 */
export const BOOKING_LEDGER_CENSUS_EXCLUDED_BOOKING_STATUSES = [
  "CANCELLED",
  "BUMPED",
] as const;

export const BOOKING_LEDGER_CENSUS_CAPTURED_PAYMENT_STATUSES = [
  "SUCCEEDED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
] as const;

/**
 * The whole operator-run census as a single read-only SELECT: every live booking
 * with a captured payment whose residual is not zero, with each term beside it.
 * REPORT ONLY - it never writes, and the owner's 8 Sep 2026 decision is that it
 * never repairs either. A human reads it and decides.
 */
export function bookingLedgerCensusSql(): string {
  const excluded = BOOKING_LEDGER_CENSUS_EXCLUDED_BOOKING_STATUSES.map(
    (status) => `'${status}'`,
  ).join(", ");
  const captured = BOOKING_LEDGER_CENSUS_CAPTURED_PAYMENT_STATUSES.map(
    (status) => `'${status}'`,
  ).join(", ");
  return [
    "SELECT",
    '  b."id"                        AS "bookingId",',
    '  b."status"                    AS "bookingStatus",',
    '  b."finalPriceCents",',
    '  p."changeFeeCents",',
    '  p."amountCents",',
    '  p."refundedAmountCents",',
    '  p."creditAppliedCents",',
    '  p."additionalAmountCents",',
    '  p."additionalPaymentStatus",',
    `  ${bookingLedgerResidualSql()} AS "residualCents"`,
    'FROM "Booking" b',
    'JOIN "Payment" p ON p."bookingId" = b."id"',
    'WHERE b."deletedAt" IS NULL',
    `  AND b."status" NOT IN (${excluded})`,
    `  AND p."status" IN (${captured})`,
    `  AND ${bookingLedgerResidualSql()} <> 0`,
    'ORDER BY "residualCents" DESC, b."id";',
  ].join("\n");
}
