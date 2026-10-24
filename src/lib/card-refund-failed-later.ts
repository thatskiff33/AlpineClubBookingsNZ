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
import {
  CARD_REFUND_OPERATION_WHERE,
  cardRefundPaymentBeforeFailure,
  carriesCardRefundOperationMetadata,
  cardRefundSliceFailedRefundIds,
  cardRefundSliceFilledBy,
  isOpenCardRefundOperationStatus,
  parseRefundAllocationPlan,
} from "@/lib/open-card-refund-owed";
import {
  isPaymentRecoveryOperationExhausted,
  isUntouchedPrePersistedRow,
  MAX_PAYMENT_RECOVERY_ATTEMPTS,
} from "@/lib/payment-recovery-constants";
import {
  buildCardRefundFailedLaterRecoveryKey,
  CARD_REFUND_FAILED_LATER_REASON,
  nextRefusedRefundKeySuffix,
} from "@/lib/payment-recovery-keys";
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
   * `not-resent`: not the club's refund for this booking - nothing is owed here.
   */
  outcome: "raised" | "raised-dead" | "raised-backlog" | "re-planned" | "re-planned-dead" | "not-resent";
  operationId: string | null;
  bookingId: string;
  paymentIntentId: string | null;
  amountCents: number;
  stripeRefundId: string;
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

/** Whether a refund carries exactly the Stripe metadata this row's runner sends (`carriesCardRefundOperationMetadata`). */
function sentByRow(row: PaymentRecoveryOperation, refund: FailedLaterRefundInput): boolean {
  return carriesCardRefundOperationMetadata(row, refund.metadata);
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
 * The open row that counted this refund as made, or "owed" when one already
 * owes it, or else (`madeBy`) the row that made it, for the new row's record.
 */
async function findOwner(
  tx: Prisma.TransactionClient,
  payment: { id: string; status: string; amountCents: number; refundedAmountCents: number },
  refund: FailedLaterRefundInput,
): Promise<OpenOwner | "owed" | { madeBy: string | null }> {
  const refundId = refund.id;
  const rows = await tx.paymentRecoveryOperation.findMany({ where: { paymentId: payment.id, ...CARD_REFUND_OPERATION_WHERE } });
  // Already owed, by the one spelling of what a slice is sent for (`cardRefundSliceFailedRefundIds`): any row of
  // its own, open or closed (its key names it, whatever its plan), and an open row's slice that recorded it.
  const sendsFor = (row: PaymentRecoveryOperation, slice: Parameters<typeof cardRefundSliceFailedRefundIds>[1]) =>
    cardRefundSliceFailedRefundIds(row, slice).includes(refundId);
  if (rows.some((row) => sendsFor(row, {}))) return "owed";
  const open = rows.filter((row) => isOpenCardRefundOperationStatus(row.status));
  for (const row of open) {
    const plan = parseRefundAllocationPlan(row.allocationPlan) ?? [];
    if (plan.some((slice) => sendsFor(row, slice))) return "owed";
    const marked = plan.findIndex((slice) => slice.madeRefundId === refundId);
    if (marked >= 0) return { row, sliceIndex: marked };
  }
  // The payment as it stood before the failure: this refund still counted.
  const refunds = await tx.paymentRefund.findMany({
    where: { paymentId: payment.id },
    select: { stripeRefundId: true, paymentTransactionId: true, amountCents: true, status: true, createdAt: true, stripeCreatedAt: true },
  });
  const filled = cardRefundSliceFilledBy(cardRefundPaymentBeforeFailure({ ...payment, recoveryOperations: rows, refunds }, refundId), refundId);
  const row = filled ? open.find((each) => each.id === filled.operation.id) : undefined;
  // A closed row's refund is owed by a row of its own, and so (CM) is one this
  // row's runner did not send: it sends its unmarked slice anyway. An open row
  // with no plan (a superseded intent's) re-derives what its charge still holds
  // by itself, and reads its own replay as refused (#4104 review, ML2).
  if (!filled || !row || !sentByRow(row, refund)) return { madeBy: madeByRow(rows, refund, filled) };
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
  const intentId =
    paymentIntentId ??
    (await tx.paymentTransaction.findUnique({ where: { id: paymentTransactionId }, select: { stripePaymentIntentId: true } }))
      ?.stripePaymentIntentId ??
    null;
  if (!intentId) {
    logger.error({ stripeRefundId: refund.id, paymentTransactionId }, "A card refund that failed later names no card payment to refund again (#4104)");
    return {};
  }
  const outcome: FailedLaterCardRefundDebt["outcome"] =
    refund.metadata?.reason === CARD_REFUND_FAILED_LATER_REASON
      ? "raised-dead"
      : cutoffSeconds !== null && typeof refund.created === "number" && refund.created < cutoffSeconds
        ? "raised-backlog"
        : "raised";
  const idempotencyKey = buildCardRefundFailedLaterRecoveryKey(refund.id);
  const inserted = await tx.paymentRecoveryOperation.createMany({
    data: [
      {
        type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
        status: PaymentRecoveryOperationStatus.PENDING,
        bookingId: payment.bookingId,
        paymentId,
        paymentIntentId: intentId,
        amountCents: refund.amount,
        idempotencyKey,
        stripeKeyPrefix: idempotencyKey,
        // #4166: which row made the refund, so the booking page tells it by what was sent, not by amount.
        allocationPlan: [{ paymentTransactionId, amountCents: refund.amount, madeByOperationId: owner.madeBy }] as unknown as Prisma.InputJsonValue,
        // Dead by the recovery module's own rule (attempts spent): never
        // claimed, and closable as paid another way. Not a FAILED write, which
        // has one route (`INV-PAY-056`).
        attempts: outcome === "raised" ? 0 : MAX_PAYMENT_RECOVERY_ATTEMPTS,
        nextRetryAt: new Date(),
        lastError: failedLaterLastError(refund.id, outcome),
      },
    ],
    skipDuplicates: true,
  });
  if (inserted.count !== 1) return {};
  const row = await tx.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey }, select: { id: true } });
  return {
    debt: {
      outcome,
      operationId: row.id,
      bookingId: payment.bookingId,
      paymentIntentId: intentId,
      amountCents: refund.amount,
      stripeRefundId: refund.id,
    },
  };
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

function alertMessage(debt: FailedLaterCardRefundDebt, amount: string): string {
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
    for (const debt of debts) {
      await alertPaymentRecoveryOfficers(
        {
          bookingId: debt.bookingId,
          operationId: debt.operationId ?? undefined,
          amountCents: debt.amountCents,
          paymentIntentId: debt.paymentIntentId ?? "",
          errorMessage: alertMessage(debt, formatCents(debt.amountCents, format)),
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
