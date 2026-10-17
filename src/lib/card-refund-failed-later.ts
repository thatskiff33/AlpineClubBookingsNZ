/**
 * #4104 (`INV-PAY-128`): A CARD REFUND STRIPE ACCEPTED AND FAILED LATER IS OWED
 * AGAIN.
 *
 * Stripe can answer a refund `pending` and fail it days later (a closed card, an
 * issuer's refusal). A `pending` refund counts as made (`isRecordedRefundStatus`),
 * so the door that asked for it - a cancellation, an edit, an approved refund
 * request, the recovery runner - closed its debt or wrote none, and when the
 * refund failed only the payment's refunded total fell back. Nothing owed it.
 *
 * WHO SEES IT. The one writer of a transaction's refund rows
 * (`recordStripeRefundsAgainstTransaction`) is the only place a refund is seen
 * to fail after it counted (`recordStripeRefundLedgerEntry`'s `failedLater`):
 * its own guarded counted -> refused write (`transition`), or a caller told the
 * refund counts - a replayed key reads Stripe's original `pending` back - while
 * the row already says refused (`replayed`). Whoever sees it - the refund-failed
 * webhook, a `charge.refunded` sync, the payments cron's read-back, a door or
 * the runner replaying its key - decides here, in the same transaction, under
 * the Payment row lock that writer already holds.
 *
 * WHICH ROW OWES IT. One row, never two:
 *
 * - **Already owed**: a row of its own (`card_refund_failed_later_<refund>`), or
 *   an open row whose slice it already moved (`failedRefundIds`): nothing.
 * - **An open row that counted it as made** - the slice marked with it
 *   (`madeRefundId`), or the unmarked slice the owed figure fills with it
 *   (`cardRefundSliceFilledBy`, read as the payment stood before the failure)
 *   when the refund carries exactly the metadata that row's runner sends
 *   (`cardRefundOperationRefundMetadata`; #4104 review, CM - a refund another
 *   door or the Stripe dashboard made is never taken for the row's own, which
 *   the runner sends anyway): that slice is moved to its next key and records the failure
 *   (`failedRefundIds`), so the runner sends it again and "Refunds owed" counts
 *   it once. A row someone may be writing - a worker's attempt (`PROCESSING`),
 *   or one no worker has claimed yet (a door's inline attempt may still be
 *   closing or re-planning it) - is not touched: a `transition` fails and is
 *   retried (`FailedLaterRefundHeldError`); a `replayed` refund is read back to
 *   its caller as refused, since the caller is that row's door or worker and
 *   moves it itself (`INV-PAY-128`'s refusal path).
 * - **Otherwise** a new row, for exactly that refund's amount on its own charge,
 *   under a key Stripe has never seen. A closed row is never reopened: nothing
 *   ties its other slices to the refunds that made them.
 *
 * NEVER RE-SENT AUTOMATICALLY, raised dead (attempts spent) for the treasurer's
 * "Paid another way" (#3372) and alerted: a retry that failed later too (a card
 * that keeps taking refunds and failing them), and a refund no open row owes
 * that Stripe CREATED before this install could notice such failures
 * (`CARD_REFUND_FAILED_LATER_CUTOFF_MIGRATION`) - the treasurer may already have
 * paid it back by hand. A slice of an open row is re-planned whenever its
 * refund was made: that row is still being worked, and no close can have been
 * recorded on it. Not owed at all, only alerted and recorded in the audit log
 * (#4104 review, CL3): a refund whose Stripe metadata names no booking of this
 * payment (made by hand in the Stripe dashboard, or a legacy group refund).
 *
 * ALREADY SETTLED BY A "PAID ANOTHER WAY" CLOSE (#4210, `INV-PAY-136`): asked
 * first, before the no-booking rule, of every refund no open row owes
 * (`findPaidAnotherWayCloseThatSettled`, which says which close and why). A full
 * close's share raises nothing; what a part close gave up, or a refund whose
 * paid-twice row was marked Resolved, is raised dead for an officer to check.
 * Audited, and alerted through its own unmuteable mail.
 *
 * The officers are alerted once per decision, after the commit that made it
 * (`alertFailedLaterCardRefunds`).
 */
