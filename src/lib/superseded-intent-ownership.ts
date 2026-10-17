/**
 * WHICH CARD CAPTURES THE SUPERSEDED-INTENT MACHINERY OWNS (#1992, #4177).
 *
 * The superseded-intent machinery (booking-payment-cleanup queues a
 * CANCEL_PAYMENT_INTENT recovery operation; when the cancel loses to a late
 * capture, payment-recovery's handoff marks that transaction SUCCEEDED and
 * queues a REFUND_SUPERSEDED_PAYMENT operation for the cron) transiently
 * produces a SUCCEEDED PRIMARY Stripe capture with net cash that no settlement
 * ever passed through. Its money is already spoken for — the recovery cron
 * will refund it under its `payment_recovery_refund_<txn>_<pi>` key — so it is
 * never "the capture that settled the booking":
 *
 * - the duplicate-capture refund (`markBookingPaymentSucceeded`, guards b′ and
 *   c′) would otherwise refund the REAL settlement as the duplicate and, once
 *   the cron also refunds the superseded capture, leave the booking PAID at
 *   zero net cash;
 * - the Xero second-instrument conflict (`findSecondInstrumentSettlement`),
 *   on a PAID / COMPLETED booking, would otherwise name a capture that is
 *   going back to the member, where the duplicate-capture refund names the
 *   real settlement (#4177). Never on a CANCELLED booking: there the new bank
 *   cash has nowhere to go, so every capture still counts.
 *
 * One home for the operation types and the refund's liveness. The two readers
 * fail safe in opposite directions, so they read a CANCEL_PAYMENT_INTENT
 * operation differently:
 *
 * - guards (b′) and (c′) (`listLiveSupersededIntentIds`,
 *   `findLiveSupersededIntentOperation`) treat any operation not SUCCEEDED as
 *   live. Wrongly skipping a capture there costs nothing; wrongly counting one
 *   refunds the real settlement;
 * - the Xero conflict (`listSupersededIntentIdsOwningCaptures`) counts a cancel
 *   operation only while it is in flight
 *   (`PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE`). A dead cancel with no
 *   refund operation behind it has handed the money to nobody, and wrongly
 *   skipping that capture would hide a booking paid twice. A refund operation
 *   still counts until it SUCCEEDED, dead or not: its machinery alerted the
 *   admins. So does a capture whose superseded refund succeeded, while an
 *   open card refund row owes money back on it again after a refund Stripe
 *   failed later, dead or not (`supersededRefundsOwedAgain`, #4221).
 *
 * Under (b′) and (c′) a superseded-machinery operation counts as LIVE while it
 * is not SUCCEEDED:
 * PENDING, PROCESSING and FAILED (retrying or exhausted, where the money is
 * still adjudicated to that machinery and admins were alerted). A SUCCEEDED
 * cancel operation either actually cancelled the intent (its transaction is
 * FAILED — never a settled capture) or handed off to a refund operation that
 * is enqueued BEFORE the cancel operation completes; a SUCCEEDED refund
 * operation leaves the transaction REFUNDED, which holds no net cash. So
 * `status != SUCCEEDED` across both types covers the handoff window itself.
 * It does not cover what follows: when Stripe fails a SUCCEEDED refund later,
 * the capture holds net cash again with no live operation of these types, and
 * (b′) and (c′) count it as a settling capture. The Xero reader covers that
 * gap through the open row that owes the failed refund again - a failed-later
 * row, or a slice re-planned on an open card refund row (#4221); the two
 * readers differ there until #4227.
 */
import {
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  type Prisma,
} from "@prisma/client";
import { OPEN_CARD_REFUND_OPERATION_WHERE, parseRefundAllocationPlan } from "@/lib/open-card-refund-owed";
import { PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE } from "@/lib/payment-recovery-constants";
import {
  CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX,
  cardRefundFailedLaterRefundId,
} from "@/lib/payment-recovery-keys";
import { exactPrefix } from "@/lib/prisma-exact-prefix";

