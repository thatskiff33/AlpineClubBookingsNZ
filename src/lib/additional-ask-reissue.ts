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
 * - `foldWaitingAsks` - a later increase asks for a waiting re-issue, or a waiting increase retry, too.
 * - `cancelRetiredAdditionalAsksNow` - after commit, the retired intents die at
 *   Stripe before anything is minted.
 *
 * The rule is `INV-PAY-120`.
 */
import { PaymentRecoveryOperationStatus, PaymentTransactionKind, type Prisma } from "@prisma/client";

import { ADDITIONAL_ASK_QUEUE_TRANSACTION_OPTIONS, lockAdditionalAskQueue } from "@/lib/additional-ask-queue-transaction";
import { assertAskRecoveryNotBeingRaised, closeWaitingAskRecoveries, PENDING_ASK_NETTED_BY_REDUCTION_NOTE } from "@/lib/additional-ask-recovery-close";
import {
  inFlightAskRecoveries,
  reductionLeftAfterAskCents,
  retireUnpaidAskChain,
  type PendingAskRecovery,
  type ReductionAgainstUnpaidAsk,
  type RetiredAdditionalAsk,
  type UnpaidAskBooking,
  type UnpaidAskDb,
} from "@/lib/additional-ask-reduction";
import { isRecoveryReplaySettled, recoveryAskBeyondPaymentAskCents, sizeRecoveryReplayAsk } from "@/lib/additional-ask-recovery-replay";
import {
  NO_ADDITIONAL_ASK,
  reissueUnpaidAdditionalAsk,
  splitUnpaidAskOffsetForXero,
  type AdditionalAsk,
} from "@/lib/additional-payment-ask";
import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import { enqueueAdditionalPaymentIntentRecovery, runPaymentRecoveryOperationNow } from "@/lib/payment-recovery";
import {
  bookingModificationIdForAdditionalIntentRecoveryKey,
  buildAdditionalIntentRecoveryIdempotencyKey,
  buildReissuedAskStripeIdempotencyKey,
  isEditFinancialReviewAdditionalIntentRecoveryKey,
} from "@/lib/payment-recovery-keys";
import { lockPaymentForRefundedTotal } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import { unpaidAskBillingEvidence } from "@/lib/unpaid-ask-billing-evidence";
import { ordinaryAskDoorRequest, type OrdinaryAskDoor } from "@/lib/ordinary-ask-request";
import {
  NO_FOLDED_WAITING_ASKS,
  recordedFoldedAskInvoiceCents,
  recordedFoldedIncreaseAsks,
  recordedFoldedReissuedAskModificationIds,
  recordedReissuedAskInvoiceCents,
  recordedReissuedAskInvoiceUnsureCents,
  type FoldedIncreaseAsk,
  type FoldedReissuedAsks,
  type FoldedWaitingAsks,
} from "@/lib/unpaid-ask-offset-marker";
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
  const leftCents = reductionLeftAfterAskCents(reduction);
  if (settlementOptions && settlementOptions.basisAmountCents > leftCents) {
    throw new Error(
      `INV-PAY-120 / INV-PAY-047 (#3954): booking ${bookingId}'s settlement options return ${formatCents(settlementOptions.basisAmountCents, format)} of a reduction whose unpaid-ask offset leaves ${formatCents(leftCents, format)}; they were sized before the reduction was set against the unpaid ask.`,
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
   * The edits whose unpaid asks it retired - a parked invoice's anchor, a
   * waiting recovery's edit, or (round 8) a retired row's own edit - for the
   * history row the repair pass reads.
   */
  retiredAskModificationIds: string[];
  /** Decision A: what the re-issued ask's own supplementary invoice bills, 0 for none. */
  reissuedAskInvoiceCents: number;
  /**
   * Round 7: what that invoice may owe beyond it, where the evidence was not
   * established (`splitUnpaidAskOffsetForXero`) - reported for a person.
   */
  reissuedAskInvoiceUnsureCents: number;
  /** The part of the offset Xero had already billed, for the repair pass. */
  unpaidAskBilledOffsetCents: number;
  /**
   * Round 6: the part of the offset the primary invoice may have billed, where
   * what it billed could not be established (`unpaidAskBillingEvidence`) -
   * reported for a person, never credit-noted.
   */
  unpaidAskBilledOffsetUnsureCents: number;
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
  if (reduction.organiserExtras || reduction.offsetCents <= 0 || !booking.payment) {
    return {
      ...settled,
      retiredAdditionalAsks: [],
      retiredAskModificationIds: [],
      reissuedAskInvoiceCents: 0,
      reissuedAskInvoiceUnsureCents: 0,
      unpaidAskBilledOffsetCents: 0,
      unpaidAskBilledOffsetUnsureCents: 0,
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
  // Decision A (owner 9 Oct 2026, "Raise a $30 invoice") and the 10 Oct
  // "Auto credit note", split in one place (`splitUnpaidAskOffsetForXero`):
  // the smaller ask's own invoice bills what the retired asks' supplementary
  // invoices would have, less the offset; what the offset took beyond them the
  // primary invoice had billed. Round 6: which money a supplementary invoice
  // bills is read from evidence, not from the invoices that happen to be
  // parked yet (`unpaidAskBillingEvidence`).
  const evidence = hasIssuedXeroInvoice
    ? await unpaidAskBillingEvidence(tx, {
        bookingId: booking.id,
        paymentId: booking.payment.id,
        rows: reduction.ask.rows,
        retired: retiredAsk,
      })
    : { supplementaryInvoicedCents: retiredAsk.invoicedCents, established: true };
  const split = splitUnpaidAskOffsetForXero({
    offsetCents: reduction.offsetCents,
    askLeftCents: reduction.askLeftCents,
    supplementaryInvoicedCents: evidence.supplementaryInvoicedCents,
    primaryInvoiceIssued: hasIssuedXeroInvoice,
    billedByPrimaryEstablished: evidence.established,
  });
  return {
    ...settled,
    retiredAdditionalAsks: retiredAsk.retired,
    retiredAskModificationIds: retiredAsk.retiredAskModificationIds,
    reissuedAskInvoiceCents: split.reissuedAskInvoiceCents,
    reissuedAskInvoiceUnsureCents: split.reissuedAskInvoiceUnsureCents,
    unpaidAskBilledOffsetCents: split.billedOffsetCents,
    unpaidAskBilledOffsetUnsureCents: split.billedOffsetUnsureCents,
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

/** What a waiting increase retry a later increase folded in says about itself (#4744). */
export const WAITING_INCREASE_FOLDED_BY_INCREASE_NOTE =
  "Not minted: a later price increase asked for this increase together with its own extra, on one fresh ask (#4744).";

/**
 * #3954 review round 4, widened by #4744: A LATER INCREASE ASKS FOR A WAITING
 * ASK TOO.
 *
 * A reduction's smaller re-issue, and an increase whose card mint failed, wait
 * on their recovery until minted. Nothing on the `Payment` shows either, so an
 * increase sized off the `Payment` alone asked only for its own money. The
 * member could then pay that short ask and be asked again for the earlier one.
 * The increase now folds every waiting re-issue and every waiting increase
 * retry into its own ask as carried money (`INV-PAY-098`) and closes them
 * under its locks, fenced exactly as a reduction closes one
 * (`closeWaitingAskRecoveries`), so one fresh ask asks for all of it.
 *
 * Skipped, and left to their own replay: an officer's review charge, a frozen
 * figure with no edit to re-derive (#3340's recency rule), and one whose own
 * row already exists — that row is the `Payment`'s ask, which this mint
 * already carries. A retry claimed within the last two minutes refuses the
 * edit (409) rather than be closed under a mint that is in flight.
 */
export async function foldWaitingAsks(
  tx: UnpaidAskDb,
  booking: UnpaidAskBooking,
  now: Date = new Date(),
): Promise<FoldedWaitingAsks> {
  const payment = booking.payment;
  if (!payment) return NO_FOLDED_WAITING_ASKS;
  const operations = await inFlightAskRecoveries(tx, booking, payment);
  if (operations.length === 0) return NO_FOLDED_WAITING_ASKS;
  const [transactions, modifications] = await Promise.all([
    tx.paymentTransaction.findMany({
      where: { paymentId: payment.id, kind: PaymentTransactionKind.ADDITIONAL },
      // #4015: the own-row rule reads the edit stamp, the withdrawal and the status too (`findOwnRecoveryRow`).
      select: { kind: true, status: true, createdAt: true, stripePaymentIntentId: true, bookingModificationId: true, withdrawnAt: true },
    }),
    tx.bookingModification.findMany({
      where: { bookingId: booking.id },
      select: { id: true, priceDiffCents: true, changeFeeCents: true, newData: true },
    }),
  ]);
  const reissueWaiting: PendingAskRecovery[] = [];
  const increaseWaiting: PendingAskRecovery[] = [];
  const increases: FoldedIncreaseAsk[] = [];
  for (const operation of operations) {
    if (isEditFinancialReviewAdditionalIntentRecoveryKey(operation.idempotencyKey)) continue;
    const bookingModificationId = bookingModificationIdForAdditionalIntentRecoveryKey(operation.idempotencyKey);
    if (!bookingModificationId) continue;
    const modification = modifications.find((row) => row.id === bookingModificationId) ?? null;
    const replay = sizeRecoveryReplayAsk({
      frozenAmountCents: operation.amountCents,
      modification,
      payment,
    });
    if (replay.kind === "frozen") continue;
    if (isRecoveryReplaySettled(replay, operation, transactions)) {
      // A worker may have written its row and still be completing its invoice.
      // Refuse a recent claim even then. An older settled worker keeps its
      // completion: its money is already on the Payment, so nothing is folded.
      assertAskRecoveryNotBeingRaised(operation, now);
      continue;
    }
    const pending = {
      id: operation.id,
      bookingModificationId,
      kind: replay.kind,
      status: operation.status,
      attempts: operation.attempts,
      processingStartedAt: operation.processingStartedAt ?? null,
      askCents: 0,
      invoiceCents: 0,
      foldedInvoiceCents: 0,
      foldedInvoices: [],
      invoiceUnknown: false,
      foldedInvoiceUnknown: false,
    } satisfies PendingAskRecovery;
    if (replay.kind === "reissue") {
      reissueWaiting.push({ ...pending, askCents: replay.frozenCents });
      continue;
    }
    const askCents = recoveryAskBeyondPaymentAskCents(replay);
    if (askCents === null || askCents <= 0) continue;
    increases.push(foldedIncreaseEntry(bookingModificationId, operation, modification, askCents, modifications));
    increaseWaiting.push({ ...pending, askCents });
  }
  const reissues: FoldedReissuedAsks = {
    cents: reissueWaiting.reduce((sum, recovery) => sum + recovery.askCents, 0),
    modificationIds: reissueWaiting.map((recovery) => recovery.bookingModificationId),
    invoiceCents: reissueWaiting.reduce(
      (sum, recovery) =>
        sum + recordedReissuedAskInvoiceCents(modifications.find((row) => row.id === recovery.bookingModificationId)?.newData),
      0,
    ),
  };
  // #4217 (`INV-LOCK-002`): the Payment row before the recoveries it closes.
  if (reissueWaiting.length + increaseWaiting.length > 0) await lockPaymentForRefundedTotal(tx, payment.id);
  await closeWaitingAskRecoveries(tx, reissueWaiting, now, WAITING_REISSUE_FOLDED_BY_INCREASE_NOTE);
  await closeWaitingAskRecoveries(tx, increaseWaiting, now, WAITING_INCREASE_FOLDED_BY_INCREASE_NOTE);
  return {
    cents: reissues.cents + increases.reduce((sum, entry) => sum + entry.askCents, 0),
    invoiceCents: reissues.invoiceCents + increases.reduce((sum, entry) => sum + entry.invoiceCents, 0),
    reissues,
    increases,
  };
}

/** What one folded increase retry records: its money beyond the Payment, and the invoice answer frozen on its recovery. */
function foldedIncreaseEntry(
  modificationId: string,
  operation: { hadIssuedXeroInvoice: boolean | null },
  modification: { priceDiffCents: number; changeFeeCents: number; newData: unknown } | null,
  askCents: number,
  modifications: readonly { id: string; newData: unknown }[],
): FoldedIncreaseAsk {
  const ownNet = modification ? modification.priceDiffCents + modification.changeFeeCents : 0;
  const history = modification?.newData;
  const nested = recordedFoldedIncreaseAsks(history);
  const reissueUnsure = recordedFoldedReissuedAskModificationIds(history).some(
    (id) => recordedReissuedAskInvoiceUnsureCents(modifications.find((row) => row.id === id)?.newData) > 0,
  );
  const hadIssuedXeroInvoice = operation.hadIssuedXeroInvoice ?? null;
  return {
    modificationId,
    askCents,
    invoiceCents: (hadIssuedXeroInvoice === true ? Math.max(0, ownNet) : 0) + recordedFoldedAskInvoiceCents(history),
    invoiceUnsure: hadIssuedXeroInvoice === null || nested.unsure || nested.entries.some((entry) => entry.invoiceUnsure) || reissueUnsure,
    hadIssuedXeroInvoice,
  };
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

/**
 * #4744: a folding increase's own ask is durable from the edit's commit.
 *
 * Closing the earlier retry means that money now depends on this edit's
 * after-commit mint. A process dying between the commit and that mint, or the
 * enqueue that follows a failed mint, would lose it. The edit writes its own
 * recovery here, under the door's Stripe key, claimable only after the same
 * grace a re-issue gets, and the door completes it. A non-folding increase is
 * unchanged: its recovery is still written only if the mint fails.
 */
export async function queueFoldingAskRecovery(
  tx: Prisma.TransactionClient,
  {
    bookingId,
    paymentId,
    bookingModificationId,
    door,
    settled,
    now = new Date(),
  }: {
    bookingId: string;
    paymentId: string | null;
    bookingModificationId: string;
    door: OrdinaryAskDoor | null;
    settled: { additionalAsk: AdditionalAsk; hasIssuedXeroInvoice: boolean; foldedWaitingAsks?: FoldedWaitingAsks };
    now?: Date;
  },
): Promise<void> {
  const folded = settled.foldedWaitingAsks ?? NO_FOLDED_WAITING_ASKS;
  if (
    folded.cents <= 0 ||
    settled.additionalAsk.reissuesUnpaidAsk ||
    settled.additionalAsk.amountCents <= 0 ||
    !paymentId ||
    !door
  ) {
    return;
  }
  const { idempotencyKey } = ordinaryAskDoorRequest(door, bookingId, bookingModificationId);
  await enqueueAdditionalPaymentIntentRecovery({
    bookingId,
    paymentId,
    idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey(bookingModificationId),
    amountCents: settled.additionalAsk.amountCents,
    stripeIdempotencyKey: idempotencyKey,
    hadIssuedXeroInvoice: settled.hasIssuedXeroInvoice,
    nextRetryAt: new Date(now.getTime() + REISSUED_ASK_INLINE_MINT_GRACE_MS),
    store: tx,
  });
}

/** A re-issued ask's recovery, as the door's after-commit mint reads it. */
export type ReissuedAskRecovery = {
  id: string;
  /** #4217: the payment whose row is locked before this recovery's. */
  paymentId: string;
  status: PaymentRecoveryOperationStatus;
  attempts: number;
  processingStartedAt: Date | null;
  /** The Stripe key frozen in the edit's transaction. */
  paymentIntentId: string;
  /** The re-issued figure frozen in the edit's transaction. */
  amountCents: number;
  createdAt: Date;
  /** Who closed it without a mint, when someone did (#3954 final review). */
  lastError: string | null;
};

/** The recovery `queueReissuedAskRecovery` wrote for this edit, if any. */
export async function readReissuedAskRecovery(
  bookingModificationId: string,
): Promise<ReissuedAskRecovery | null> {
  return prisma.paymentRecoveryOperation.findUnique({
    where: { idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey(bookingModificationId) },
    select: {
      id: true,
      paymentId: true,
      status: true,
      attempts: true,
      processingStartedAt: true,
      paymentIntentId: true,
      amountCents: true,
      createdAt: true,
      lastError: true,
    },
  });
}

/**
 * #4052: whether an additional ask's recovery was closed without its mint, and by
 * whom: a later reduction that netted it off, or a later increase that folded
 * it into its own ask (`closeWaitingAskRecoveries`, each with its note). Either
 * way nobody mints under its Stripe key again. Null for anything else - still
 * waiting, claimed by the runner, completed with a mint, or failed.
 */
export function askClosedUnminted(
  recovery: Pick<ReissuedAskRecovery, "status" | "lastError"> | null,
): "netted" | "folded" | null {
  if (recovery?.status !== PaymentRecoveryOperationStatus.SUCCEEDED) return null;
  if (recovery.lastError === PENDING_ASK_NETTED_BY_REDUCTION_NOTE) return "netted";
  return recovery.lastError === WAITING_REISSUE_FOLDED_BY_INCREASE_NOTE ||
    recovery.lastError === WAITING_INCREASE_FOLDED_BY_INCREASE_NOTE
    ? "folded"
    : null;
}

/**
 * The door's own mint of a re-issued ask, WRITTEN ONLY WHILE ITS RECOVERY IS
 * STILL UNCLAIMED: the recovery is completed - fenced on exactly the state the
 * mint read - in one transaction with the ask's row and its supersede's durable
 * rows (`write`). A later reduction that netted the waiting re-issue off, or a
 * runner that claimed it after the grace, moved that state, so this writes
 * nothing (null) and the member is asked through whichever owns it now.
 */
export async function writeAskUnderDoorRecovery<T>(
  recovery: ReissuedAskRecovery,
  paymentIntentId: string,
  write: (store: Prisma.TransactionClient) => Promise<T>,
  now: Date = new Date(),
): Promise<T | null> {
  return prisma.$transaction(async (tx) => {
    // #4217, #4442 (`INV-LOCK-002`): the global key, then the Payment row, before the recovery row.
    await lockAdditionalAskQueue(tx, recovery.paymentId);
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
  }, ADDITIONAL_ASK_QUEUE_TRANSACTION_OPTIONS);
}
