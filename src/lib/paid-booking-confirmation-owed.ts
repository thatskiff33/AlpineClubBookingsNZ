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

import type { OwedNoticeKind } from "@/lib/owed-notice/kinds";
import { recordOwedNotices, type OwedNoticeMarker } from "@/lib/owed-notice/store";

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