export const SUPERSEDED_INTENT_OPERATION_TYPES = [
  PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
  PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
] as const;

type RecoveryOperationReader = Pick<Prisma.TransactionClient, "paymentRecoveryOperation">;

/** The one liveness predicate both reads below share. */
function liveSupersededOperation() {
  return {
    type: { in: [...SUPERSEDED_INTENT_OPERATION_TYPES] },
    status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
  } satisfies Prisma.PaymentRecoveryOperationWhereInput;
}

/**
 * Guard (b′): every intent id on this payment whose money a live
 * superseded-intent recovery operation already owns. Read under lock(1), which
 * every caller already holds.
 */
export async function listLiveSupersededIntentIds(
  tx: RecoveryOperationReader,
  paymentId: string
): Promise<string[]> {
  const operations = await tx.paymentRecoveryOperation.findMany({
    where: { paymentId, ...liveSupersededOperation() },
    select: { paymentIntentId: true },
  });
  return [...new Set(operations.map((operation) => operation.paymentIntentId))];
}

/**
 * Guard (c′), belt-and-braces sibling of (b′) with a deliberately DIFFERENT
 * query shape (direct intent-id lookup, not scoped to a payment): does a live
 * superseded-intent recovery operation own this specific intent's money? The
 * duplicate-capture refund re-checks its matched "settlement" with it, so even
 * a candidate that slipped the (b′) exclusion leaves the arriving capture
 * plain `already_paid`.
 */
export async function findLiveSupersededIntentOperation(
  tx: RecoveryOperationReader,
  paymentIntentId: string
) {
  return tx.paymentRecoveryOperation.findFirst({
    where: { paymentIntentId, ...liveSupersededOperation() },
    select: { id: true },
  });
}

/** A row the Xero reader reads: the superseded machinery's, or an open card refund row. */
type OwnershipRow = {
  type: PaymentRecoveryOperationType;
  status: PaymentRecoveryOperationStatus;
  paymentIntentId: string;
  paymentTransactionId: string | null;
  idempotencyKey: string;
  allocationPlan: unknown;
};

/**
 * #4221: the rows `supersededRefundsOwedAgain` reads - every superseded refund
 * operation, whatever its status (a SUCCEEDED one is the refund Stripe can
 * fail later), every OPEN failed-later row (`card_refund_failed_later_*`,
 * #4104), and every OPEN card refund row, whose plan a failure re-plans
 * (`OPEN_CARD_REFUND_OPERATION_WHERE`, the rows `keepFailedLaterCardRefundOwed`
 * re-plans). Open means live, or dead for the treasurer; a SUCCEEDED one was
 * made or closed as paid another way. The failed-later rows are open card
 * refund rows today; they are read by their key too, so the key's rule, not
 * the row's type, decides. Scoped to a payment: a re-planned slice names its
 * capture by transaction, on a row that may sit on another intent.
 */
const SUPERSEDED_REFUND_OWED_AGAIN_WHERE = [
  { type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT },
  {
    idempotencyKey: exactPrefix(CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX),
    status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
  },
  OPEN_CARD_REFUND_OPERATION_WHERE,
] satisfies Prisma.PaymentRecoveryOperationWhereInput[];