import {
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  type PaymentRecoveryOperation,
  type Prisma,
} from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import logger from "@/lib/logger";
import { readMigrationFinishedAt } from "@/lib/migration-finished-at";
import { CHECK_REASON_OF, findPaidAnotherWayCloseThatSettled, type SettlingPaidAnotherWayClose } from "@/lib/card-refund-failed-later-paid-another-way";
import { PAID_ANOTHER_WAY_CHECK_WHY, paidAnotherWayFailedLaterNote, type PaidAnotherWayFailedLaterOutcome } from "@/lib/card-refund-failed-later-paid-another-way-note";
import {
  CARD_REFUND_OPERATION_WHERE,
  cardRefundPaymentBeforeFailure,
  cardRefundSliceFilledBy,
  parseRefundAllocationPlan,
  type CardRefundOwedPaymentRow,
} from "@/lib/open-card-refund-owed";
import {
  isPaymentRecoveryOperationExhausted,
  isUntouchedPrePersistedRow,
  MAX_PAYMENT_RECOVERY_ATTEMPTS,
} from "@/lib/payment-recovery-constants";
import {
  buildCardRefundFailedLaterRecoveryKey,
  CARD_REFUND_FAILED_LATER_REASON,
  cardRefundOperationRefundMetadata,
  nextRefusedRefundKeySuffix,
} from "@/lib/payment-recovery-keys";
import type { PaidAnotherWayCheck } from "@/lib/open-card-refund-owed";
import { stripeReferenceId, type StripeReference } from "@/lib/stripe-references";
import { formatCents } from "@/lib/utils";

/**
 * The cutoff (#4104 review, ops 8): the migration that shipped this release.
 * A refund Stripe CREATED before it finished on this install that no open row
 * owes is raised dead, never re-sent: it may have failed while nothing here
 * could notice, and the treasurer may have paid it back by hand since. It
 * changes no schema.
 */
export const CARD_REFUND_FAILED_LATER_CUTOFF_MIGRATION = "20261115010000_card_refund_failed_later_cutoff";

/** The refund as the ledger writer has it: Stripe's object, or the part of it the writer reads. */
export type FailedLaterRefundInput = {
  id: string;
  amount: number;
  status?: string | null;
  created?: number | null;
  metadata?: Record<string, string> | null;
  payment_intent?: StripeReference;
};

/** How the ledger writer saw it fail (see the module comment). */
export type FailedLaterKind = "transition" | "replayed";

/** A decision about one failed-later refund, for the alert after commit. */
export type FailedLaterCardRefundDebt = {
  /**
   * `raised-dead`: a retry that failed too; `raised-backlog`: made before the
   * cutoff; `re-planned-dead`: moved on a row whose retries are already spent;
   * `not-resent`: not the club's refund for this booking - nothing is owed here;
   * #4210 (`PaidAnotherWayFailedLaterOutcome`): a "Paid another way" close had
   * settled it - nothing raised (`settled-paid-another-way`), or a dead row to
   * check for what a part close gave up or a resolved paid-twice row covered.
   */
  outcome: "raised" | "raised-dead" | "raised-backlog" | "re-planned" | "re-planned-dead" | "not-resent" | PaidAnotherWayFailedLaterOutcome;
  /** The row that owes it (for `settled-paid-another-way`, the row the close closed); none for `not-resent`. */
  operationId: string | null;
  bookingId: string;
  paymentIntentId: string | null;
  amountCents: number;
  stripeRefundId: string;
  /** #4210: the close that settled it (`findPaidAnotherWayCloseThatSettled`). */
  paidAnotherWay?: Omit<SettlingPaidAnotherWayClose, "outcome">;
};

/** What the ledger writer does next: the decisions to alert, and the refunds its caller must read as refused. */
export type FailedLaterDecisions = { debts: FailedLaterCardRefundDebt[]; readAsRefused: string[] };

/** A row someone may be writing owns this refund; the caller rolls back and is retried. */
export class FailedLaterRefundHeldError extends Error {
  constructor(stripeRefundId: string, operationId: string) {
    super(
      `Card refund ${stripeRefundId} failed after Stripe accepted it, and recovery ${operationId} is mid-attempt or not yet claimed; try again once it is (#4104)`,
    );
    this.name = "FailedLaterRefundHeldError";
  }
}

