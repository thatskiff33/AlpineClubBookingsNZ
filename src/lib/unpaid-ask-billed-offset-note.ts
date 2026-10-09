/**
 * #3954 (owner decision 10 Oct 2026, "Auto credit note", `INV-PAY-120`): A
 * REDUCTION CREDITS THE PRIMARY INVOICE FOR THE PART OF ITS OFFSET THAT
 * INVOICE ALREADY BILLED.
 *
 * A reduction set against an unpaid card ask releases the member from money
 * nobody paid (`settleReductionAgainstUnpaidAsk`). Where the increase's own
 * supplementary invoice was still parked on the ask, it is retired with it and
 * nothing reached Xero. But a primary invoice raised AFTER the increase bills
 * the booking as it then stood, ask included, so Xero still bills the part of
 * the offset that the retired invoices did not carry
 * (`unpaidAskBilledOffsetCents`). The edit queues a credit note for exactly
 * that, allocated against the primary invoice and worded as an invoice
 * correction - nothing was refunded.
 *
 * - DETERMINISTIC: the figure is the reduction's own history, fixed in its
 *   transaction from what it retired, so a retired invoice's money is never
 *   credited as well (the two paths never double up).
 * - DURABLE: queued in the edit's own transaction, beside the re-issued ask's
 *   recovery (`queueReductionAskFollowUps`), so a process dying after commit
 *   loses nothing; the outbox worker raises it.
 * - IDEMPOTENT: one note per reducing edit, scoped
 *   (`UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE`) on the existing per-share key slot,
 *   as #3809's give-back note is. The enqueue's own-key dedupe (a SUCCEEDED row
 *   included, for a scoped note) answers a replay, and the repair pass verifies
 *   the note or queues it under the same key (`scopedBilledOffsetNote`).
 * - NO CASH: the inbound credit-note sync leaves it out of the payment's
 *   refunded total (`noCashModificationNoteIds`).
 */
import type { Prisma } from "@prisma/client";

import { queueReissuedAskRecovery } from "@/lib/additional-ask-reissue";
import type { AdditionalAsk } from "@/lib/additional-payment-ask";
import { enqueueXeroModificationCreditNoteOperation } from "@/lib/xero-operation-outbox";
import { UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE } from "@/lib/xero-review-task-key";

/** Queue the reduction's invoice-correction note for the offset Xero had billed, in the edit's transaction. */
export async function queueUnpaidAskBilledOffsetNote(
  tx: Prisma.TransactionClient,
  {
    bookingId,
    bookingModificationId,
    unpaidAskBilledOffsetCents,
  }: {
    bookingId: string;
    /** The REDUCING edit, whose history records the figure and which anchors the note. */
    bookingModificationId: string;
    unpaidAskBilledOffsetCents: number;
  },
): Promise<string | null> {
  if (unpaidAskBilledOffsetCents <= 0) return null;
  const queued = await enqueueXeroModificationCreditNoteOperation(
    {
      bookingId,
      refundAmountCents: unpaidAskBilledOffsetCents,
      bookingModificationId,
      noteWording: "invoice-correction",
      reviewTaskId: UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE,
    },
    { store: tx },
  );
  return queued.queueOperationId;
}

/**
 * Everything a reduction set against an unpaid ask makes durable in its own
 * transaction, once its `BookingModification` row exists: the smaller
 * re-issued ask's recovery (`queueReissuedAskRecovery`) and the note for the
 * offset the primary invoice had billed. Every edit door that records an
 * offset calls this exactly once (the `INV-PAY-120` census).
 */
export async function queueReductionAskFollowUps(
  tx: Prisma.TransactionClient,
  {
    bookingId,
    paymentId,
    bookingModificationId,
    settled,
  }: {
    bookingId: string;
    paymentId: string | null;
    bookingModificationId: string;
    settled: { additionalAsk: AdditionalAsk; hasIssuedXeroInvoice: boolean; unpaidAskBilledOffsetCents: number };
  },
): Promise<void> {
  await queueReissuedAskRecovery(tx, { bookingId, paymentId, bookingModificationId, settled });
  await queueUnpaidAskBilledOffsetNote(tx, {
    bookingId,
    bookingModificationId,
    unpaidAskBilledOffsetCents: settled.unpaidAskBilledOffsetCents,
  });
}