/**
 * #4221: every capture whose money is owed back again after its superseded
 * refund, on a capture a superseded refund operation exists for:
 *
 * - an open failed-later row whose OWN `paymentIntentId` is the capture (the
 *   intent Stripe's failed refund named, as `late-capture-paid-another-way`
 *   keys it). Rows carry the failed-later key's own rule
 *   (`cardRefundFailedLaterRefundId`, #4146), not just its prefix;
 * - an open card refund row with a slice on the capture's transaction (the
 *   superseded refund's `paymentTransactionId`) that a refund Stripe failed
 *   later re-planned (`failedRefundIds`) and that is not made again
 *   (`madeRefundId`). That row sends it again; no failed-later row is raised.
 *
 * It does not ask which refund failed. Once a superseded refund on the capture
 * succeeded, cash the capture holds again came back from a refund Stripe
 * failed later, whichever door sent it. A failure the club owes again
 * (`keepFailedLaterCardRefundOwed`) either raises a failed-later row on the
 * failed refund's intent or re-plans the open row's slice that made it; while
 * that row is open, the cash is on its way back to the member. A failure it
 * does not re-send - a refund made by hand in Stripe, `not-resent` - leaves
 * the capture counted, as it should: nothing owes that cash back.
 *
 * Pure over the rows `SUPERSEDED_REFUND_OWED_AGAIN_WHERE` reads, so guards
 * (b′) and (c′) can share it (#4227). That where decides which rows are
 * open: the one row it reads closed, a superseded refund, carries no
 * failed-later key and no plan (its enqueue writes none, and only an open
 * row's plan is re-planned).
 */
function supersededRefundsOwedAgain(rows: readonly OwnershipRow[]): Set<string> {
  const supersededRefunds = rows.filter((row) => row.type === PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT);
  const superseded = new Set(supersededRefunds.map((row) => row.paymentIntentId));
  const owed = new Set<string>();
  // Every row but a superseded refund is open: the where reads no other.
  for (const row of rows) {
    if (cardRefundFailedLaterRefundId(row.idempotencyKey) !== null && superseded.has(row.paymentIntentId)) {
      owed.add(row.paymentIntentId);
    }
  }
  const replannedTransactions = new Set(
    rows.flatMap((row) =>
      (parseRefundAllocationPlan(row.allocationPlan) ?? [])
        .filter((slice) => (slice.failedRefundIds?.length ?? 0) > 0 && !slice.madeRefundId)
        .map((slice) => slice.paymentTransactionId),
    ),
  );
  for (const refund of supersededRefunds) {
    if (refund.paymentTransactionId !== null && replannedTransactions.has(refund.paymentTransactionId)) {
      owed.add(refund.paymentIntentId);
    }
  }
  return owed;
}

/**
 * The Xero second-instrument conflict's reading (#4177): every intent id on
 * this payment whose captured money a superseded-intent operation still holds
 * for the member - a REFUND_SUPERSEDED_PAYMENT not yet SUCCEEDED, a
 * CANCEL_PAYMENT_INTENT still in flight, or (#4221) a capture owed back again
 * after its superseded refund (`supersededRefundsOwedAgain`). See the module
 * comment for why a dead cancel does not count here while it does for (b′); a
 * dead row that owes a failed refund again counts, since it still owes the
 * member. Read under lock(1).
 */
export async function listSupersededIntentIdsOwningCaptures(
  tx: RecoveryOperationReader,
  paymentId: string
): Promise<string[]> {
  const operations: OwnershipRow[] = await tx.paymentRecoveryOperation.findMany({
    where: {
      paymentId,
      OR: [
        ...SUPERSEDED_REFUND_OWED_AGAIN_WHERE,
        {
          type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
          AND: [PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE],
        },
      ],
    },
    select: {
      type: true,
      status: true,
      paymentIntentId: true,
      paymentTransactionId: true,
      idempotencyKey: true,
      allocationPlan: true,
    },
  });
  const owned = supersededRefundsOwedAgain(operations);
  for (const operation of operations) {
    // A failed-later row counts only through `supersededRefundsOwedAgain`, as
    // does an open edit or cancel refund row, which no branch below matches.
    if (cardRefundFailedLaterRefundId(operation.idempotencyKey) !== null) continue;
    if (operation.type === PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT) {
      // Only an in-flight cancel is read.
      owned.add(operation.paymentIntentId);
    } else if (
      operation.type === PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT &&
      operation.status !== PaymentRecoveryOperationStatus.SUCCEEDED
    ) {
      owned.add(operation.paymentIntentId);
    }
  }
  return [...owned];
}
