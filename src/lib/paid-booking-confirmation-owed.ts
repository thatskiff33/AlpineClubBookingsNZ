/**
 * #5433 (ST, CP-2; owner decision D1): the record, inside a card settle's own
 * transaction, that the member is owed their booking confirmation.
 *
 * The settle (`settleAndPostBookingReceipts`) writes it when its body returns
 * "paid", which only the fresh PAID claim does, for a card settle whose caller
 * sends the confirmation: last in the transaction, after every existing write,
 * so it commits or rolls back with the payment and moves nothing else. A
 * replayed settle that finds the booking already paid never reaches the claim
 * and writes none. The delivery after the
 * commit, and the sweep that sends what that attempt never did, are
 * `paid-booking-confirmation-notice.ts`.
 *
 * Its own small module, so the settlement imports the marker write alone and
 * none of the email code that delivers it.
 *
 * Locks (`INV-LOCK-001`): one insert by primary key under the locks the settle
 * already holds (lock(1), the lodge key, the member credit key), with no read,
 * provider call or settings query (`INV-INT-003`); `ON CONFLICT DO NOTHING`, so
 * no unique-key error can abort the settle.
 */
import type { Prisma } from "@prisma/client";

import logger from "@/lib/logger";
import type { OwedNoticeKind } from "@/lib/owed-notice/kinds";
import { OWED_NOTICE_PAYLOAD_ID, recordOwedNotices, type OwedNoticeMarker } from "@/lib/owed-notice/store";
import type { BookingSettlementSource } from "@/lib/payment-reconciliation-sources";

/** The owed confirmation's kind. Named for the email, not the payment, so the zero-balance and bank-transfer confirmations can join it. */
export const BOOKING_CONFIRMED_KIND: OwedNoticeKind = "booking-confirmed";

/**
 * Record the confirmation as owed, keyed by the booking and the moment it was
 * paid (`paidAt`, taken once inside the settle), and return the marker for the
 * delivery after the commit (`INV-SSOT-002`).
 */
export async function recordPaidBookingConfirmationOwed(
  tx: Pick<Prisma.TransactionClient, "owedNotice">,
  { bookingId, paidAt }: { bookingId: string; paidAt: Date },
): Promise<OwedNoticeMarker> {
  const [marker] = await recordOwedNotices(tx, [{ kind: BOOKING_CONFIRMED_KIND, subjectId: bookingId, eventAt: paidAt }]);
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
  // Round 1, item 1: the marker's identity check throws on a booking id that is
  // not an id, and a throw here would roll back a captured card payment (and
  // Stripe would retry it for days). So the shape is decided first, without
  // writing: an unwritable marker is an error log, and the settle goes on.
  if (!OWED_NOTICE_PAYLOAD_ID.test(bookingId)) {
    logger.error({ bookingId }, "A paid booking's id cannot key an owed confirmation; the payment settles and no confirmation is recorded as owed");
    return { ...result, paidConfirmation: null };
  }
  return { ...result, paidConfirmation: await recordPaidBookingConfirmationOwed(tx, { bookingId, paidAt: new Date() }) };
}
