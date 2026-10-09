import { BookingRequestType, type Prisma } from "@prisma/client";

/**
 * IS THIS BOOKING A SCHOOL GROUP'S? — the one answer (`INV-SSOT-001`).
 *
 * A booking converted from, or held for, a SCHOOL booking request. Bed
 * allocation rooms such a group's adults together and its students separately
 * (#1768), and hut-leader coverage lets each lodge decide who may lead its
 * nights (#3819). Both ask here: {@link isSchoolGroupBooking} for a loaded row,
 * {@link SCHOOL_GROUP_BOOKING_WHERE} for a query.
 */
type RequestLink = { type: BookingRequestType | `${BookingRequestType}` } | null | undefined;

export function isSchoolGroupBooking(booking: {
  originBookingRequest?: RequestLink;
  heldForBookingRequest?: RequestLink;
} | null | undefined): boolean {
  return (
    booking?.originBookingRequest?.type === BookingRequestType.SCHOOL ||
    booking?.heldForBookingRequest?.type === BookingRequestType.SCHOOL
  );
}

/**
 * {@link isSchoolGroupBooking} as a Prisma filter. Its top level is an `OR`, so
 * spread it under `AND` beside a where that has an `OR` of its own.
 */
export const SCHOOL_GROUP_BOOKING_WHERE = {
  OR: [
    { originBookingRequest: { is: { type: BookingRequestType.SCHOOL } } },
    { heldForBookingRequest: { is: { type: BookingRequestType.SCHOOL } } },
  ],
} as const satisfies Prisma.BookingWhereInput;
