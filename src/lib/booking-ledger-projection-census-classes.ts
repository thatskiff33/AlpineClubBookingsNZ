/**
 * THE NAMED CLASSES OF THE BOOKING-LEDGER PROJECTION CENSUS, AND THE SNAPSHOT
 * IT READS (#3583, `INV-MONEY-037`; design `docs/design/booking-ledger.md` §6).
 *
 * The census compares each money column with the ledger lines that project it.
 * Where the two differ by design — a column with another derivation, a refund
 * still in flight, a decision a person took — the difference is NAMED here,
 * and each name is a figure computed from the booking's own rows. A residual is
 * classified only when it equals, to the cent, the sum of the components this
 * module finds for it; anything else is a disagreement. That is the rule that
 * keeps a class from swallowing drift: a class explains an exact amount, never
 * a direction or a shape.
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

import { cancellationCreditDescription } from "@/lib/cancellation-settled-money";
import { buildBookingCancellationRefundIdempotencyKey } from "@/lib/payment-recovery-keys";
import { isCapturedTransactionStatus, isRecordedRefundStatus } from "@/lib/payment-transaction-status";

// ---------------------------------------------------------------------------
// The two pending owner decisions (#3583's plan comment). Each is ONE line.
// ---------------------------------------------------------------------------

export const BOOKING_LEDGER_CENSUS_GATE_POLICY = {
  /**
   * Owner decision 1, recommended A: bookings already damaged by #3791 or
   * #3792 are listed under `KNOWN_DEFECT_HISTORY` and HOLD the gate until each
   * is corrected by an officer or written off with the owner's acknowledgement.
   * `false` is option B: acknowledged as a class that does not hold the gate.
   */
  knownDefectHistoryHoldsGate: true,
  /**
   * Owner decision 2, recommended A: a group-booking child settled through
   * `GroupBookingSettlement` is named `GROUP_SETTLEMENT_OFF_LEDGER` and does not
   * hold the gate (its poster is a separate issue). `true` would hold it.
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
  /** The paid path's CANCELLED event snapshot (`writePaidCancellationEvent`), or null. */
  cancellation: { refundMethod: string | null; settledAmountCents: number | null } | null;
  lines: readonly CensusLedgerLine[];
};

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export const BOOKING_LEDGER_CENSUS_CLASSES = [
  "NOTHING_CAPTURED",
  "CREDIT_MIRROR_MANUAL_SETTLE",
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
// Ledger figures every predicate shares
// ---------------------------------------------------------------------------

export const CAPTURE_KINDS = ["CARD_CAPTURE", "BANK_RECEIPT", "CASH_RECORDED"] as const satisfies readonly LedgerLineKind[];

export function sumKinds(lines: readonly CensusLedgerLine[], kinds: readonly LedgerLineKind[]): number {
  let total = 0;
  for (const line of lines) if (kinds.includes(line.kind)) total += line.amountCents;
  return total;
}

/** Credit applied to the booking by its rows: `deriveBookingAppliedCreditCents`'s sum, unfloored. */
export function appliedRowsCents(row: BookingLedgerCensusRow): number {
  return -row.credits
    .filter((credit) => credit.type === "BOOKING_APPLIED" && credit.appliedToBookingId === row.booking.id)
    .reduce((sum, credit) => sum + credit.amountCents, 0);
}

function restoreRow(row: BookingLedgerCensusRow) {
  return row.credits.find((credit) => credit.restoredFromBookingId === row.booking.id) ?? null;
}

function capturedTransactions(row: BookingLedgerCensusRow) {
  return row.transactions.filter((txn) => isCapturedTransactionStatus(txn.status) && txn.amountCents > 0);
}

/** A completed `EDIT_FINANCIAL_REVIEW` CHARGE share no `AGREED_ADJUSTMENT` records (design §5.3). */
export function retainedChargeShareCents(row: BookingLedgerCensusRow): number {
  return row.tasks
    .filter(
      (task) =>
        task.kind === "EDIT_FINANCIAL_REVIEW" &&
        task.status === "COMPLETED" &&
        task.settlementDirection === "CHARGE_TO_MEMBER" &&
        (task.amountCents ?? 0) > 0 &&
        !row.lines.some(
          (line) =>
            line.kind === "AGREED_ADJUSTMENT" &&
            line.anchorKind === "REVIEW_TASK" &&
            line.anchorId === task.id &&
            line.reversesLineId === null,
        ),
    )
    .reduce((sum, task) => sum + (task.amountCents ?? 0), 0);
}

// ---------------------------------------------------------------------------
// Components, one function per identity
// ---------------------------------------------------------------------------

/** `amountCents` with nothing captured is the latest primary's face amount (`reconcilePaymentAggregates`). */
export function capturedComponents(
  row: BookingLedgerCensusRow,
  ledgerCents: number,
  latestPrimaryAmountCents: number | null,
): ResidualComponent[][] {
  const nothingCaptured =
    ledgerCents === 0 && capturedTransactions(row).length === 0 && latestPrimaryAmountCents !== null;
  return [[{ name: "NOTHING_CAPTURED", cents: nothingCaptured ? latestPrimaryAmountCents : 0 }]];
}

/**
 * The two derivations of `creditAppliedCents` that are not the applied-row sum
 * (design §6). Each is named only where the LEDGER agrees with the credit rows,
 * so the class can only ever explain the column, never a missing line.
 */
export function creditAppliedComponents(row: BookingLedgerCensusRow, ledgerCents: number): ResidualComponent[][] {
  const payment = row.payment;
  const applied = appliedRowsCents(row);
  if (!payment || ledgerCents !== applied) return [];
  // The settle's own split of the captured amount into cash and credit.
  const settleDerived = Math.max(0, row.booking.finalPriceCents - payment.amountCents);
  // The Xero allocation repair's write, capped at the payment amount.
  const appliedFloor = Math.max(0, applied);
  const capped = appliedFloor > payment.amountCents ? payment.amountCents : null;
  return [
    [{ name: "CREDIT_MIRROR_MANUAL_SETTLE", cents: settleDerived - ledgerCents }],
    [{ name: "CREDIT_MIRROR_XERO_CAP", cents: capped === null ? 0 : capped - ledgerCents }],
  ];
}

const LEGACY_BACKFILL_REASONS = new Set(["legacy_primary_backfill", "legacy_additional_backfill"]);

/** What raised `refundedAmountCents` that is not a `CARD_REFUND` line (design §5.2, `INV-MONEY-034`). */
export function refundedComponents(row: BookingLedgerCensusRow): ResidualComponent[][] {
  const bookingId = row.booking.id;
  const handBack = -sumKinds(row.lines, ["BANK_REFUND"]);
  const v3 = row.tasks
    .filter(
      (task) =>
        task.kind === "DELETED_BOOKING_LATE_CAPTURE" &&
        task.status === "COMPLETED" &&
        task.lateCaptureApprovalIntentId === null &&
        row.payment !== null &&
        task.paymentId === row.payment.id &&
        row.payment.source === "STRIPE",
    )
    .reduce((sum, task) => sum + (task.amountCents ?? 0), 0);
  // Only the two writers that ran `applyLocalRefundAllocation` beside their row:
  // the cancel's credit branch (`createCancellationCredit`, its own description)
  // and a reduction credited to account. A restore and the Xero inbound mints
  // never moved the column.
  const creditAllocation = row.credits
    .filter(
      (credit) =>
        credit.sourceBookingId === bookingId &&
        credit.restoredFromBookingId === null &&
        ((credit.type === "CANCELLATION_REFUND" && credit.description === cancellationCreditDescription(bookingId)) ||
          credit.type === "BOOKING_MODIFICATION_REFUND"),
    )
    .reduce((sum, credit) => sum + credit.amountCents, 0);
  const legacyIds = new Set(row.transactions.filter((txn) => LEGACY_BACKFILL_REASONS.has(txn.reason ?? "")).map((txn) => txn.id));
  const legacySeed =
    row.transactions.filter((txn) => legacyIds.has(txn.id)).reduce((sum, txn) => sum + txn.refundedAmountCents, 0) -
    row.refunds
      .filter((refund) => refund.paymentTransactionId !== null && legacyIds.has(refund.paymentTransactionId) && isRecordedRefundStatus(refund.status))
      .reduce((sum, refund) => sum + refund.amountCents, 0);
  const failed = row.refunds.filter((refund) => !isRecordedRefundStatus(refund.status)).reduce((sum, refund) => sum + refund.amountCents, 0);
  const base: ResidualComponent[] = [
    { name: "REFUND_MIRROR_HAND_BACK", cents: handBack },
    { name: "V3_LEGACY_HAND_BACK", cents: v3 },
    { name: "REFUND_MIRROR_CREDIT_ALLOCATION", cents: creditAllocation },
    { name: "REFUND_MIRROR_LEGACY_SEED", cents: legacySeed },
  ];
  // A refund that failed after it was counted: subtracted again since #3640
  // (so absent from the residual), still counted before it (so all of it).
  return [base, [...base, { name: "REFUND_MIRROR_FAILED_REFUND", cents: failed }]];
}

/** Fees an edit charged that no `CHANGE_FEE` line records, and fees a cancellation took back. */
export function changeFeeComponents(
  row: BookingLedgerCensusRow,
  unpostedChangeFeeCents: number,
): ResidualComponent[][] {
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
  const policyRefundCents =
    row.cancellation?.refundMethod === "card" ? (row.cancellation.settledAmountCents ?? 0) : 0;
  const v5 = Math.max(0, policyRefundCents - plannedCents);
  return [
    [
      { name: "IN_FLIGHT_HAND_BACK", cents: handBacks("OPEN") },
      { name: "D2_DISMISSED_HAND_BACK", cents: handBacks("DISMISSED") },
      { name: "IN_FLIGHT_REFUND", cents: inFlightRefund },
      { name: "V5_PLANNED_REFUND_SHORT", cents: v5 },
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
  const restore = restoreRow(row);
  const found: ResidualComponent[] = [];

  // #3791: credit-only, a review share minted as credit with no captured
  // payment, the applied credit restored in full. owed = +the share.
  const mints = row.credits.filter((credit) => credit.type === "BOOKING_MODIFICATION_REFUND" && credit.sourceBookingId === bookingId);
  const refundShares = row.tasks
    .filter((task) => task.kind === "EDIT_FINANCIAL_REVIEW" && task.status === "COMPLETED" && task.settlementDirection === "REFUND_TO_MEMBER")
    .map((task) => task.amountCents ?? 0);
  const everyMintIsAShare = mints.length > 0 && mints.every((mint) => {
    const at = refundShares.indexOf(mint.amountCents);
    if (at < 0) return false;
    refundShares.splice(at, 1);
    return true;
  });
  if (
    sumKinds(row.lines, CAPTURE_KINDS) === 0 &&
    applied > 0 &&
    restore !== null &&
    restore.amountCents === applied &&
    everyMintIsAShare
  ) {
    found.push({ name: "KNOWN_DEFECT_HISTORY", cents: -mints.reduce((sum, mint) => sum + mint.amountCents, 0), detail: "#3791" });
  }

  // #3792: internet banking, the cash minted as credit, applied credit never
  // restored. owed = −Σ CREDIT_APPLIED.
  const receipts = sumKinds(row.lines, ["BANK_RECEIPT"]);
  if (
    row.payment?.source === "INTERNET_BANKING" &&
    receipts > 0 &&
    applied > 0 &&
    restore === null &&
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