/** #4210: the audit summary's reason for a check row. */
const AUDIT_CHECK_WHY = {
  "raised-check-part-close": "a part close",
  "raised-check-resolved": "its paid-twice row was marked resolved",
  "raised-check-uncertain": "the app cannot tell whether the close paid it back",
} as const;

/** Where the treasurer closes a row the app will not ask Stripe for again (#4104 review, D1). */
const CLOSE_IT_WHERE = 'close it under "Card refunds Stripe gave up on" on the Stuck states page';

/** What the row says, for a person reading it; nothing parses it. */
function failedLaterLastError(refundId: string, outcome: FailedLaterCardRefundDebt["outcome"]): string {
  if (outcome === "raised-dead") {
    return `Stripe accepted retried refund ${refundId} and later reported it failed too. Not asked for again automatically: pay the member another way and ${CLOSE_IT_WHERE} (#4104).`;
  }
  if (outcome === "raised-backlog") {
    return `Stripe reported refund ${refundId} failed; it was made before this release could notice that, so it is not asked for again automatically. Check whether the member was paid back, then ${CLOSE_IT_WHERE} (#4104).`;
  }
  // #4210: what a "Paid another way" close may not have covered - a person decides.
  if (outcome === "raised-check-part-close" || outcome === "raised-check-resolved" || outcome === "raised-check-uncertain") {
    return `Stripe reported refund ${refundId} failed after its card refund was closed as paid another way. ${PAID_ANOTHER_WAY_CHECK_WHY[CHECK_REASON_OF[outcome]]}: check before paying. Not asked for again automatically: if the member is owed it, pay them another way and close it as paid another way; if not, close it as checked - not owed. Both are under "Card refunds Stripe gave up on" on the Stuck states page (#4210).`;
  }
  // #4104 review (D7): a row whose retries are already spent is never claimed again.
  if (outcome === "re-planned-dead") {
    return `Stripe accepted refund ${refundId} and later reported it failed, so no money went back. It is still owed, and this refund's retries are already spent, so it is not asked for again automatically: pay the member another way and ${CLOSE_IT_WHERE} (#4104).`;
  }
  return `Stripe accepted refund ${refundId} and later reported it failed, so no money went back. It is owed again and is asked for again as a new request (#4104).`;
}

/**
 * When the cutoff migration finished on this install, in whole seconds (Stripe
 * dates a refund in seconds); null where there is no migration history (a
 * `prisma db push` database never ran an older release). Fail-safe (#4104
 * review, ML3): with a history that has no finished cutoff row - rolled back,
 * or not run - every refund is read as made before it, raised dead for the
 * treasurer rather than re-sent.
 */
export async function cardRefundFailedLaterCutoffSeconds(db: Prisma.TransactionClient): Promise<number | null> {
  const cutoff = await readMigrationFinishedAt(db, CARD_REFUND_FAILED_LATER_CUTOFF_MIGRATION);
  if (!cutoff.history) return null;
  if (cutoff.finishedAtSeconds === null) {
    logger.error(
      { migration: CARD_REFUND_FAILED_LATER_CUTOFF_MIGRATION },
      "The failed-later card refund cutoff migration has not finished here: every refund Stripe failed later is raised dead for the treasurer (#4104)",
    );
    return Number.POSITIVE_INFINITY;
  }
  return cutoff.finishedAtSeconds;
}

/** Whether a refund carries exactly the Stripe metadata this row's runner sends (`cardRefundOperationRefundMetadata`). */
function sentByRow(row: PaymentRecoveryOperation, refund: FailedLaterRefundInput): boolean {
  const expected = Object.entries(cardRefundOperationRefundMetadata(row));
  const actual = refund.metadata ?? {};
  return Object.keys(actual).length === expected.length && expected.every(([key, value]) => actual[key] === value);
}

/** The open row that counted this refund as made: the slice it moves, or (`sliceIndex` null) a plan-less row that re-derives what it sends. */
type OpenOwner = { row: PaymentRecoveryOperation; sliceIndex: number | null };

