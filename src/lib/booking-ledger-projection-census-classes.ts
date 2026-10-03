/**
 * THE NAMED CLASSES OF THE BOOKING-LEDGER PROJECTION CENSUS, AND THE SNAPSHOT
 * IT READS (#3583, `INV-MONEY-037`; design `docs/design/booking-ledger.md` §6).
 *
 * The census compares each money column with the ledger lines that project it.
 * Where the two differ by design — a column with another derivation, a refund
 * still in flight, a decision a person took — the difference is NAMED here,
 * and each name is a figure computed from EVIDENCE the delta does not contain:
 * a row, a line matched to its row, a frozen snapshot. A residual is classified
 * only when it equals, to the cent, the sum of the components found for it;
 * anything else is a disagreement. That is the rule that keeps a class from
 * swallowing drift: a class explains an exact amount, never a direction or a
 * shape, and removing its evidence removes the class
 * (`booking-ledger-projection-census.test.ts` proves both for every class).
 *
 * Pure: no reads, no writes, no Prisma client. The rows arrive from
 * `booking-ledger-projection-census-store.ts`; the identities that ask these
 * questions live in `booking-ledger-projection-census.ts`.
 */
import type {
  BookingStatus,
  CreditType,
  LedgerAnchorKind,
  LedgerLineKind,
  LedgerSide,
  ManualRefundTaskDirection,
  ManualRefundTaskKind,
  ManualRefundTaskStatus,
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
  SettlementMethod,
} from "@prisma/client";

import { creditKey } from "@/lib/booking-ledger-posting-keys";
import { deriveCardAppliedCreditDoublePayFinding } from "@/lib/card-applied-credit-double-pay";
import { cancellationCreditDescription } from "@/lib/cancellation-settled-money";
import { buildBookingCancellationRefundIdempotencyKey } from "@/lib/payment-recovery-keys";
import {
  LEGACY_BACKFILL_REASONS,
  isCapturedTransactionStatus,
  isRecordedRefundStatus,
  latestTransactionOfKind,
} from "@/lib/payment-transaction-status";

// ---------------------------------------------------------------------------
// The owner's two decisions on #3583 (3 Oct 2026, both A). Each is ONE line.
// ---------------------------------------------------------------------------

export const BOOKING_LEDGER_CENSUS_GATE_POLICY = {
  /**
   * Owner decision 1, A (#3583, 3 Oct 2026): bookings already damaged by
   * #3791, #3792 or #1641 are listed under `KNOWN_DEFECT_HISTORY` and HOLD the
   * gate until each is corrected by an officer or written off with the owner's
   * acknowledgement on #3583 — that written-off list is the census's
   * `--acknowledged` file. Option B (a class that does not hold) was declined.
   */
  knownDefectHistoryHoldsGate: true,
  /**
   * Owner decision 2, A (#3583, 3 Oct 2026): a group-booking child settled
   * through `GroupBookingSettlement` is named `GROUP_SETTLEMENT_OFF_LEDGER` and
   * does not hold the gate; its poster is #3854, which lands before #3584 moves
   * a reader that shows one. Option B (the poster here) was declined.
   */
  groupSettlementOffLedgerHoldsGate: false,
} as const;

// ---------------------------------------------------------------------------
// The snapshot one booking is judged from
// ---------------------------------------------------------------------------

export type CensusLedgerLine = {
  id: string;
  side: LedgerSide;
  kind: LedgerLineKind;
  sign: number;
  quantity: number;
  unitCents: number;
  amountCents: number;
  bookingGuestId: string | null;
  nightStart: Date | null;
  nightEndExclusive: Date | null;
  anchorKind: LedgerAnchorKind;
  anchorId: string;
  settlementMethod: SettlementMethod | null;
  reversesLineId: string | null;
  postingKey: string | null;
  postedAt: Date;
};

