import { Prisma } from "@prisma/client";

import { bookingOwner } from "@/lib/booking-owner";

/**
 * #4042, #3949: what an officer-facing line selects to name a booking's owner, and the name it prints - a member's
 * first and last name, or an organisation's name (`bookingOwner`, `INV-SSOT-005`). One select and one spelling for
 * every alert and task reason that names a group organiser.
 */
export const BOOKING_OWNER_NAME_SELECT = Prisma.validator<Prisma.BookingSelect>()({
  member: { select: { firstName: true, lastName: true } },
  organisation: { select: { name: true, email: true } },
});

export function bookingOwnerName(booking: Prisma.BookingGetPayload<{ select: typeof BOOKING_OWNER_NAME_SELECT }>): string {
  const { firstName, lastName } = bookingOwner(booking).member;
  return [firstName, lastName].filter(Boolean).join(" ");
}