/**
 * #4166: which row made a refund no open row owes, for the row raised to owe
 * it (`madeByOperationId`): the one row on the payment whose runner metadata it
 * carries exactly (`sentByRow`) - by what was sent, not by amount, so a refund
 * of the same amount on the same charge from another door is never taken for
 * it - or, where several carry it (a booking's failed-later retries), the one
 * whose slice it fills; else none.
 */
function madeByRow(
  rows: ReadonlyArray<PaymentRecoveryOperation>,
  refund: FailedLaterRefundInput,
  filled: { operation: { id: string } } | null,
): string | null {
  const senders = rows.filter((row) => sentByRow(row, refund));
  if (senders.length === 1) return senders[0]?.id ?? null;
  return filled && senders.some((row) => row.id === filled.operation.id) ? filled.operation.id : null;
}

/**
 * No open row owes it: the row that made it (`madeBy`), for the new row's
 * record, and (#4210) what a "Paid another way" close is weighed by - the rows,
 * the payment as it stood before the failure, and the row whose slice it
 * fills there (`filledBy`).
 */
type NoOpenOwner = {
  madeBy: string | null;
  filledBy: string | null;
  rows: PaymentRecoveryOperation[];
  beforeFailure: CardRefundOwedPaymentRow;
};

/**
 * The open row that counted this refund as made, or "owed" when one already
 * owes it, or else the rows that made it (`NoOpenOwner`).
 */
async function findOwner(
  tx: Prisma.TransactionClient,
  payment: { id: string; status: string; amountCents: number; refundedAmountCents: number },
  refund: FailedLaterRefundInput,
): Promise<OpenOwner | "owed" | NoOpenOwner> {
  const refundId = refund.id;
  const rows = await tx.paymentRecoveryOperation.findMany({ where: { paymentId: payment.id, ...CARD_REFUND_OPERATION_WHERE } });
  if (rows.some((row) => row.idempotencyKey === buildCardRefundFailedLaterRecoveryKey(refundId))) return "owed";
  const open = rows.filter((row) => row.status !== PaymentRecoveryOperationStatus.SUCCEEDED);
  for (const row of open) {
    const plan = parseRefundAllocationPlan(row.allocationPlan) ?? [];
    if (plan.some((slice) => slice.failedRefundIds?.includes(refundId))) return "owed";
    const marked = plan.findIndex((slice) => slice.madeRefundId === refundId);
    if (marked >= 0) return { row, sliceIndex: marked };
  }
  // The payment as it stood before the failure: this refund still counted.
  const refunds = await tx.paymentRefund.findMany({
    where: { paymentId: payment.id },
    select: { stripeRefundId: true, paymentTransactionId: true, amountCents: true, status: true, createdAt: true, stripeCreatedAt: true },
  });
  const beforeFailure = cardRefundPaymentBeforeFailure({ ...payment, recoveryOperations: rows, refunds }, refundId);
  const filled = cardRefundSliceFilledBy(beforeFailure, refundId);
  const row = filled ? open.find((each) => each.id === filled.operation.id) : undefined;
  // A closed row's refund is owed by a row of its own, and so (CM) is one this
  // row's runner did not send: it sends its unmarked slice anyway. An open row
  // with no plan (a superseded intent's) re-derives what its charge still holds
  // by itself, and reads its own replay as refused (#4104 review, ML2).
  if (!filled || !row || !sentByRow(row, refund)) {
    return { madeBy: madeByRow(rows, refund, filled), filledBy: filled?.operation.id ?? null, rows, beforeFailure };
  }
  return { row, sliceIndex: parseRefundAllocationPlan(row.allocationPlan) ? filled.sliceIndex : null };
}

/**
 * Decide one failed-later refund. Runs inside the ledger writer's transaction,
 * after its refund rows and mirror, under its Payment row lock.
 */
