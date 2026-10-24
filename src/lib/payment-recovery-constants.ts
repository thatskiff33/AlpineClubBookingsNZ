import type { PaymentRecoveryOperationStatus, Prisma } from "@prisma/client";

// Shared payment-recovery constants kept in a dependency-light module so health
// and visibility code can reuse them without importing the full payment-recovery
// service (which pulls in Stripe and the email/transaction layers).

// A recovery operation is retried while attempts < this maximum; once attempts
// reach it the operation is terminal and will never be reclaimed.
export const MAX_PAYMENT_RECOVERY_ATTEMPTS = 5;

/**
 * #4126 (`INV-SSOT`): a pre-persisted door's row no worker has touched - still
 * PENDING, never attempted. The runner's claim (PENDING -> PROCESSING, attempts
 * + 1) ends it, and from then the runner owns the row. The door's
 * compare-and-set (`untouchedPrePersistedRowWhere`) and the reads
 * (`isUntouchedPrePersistedRow`) both spell it from here.
 */
export const UNTOUCHED_PRE_PERSISTED_ROW = { status: "PENDING", attempts: 0 } as const satisfies {
  status: PaymentRecoveryOperationStatus;
  attempts: number;
};

export function isUntouchedPrePersistedRow(row: { status: PaymentRecoveryOperationStatus; attempts: number }): boolean {
  return row.status === UNTOUCHED_PRE_PERSISTED_ROW.status && row.attempts === UNTOUCHED_PRE_PERSISTED_ROW.attempts;
}

/**
 * IS A RECOVERY OPERATION STILL IN FLIGHT — will the runner still make it?
 * (#3854 K1): `PENDING` and `PROCESSING`, and a `FAILED` row with a retry
 * still scheduled (`nextRetryAt` set) and attempts left. A `FAILED` row with
 * no retry scheduled, or at the attempt ceiling, is DEAD: the money it was to
 * move will not move without a person, so it is never read as in flight.
 *
 * `PENDING` counts REGARDLESS of `nextRetryAt`, deliberately: the runner's
 * claim additionally requires `nextRetryAt <= now` (`claimPaymentRecoveryOperation`),
 * but a `PENDING` row is one enqueued or re-armed to run, not one the runner
 * gave up on, and this predicate answers "not yet dead", not "claimable this
 * instant". Except with its attempts spent (#4104 review, CL5): a card refund
 * Stripe failed later that is raised dead for the treasurer is written
 * `PENDING` at the attempt ceiling, which no claim takes again.
 *
 * Its readers: the booking-ledger projection census — the in-flight refund
 * class (`booking-ledger-projection-census-classes.ts`) and the snapshot's
 * per-operation flag (`booking-ledger-projection-census-store.ts`) - and the
 * refund-requests screen's retrying-or-dead read of an approved appeal's card
 * refund (`refund-appeal-outcome.ts`, #4117), and the booking and payment-link
 * pages' read of a cancel's card refund row - on its way or stalled
 * (`cardRefundRowState`, `cancel-card-refund-shortfall-status.ts`, #4125). Two
 * readers deliberately use a different rule and do not route through this:
 * `isEditFinancialReviewChargeRecoveryDead` (`payment-recovery.ts`, #3402) and
 * `unfinishedCardRefundDebts` (`edit-financial-review-cancel-netting.ts`,
 * #3835, its Prisma-filter twin) read a row in a claimable status (`PENDING`
 * OR `FAILED`) with no retry time or its attempts spent as DEAD — the re-arm
 * leaves such a row (`INV-PAY-057`), so for them a stranded `PENDING` row is a
 * person's to settle, where this predicate still counts it in flight. A third
 * reader routes through this one and adds that rule beside it: the card refund
 * shortfall's completion guard (`cardShortfallSettlement`,
 * `cancel-card-refund-shortfall-settle.ts`, #4097) reads a claimable row at the
 * attempt ceiling as stopped - the "Paid another way" close's own rule
 * (`deadCardRefundOperationWhere`) - so its refusal points at that close
 * rather than at a retry that will never come.
 */
