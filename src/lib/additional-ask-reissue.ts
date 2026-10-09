/**
 * #3954: WHAT A PRICE REDUCTION LEAVES OF AN UNPAID ASK, AND THE ASKS THAT
 * FOLLOW IT - split from `additional-ask-reduction.ts` (review round 4) to keep
 * that module, which reads and retires the ask, inside its size budget.
 *
 * - `settleReductionAgainstUnpaidAsk` - `applyPaymentAdjustments`'s half: retire
 *   the ask, size the smaller re-issue, its own invoice (decision A, owner 9 Oct
 *   2026) and what Xero had already billed, and record the fee the ask took.
 * - `queueReissuedAskRecovery` / `readReissuedAskRecovery` /
 *   `writeReissuedAskUnderRecovery` - the re-issue is durable from the edit's
 *   commit and the door's mint completes it, fenced.
 * - `foldWaitingReissuedAsks` - a later increase asks for a waiting re-issue too.
 * - `cancelRetiredAdditionalAsksNow` - after commit, the retired intents die at
 *   Stripe before anything is minted.
 *
 * The rule is `INV-PAY-120`.
 */
import { PaymentRecoveryOperationStatus, PaymentTransactionKind, type Prisma } from "@prisma/client";

import {
  closeWaitingAskRecoveries,
  inFlightAskRecoveries,
  retireUnpaidAskChain,
  type PendingAskRecovery,
  type ReductionAgainstUnpaidAsk,
  type RetiredAdditionalAsk,
  type UnpaidAskBooking,
  type UnpaidAskDb,
} from "@/lib/additional-ask-reduction";
import { isRecoveryReplaySettled, sizeRecoveryReplayAsk } from "@/lib/additional-ask-recovery-replay";
import { NO_ADDITIONAL_ASK, reissueUnpaidAdditionalAsk, type AdditionalAsk } from "@/lib/additional-payment-ask";
import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import { enqueueAdditionalPaymentIntentRecovery, runPaymentRecoveryOperationNow } from "@/lib/payment-recovery";
import {
  bookingModificationIdForAdditionalIntentRecoveryKey,
  buildAdditionalIntentRecoveryIdempotencyKey,
  buildReissuedAskStripeIdempotencyKey,
  isEditFinancialReviewAdditionalIntentRecoveryKey,
} from "@/lib/payment-recovery-keys";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";

/**
 * The settlement options must have been sized on what the unpaid ask leaves of
 * the reduction (the same read), or a reduction would both release the ask and
 * refund the same money.
 */
export function assertOptionsSizedAfterUnpaidAsk(
  settlementOptions: { basisAmountCents: number } | null | undefined,
  reduction: ReductionAgainstUnpaidAsk,
  bookingId: string,
  format: ClubFormat,
): void {
  const leftCents = Math.max(0, -reduction.netChargeLeftCents);
  if (settlementOptions && settlementOptions.basisAmountCents > leftCents) {
    throw new Error(
      `INV-PAY-047 (#3954): booking ${bookingId}'s settlement options return ${formatCents(settlementOptions.basisAmountCents, format)} of a reduction whose unpaid-ask offset leaves ${formatCents(leftCents, format)}; they were sized before the reduction was set against the unpaid ask.`,
    );
  }
}

/** What a reduction's offset did to the unpaid ask, for the edit's result and history. */
export type UnpaidAskSettlement = {
  /**
   * How much of the reduction released the member from an unpaid ask rather
   * than being refunded or credited.
   */
  unpaidAskOffsetCents: number;
  /** The reduction cancelled the unpaid ask outright, for the member's email. */
  unpaidAskCancelled: boolean;
  /** The asks it retired inside this transaction, cancelled at Stripe after commit by the minter. */
  retiredAdditionalAsks: RetiredAdditionalAsk[];
  /**
   * The edits whose unpaid asks it retired - a parked invoice's anchor, or a
   * waiting recovery's edit - for the history row the repair pass reads.
   */
  retiredAskModificationIds: string[];
  /** Decision A: what the re-issued ask's own supplementary invoice bills, 0 for none. */
  reissuedAskInvoiceCents: number;
  /** The part of the offset Xero had already billed, for the repair pass. */
  unpaidAskBilledOffsetCents: number;
};