export type BookingLedgerCensusRow = {
  booking: {
    id: string;
    status: BookingStatus;
    deletedAt: Date | null;
    organiserSettled: boolean;
    finalPriceCents: number;
  };
  payment: {
    id: string;
    source: PaymentSource;
    status: PaymentStatus;
    amountCents: number;
    creditAppliedCents: number;
    refundedAmountCents: number;
    changeFeeCents: number;
    additionalAmountCents: number;
    additionalPaymentStatus: string | null;
  } | null;
  transactions: ReadonlyArray<{
    id: string;
    kind: PaymentTransactionKind;
    status: PaymentStatus;
    amountCents: number;
    refundedAmountCents: number;
    reason: string | null;
    withdrawnAt: Date | null;
    createdAt: Date;
  }>;
  refunds: ReadonlyArray<{
    id: string;
    status: string;
    amountCents: number;
    paymentTransactionId: string | null;
  }>;
  /** Every `MemberCredit` row applied to or minted from the booking (`member-credit-booking-rows.ts`). */
  credits: ReadonlyArray<{
    id: string;
    type: CreditType;
    amountCents: number;
    sourceBookingId: string | null;
    appliedToBookingId: string | null;
    restoredFromBookingId: string | null;
    description: string;
    xeroCreditNoteId: string | null;
  }>;
  tasks: ReadonlyArray<{
    id: string;
    kind: ManualRefundTaskKind | null;
    status: ManualRefundTaskStatus;
    amountCents: number | null;
    settlementDirection: ManualRefundTaskDirection | null;
    paymentId: string | null;
    lateCaptureApprovalIntentId: string | null;
  }>;
  modifications: ReadonlyArray<{
    id: string;
    modificationType: string;
    priceDiffCents: number;
    changeFeeCents: number;
    createdAt: Date;
  }>;
  recoveryOperations: ReadonlyArray<{
    type: PaymentRecoveryOperationType;
    status: PaymentRecoveryOperationStatus;
    amountCents: number;
    idempotencyKey: string;
  }>;
  /**
   * The paid path's CANCELLED event snapshot (`writePaidCancellationEvent`):
   * the refund it decided and, since #3611, the kept figure it froze for the
   * ledger. Null where there is none.
   */
  cancellation: { refundMethod: string | null; settledAmountCents: number | null; keptCents: number | null } | null;
  lines: readonly CensusLedgerLine[];
};

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export const BOOKING_LEDGER_CENSUS_CLASSES = [
  "NOTHING_CAPTURED",
  "CREDIT_MIRROR_XERO_CAP",
  "REFUND_MIRROR_HAND_BACK",
  "REFUND_MIRROR_CREDIT_ALLOCATION",
  "REFUND_MIRROR_FAILED_REFUND",
  "REFUND_MIRROR_LEGACY_SEED",
  "V3_LEGACY_HAND_BACK",
  "CHANGE_FEE_REVERSED_BY_CANCELLATION",
  "RETAINED_REVIEW_SHARE",
  "IN_FLIGHT_HAND_BACK",
  "IN_FLIGHT_REFUND",
  "V5_PLANNED_REFUND_SHORT",
  "D2_DISMISSED_HAND_BACK",
  "KNOWN_DEFECT_HISTORY",
  "GROUP_SETTLEMENT_OFF_LEDGER",
] as const;
export type BookingLedgerCensusClass = (typeof BOOKING_LEDGER_CENSUS_CLASSES)[number];

/** Before the back-post (PR 2 of #3583), the gap itself: every one holds the gate. */
export const BOOKING_LEDGER_COVERAGE_KINDS = [
  "NO_LINES",
  "NOT_CONFIRMED_ON_LEDGER",
  "UNPOSTED_EDIT",
  "UNPOSTED_CHANGE_FEE",
  "UNPOSTED_CREDIT",
] as const;
export type BookingLedgerCoverageKind = (typeof BOOKING_LEDGER_COVERAGE_KINDS)[number];

export function classHoldsGate(name: BookingLedgerCensusClass): boolean {
  if (name === "KNOWN_DEFECT_HISTORY") return BOOKING_LEDGER_CENSUS_GATE_POLICY.knownDefectHistoryHoldsGate;
  if (name === "GROUP_SETTLEMENT_OFF_LEDGER") return BOOKING_LEDGER_CENSUS_GATE_POLICY.groupSettlementOffLedgerHoldsGate;
  return false;
}

/** One named part of a residual, in the identity's own delta terms (column − ledger). */
export type ResidualComponent = {
  name: BookingLedgerCensusClass | BookingLedgerCoverageKind;
  cents: number;
  detail?: string;
};

