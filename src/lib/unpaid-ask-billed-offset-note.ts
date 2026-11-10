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
 *   recovery (`queueEditAskFollowUps`), so a process dying after commit
 *   loses nothing; the outbox worker raises it.
 * - IDEMPOTENT: one note per reducing edit, scoped
 *   (`UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE`) on the existing per-share key slot,
 *   as #3809's give-back note is. The enqueue's own-key dedupe (a SUCCEEDED row
 *   included, for a scoped note) answers a replay, and the repair pass verifies
 *   the note or queues it under the same key (`scopedBilledOffsetNote`).
 * - NO CASH: the inbound credit-note sync leaves it out of the payment's
 *   refunded total (`noCashModificationNoteIds`).
 * - AFTER THE EDIT'S OWN NOTE (round 7): where the edit's Xero leg will queue
 *   one after commit, the payload says so and this note waits for it
 *   (`unpaid-ask-billed-offset-order.ts`).
 */
import type { Prisma } from "@prisma/client";

import { queueFoldingAskRecovery, queueReissuedAskRecovery } from "@/lib/additional-ask-reissue";
import type { AdditionalAsk } from "@/lib/additional-payment-ask";
import type { OrdinaryAskDoor } from "@/lib/ordinary-ask-request";
import type { FoldedWaitingAsks } from "@/lib/unpaid-ask-offset-marker";
import { ownNoteExpected } from "@/lib/unpaid-ask-billed-offset-order";
import { enqueueXeroModificationCreditNoteOperation } from "@/lib/xero-operation-outbox";
import { UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE } from "@/lib/xero-review-task-key";

/** Queue the reduction's invoice-correction note for the offset Xero had billed, in the edit's transaction. */
export async function queueUnpaidAskBilledOffsetNote(
  tx: Prisma.TransactionClient,
  {
    bookingId,
    bookingModificationId,
    unpaidAskBilledOffsetCents,
    ownNoteExpected,
  }: {
    bookingId: string;
    /** The REDUCING edit, whose history records the figure and which anchors the note. */
    bookingModificationId: string;
    unpaidAskBilledOffsetCents: number;
    /** Round 7: the edit's own note is still to be queued; this one waits for it. */
    ownNoteExpected: boolean;
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
      ownNoteExpected,
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
export async function queueEditAskFollowUps(
  tx: Prisma.TransactionClient,
  {
    bookingId,
    paymentId,
    bookingModificationId,
    door = null,
    settled,
    now,
  }: {
    bookingId: string;
    paymentId: string | null;
    bookingModificationId: string;
    /** The door's Stripe key, so a folding increase's recovery replays the door's own request. */
    door?: OrdinaryAskDoor | null;
    settled: {
      additionalAsk: AdditionalAsk;
      hasIssuedXeroInvoice: boolean;
      unpaidAskBilledOffsetCents: number;
      /** What the edit's own note will return of the reduction left after the ask. */
      xeroRefundAmountCents: number;
      /** An organiser's card refund raises its note later, not the edit's Xero leg. */
      organiserChildRefund: unknown;
      foldedWaitingAsks?: FoldedWaitingAsks;
    };
    now?: Date;
  },
): Promise<void> {
  await queueReissuedAskRecovery(tx, { bookingId, paymentId, bookingModificationId, settled, ...(now ? { now } : {}) });
  await queueUnpaidAskBilledOffsetNote(tx, {
    bookingId,
    bookingModificationId,
    unpaidAskBilledOffsetCents: settled.unpaidAskBilledOffsetCents,
    ownNoteExpected: ownNoteExpected(settled),
  });
  await queueFoldingAskRecovery(tx, { bookingId, paymentId, bookingModificationId, door, settled, ...(now ? { now } : {}) });
}
