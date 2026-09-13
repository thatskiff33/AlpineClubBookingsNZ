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
 * 2. **How big is the ask a price increase raises?** `sizeAdditionalAsk`.
 *    Minting an ADDITIONAL PaymentIntent retires every other outstanding ask on
 *    the payment (`queueSupersededAdditionalIntentCancellations`), so an ask
 *    sized on this edit's delta alone DELETES the unpaid balance of the ask it
 *    replaces. That is how a $130 booking with $130 paid, then +$70 unpaid, then
 *    +$70 again, ended up asking for $70 and never for the other $70: the first
 *    extra simply ceased to be owed. The ask is therefore the edit's own net
 *    (price delta plus change fee) PLUS the unpaid balance of the ask it
 *    supersedes - everything the member still owes once this edit lands.
 *
 *    **And it says how much of itself it absorbed** (#3371). See `AdditionalAsk`
 *    below: the figure and its carried part are ONE value that only this module
 *    can build, so a mint cannot record the total while forgetting the
 *    provenance, and the two can never be sized from different inputs.
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
import { CAPTURED_PAYMENT_STATUS_LIST } from "@/lib/booking-payment-state";

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
 * AN ASK, AND WHAT IT ABSORBED - one value, and the only thing the shared minter
 * will accept (#3371).
 *
 * ## Why this is a type rather than two numbers
 *
 * Minting an ADDITIONAL PaymentIntent retires every other live one on the
 * payment. The new ask therefore has to carry the unpaid balance of the one it
 * supersedes, and - because once that row is cancelled what it was owed for is
 * **not derivable from anything** - it has to RECORD what it carried, in
 * `PaymentTransaction.carriedAskCents`.
 *
 * That is a permanent obligation on every future writer, and the owner's 13 Sep
 * 2026 decision on #3371 is that it must be **structurally hard to omit rather
 * than merely required**. So:
 *
 *   * the two numbers travel as ONE value, built in ONE place, from the same
 *     inputs - a mint cannot fold the balance in and forget to say so, or say so
 *     and forget to fold it in;
 *   * the class below is NOT exported, only its instance type is, so there is no
 *     constructor to reach and no way to build one outside this file;
 *   * `carriedCents` is held in a `#private` field. A private field is what the
 *     brand it replaced could not be: an object spread DROPS it, so the obvious
 *     forgery - `{ ...NO_ADDITIONAL_ASK, amountCents: someDelta }`, which needs
 *     no cast at all and compiled clean against the earlier `unique symbol`
 *     brand - is now a type error naming the missing member;
 *   * every constructor that can return a POSITIVE ask takes the thing that
 *     decides the carried figure - the `Payment` whose live ask the mint will
 *     retire, or the stored request row a raise reads it back off. The one
 *     constructor that takes neither, `NO_ADDITIONAL_ASK`, is zero, and a zero
 *     ask never reaches the mint at all (`createModificationAdditionalPaymentIntent`
 *     returns before minting), so it can retire nothing and has nothing to carry.
 *
 * ## What this does NOT stop, said plainly
 *
 * A DELIBERATE type assertion. TypeScript permits `x as T` whenever `T` is
 * assignable to the type of `x`, and every class is assignable to the bare
 * object type of its own public members - so
 * `{ amountCents, carriedCents } as AdditionalAsk` still compiles here, exactly
 * as `as unknown as AdditionalAsk` would in any design. Measured against this
 * file with the repository's own compiler, not assumed. That residue is covered
 * by the call-site census in `__tests__/booking-ledger-census.test.ts`, which
 * refuses the assertion by name anywhere outside this module - a guard, and
 * named as one. The type stops the accident; the census stops the shortcut.
 *
 * `carriedCents` is a PART OF `amountCents`, never an addition to it. Reading it
 * as a second amount would double-count the money.
 */
class AdditionalAskValue {
  /** What the member is asked for, in integer cents. */
  readonly amountCents: number;

  /**
   * How much of `amountCents` was absorbed from an ask this mint will retire,
   * rather than derived from this edit's own figures. Zero when the mint
   * supersedes nothing.
   *
   * PRIVATE, and read back through the accessor below, because that is the part
   * that makes the value unforgeable: a `#` field cannot survive a spread and
   * cannot be written by a literal.
   */
  readonly #carriedCents: number;

  constructor(params: { ownCents: number; carriedCents: number }) {
    this.amountCents = params.ownCents + params.carriedCents;
    this.#carriedCents = params.carriedCents;
  }

  get carriedCents(): number {
    return this.#carriedCents;
  }
}

/**
 * The ask type every caller names. The class itself stays module-private, so
 * naming the type never hands anybody a constructor.
 */
export type AdditionalAsk = AdditionalAskValue;

/** The only place an `AdditionalAsk` comes into existence. */
function buildAdditionalAsk(params: {
  ownCents: number;
  carriedCents: number;
}): AdditionalAsk {
  return new AdditionalAskValue(params);
}

/**
 * NOTHING IS BEING ASKED FOR through this instrument.
 *
 * Every edit path builds an ask, including the ones that turn out to owe the
 * member money or to bill through Xero instead, because the minter's parameter
 * is required. Those paths pass this. It is safe by construction rather than by
 * convention: the minter returns before minting on a non-positive amount, so a
 * zero ask supersedes nothing and there is nothing for it to carry.
 */
export const NO_ADDITIONAL_ASK: AdditionalAsk = buildAdditionalAsk({
  ownCents: 0,
  carriedCents: 0,
});

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
export function sizeAdditionalAsk({
  priceDiffCents,
  changeFeeCents,
  payment,
}: {
  priceDiffCents: number;
  changeFeeCents: number;
  payment: AdditionalAskPayment | null | undefined;
}): AdditionalAsk {
  return buildAdditionalAsk({
    ownCents: priceDiffCents + changeFeeCents,
    carriedCents: outstandingAdditionalAskCents(payment),
  });
}

/** The stored ADDITIONAL row a review charge's later share reads back. */
export interface CarriedAskRecord {
  carriedAskCents: number;
}

/**
 * THE FIRST charge raised by a settled booking-change financial review (#3371).
 *
 * Same rule as `sizeAdditionalAsk`, different "own" figure: a review charge's
 * own amount is the SUM of the shares settled against this one edit
 * (`INV-PAY-062`), not a price delta. Everything else is identical, and that is
 * the point - #3340's fix for the ordinary edit and this one are one rule in two
 * places, not two rules for one fact.
 *
 * The carried part is read off the payment because that is the ask this mint is
 * about to retire. It is only correct HERE, at the mint: by the time a later
 * share settles, the payment's own ask column mirrors this review's intent, so
 * re-reading it there would double-count. That later call is
 * `raiseReviewChargeAsk`, which reads the figure back off the row instead.
 */
export function sizeReviewChargeAsk({
  shareTotalCents,
  payment,
}: {
  shareTotalCents: number;
  payment: AdditionalAskPayment | null | undefined;
}): AdditionalAsk {
  return buildAdditionalAsk({
    ownCents: shareTotalCents,
    carriedCents: outstandingAdditionalAskCents(payment),
  });
}

/**
 * A LATER share joining a review charge that already exists (#3371).
 *
 * Nothing is minted and nothing is superseded, so nothing new is carried: the
 * figure comes back off the row the first mint wrote. Taking the ROW rather than
 * a number is the point - a caller cannot supply a fresh 0 and quietly write the
 * carried balance out of the ask.
 *
 * KEEPING THE CARRIED PART OUT OF THE SHARE SUM IS WHAT MAKES THIS MONOTONE.
 * `shareTotalCents` only ever grows (a settled share is terminal) and
 * `carriedAskCents` is fixed at the mint, so the figure this returns never
 * falls. That is what the refuse-to-lower rule in
 * `syncEditFinancialReviewChargeRequest` needs, and it is why folding the
 * carried balance into the share sum was rejected on #3371 - a sum that can fall
 * would need a lock held across the provider call, which
 * `docs/CONCURRENCY_AND_LOCKING.md` forbids.
 *
 * SAID EXACTLY, because an earlier draft of this sentence claimed more than the
 * code does. Monotone means a run that has seen MORE settled shares never
 * derives a SMALLER figure, so a stale replay cannot lower a live ask. It does
 * not serialise two runs: the refusal it feeds reads the row and writes it in
 * separate statements with a provider round trip between them, which is a
 * refusal rather than an atomic compare-and-set. What that does and does not
 * guarantee is written out where it happens, in
 * `syncEditFinancialReviewChargeRequest`.
 */
export function raiseReviewChargeAsk({
  shareTotalCents,
  request,
}: {
  shareTotalCents: number;
  request: CarriedAskRecord;
}): AdditionalAsk {
  return buildAdditionalAsk({
    ownCents: shareTotalCents,
    carriedCents: request.carriedAskCents,
  });
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
 * EVERYTHING THE BOOKING STILL OWES, in integer cents - the ask included, and
 * whatever the price says is owed beyond it.
 *
 * `outstandingAdditionalAskCents` above answers a narrower question: how much is
 * unpaid on the ONE ask the payment currently carries. That is the right figure
 * wherever an ask is the only thing outstanding, and it is 0 on a booking whose
 * WHOLE price is still owed as a PRIMARY payment - which is why a member on that
 * booking must never be told "nothing further is owing" from it (#3340 fix
 * round). The supersede-refund notice is reached from the PRIMARY supersede path
 * as well as the ADDITIONAL one, and that is the shape it hits.
 *
 * Built from `BOOKING_LEDGER_IDENTITY_TERMS`, so it is `INV-PAY-047` rearranged
 * rather than a second opinion: the residual is what is owed BEYOND the ask, and
 * adding the ask back gives the whole. On a balanced ledger it therefore equals
 * the ask exactly, which is what keeps the ordinary case's figure unchanged.
 *
 * Floored at zero. A NEGATIVE residual is the club legitimately holding more
 * than the price (a policy-tiered reduction's retained slice, a reduction
 * settled as account credit), and "the club owes the member" is not a sentence
 * this figure is allowed to imply - the refund it accompanies has its own
 * amount.
 */
export function bookingOutstandingCents(
  row: BookingLedgerIdentityRow,
): number {
  return Math.max(
    bookingLedgerResidualCents(row) + outstandingAdditionalAskCents(row),
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

// #3340 fix round (`INV-SSOT-001`): re-exported, never restated. A third copy of
// this list was added HERE by the change that exists to stop facts having two
// homes, which is the finding. `booking-payment-state.ts` is the one home.
export const BOOKING_LEDGER_CENSUS_CAPTURED_PAYMENT_STATUSES =
  CAPTURED_PAYMENT_STATUS_LIST;

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
