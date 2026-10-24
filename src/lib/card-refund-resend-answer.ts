import type { PaymentRecoveryOperationStatus, Prisma } from "@prisma/client";

import { cardRefundNoteRowsWhere } from "@/lib/card-refund-paid-another-way-cash";
import { findLateCapturePaymentIntents } from "@/lib/late-capture-xero-receipt";
import logger from "@/lib/logger";
import {
  CARD_REFUND_OPERATION_WHERE,
  cardRefundFailuresAnsweredBy,
  carriesCardRefundOperationMetadata,
  cardRefundSliceFailedRefundIds,
  OPEN_CARD_REFUND_OPERATION_WHERE,
  operationWindowTakes,
  parseRefundAllocationPlan,
} from "@/lib/open-card-refund-owed";
import { isPaymentRecoveryOperationExhausted } from "@/lib/payment-recovery-constants";
import { isRecordedRefundStatus } from "@/lib/payment-transaction-status";
import { prisma } from "@/lib/prisma";
import { onPlanWhere } from "@/lib/refused-card-refund-retry";
import { sumRefundCreditNoteCoverageOfRowsCents } from "@/lib/xero-resolved-in-xero-fences";

/**
 * #4312 round 7 (#4104, `INV-ADDPAY-047`): A CARD REFUND SENT AGAIN FOR ONE
 * STRIPE FAILED LATER IS ANSWERED BY THE FAILED REFUND'S OWN NOTE.
 *
 * A refund Stripe accepted and failed later keeps the note it took while it
 * counted, and #4104 meant that note to answer the money once it goes back -
 * so the refund the recovery replay sends in its place is owed only what that
 * note does not cover. Which failures a refund answers is the replay's own
 * record and nothing else (`cardRefundFailuresAnsweredBy`): the slice it sent
 * for them, marked with the refund Stripe made. A refund no slice is marked
 * with - a Stripe dashboard refund - answers nothing and is noted in full. A
 * late capture's refunds are its capture's note's to size
 * (`planLateCaptureCardNotes`), so they answer nothing here.
 *
 * Read by a card refund's note share (`readCardRefundNoteShare`), so its
 * enqueue and its execution size it alike, and - whether it is a re-send at
 * all (`paired`) and noted on its own record (`ownNoted`) - by the recovery
 * replay and `charge.refunded` alike: one rule, two writers.
 */
export type FailedRefundAnswer = {
  /** The failed refunds this refund was sent again for, the chain behind them included. */
  failedRefundIds: string[];
  /** Whether any of them was asked for on its own record (it has a note row of its own, in any status). */
  ownNoted: boolean;
  /** What their own notes cover: what already answers this refund in Xero. */
  coverCents: number;
};

const NONE: FailedRefundAnswer = { failedRefundIds: [], ownNoted: false, coverCents: 0 };

type AnswerReader = Pick<Prisma.TransactionClient, "paymentRecoveryOperation" | "paymentRefund" | "manualRefundTask" | "xeroObjectLink" | "xeroSyncOperation">;

/** The failed refunds `stripeRefundId` was sent again for on this payment, the chain behind them, and what their own notes cover. */
export async function readFailedRefundsAnsweredBy(db: AnswerReader, paymentId: string, stripeRefundId: string): Promise<FailedRefundAnswer> {
  const refund = await db.paymentRefund.findFirst({ where: { paymentId, stripeRefundId }, select: { status: true, stripePaymentIntentId: true } });
  if (!refund || !isRecordedRefundStatus(refund.status)) return NONE;
  if (refund.stripePaymentIntentId && (await findLateCapturePaymentIntents([refund.stripePaymentIntentId], db)).size > 0) return NONE;
  const operations = await db.paymentRecoveryOperation.findMany({
    where: { paymentId, ...CARD_REFUND_OPERATION_WHERE },
    select: { idempotencyKey: true, allocationPlan: true },
  });
  const failedRefundIds = cardRefundFailuresAnsweredBy(operations, stripeRefundId);
  if (failedRefundIds.length === 0) return NONE;
  let ownNoted = false;
  let coverCents = 0;
  for (const id of failedRefundIds) {
    const rowsWhere = cardRefundNoteRowsWhere(paymentId, id);
    ownNoted ||= (await db.xeroSyncOperation.count({ where: rowsWhere })) > 0;
    coverCents += await sumRefundCreditNoteCoverageOfRowsCents(paymentId, rowsWhere, db);
  }
  return { failedRefundIds, ownNoted, coverCents };
}

/** A card refund row as the pairing of a re-send recorded first reads it. */
export type ResendRow = {
  id: string;
  type: string;
  status: string;
  attempts: number;
  idempotencyKey: string;
  stripeKeyPrefix: string | null;
  bookingId: string;
  allocationPlan: unknown;
  createdAt: Date;
  succeededAt: Date | null;
};

/** A refund just recorded on a card charge, as the pairing reads it. */
export type RecordedResend = {
  stripeRefundId: string;
  paymentTransactionId: string;
  amountCents: number;
  createdAt: Date;
  stripeCreatedAt: Date | null;
  metadata: Record<string, string> | null | undefined;
};

/**
 * #4312 round 8 (#4104, `INV-ADDPAY-047`): THE UNMARKED RE-SENDS ONE REFUND
 * COULD BE STRIPE'S ANSWER TO - pure. A slice of an unclosed row, sent for
 * refunds Stripe failed later (`cardRefundSliceFailedRefundIds`), not marked
 * made yet, on the refund's charge for exactly its amount, of a row whose
 * runner sends exactly the metadata the refund carries
 * (`carriesCardRefundOperationMetadata`) and that was raised before Stripe made
 * it (`operationWindowTakes`) and that has tried to send (a row raised dead
 * never has). A refund the Stripe dashboard or another door made carries other
 * metadata, so it is no row's.
 */
