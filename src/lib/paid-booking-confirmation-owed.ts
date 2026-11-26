/**
 * #5433 (ST, CP-2; owner decision D1): the record, inside a card settle's own
 * transaction, that the member is owed their booking confirmation.
 *
 * The settle (`settleAndPostBookingReceipts`) writes it when its body returns
 * "paid", which only the fresh PAID claim does, for a card settle whose caller
 * sends the confirmation: last in the transaction, after every existing write,
 * so it commits or rolls back with the payment and moves nothing else. A
 * replayed settle that finds the booking already paid never reaches the claim
 * and writes none. The confirm-pending job's zero-balance confirmation (#5433
 * PR 4, CP-1) writes the same marker at its own PENDING to PAID claim, last in
 * that transaction. The delivery after the commit, and the sweep that sends
 * what that attempt never did, are `paid-booking-confirmation-notice.ts`.
 *
 * Its own small module, so the settlement imports the marker write alone and
 * none of the email code that delivers it.
 *
 * Locks (`INV-LOCK-001`): one insert by primary key under the locks the settle
 * already holds (lock(1), the lodge key, the member credit key; the
 * zero-balance confirmation's lock(1) and lodge key), with no read,
 * provider call or settings query (`INV-INT-003`); `ON CONFLICT DO NOTHING`, so
 * no unique-key error can abort the settle.
 */
import type { Prisma } from "@prisma/client";

import logger from "@/lib/logger";
import type { OwedNoticeKind } from "@/lib/owed-notice/kinds";
import { owedNoticeInputProblem, recordOwedNotices, type OwedNoticeInput, type OwedNoticeMarker } from "@/lib/owed-notice/store";
import type { BookingSettlementSource } from "@/lib/payment-reconciliation-sources";

/** The owed confirmation's kind. Named for the email, not the payment, so the zero-balance and bank-transfer confirmations can join it. */
export const BOOKING_CONFIRMED_KIND: OwedNoticeKind = "booking-confirmed";

/** The marker's input for one payment: one definition for the write and its pre-check. */
function paidConfirmationInput(bookingId: string, paidAt: Date): OwedNoticeInput {
  return { kind: BOOKING_CONFIRMED_KIND, subjectId: bookingId, eventAt: paidAt };
}

/**
 * Record the confirmation as owed, keyed by the booking and the moment it was
 * paid (`paidAt`, taken once inside the settle), and return the marker for the
 * delivery after the commit (`INV-SSOT-002`).
 */
export async function recordPaidBookingConfirmationOwed(
  tx: Pick<Prisma.TransactionClient, "owedNotice">,
  { bookingId, paidAt }: { bookingId: string; paidAt: Date },
): Promise<OwedNoticeMarker> {
  const [marker] = await recordOwedNotices(tx, [paidConfirmationInput(bookingId, paidAt)]);
  return marker!;
}

/**
 * The settle's last write (`settleAndPostBookingReceipts`), given what its body
 * returned: record the confirmation as owed, paid now, when the body returned
 * "paid" (only its fresh PAID claim does) for a card settle whose caller asked
 * for it (`owesPaidConfirmation`); otherwise write nothing. The result goes back
 * with the marker, or null, for the caller's delivery after the commit.
 */
export async function owePaidConfirmationAfterFreshClaim<R extends { outcome: string }>(
  tx: Pick<Prisma.TransactionClient, "owedNotice">,
  bookingId: string,
  settlement: BookingSettlementSource,
  result: R,
): Promise<R & { paidConfirmation: OwedNoticeMarker | null }> {
  const owed = result.outcome === "paid" && settlement.kind === "stripe" && settlement.owesPaidConfirmation === true;
  if (!owed) return { ...result, paidConfirmation: null };
  return { ...result, paidConfirmation: await recordPaidConfirmationOwedUnlessUnkeyable(tx, bookingId) };
}

/**
 * Record the confirmation as owed, paid now, as the last write of the
 * transaction that made the booking paid, and return the marker; or, when the
 * booking cannot key one, an error log and null, with nothing written. The card
 * settle above and the confirm-pending job's zero-balance confirmation (#5433
 * PR 4, CP-1) both write through here.
 *
 * Round 1, item 1 (round 2, F3): the store throws on an input it cannot write,
 * and a throw here would roll back the payment (for a card, a captured one that
 * Stripe would retry for days). So the store's own rule is asked first, without
 * writing: an unwritable marker is an error log, and the transaction goes on.
 */
export async function recordPaidConfirmationOwedUnlessUnkeyable(
  tx: Pick<Prisma.TransactionClient, "owedNotice">,
  bookingId: string,
): Promise<OwedNoticeMarker | null> {
  const paidAt = new Date();
  const problem = owedNoticeInputProblem(paidConfirmationInput(bookingId, paidAt));
  if (problem) {
    logger.error({ bookingId, problem }, "A paid booking cannot key an owed confirmation; the payment settles and no confirmation is recorded as owed");
    return null;
  }
  return recordPaidBookingConfirmationOwed(tx, { bookingId, paidAt });
}
