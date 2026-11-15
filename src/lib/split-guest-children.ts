import { BookingStatus, type Prisma } from "@prisma/client";

/**
 * Which linked bookings are genuine split guest children (#738): still PENDING,
 * carrying non-members, and not a #796 group joiner (joiners share
 * `parentBookingId` but always have a join row and settle through their own
 * flow). One definition for every caller that picks the children a
 * split-guest payment link goes to: the member's "send guest payment link"
 * route and the officer's fresh-copy panel. `issueSplitGuestPaymentLink`
 * applies {@link isSplitGuestChild} to the row it loads, plus deletion and the
 * saved-card rule, before it mints anything.
 *
 * Kept in its own dependency-free module so routes and services can import it
 * without pulling in the issuer (which several tests replace with a mock).
 */
export const SPLIT_GUEST_CHILD_WHERE = {
  status: BookingStatus.PENDING,
  hasNonMembers: true,
  groupBookingJoin: { is: null },
} as const satisfies Prisma.BookingWhereInput;

/** The same rule as {@link SPLIT_GUEST_CHILD_WHERE}, for a row already loaded. */
export function isSplitGuestChild(booking: {
  parentBookingId: string | null;
  status: BookingStatus;
  hasNonMembers: boolean;
  groupBookingJoin: { id: string } | null;
}): boolean {
  return (
    booking.parentBookingId !== null &&
    booking.status === SPLIT_GUEST_CHILD_WHERE.status &&
    booking.hasNonMembers === SPLIT_GUEST_CHILD_WHERE.hasNonMembers &&
    booking.groupBookingJoin === null
  );
}