export function unmarkedResendSlicesFor(
  operations: ReadonlyArray<ResendRow>,
  refund: RecordedResend,
): Array<{ operation: ResendRow; sliceIndex: number }> {
  return operations.flatMap((operation) => {
    if (operation.status === "SUCCEEDED" || !carriesCardRefundOperationMetadata(operation, refund.metadata)) return [];
    // Raised dead (`raised-dead`, `raised-backlog`): never claimed, so it never sent anything Stripe could answer.
    if (operation.status === "PENDING" && isPaymentRecoveryOperationExhausted(operation)) return [];
    if (!operationWindowTakes(operation, refund)) return [];
    return (parseRefundAllocationPlan(operation.allocationPlan) ?? []).flatMap((slice, sliceIndex) => {
      if (slice.madeRefundId || slice.paymentTransactionId !== refund.paymentTransactionId || slice.amountCents !== refund.amountCents) return [];
      const failed = cardRefundSliceFailedRefundIds(operation, slice);
      return failed.length > 0 && !failed.includes(refund.stripeRefundId) ? [{ operation, sliceIndex }] : [];
    });
  });
}

/**
 * What `charge.refunded` does with an app refund it records before any slice
 * is marked with it (`pairResendRecordedFirst`): `none` - no re-send could be
 * it; `replay` - an unclosed row that will replay its slice could have sent
 * it; `marked` - it was the one re-send of a dead row, now marked with it;
 * `ambiguous` - several dead rows' re-sends could be it.
 */
export type ResendRecordedFirst = "none" | "replay" | "marked" | "ambiguous";

type ResendStore = { paymentRefund: Pick<typeof prisma.paymentRefund, "findFirst">; paymentRecoveryOperation: Pick<typeof prisma.paymentRecoveryOperation, "findMany" | "updateMany"> };

/**
 * #4312 round 8 (#4104, `INV-ADDPAY-047`): A RE-SEND `charge.refunded`
 * RECORDS BEFORE ITS SLICE IS MARKED. Stripe's `charge.refunded` can record
 * the refund the recovery replay sent again before the replay marks its slice
 * with it (`markResentSlices`) - the replay's answer was lost, or is still on
 * its way. Unmarked, the refund pairs with nothing, so it would enter the
 * canonical delta, whose payment-wide gap hands it another refund's share.
 *
 * - A row that will replay the slice (not dead: open, mid-attempt or due
 *   again) is left to: its replay reads the same refund back under the same
 *   key, marks the slice and asks for its note (`replayNotingEachRefund`).
 * - A dead row (retries spent, `isPaymentRecoveryOperationExhausted`) is
 *   never replayed, so its one matching re-send is marked here, compare-and-set
 *   on the plan, status and attempts read: the refund carries that row's
 *   runner metadata, on that slice's charge, for its amount, made after the
 *   row was raised. A write in between leaves it to whoever wrote.
 * - Several dead rows' re-sends that could each be it are left unmarked and
 *   logged: nothing here can tell which one Stripe answered.
 *
 * STATED LIMIT: a final attempt whose answer is lost after `charge.refunded`
 * already left the refund to it is marked by nobody - no refund row stores the
 * slice's key, and no writer reads the refund again (ARCHITECTURE).
 */
export async function pairResendRecordedFirst(
  paymentId: string,
  refund: { id: string; metadata?: Record<string, string> | null },
  db: ResendStore = prisma,
): Promise<ResendRecordedFirst> {
  const recorded = await db.paymentRefund.findFirst({
    where: { paymentId, stripeRefundId: refund.id },
    select: { paymentTransactionId: true, amountCents: true, status: true, createdAt: true, stripeCreatedAt: true },
  });
  if (!recorded?.paymentTransactionId || !isRecordedRefundStatus(recorded.status)) return "none";
  const operations = await db.paymentRecoveryOperation.findMany({
    where: { paymentId, ...OPEN_CARD_REFUND_OPERATION_WHERE },
    select: {
      id: true, type: true, status: true, attempts: true, idempotencyKey: true, stripeKeyPrefix: true,
      bookingId: true, allocationPlan: true, createdAt: true, succeededAt: true,
    },
  });
  const candidates = unmarkedResendSlicesFor(operations, {
    stripeRefundId: refund.id,
    paymentTransactionId: recorded.paymentTransactionId,
    amountCents: recorded.amountCents,
    createdAt: recorded.createdAt,
    stripeCreatedAt: recorded.stripeCreatedAt,
    metadata: refund.metadata,
  });
  if (candidates.length === 0) return "none";
  if (candidates.some(({ operation }) => !isPaymentRecoveryOperationExhausted(operation))) return "replay";
  const [only] = candidates;
  if (!only || candidates.length > 1) {
    logger.error(
      { paymentId, stripeRefundId: refund.id, operationIds: candidates.map(({ operation }) => operation.id) },
      "A card refund re-send that charge.refunded recorded first could be any of several dead rows' slices: it is noted by nobody - raise its Xero note by hand (#4312)",
    );
    return "ambiguous";
  }
  const { operation, sliceIndex } = only;
  const plan = parseRefundAllocationPlan(operation.allocationPlan) ?? [];
  const marked = plan.map((slice, index) => (index === sliceIndex ? { ...slice, madeRefundId: refund.id } : slice));
  const written = await db.paymentRecoveryOperation.updateMany({
    where: { id: operation.id, status: operation.status as PaymentRecoveryOperationStatus, attempts: operation.attempts, ...onPlanWhere(operation.allocationPlan as Prisma.JsonValue) },
    data: { allocationPlan: marked as unknown as Prisma.InputJsonValue },
  });
  return written.count === 1 ? "marked" : "replay";
}