export function isCoverageName(name: ResidualComponent["name"]): name is BookingLedgerCoverageKind {
  return (BOOKING_LEDGER_COVERAGE_KINDS as readonly string[]).includes(name);
}

/**
 * The first alternative whose non-zero components add up to the residual
 * EXACTLY, or null. An alternative with nothing in it explains nothing, so a
 * residual is never classified by an empty set.
 */
export function explainResidual(
  deltaCents: number,
  alternatives: ReadonlyArray<readonly ResidualComponent[]>,
): ResidualComponent[] | null {
  if (deltaCents === 0) return null;
  for (const alternative of alternatives) {
    const present = alternative.filter((component) => component.cents !== 0);
    if (present.length === 0) continue;
    if (present.reduce((sum, component) => sum + component.cents, 0) === deltaCents) return present;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ledger figures and evidence every predicate shares
// ---------------------------------------------------------------------------

export const CAPTURE_KINDS = ["CARD_CAPTURE", "BANK_RECEIPT", "CASH_RECORDED"] as const satisfies readonly LedgerLineKind[];

export function sumKinds(lines: readonly CensusLedgerLine[], kinds: readonly LedgerLineKind[]): number {
  let total = 0;
  for (const line of lines) if (kinds.includes(line.kind)) total += line.amountCents;
  return total;
}

type Credit = BookingLedgerCensusRow["credits"][number];

/** Credit applied to the booking by its rows: `deriveBookingAppliedCreditCents`'s sum, unfloored. */
export function appliedRowsCents(row: BookingLedgerCensusRow): number {
  return -row.credits
    .filter((credit) => credit.type === "BOOKING_APPLIED" && credit.appliedToBookingId === row.booking.id)
    .reduce((sum, credit) => sum + credit.amountCents, 0);
}

function isIssuedFromBooking(row: BookingLedgerCensusRow, credit: Credit): boolean {
  return credit.type !== "BOOKING_APPLIED" && credit.sourceBookingId === row.booking.id;
}

/**
 * An issued credit row whose writer ran `applyLocalRefundAllocation` beside it,
 * so it raised `refundedAmountCents`: the cancel's credit branch
 * (`createCancellationCredit`, its own description) and a reduction credited to
 * account. A restore and the Xero inbound mints never moved the column.
 */
export function isAllocatingCredit(row: BookingLedgerCensusRow, credit: Credit): boolean {
  return (
    isIssuedFromBooking(row, credit) &&
    credit.restoredFromBookingId === null &&
    ((credit.type === "CANCELLATION_REFUND" && credit.description === cancellationCreditDescription(row.booking.id)) ||
      credit.type === "BOOKING_MODIFICATION_REFUND")
  );
}

/** The live credit line posted for one row, keyed `credit:<id>` (`INV-MONEY-035`), or null. */
function creditLineFor(row: BookingLedgerCensusRow, credit: Credit): CensusLedgerLine | null {
  const key = creditKey(credit.id);
  return row.lines.find((line) => line.postingKey === key) ?? null;
}

/** Credit rows that move money and no line records: `UNPOSTED_CREDIT`. */
export function unpostedCredits(row: BookingLedgerCensusRow): Credit[] {
  return row.credits.filter((credit) => credit.amountCents !== 0 && creditLineFor(row, credit) === null);
}

/** Issued credit no `refundedAmountCents` allocation counted, with its line: what owed(b) holds beyond the column's refunds. */
export function nonAllocatingIssuedCents(row: BookingLedgerCensusRow): number {
  return row.credits
    .filter((credit) => isIssuedFromBooking(row, credit) && !isAllocatingCredit(row, credit))
    .reduce((sum, credit) => sum + credit.amountCents, 0);
}

function capturedTransactions(row: BookingLedgerCensusRow) {
  return row.transactions.filter((txn) => isCapturedTransactionStatus(txn.status) && txn.amountCents > 0);
}

/**
 * `amountCents` with nothing captured is the latest primary's face amount
 * (`reconcilePaymentAggregates`). The evidence: no captured transaction, no
 * capture line, and a primary to take the face amount from.
 */
function nothingCapturedFaceCents(row: BookingLedgerCensusRow): number {
  if (sumKinds(row.lines, CAPTURE_KINDS) !== 0 || capturedTransactions(row).length > 0) return 0;
  return latestTransactionOfKind(row.transactions, "PRIMARY")?.amountCents ?? 0;
}

/**
 * The Xero allocation repair caps `creditAppliedCents` at the payment amount.
 * Named only on independent evidence that the money adds up — the price plus
 * fees equals what the ledger captured plus the applied rows, the ledger agrees
 * with the rows — and that the repair ran (an applied row stamped with a Xero
 * note). The column is then the only wrong figure.
 */
function xeroCapEvidence(row: BookingLedgerCensusRow): { appliedCents: number; cappedCents: number } | null {
  const payment = row.payment;
  if (!payment) return null;
  const applied = appliedRowsCents(row);
  const captured = sumKinds(row.lines, CAPTURE_KINDS);
  const repaired = row.credits.some((credit) => credit.type === "BOOKING_APPLIED" && credit.xeroCreditNoteId !== null);
  if (
    !repaired ||
    applied <= payment.amountCents ||
    sumKinds(row.lines, ["CREDIT_APPLIED"]) !== applied ||
    row.booking.finalPriceCents + payment.changeFeeCents !== captured + applied
  ) {
    return null;
  }
  return { appliedCents: applied, cappedCents: payment.amountCents };
}

/**
 * #1641: a full-price card capture beside applied credit nobody allocated —
 * the member paid the applied slice twice. Its fingerprint is the retired card
 * audit's own (`card-applied-credit-double-pay.ts`), on its own population: a
 * captured card payment on a booking that is not cancelled.
 */
function cardDoublePayCents(row: BookingLedgerCensusRow): number {
  const payment = row.payment;
  if (!payment || payment.source === "INTERNET_BANKING" || payment.status !== "SUCCEEDED" || row.booking.status === "CANCELLED") {
    return 0;
  }
  const unallocated = Math.max(
    0,
    -row.credits
      .filter((credit) => credit.type === "BOOKING_APPLIED" && credit.appliedToBookingId === row.booking.id && credit.xeroCreditNoteId === null)
      .reduce((sum, credit) => sum + credit.amountCents, 0),
  );
  const finding = deriveCardAppliedCreditDoublePayFinding({
    paymentId: payment.id,
    bookingId: row.booking.id,
    bookingStatus: row.booking.status,
    paymentStatus: payment.status,
    paymentSource: payment.source,
    amountCents: payment.amountCents,
    creditAppliedCents: payment.creditAppliedCents,
    finalPriceCents: row.booking.finalPriceCents,
    ledgerAppliedCents: unallocated,
  });
  return finding?.strandExposureCents ?? 0;
}

/** Hand-backs the ledger records against a completed task: −Σ matched BANK_REFUND lines. */
function handBackCents(row: BookingLedgerCensusRow): number {
  return -row.lines
    .filter(
      (line) =>
        line.kind === "BANK_REFUND" &&
        line.anchorKind === "REVIEW_TASK" &&
        row.tasks.some((task) => task.id === line.anchorId && task.status === "COMPLETED" && task.amountCents === -line.amountCents),
    )
    .reduce((sum, line) => sum + line.amountCents, 0);
}

/** V3: a legacy late-capture hand-back on a card payment for a deleted booking, which posts no `BANK_REFUND`. */
function v3Cents(row: BookingLedgerCensusRow): number {
  const payment = row.payment;
  if (!payment || payment.source !== "STRIPE" || row.booking.deletedAt === null) return 0;
  return row.tasks
    .filter(
      (task) =>
        task.kind === "DELETED_BOOKING_LATE_CAPTURE" &&
        task.status === "COMPLETED" &&
        task.lateCaptureApprovalIntentId === null &&
        task.paymentId === payment.id,
    )
    .reduce((sum, task) => sum + (task.amountCents ?? 0), 0);
}

/** Allocations the ledger records: −Σ the live lines matched, by key, to allocating rows. */
function creditAllocationCents(row: BookingLedgerCensusRow): number {
  return row.credits
    .filter((credit) => isAllocatingCredit(row, credit))
    .reduce((sum, credit) => sum - (creditLineFor(row, credit)?.amountCents ?? 0), 0);
}

function legacySeedCents(row: BookingLedgerCensusRow): number {
  const legacyIds = new Set(row.transactions.filter((txn) => LEGACY_BACKFILL_REASONS.includes(txn.reason ?? "")).map((txn) => txn.id));
  return (
    row.transactions.filter((txn) => legacyIds.has(txn.id)).reduce((sum, txn) => sum + txn.refundedAmountCents, 0) -
    row.refunds
      .filter((refund) => refund.paymentTransactionId !== null && legacyIds.has(refund.paymentTransactionId) && isRecordedRefundStatus(refund.status))
      .reduce((sum, refund) => sum + refund.amountCents, 0)
  );
}

function failedRefundCents(row: BookingLedgerCensusRow): number {
  return row.refunds.filter((refund) => !isRecordedRefundStatus(refund.status)).reduce((sum, refund) => sum + refund.amountCents, 0);
}

/**
 * A completed CHARGE share the booking's price does not carry: no stand-in
 * `AGREED_ADJUSTMENT` records it, AND no closure re-price moved the price by
 * it (a `PRICE_REBASE` history row whose lines net to the share; one re-price
 * carries one share). Only those can explain an ask the ledger does not.
 */
export function retainedChargeShareCents(row: BookingLedgerCensusRow): number {
  const rebaseMovements = row.modifications
    .filter((modification) => modification.modificationType === "PRICE_REBASE")
    .map((modification) =>
      row.lines.filter((line) => line.anchorKind === "MODIFICATION" && line.anchorId === modification.id).reduce((sum, line) => sum + line.amountCents, 0),
    );
  let retained = 0;
  for (const task of row.tasks) {
    const share = task.amountCents ?? 0;
    if (task.kind !== "EDIT_FINANCIAL_REVIEW" || task.status !== "COMPLETED" || task.settlementDirection !== "CHARGE_TO_MEMBER" || share <= 0) continue;
    const standIn = row.lines.some(
      (line) => line.kind === "AGREED_ADJUSTMENT" && line.anchorKind === "REVIEW_TASK" && line.anchorId === task.id && line.reversesLineId === null,
    );
    if (standIn) continue;
    const carried = rebaseMovements.indexOf(share);
    if (carried >= 0) {
      rebaseMovements.splice(carried, 1);
      continue;
    }
    retained += share;
  }
  return retained;
}

// ---------------------------------------------------------------------------
// Components, one function per identity, in that identity's delta terms
// ---------------------------------------------------------------------------

export function capturedComponents(row: BookingLedgerCensusRow): ResidualComponent[][] {
  return [[{ name: "NOTHING_CAPTURED", cents: nothingCapturedFaceCents(row) }]];
}

export function creditAppliedComponents(row: BookingLedgerCensusRow): ResidualComponent[][] {
  const cap = xeroCapEvidence(row);
  const unpostedApplied = unpostedCredits(row)
    .filter((credit) => credit.type === "BOOKING_APPLIED")
    .reduce((sum, credit) => sum - credit.amountCents, 0);
  return [
    [{ name: "CREDIT_MIRROR_XERO_CAP", cents: cap ? cap.cappedCents - cap.appliedCents : 0 }],
    [{ name: "KNOWN_DEFECT_HISTORY", cents: -cardDoublePayCents(row), detail: "#1641" }],
    [{ name: "UNPOSTED_CREDIT", cents: unpostedApplied }],
  ];
}

/** What raised `refundedAmountCents` that is not a `CARD_REFUND` line (design §5.2, `INV-MONEY-034`). */
export function refundedComponents(row: BookingLedgerCensusRow): ResidualComponent[][] {
  const unpostedAllocations = unpostedCredits(row)
    .filter((credit) => isAllocatingCredit(row, credit))
    .reduce((sum, credit) => sum + credit.amountCents, 0);
  const base: ResidualComponent[] = [
    { name: "REFUND_MIRROR_HAND_BACK", cents: handBackCents(row) },
    { name: "V3_LEGACY_HAND_BACK", cents: v3Cents(row) },
    { name: "REFUND_MIRROR_CREDIT_ALLOCATION", cents: creditAllocationCents(row) },
    { name: "REFUND_MIRROR_LEGACY_SEED", cents: legacySeedCents(row) },
    { name: "UNPOSTED_CREDIT", cents: unpostedAllocations },
  ];
  // A refund that failed after it was counted: subtracted again since #3640
  // (so absent from the residual), still counted before it (so all of it).
  return [base, [...base, { name: "REFUND_MIRROR_FAILED_REFUND", cents: failedRefundCents(row) }]];
}

/** Fees an edit charged that no `CHANGE_FEE` line records, and fees a cancellation took back. */
export function changeFeeComponents(row: BookingLedgerCensusRow, unpostedChangeFeeCents: number): ResidualComponent[][] {
  const reversedByCancellation =
    row.booking.status === "CANCELLED"
      ? -row.lines
          .filter((line) => line.kind === "CHANGE_FEE" && line.anchorKind === "CANCELLATION" && line.reversesLineId !== null)
          .reduce((sum, line) => sum + line.amountCents, 0)
      : 0;
  return [
    [
      { name: "CHANGE_FEE_REVERSED_BY_CANCELLATION", cents: reversedByCancellation },
      { name: "UNPOSTED_CHANGE_FEE", cents: unpostedChangeFeeCents },
    ],
  ];
}

/** The ask a CHARGE share raised that the booking's price does not carry (LANE-SYNC on #3583, 30 Sep). */
export function additionalComponents(row: BookingLedgerCensusRow, owedCents: number, liveAsk: boolean): ResidualComponent[][] {
  const retained = liveAsk && owedCents <= 0 ? retainedChargeShareCents(row) : 0;
  return [[{ name: "RETAINED_REVIEW_SHARE", cents: retained }]];
}

/**
 * A live booking's owed(b) against what its columns say is owed
 * (`INV-PAY-047`'s residual plus the ask). Each component is the SAME evidence
 * a column identity uses, in owed terms: a column-only figure moves the
 * column side, a missing line the ledger side.
 */
export function liveOwedComponents(
  row: BookingLedgerCensusRow,
  unposted: { priceCents: number; changeFeeCents: number },
): ResidualComponent[][] {
  const cap = xeroCapEvidence(row);
  const base: ResidualComponent[] = [
    { name: "NOTHING_CAPTURED", cents: -nothingCapturedFaceCents(row) },
    { name: "CREDIT_MIRROR_XERO_CAP", cents: cap ? cap.appliedCents - cap.cappedCents : 0 },
    { name: "KNOWN_DEFECT_HISTORY", cents: cardDoublePayCents(row), detail: "#1641" },
    { name: "V3_LEGACY_HAND_BACK", cents: v3Cents(row) },
    { name: "REFUND_MIRROR_LEGACY_SEED", cents: legacySeedCents(row) },
    { name: "UNPOSTED_EDIT", cents: unposted.priceCents },
    { name: "UNPOSTED_CHANGE_FEE", cents: unposted.changeFeeCents },
    { name: "UNPOSTED_CREDIT", cents: unpostedCredits(row).reduce((sum, credit) => sum + credit.amountCents, 0) },
  ];
  return [base, [...base, { name: "REFUND_MIRROR_FAILED_REFUND", cents: failedRefundCents(row) }]];
}

/**
 * A cancelled booking's `owed(b)` once its refunds have posted is zero; these
 * are the named reasons it is not yet, each in delta terms (`0 − owed`).
 */
export function cancelledOwedComponents(row: BookingLedgerCensusRow): ResidualComponent[][] {
  const nonCardPayment = row.payment !== null && row.payment.source !== "STRIPE";
  const handBacks = (status: ManualRefundTaskStatus) =>
    nonCardPayment
      ? row.tasks
          .filter((task) => task.kind === "CANCELLED_BOOKING_HAND_BACK" && task.status === status)
          .reduce((sum, task) => sum + (task.amountCents ?? 0), 0)
      : 0;
  const inFlightRefund = row.recoveryOperations
    .filter(
      (operation) =>
        (operation.type === "REFUND_BOOKING_MODIFICATION" || operation.type === "REFUND_SUPERSEDED_PAYMENT") &&
        (operation.status === "PENDING" || operation.status === "PROCESSING"),
    )
    .reduce((sum, operation) => sum + operation.amountCents, 0);
  // V5: the card refund plan paid less than the policy refund the snapshot froze.
  const cancelRefundKey = buildBookingCancellationRefundIdempotencyKey(row.booking.id);
  const plannedCents = row.recoveryOperations
    .filter((operation) => operation.idempotencyKey === cancelRefundKey)
    .reduce((sum, operation) => sum + operation.amountCents, 0);
  const policyRefundCents = row.cancellation?.refundMethod === "card" ? (row.cancellation.settledAmountCents ?? 0) : 0;
  const v5 = Math.max(0, policyRefundCents - plannedCents);
  return [
    [
      { name: "IN_FLIGHT_HAND_BACK", cents: handBacks("OPEN") },
      { name: "D2_DISMISSED_HAND_BACK", cents: handBacks("DISMISSED") },
      { name: "IN_FLIGHT_REFUND", cents: inFlightRefund },
      { name: "V5_PLANNED_REFUND_SHORT", cents: v5 },
      { name: "UNPOSTED_CREDIT", cents: unpostedCredits(row).reduce((sum, credit) => sum + credit.amountCents, 0) },
      ...knownDefectHistory(row),
    ],
  ];
}

/**
 * #3791 and #3792, by shape (the plan comment's owner decision 1). On these
 * bookings the ledger is RIGHT: it records a real over-return or a real loss.
 */
function knownDefectHistory(row: BookingLedgerCensusRow): ResidualComponent[] {
  const bookingId = row.booking.id;
  const applied = sumKinds(row.lines, ["CREDIT_APPLIED"]);
  const found: ResidualComponent[] = [];

  // #3791, pre-fix evidence: on a credit-only booking a review share refunded
  // as credit was MINTED (a BOOKING_MODIFICATION_REFUND row, which the fix no
  // longer writes for money given back), beside the full applied figure, so
  // the cancellation's restore — at any tier — paid it again. owed = +the share.
  const mints = row.credits.filter((credit) => credit.type === "BOOKING_MODIFICATION_REFUND" && credit.sourceBookingId === bookingId);
  const refundShares = row.tasks
    .filter((task) => task.kind === "EDIT_FINANCIAL_REVIEW" && task.status === "COMPLETED" && task.settlementDirection === "REFUND_TO_MEMBER")
    .map((task) => task.amountCents ?? 0);
  const everyMintIsAShare =
    mints.length > 0 &&
    mints.every((mint) => {
      const at = refundShares.indexOf(mint.amountCents);
      if (at < 0) return false;
      refundShares.splice(at, 1);
      return true;
    });
  if (sumKinds(row.lines, CAPTURE_KINDS) === 0 && applied > 0 && everyMintIsAShare) {
    found.push({ name: "KNOWN_DEFECT_HISTORY", cents: -mints.reduce((sum, mint) => sum + mint.amountCents, 0), detail: "#3791" });
  }

  // #3792: internet banking, the cash minted as credit, applied credit never
  // restored. owed = −Σ CREDIT_APPLIED.
  const receipts = sumKinds(row.lines, ["BANK_RECEIPT"]);
  if (
    row.payment?.source === "INTERNET_BANKING" &&
    receipts > 0 &&
    applied > 0 &&
    !row.credits.some((credit) => credit.restoredFromBookingId === bookingId) &&
    row.credits.some(
      (credit) =>
        credit.type === "CANCELLATION_REFUND" &&
        credit.sourceBookingId === bookingId &&
        credit.restoredFromBookingId === null &&
        credit.amountCents === receipts,
    )
  ) {
    found.push({ name: "KNOWN_DEFECT_HISTORY", cents: applied, detail: "#3792" });
  }
  return found;
}

/** `GROUP_SETTLEMENT_OFF_LEDGER`: money that moved only through the organiser's settlement. */
export function isGroupSettlementOffLedger(row: BookingLedgerCensusRow): boolean {
  return (
    row.booking.organiserSettled &&
    row.lines.length === 0 &&
    row.transactions.length === 0 &&
    row.refunds.length === 0
  );
}