export async function keepFailedLaterCardRefundOwed(
  tx: Prisma.TransactionClient,
  {
    paymentId,
    paymentTransactionId,
    refund,
    kind,
    paymentIntentId,
    cutoffSeconds,
  }: {
    paymentId: string;
    paymentTransactionId: string;
    refund: FailedLaterRefundInput;
    kind: FailedLaterKind;
    /** The refund's intent, where the writer has it; else the charge's own. */
    paymentIntentId: string | null;
    cutoffSeconds: number | null;
  },
): Promise<{ debt?: FailedLaterCardRefundDebt; readAsRefused?: true }> {
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    select: { id: true, bookingId: true, status: true, amountCents: true, refundedAmountCents: true },
  });
  if (!payment) return {};
  const owner = await findOwner(tx, payment, refund);
  if (owner === "owed") return {};

  if ("row" in owner) {
    const { row, sliceIndex } = owner;
    if (sliceIndex === null) {
      // #4104 review (ML2): a superseded intent's plan-less row asks for what its
      // charge still holds, which the failure just raised. Its own replay - the
      // one writer that reads this refund back as counted - is told it failed,
      // so the row moves its key and asks again rather than closing on it.
      return kind === "replayed" ? { readAsRefused: true } : {};
    }
    const held = row.status === PaymentRecoveryOperationStatus.PROCESSING || isUntouchedPrePersistedRow(row);
    if (held) {
      if (kind === "replayed") return { readAsRefused: true };
      throw new FailedLaterRefundHeldError(refund.id, row.id);
    }
    const plan = parseRefundAllocationPlan(row.allocationPlan) ?? [];
    const replanned = plan.map((slice, index) => {
      if (index !== sliceIndex) return slice;
      return {
        paymentTransactionId: slice.paymentTransactionId,
        amountCents: slice.amountCents,
        stripeKeySuffix: nextRefusedRefundKeySuffix(slice.stripeKeySuffix),
        failedRefundIds: [...(slice.failedRefundIds ?? []), refund.id],
        ...(slice.madeByOperationId === undefined ? {} : { madeByOperationId: slice.madeByOperationId }),
        ...(slice.paidAnotherWayCheck === undefined ? {} : { paidAnotherWayCheck: slice.paidAnotherWayCheck }),
      };
    });
    const outcome = isPaymentRecoveryOperationExhausted(row) ? "re-planned-dead" : "re-planned";
    // Compare-and-set on what the plan and the outcome were read from (#4104
    // review, CL2): a write in between - a re-plan, a claim, a re-arm - means
    // this read is stale.
    const moved = await tx.paymentRecoveryOperation.updateMany({
      where: {
        id: row.id,
        status: row.status,
        attempts: row.attempts,
        nextRetryAt: row.nextRetryAt,
        allocationPlan: { equals: row.allocationPlan as Prisma.InputJsonValue },
      },
      data: { allocationPlan: replanned as unknown as Prisma.InputJsonValue, lastError: failedLaterLastError(refund.id, outcome) },
    });
    if (moved.count !== 1) throw new FailedLaterRefundHeldError(refund.id, row.id);
    return {
      debt: {
        outcome,
        operationId: row.id,
        bookingId: row.bookingId,
        paymentIntentId: row.paymentIntentId,
        amountCents: plan[sliceIndex]?.amountCents ?? refund.amount,
        stripeRefundId: refund.id,
      },
    };
  }

  // #4210 (`INV-PAY-136`): settled by a "Paid another way" close - asked before
  // the no-booking rule, so a dashboard refund a close settled is said as settled.
  const close = await findPaidAnotherWayCloseThatSettled(tx, { ...owner, refund, bookingId: payment.bookingId });
  if (close) {
    if (kind !== "transition") return {};
    const { outcome, ...paidAnotherWay } = close;
    let operationId: string = close.operationId;
    let intentId = paymentIntentId;
    if (outcome !== "settled-paid-another-way") {
      const check = { closedOperationId: close.operationId, reason: CHECK_REASON_OF[outcome] };
      const raised = await raiseRow(tx, { payment, paymentTransactionId, refund, paymentIntentId, amountCents: close.checkCents, dead: true, madeBy: owner.madeBy, check, lastError: failedLaterLastError(refund.id, outcome) });
      if (!raised) return {};
      ({ operationId, intentId } = raised);
    }
    await createAuditLog(
      {
        action: "booking-payment.card-refund.failed-later-paid-another-way",
        targetId: payment.bookingId,
        entityType: "PaymentRefund",
        entityId: refund.id,
        category: "payment",
        severity: "important",
        outcome: "failure",
        summary: `Stripe reported card refund ${refund.id} failed after accepting it, after its card refund was closed "Paid another way"${outcome === "settled-paid-another-way" ? "; that close paid it back, so it is not asked for again" : `; raised for an officer to check (${AUDIT_CHECK_WHY[outcome]})`}`,
        ...(close.resolutionNote ? { details: close.resolutionNote } : {}),
        metadata: { stripeRefundId: refund.id, paymentId, paymentTransactionId, paymentIntentId, amountCents: refund.amount, decision: outcome, raisedOperationId: outcome === "settled-paid-another-way" ? null : operationId, ...paidAnotherWay },
      },
      tx,
    );
    return { debt: { outcome, operationId, bookingId: payment.bookingId, paymentIntentId: intentId, amountCents: refund.amount, stripeRefundId: refund.id, paidAnotherWay } };
  }
  // #4210 (concurrency F1): an open row's own replay reads the refund as refused
  // and moves its slice itself - one owes it, never two.
  const maker = owner.rows.find((each) => each.id === owner.madeBy);
  if (kind === "replayed" && maker && maker.status !== PaymentRecoveryOperationStatus.SUCCEEDED) return { readAsRefused: true };

  if (refund.metadata?.bookingId !== payment.bookingId) {
    // Not the club's to re-send: made by hand in the Stripe dashboard, or a
    // legacy group refund that names no booking. The officers are told once,
    // and (#4104 review, CL3) the audit log keeps it, on this transaction.
    if (kind !== "transition") return {};
    await createAuditLog(
      {
        action: "booking-payment.card-refund.failed-later-not-resent",
        targetId: payment.bookingId,
        entityType: "PaymentRefund",
        entityId: refund.id,
        category: "payment",
        severity: "important",
        outcome: "failure",
        summary: `Stripe reported card refund ${refund.id} failed after accepting it; the app did not make it for this booking, so it is not asked for again`,
        metadata: { stripeRefundId: refund.id, paymentId, paymentTransactionId, paymentIntentId, amountCents: refund.amount },
      },
      tx,
    );
    return {
      debt: {
        outcome: "not-resent",
        operationId: null,
        bookingId: payment.bookingId,
        paymentIntentId,
        amountCents: refund.amount,
        stripeRefundId: refund.id,
      },
    };
  }
  const outcome: FailedLaterCardRefundDebt["outcome"] =
    refund.metadata?.reason === CARD_REFUND_FAILED_LATER_REASON
      ? "raised-dead"
      : cutoffSeconds !== null && typeof refund.created === "number" && refund.created < cutoffSeconds
        ? "raised-backlog"
        : "raised";
  const raised = await raiseRow(tx, { payment, paymentTransactionId, refund, paymentIntentId, amountCents: refund.amount, dead: outcome !== "raised", madeBy: owner.madeBy, lastError: failedLaterLastError(refund.id, outcome) });
  if (!raised) return {};
  return {
    debt: {
      outcome,
      operationId: raised.operationId,
      bookingId: payment.bookingId,
      paymentIntentId: raised.intentId,
      amountCents: refund.amount,
      stripeRefundId: refund.id,
    },
  };
}