export function isPaymentRecoveryOperationInFlight(operation: {
  status: PaymentRecoveryOperationStatus;
  attempts: number;
  nextRetryAt: Date | null;
}): boolean {
  if (operation.status === "PROCESSING") return true;
  // #4104 review (CL5): a card refund raised dead is PENDING with its attempts
  // spent (`isPaymentRecoveryOperationExhausted`) - never run again, so not in flight.
  if (operation.status === "PENDING") return operation.attempts < MAX_PAYMENT_RECOVERY_ATTEMPTS;
  return operation.status === "FAILED" && operation.nextRetryAt !== null && operation.attempts < MAX_PAYMENT_RECOVERY_ATTEMPTS;
}

/**
 * #4036 review: {@link isPaymentRecoveryOperationInFlight} as a Prisma filter,
 * for a reader that must find the in-flight rows in the database. Its twin, not
 * a second rule: the reader still applies the predicate to what it reads, and
 * `payment-recovery-constants.test.ts` holds the two to the same rows.
 */
export const PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE = {
  OR: [
    { status: "PROCESSING" },
    { status: "PENDING", attempts: { lt: MAX_PAYMENT_RECOVERY_ATTEMPTS } },
    { status: "FAILED", nextRetryAt: { not: null }, attempts: { lt: MAX_PAYMENT_RECOVERY_ATTEMPTS } },
  ],
} satisfies Prisma.PaymentRecoveryOperationWhereInput;

/**
 * #4104 review (ops 7): a recovery the runner will never claim again - in a
 * claimable status with its attempts spent - as a Prisma filter. A card refund
 * raised dead (`card-refund-failed-later.ts`) is PENDING with its attempts
 * spent, so "exhausted" is read on both statuses, and a queue that is only
 * waiting on dead rows is not a stalled cron (`PAYMENT_RECOVERY_CLAIMABLE_LATER_WHERE`).
 */
export const PAYMENT_RECOVERY_EXHAUSTED_WHERE = {
  status: { in: ["PENDING", "FAILED"] },
  attempts: { gte: MAX_PAYMENT_RECOVERY_ATTEMPTS },
} satisfies Prisma.PaymentRecoveryOperationWhereInput;

/** The other side of it: a row the runner's claim can still take, once its retry time comes. */
export const PAYMENT_RECOVERY_CLAIMABLE_LATER_WHERE = {
  attempts: { lt: MAX_PAYMENT_RECOVERY_ATTEMPTS },
  nextRetryAt: { not: null },
} satisfies Prisma.PaymentRecoveryOperationWhereInput;

/**
 * A recovery row put back to run from the start, due now: PENDING, attempts
 * reset, its last error and claim cleared. The re-arms write it, each fenced
 * on the rows it may reopen: an edit's review charge
 * (`rearmEditFinancialReviewChargeRecovery`) and a dead cancellation a
 * mark-paid's reversal still needs (`withdrawManualSettlementIntentCancellations`, #4320).
 */
export function rearmedPaymentRecoveryOperationData(now: Date) {
  return {
    status: "PENDING",
    attempts: 0,
    nextRetryAt: now,
    lastError: null,
    processingStartedAt: null,
    succeededAt: null,
  } as const satisfies Prisma.PaymentRecoveryOperationUpdateManyMutationInput;
}

/**
 * #4104 review (CL4, `INV-SSOT`): {@link PAYMENT_RECOVERY_EXHAUSTED_WHERE} as a
 * predicate - the one "dead" rule of a card refund row: the "Paid another way"
 * close's claim (`deadCardRefundOperationWhere`), the card refund shortfall's
 * "stopped" refusal and the failed-later re-plan's outcome all ask it. A
 * `FAILED` row with no retry time has its attempts spent too: the worker's
 * failure is terminal exactly at the ceiling (`failPaymentRecoveryOperation`).
 */
export function isPaymentRecoveryOperationExhausted(operation: {
  status: PaymentRecoveryOperationStatus | string;
  attempts: number;
}): boolean {
  return (operation.status === "PENDING" || operation.status === "FAILED") && operation.attempts >= MAX_PAYMENT_RECOVERY_ATTEMPTS;
}