/**
 * `applyPaymentAdjustments`'s half of `INV-PAY-120`, inside the edit's
 * transaction and after its locks: retire the ask the reduction was set against
 * and return the smaller ask that is left (`reissueUnpaidAdditionalAsk`, all
 * carried, `INV-PAY-098`), or `NO_ADDITIONAL_ASK`.
 */
export async function settleReductionAgainstUnpaidAsk(
  tx: Prisma.TransactionClient,
  {
    booking,
    reduction,
    changeFeeCents,
    hasSettledPayment,
    hasIssuedXeroInvoice,
    changeFeeRecordedByCaller,
  }: {
    booking: { id: string; payment: { id: string } | null };
    reduction: ReductionAgainstUnpaidAsk;
    changeFeeCents: number;
    hasSettledPayment: boolean;
    hasIssuedXeroInvoice: boolean;
    changeFeeRecordedByCaller: boolean;
  },
): Promise<UnpaidAskSettlement & { reissuedAsk: AdditionalAsk }> {
  const settled = {
    unpaidAskOffsetCents: reduction.offsetCents,
    unpaidAskCancelled: reduction.offsetCents > 0 && reduction.askLeftCents === 0,
  };
  if (reduction.offsetCents <= 0 || !booking.payment) {
    return {
      ...settled,
      retiredAdditionalAsks: [],
      retiredAskModificationIds: [],
      reissuedAskInvoiceCents: 0,
      unpaidAskBilledOffsetCents: 0,
      reissuedAsk: NO_ADDITIONAL_ASK,
    };
  }
  const retiredAsk = await retireUnpaidAskChain(tx, {
    bookingId: booking.id,
    paymentId: booking.payment.id,
    ask: reduction.ask,
  });
  // The fee this edit charges was collected by shrinking the ask, so it is
  // recorded beside the ask like any fee an ask collects (`INV-PAY-047`) -
  // also on a credit-paid booking, which the settled arm never reaches - unless
  // the caller records it on the amount owed itself (#3750).
  if (changeFeeCents > 0 && !hasSettledPayment && !changeFeeRecordedByCaller) {
    await tx.payment.update({
      where: { id: booking.payment.id },
      data: { changeFeeCents: { increment: changeFeeCents } },
    });
  }
  return {
    ...settled,
    retiredAdditionalAsks: retiredAsk.retired,
    retiredAskModificationIds: retiredAsk.retiredAskModificationIds,
    // Decision A (owner 9 Oct 2026, "Raise a $30 invoice"): the smaller ask's
    // own invoice bills what the retired asks' invoices would have, less the
    // offset - never more than the ask. What the offset took beyond those
    // invoices Xero had ALREADY billed (a primary invoice raised after the
    // increase): recorded for the repair pass, not billed again.
    reissuedAskInvoiceCents: Math.min(reduction.askLeftCents, Math.max(0, retiredAsk.invoicedCents - reduction.offsetCents)),
    unpaidAskBilledOffsetCents: hasIssuedXeroInvoice ? Math.max(0, reduction.offsetCents - retiredAsk.invoicedCents) : 0,
    reissuedAsk: reissueUnpaidAdditionalAsk({ askLeftCents: reduction.askLeftCents }),
  };
}

/**
 * After commit: cancel the retired asks' intents at Stripe now, rather than at
 * the recovery cron's next pass. Best-effort - the queued rows written in the
 * edit's transaction are the guarantee, and a capture before the cancel lands
 * is refunded by the superseded-capture path.
 */
export async function cancelRetiredAdditionalAsksNow({
  format,
  bookingId,
  retired,
}: {
  format: ClubFormat;
  bookingId: string;
  retired: readonly RetiredAdditionalAsk[];
}): Promise<void> {
  for (const entry of retired) {
    const outcome = await runPaymentRecoveryOperationNow(entry.cancelOperationId, format).catch(
      (err) => {
        logger.error(
          { err, bookingId, paymentIntentId: entry.paymentIntentId },
          "Immediate cancellation of an ask a reduction retired did not run; the queued recovery operation stands",
        );
        return "failed" as const;
      },
    );
    if (outcome !== "succeeded") {
      logger.warn(
        { bookingId, paymentIntentId: entry.paymentIntentId, operationId: entry.cancelOperationId, outcome },
        "An ask a reduction retired was not cancelled immediately; it stays confirmable until the queued recovery operation runs, and a capture in that window is refunded (#3954)",
      );
    }
  }
}