/**
 * Raise the row that owes a failed refund again, under a key Stripe has never
 * seen (`card_refund_failed_later_<refund>`), for `amountCents` on its own
 * charge; dead (attempts spent) when no runner may send it. Null when another
 * writer raised it first, or the charge names no card payment.
 */
async function raiseRow(
  tx: Prisma.TransactionClient,
  {
    payment,
    paymentTransactionId,
    refund,
    paymentIntentId,
    amountCents,
    dead,
    madeBy,
    check,
    lastError,
  }: {
    payment: { id: string; bookingId: string };
    paymentTransactionId: string;
    refund: FailedLaterRefundInput;
    paymentIntentId: string | null;
    amountCents: number;
    dead: boolean;
    madeBy: string | null;
    /** #4210: raised for an officer to check against a close (`PaidAnotherWayCheck`). */
    check?: PaidAnotherWayCheck;
    lastError: string;
  },
): Promise<{ operationId: string; intentId: string } | null> {
  const intentId =
    paymentIntentId ??
    (await tx.paymentTransaction.findUnique({ where: { id: paymentTransactionId }, select: { stripePaymentIntentId: true } }))
      ?.stripePaymentIntentId ??
    null;
  if (!intentId) {
    logger.error({ stripeRefundId: refund.id, paymentTransactionId }, "A card refund that failed later names no card payment to refund again (#4104)");
    return null;
  }
  const idempotencyKey = buildCardRefundFailedLaterRecoveryKey(refund.id);
  const inserted = await tx.paymentRecoveryOperation.createMany({
    data: [
      {
        type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
        status: PaymentRecoveryOperationStatus.PENDING,
        bookingId: payment.bookingId,
        paymentId: payment.id,
        paymentIntentId: intentId,
        amountCents,
        idempotencyKey,
        stripeKeyPrefix: idempotencyKey,
        // #4166: which row made the refund, so the booking page tells it by what was sent, not by amount.
        allocationPlan: [{ paymentTransactionId, amountCents, madeByOperationId: madeBy, ...(check ? { paidAnotherWayCheck: check } : {}) }] as unknown as Prisma.InputJsonValue,
        // Dead by the recovery module's own rule (attempts spent): never
        // claimed, and closable as paid another way. Not a FAILED write, which
        // has one route (`INV-PAY-056`).
        attempts: dead ? MAX_PAYMENT_RECOVERY_ATTEMPTS : 0,
        nextRetryAt: new Date(),
        lastError,
      },
    ],
    skipDuplicates: true,
  });
  if (inserted.count !== 1) return null;
  const row = await tx.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey }, select: { id: true } });
  return { operationId: row.id, intentId };
}

