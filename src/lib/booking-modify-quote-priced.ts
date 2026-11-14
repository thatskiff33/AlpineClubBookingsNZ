// Split out of src/lib/booking-modify-validation.ts (#4924 kept that file within
// its size budget): the booking-request-origin fences on a booking edit - the
// quote-priced block and the member whole-lodge test. Code moved verbatim;
// import via the "@/lib/booking-modify" barrel.

import type { Prisma } from "@prisma/client";

import { ApiError } from "@/lib/api-error";

/**
 * Bookings converted from (or held for) a public/school booking request keep
 * an officer-negotiated price that was flat-split across the guest rows; the
 * quote's per-tier rates are not persisted on the booking. Every standard
 * edit path reprices the whole booking at current season rates, which would
 * silently replace the negotiated basis — a one-student addition can swing
 * the total by the full quote-vs-season delta (#1032) — so those paths
 * refuse instead and direct the admin to the booking-request re-quote /
 * re-price flow.
 */
export async function isQuotePricedBooking(
  db: Prisma.TransactionClient,
  bookingId: string,
): Promise<boolean> {
  const request = await db.bookingRequest.findFirst({
    where: {
      OR: [{ convertedBookingId: bookingId }, { heldBookingId: bookingId }],
    },
    select: { id: true },
  });
  return Boolean(request);
}

export const QUOTE_PRICED_EDIT_BLOCK_MESSAGE =
  "This booking keeps a negotiated booking-request price, so standard edits are disabled — they would reprice every guest at season rates. Re-price or issue a revised quote from its booking request instead.";

/** #4202: the member-origin link fence's one wording, for the save, the quote and the promo box. */
export const GUEST_MEMBER_LINK_MEMBER_WHOLE_LODGE_ONLY_MESSAGE =
  "Linking a placeholder to a member is only available on member whole-lodge bookings.";
/**
 * True when this booking was created from an authenticated member whole-lodge
 * request (#2263) — `requestedByMemberId` set and `exclusivityRequested` — as
 * opposed to a public or SCHOOL booking request. Mirrors
 * `isMemberWholeLodgeRequest` at the booking level.
 *
 * The #2337 placeholder→member link keys on this, NOT on `Booking.wholeLodgeHold`
 * alone: a school whole-lodge booking ALSO carries `wholeLodgeHold` (the admin
 * capacity action), and its non-member student rows would pass the placeholder
 * gate — so re-rating one at a member rate would silently corrupt the school's
 * flat-split negotiated price. Member-origin is the fence that keeps the re-rate
 * to the one booking class whose placeholders were always meant to re-rate.
 *
 * Every member whole-lodge booking is also "quote-priced" (its placeholders were
 * flat-split at approval), so `isQuotePricedBooking` returns true for it and the
 * standard structural-edit block would refuse the link; the apply/quote paths
 * exempt a member-whole-lodge link-only request from that block for exactly this
 * reason.
 */
export async function isMemberWholeLodgeBooking(
  db: Prisma.TransactionClient,
  bookingId: string,
): Promise<boolean> {
  const request = await db.bookingRequest.findFirst({
    where: {
      OR: [{ convertedBookingId: bookingId }, { heldBookingId: bookingId }],
      requestedByMemberId: { not: null },
      exclusivityRequested: true,
    },
    select: { id: true },
  });
  return Boolean(request);
}

export async function assertBookingNotQuotePriced(
  db: Prisma.TransactionClient,
  bookingId: string,
): Promise<void> {
  if (await isQuotePricedBooking(db, bookingId)) {
    throw new ApiError(QUOTE_PRICED_EDIT_BLOCK_MESSAGE, 400);
  }
}