/** What a waiting re-issue an increase folded in says about itself (#3954 round 4). */
export const WAITING_REISSUE_FOLDED_BY_INCREASE_NOTE =
  "Not minted: a later price increase asked for this re-issued card request together with its own extra, on one fresh ask (#3954).";

/**
 * #3954 review round 4: A LATER INCREASE ASKS FOR A WAITING RE-ISSUE TOO.
 *
 * A reduction's smaller re-issue waits on its recovery until it is minted - for
 * the door's one-minute grace, or longer when that mint failed. Nothing on the
 * `Payment` shows it, so an increase sized off the `Payment` alone
 * (`sizeAdditionalAsk`) asked only for its own money; its mint then overtook
 * the re-issue and, under #3340's rule, the re-issue's whole figure was lost -
 * or, inside the grace, the door's re-issue minted after it and superseded the
 * increase's ask instead. The increase now folds every waiting re-issue into
 * its own ask as carried money (`INV-PAY-098`) and closes it under its locks,
 * fenced exactly as a reduction closes one (`closeWaitingAskRecoveries`), so
 * one fresh ask asks for both. Returns what it folded, for `sizeAdditionalAsk`.
 *
 * Re-issues only. An increase's own failed mint keeps #3340's rule, under
 * which a later ask overtakes it; that is not this change's to move.
 */
export async function foldWaitingReissuedAsks(
  tx: UnpaidAskDb,
  booking: UnpaidAskBooking,
  now: Date = new Date(),
): Promise<number> {
  const payment = booking.payment;
  if (!payment) return 0;
  const operations = await inFlightAskRecoveries(tx, booking, payment);
  if (operations.length === 0) return 0;
  const [transactions, modifications] = await Promise.all([
    tx.paymentTransaction.findMany({
      where: { paymentId: payment.id, kind: PaymentTransactionKind.ADDITIONAL },
      select: { kind: true, createdAt: true, stripePaymentIntentId: true },
    }),
    tx.bookingModification.findMany({
      where: { bookingId: booking.id },
      select: { id: true, priceDiffCents: true, changeFeeCents: true },
    }),
  ]);
  const waiting: PendingAskRecovery[] = [];
  for (const operation of operations) {
    if (isEditFinancialReviewAdditionalIntentRecoveryKey(operation.idempotencyKey)) continue;
    const bookingModificationId = bookingModificationIdForAdditionalIntentRecoveryKey(operation.idempotencyKey);
    if (!bookingModificationId) continue;
    const replay = sizeRecoveryReplayAsk({
      frozenAmountCents: operation.amountCents,
      modification: modifications.find((row) => row.id === bookingModificationId) ?? null,
      payment,
    });
    if (replay.kind !== "reissue" || isRecoveryReplaySettled(replay, operation, transactions)) continue;
    waiting.push({
      id: operation.id,
      bookingModificationId,
      kind: replay.kind,
      status: operation.status,
      attempts: operation.attempts,
      processingStartedAt: operation.processingStartedAt ?? null,
      askCents: replay.frozenCents,
      invoiceCents: 0,
    });
  }
  await closeWaitingAskRecoveries(tx, waiting, now, WAITING_REISSUE_FOLDED_BY_INCREASE_NOTE);
  return waiting.reduce((sum, recovery) => sum + recovery.askCents, 0);
}

/**
 * How long the door's own after-commit mint has a re-issued ask to itself
 * before the recovery runner may claim it (#3954 review round 4).
 */
export const REISSUED_ASK_INLINE_MINT_GRACE_MS = 60 * 1000;

