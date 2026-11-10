/**
 * #3954 (`INV-PAY-120`): WHICH ASKS STILL WAITING ON A FAILED MINT'S RECOVERY A
 * PRICE REDUCTION MAY SET AGAINST, AND WHAT EACH WOULD HAVE BILLED - split from
 * `additional-ask-reduction.ts` (review round 8) to keep that module, which
 * reads and retires the ask, inside its size budget. Pure: the reads are the
 * caller's (`readUnpaidPriceAsk`, `inFlightAskRecoveries`).
 */
import { PaymentRecoveryOperationStatus } from "@prisma/client";

import type {
  AskTransaction,
  EditFigures,
  PendingAskRecovery,
  UnpaidAskBooking,
} from "@/lib/additional-ask-reduction";
import {
  isRecoveryReplaySettled,
  recoveryAskBeyondPaymentAskCents,
  sizeRecoveryReplayAsk,
} from "@/lib/additional-ask-recovery-replay";
import logger from "@/lib/logger";
import { foldedAskInvoiceParts } from "@/lib/folded-ask-invoice-parts";
import {
  bookingModificationIdForAdditionalIntentRecoveryKey,
  isEditFinancialReviewAdditionalIntentRecoveryKey,
} from "@/lib/payment-recovery-keys";
import {
  recordedReissuedAskInvoiceCents,
  recordedReissuedAskInvoiceUnsureCents,
} from "@/lib/unpaid-ask-offset-marker";

/** A waiting `CREATE_ADDITIONAL_PAYMENT_INTENT` recovery, as `inFlightAskRecoveries` reads it. */
export type AskRecoveryOperation = {
  id: string;
  status: PaymentRecoveryOperationStatus;
  attempts: number;
  nextRetryAt: Date | null;
  processingStartedAt: Date | null;
  idempotencyKey: string;
  /** The Stripe key until its replay mints, then that intent's id. */
  paymentIntentId: string;
  amountCents: number;
  hadIssuedXeroInvoice: boolean | null;
  createdAt: Date;
};

/**
 * Asks whose mint failed and that their recovery will still mint, each sized
 * exactly as that replay will size it (`sizeRecoveryReplayAsk`), less what it
 * would carry from the rows' ask, which `unpaidChain` already counts. A
 * recovery with nothing left to mint (`isRecoveryReplaySettled`, the replay's
 * own rule) is not owed. Null - net nothing - for one this cannot size.
 *
 * ONLY THE MEMBER'S OWN PRICE ASKS (#3954, owner decision 9 Oct 2026, "Only
 * the member's request"). A review charge's recovery is an officer's money
 * (`INV-ADDPAY-040`): it is left exactly as set - not counted, not closed -
 * and the reduction still nets against the price asks beside it. (It used to
 * turn netting off for the whole booking.) When it mints, it carries what the
 * price ask then is, the reduction's smaller re-issue included.
 */
export function pendingAskRecoveries(
  booking: UnpaidAskBooking,
  payment: NonNullable<UnpaidAskBooking["payment"]>,
  operations: readonly AskRecoveryOperation[],
  transactions: readonly AskTransaction[],
  modifications: readonly EditFigures[],
): PendingAskRecovery[] | null {
  const pending: PendingAskRecovery[] = [];
  for (const operation of operations) {
    if (isEditFinancialReviewAdditionalIntentRecoveryKey(operation.idempotencyKey)) continue;
    const bookingModificationId = bookingModificationIdForAdditionalIntentRecoveryKey(
      operation.idempotencyKey,
    );
    const modification = modifications.find((row) => row.id === bookingModificationId) ?? null;
    const replay = bookingModificationId
      ? sizeRecoveryReplayAsk({ frozenAmountCents: operation.amountCents, modification, payment })
      : null;
    const askCents = replay ? recoveryAskBeyondPaymentAskCents(replay) : null;
    if (!bookingModificationId || !replay || replay.kind === "frozen" || askCents === null) {
      logger.warn(
        { bookingId: booking.id, paymentId: payment.id, operationId: operation.id },
        "An additional ask waiting on its recovery cannot be sized; a reduction settles without setting against it (#3954)",
      );
      return null;
    }
    // CLAIMED FIRST, THEN SETTLED (review round 4). A retry already minting
    // may have written its own row and still be on its way to its supersede
    // and its invoice; skipping it as settled would leave it free to finish
    // beside this reduction. So a claimed retry is always carried to the
    // retire, which refuses or fences it; it adds nothing to the ask when a
    // row already carries it.
    const claimed = operation.status === PaymentRecoveryOperationStatus.PROCESSING;
    const settled = isRecoveryReplaySettled(replay, operation, transactions);
    if (settled && !claimed) continue;
    const folded = !settled && replay.kind === "increase"
      ? foldedAskInvoiceParts(modification?.newData, modifications)
      : { parts: [], unsure: false };
    const foldedInvoices = folded.parts;
    pending.push({
      id: operation.id,
      bookingModificationId,
      kind: replay.kind,
      status: operation.status,
      attempts: operation.attempts,
      // Never `undefined`: an undefined filter is no filter at all in Prisma.
      processingStartedAt: operation.processingStartedAt ?? null,
      askCents: settled ? 0 : askCents,
      invoiceCents: settled
        ? 0
        : replay.kind === "reissue"
          ? recordedReissuedAskInvoiceCents(modification?.newData)
          : operation.hadIssuedXeroInvoice === true
            ? askCents - (replay.kind === "increase" ? replay.foldedCents : 0)
            : 0,
      foldedInvoiceCents: foldedInvoices.reduce((sum, part) => sum + part.invoiceCents, 0),
      foldedInvoices,
      // Round 8: a re-issue whose reduction was unsure of its invoice is no
      // surer for being retired; nor is an increase's fold of one. #4744: nor a folded increase retry.
      invoiceUnknown:
        !settled &&
        (replay.kind === "increase"
          ? operation.hadIssuedXeroInvoice === null
          : recordedReissuedAskInvoiceUnsureCents(modification?.newData) > 0),
      foldedInvoiceUnknown: folded.unsure,
    });
  }
  return pending;
}

/**
 * Folded invoices a reduction has not already counted from a parked operation.
 * A legacy invoice waiting on a folded increase is in the parked total; the
 * rest of the fold is not queued until the increase mints.
 */
export function foldedInvoiceCentsNotParked(
  recoveries: readonly { foldedInvoiceCents: number; foldedInvoices: readonly { modificationId: string; invoiceCents: number }[] }[],
  parkedAnchors: ReadonlySet<string>,
): number {
  return recoveries.reduce((sum, recovery) => {
    if (recovery.foldedInvoices.length === 0) return sum + recovery.foldedInvoiceCents;
    return sum + recovery.foldedInvoices.reduce((partSum, part) => partSum + (parkedAnchors.has(part.modificationId) ? 0 : part.invoiceCents), 0);
  }, 0);
}
