import "server-only";

import type { Prisma } from "@prisma/client";

import type { EditReviewSettlementRoute } from "@/lib/edit-financial-review-settlement";
import {
  createBookingModificationCredit,
  giveBackAppliedCreditForReviewShare,
} from "@/lib/member-credit";

/**
 * #3032/#3791: the account-credit route's write, inside the caller's
 * transaction and after its status claim (the claim is what makes it run once).
 *
 * WITH a captured payment: one `BOOKING_MODIFICATION_REFUND` credit on the
 * edit's anchor, allocated against that payment - unchanged.
 *
 * WITHOUT one (#3791): the booking was paid by account credit, so the share is
 * that credit coming back. It is returned as a give-back of applied credit -
 * the clamp's own mechanism - which lowers the applied figure a later
 * cancellation tiers. Minting it instead left the applied figure whole and the
 * cancellation paid the share a second time. Only a share LARGER than the
 * applied credit mints its remainder, exactly as before.
 */
export async function writeEditReviewAccountCredit({
  route,
  memberId,
  bookingId,
  amountCents,
  store,
}: {
  route: Extract<EditReviewSettlementRoute, { kind: "account-credit" }>;
  memberId: string;
  bookingId: string;
  amountCents: number;
  store: Prisma.TransactionClient;
}): Promise<void> {
  const givenBackCents =
    route.allocateAgainstPaymentId === null
      ? await giveBackAppliedCreditForReviewShare(
          { memberId, bookingId, shareCents: amountCents },
          store,
        )
      : 0;
  const mintCents = amountCents - givenBackCents;
  if (mintCents <= 0) return;
  // The canonical account-credit writer, re-entered unchanged. Its exactly-once
  // key is the `BookingModification` id (D-3032-1), and it writes the refund
  // allocation itself when handed a payment id.
  await createBookingModificationCredit(
    memberId,
    mintCents,
    bookingId,
    route.bookingModificationId,
    undefined,
    store,
    route.allocateAgainstPaymentId ?? undefined,
  );
}