/**
 * #3954 review round 4: THE RE-ISSUED ASK IS DURABLE FROM THE EDIT'S COMMIT.
 *
 * A reduction that shrinks an unpaid ask retires the old one inside its
 * transaction and used to mint the smaller one only after commit - so a
 * process dying in between left the member asked for nothing, with nothing to
 * retry. The edit now writes, in its own transaction and once its
 * `BookingModification` row exists, a PENDING `CREATE_ADDITIONAL_PAYMENT_INTENT`
 * recovery carrying the re-issued figure under a Stripe key scoped to the edit
 * (`buildReissuedAskStripeIdempotencyKey`), claimable only after
 * `REISSUED_ASK_INLINE_MINT_GRACE_MS`. The door's own mint after commit reads
 * the row and completes it (`writeReissuedAskUnderRecovery`); if that never
 * happens, the runner replays it under the same key, so the two converge on
 * one intent. Its edit's own net is negative, which is how the replay knows it
 * as a re-issue (`sizeRecoveryReplayAsk`). Nothing for any other edit.
 */
export async function queueReissuedAskRecovery(
  tx: Prisma.TransactionClient,
  {
    bookingId,
    paymentId,
    bookingModificationId,
    settled,
    now = new Date(),
  }: {
    bookingId: string;
    paymentId: string | null;
    bookingModificationId: string;
    settled: { additionalAsk: AdditionalAsk; hasIssuedXeroInvoice: boolean };
    now?: Date;
  },
): Promise<void> {
  if (!settled.additionalAsk.reissuesUnpaidAsk || settled.additionalAsk.amountCents <= 0 || !paymentId) {
    return;
  }
  await enqueueAdditionalPaymentIntentRecovery({
    bookingId,
    paymentId,
    idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey(bookingModificationId),
    amountCents: settled.additionalAsk.amountCents,
    stripeIdempotencyKey: buildReissuedAskStripeIdempotencyKey(bookingModificationId),
    hadIssuedXeroInvoice: settled.hasIssuedXeroInvoice,
    nextRetryAt: new Date(now.getTime() + REISSUED_ASK_INLINE_MINT_GRACE_MS),
    store: tx,
  });
}

/** A re-issued ask's recovery, as the door's after-commit mint reads it. */
export type ReissuedAskRecovery = {
  id: string;
  status: PaymentRecoveryOperationStatus;
  attempts: number;
  processingStartedAt: Date | null;
  /** The Stripe key frozen in the edit's transaction. */
  paymentIntentId: string;
};

/** The recovery `queueReissuedAskRecovery` wrote for this edit, if any. */
export async function readReissuedAskRecovery(
  bookingModificationId: string,
): Promise<ReissuedAskRecovery | null> {
  return prisma.paymentRecoveryOperation.findUnique({
    where: { idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey(bookingModificationId) },
    select: { id: true, status: true, attempts: true, processingStartedAt: true, paymentIntentId: true },
  });
}

/**
 * The door's own mint of a re-issued ask, WRITTEN ONLY WHILE ITS RECOVERY IS
 * STILL UNCLAIMED: the recovery is completed - fenced on exactly the state the
 * mint read - in one transaction with the ask's row and its supersede's durable
 * rows (`write`). A later reduction that netted the waiting re-issue off, or a
 * runner that claimed it after the grace, moved that state, so this writes
 * nothing (null) and the member is asked through whichever owns it now.
 */
export async function writeReissuedAskUnderRecovery<T>(
  recovery: ReissuedAskRecovery,
  paymentIntentId: string,
  write: (store: Prisma.TransactionClient) => Promise<T>,
  now: Date = new Date(),
): Promise<T | null> {
  return prisma.$transaction(async (tx) => {
    const completed = await tx.paymentRecoveryOperation.updateMany({
      where: {
        id: recovery.id,
        status: PaymentRecoveryOperationStatus.PENDING,
        attempts: recovery.attempts,
        processingStartedAt: recovery.processingStartedAt ?? null,
      },
      data: {
        status: PaymentRecoveryOperationStatus.SUCCEEDED,
        paymentIntentId,
        nextRetryAt: null,
        processingStartedAt: null,
        lastError: null,
        succeededAt: now,
      },
    });
    if (completed.count !== 1) return null;
    return write(tx);
  });
}