/** Each refund the ledger writer saw fail later, decided in its transaction, in the order it saw them. */
export async function keepFailedLaterCardRefundsOwed(
  tx: Prisma.TransactionClient,
  {
    paymentId,
    paymentTransactionId,
    seen,
    fallbackPaymentIntentId,
  }: {
    paymentId: string;
    paymentTransactionId: string;
    seen: ReadonlyArray<{ refund: FailedLaterRefundInput; kind: FailedLaterKind }>;
    fallbackPaymentIntentId?: string | null;
  },
): Promise<FailedLaterDecisions> {
  const decisions: FailedLaterDecisions = { debts: [], readAsRefused: [] };
  if (seen.length === 0) return decisions;
  const cutoffSeconds = await cardRefundFailedLaterCutoffSeconds(tx);
  for (const { refund, kind } of seen) {
    const paymentIntentId = stripeReferenceId(refund.payment_intent) ?? fallbackPaymentIntentId ?? null;
    const decided = await keepFailedLaterCardRefundOwed(tx, { paymentId, paymentTransactionId, refund, kind, paymentIntentId, cutoffSeconds });
    if (decided.debt) decisions.debts.push(decided.debt);
    if (decided.readAsRefused) decisions.readAsRefused.push(refund.id);
  }
  return decisions;
}

/** #4210: a decision about a refund a "Paid another way" close had settled - its own unmuteable mail. */
function isPaidAnotherWayDebt(
  debt: FailedLaterCardRefundDebt,
): debt is FailedLaterCardRefundDebt & { outcome: PaidAnotherWayFailedLaterOutcome; paidAnotherWay: NonNullable<FailedLaterCardRefundDebt["paidAnotherWay"]> } {
  return (
    (debt.outcome === "settled-paid-another-way" || Object.hasOwn(CHECK_REASON_OF, debt.outcome)) &&
    debt.paidAnotherWay !== undefined
  );
}

function alertMessage(debt: FailedLaterCardRefundDebt, money: (cents: number) => string): string {
  const amount = money(debt.amountCents);
  switch (debt.outcome) {
    case "raised":
    case "re-planned":
      return `Stripe accepted a card refund of ${amount} and later reported it failed, so no money went back. It is owed again and will be asked for again automatically.`;
    case "re-planned-dead":
      return `Stripe accepted a card refund of ${amount} and later reported it failed, so no money went back. It is still owed, and its retries are already spent: pay the member another way and ${CLOSE_IT_WHERE}.`;
    case "raised-dead":
      return `Stripe accepted a retried card refund of ${amount} and later reported it failed too, so no money went back. It is still owed and will not be asked for again automatically: pay the member another way and ${CLOSE_IT_WHERE}.`;
    case "raised-backlog":
      return `Stripe reported a card refund of ${amount} failed. It was made before this release could notice such failures, so it is not asked for again automatically: check whether the member has already been paid back, and ${CLOSE_IT_WHERE}.`;
    case "not-resent":
      // #4104 review (D2): which refund, and how to settle it - nothing here owes it.
      return `Stripe reported card refund ${debt.stripeRefundId} of ${amount} on this booking failed after accepting it. The app did not make it for this booking (a refund made in the Stripe dashboard, or a group refund), so it is not asked for again and is not listed under Refunds owed. Find it in the Stripe dashboard: if the member is still owed, refund them again there or pay them another way. Raise no refund note for it in Xero: the card refund credit note raised while Stripe counted it, if there is one, already records it, and a second note would credit the member twice. If they are no longer owed, the Xero reconciliation report lists that note as refund coverage above the refunded total, for you to correct in Xero.`;
    case "settled-paid-another-way":
    case "raised-check-part-close":
    case "raised-check-resolved":
    case "raised-check-uncertain":
      // #4210: never sent this way (`isPaidAnotherWayDebt`); said for completeness.
      return `Stripe reported card refund ${debt.stripeRefundId} of ${amount} failed after a "Paid another way" close had settled it.`;
  }
}

/**
 * The officers' alert, once per decision, after the commit that wrote it.
 * Never throws: the debt is already owed.
 */
export async function alertFailedLaterCardRefunds(debts: ReadonlyArray<FailedLaterCardRefundDebt>): Promise<void> {
  if (debts.length === 0) return;
  try {
    const [{ clubFormatValues }, { alertPaymentRecoveryOfficers }] = await Promise.all([
      import("@/lib/club-format-server"),
      import("@/lib/payment-recovery-alert"),
    ]);
    const format = await clubFormatValues();
    const money = (cents: number) => formatCents(cents, format);
    for (const debt of debts) {
      if (isPaidAnotherWayDebt(debt)) {
        // #4210: its own subject, through the unmuteable sender - money a person must not pay twice.
        const { alertCardRefundFailedAfterPaidAnotherWay } = await import("@/lib/email/admin-alerts-card-refund");
        const close = debt.paidAnotherWay;
        await alertCardRefundFailedAfterPaidAnotherWay(
          {
            bookingId: debt.bookingId,
            amountCents: debt.amountCents,
            note: paidAnotherWayFailedLaterNote({
              outcome: debt.outcome,
              stripeRefundId: debt.stripeRefundId,
              amount: money(debt.amountCents),
              paidBack: money(close.paidBackCents),
              owed: money(close.owedCents),
              partClose: close.paidBackCents < close.owedCents,
              check: money(close.checkCents),
              onPaidTwiceList: close.onPaidTwiceList,
              recordedAfterClose: close.recordedAfterClose,
              resolutionNote: close.resolutionNote,
            }),
          },
          format,
        ).catch((err: unknown) =>
          logger.error({ err, operationId: debt.operationId }, "Could not alert the officers to a card refund that failed after it was paid back another way (#4210)"),
        );
        continue;
      }
      await alertPaymentRecoveryOfficers(
        {
          bookingId: debt.bookingId,
          operationId: debt.operationId ?? undefined,
          amountCents: debt.amountCents,
          paymentIntentId: debt.paymentIntentId ?? "",
          errorMessage: alertMessage(debt, money),
        },
        format,
      ).catch((err: unknown) =>
        logger.error({ err, operationId: debt.operationId }, "Could not alert the officers to a card refund that failed later (#4104)"),
      );
    }
  } catch (err) {
    logger.error({ err }, "Could not alert the officers to card refunds that failed later (#4104)");
  }
}
