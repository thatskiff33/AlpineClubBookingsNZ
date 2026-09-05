import type { BookingStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// test seam
// Booking statuses that represent a stay that has been committed (paid/confirmed
// or completed). Drafts, pending, cancelled, bumped and waitlisted bookings do
// not count toward a member's nights stayed.
export const COMMITTED_BOOKING_STATUSES: BookingStatus[] = [
  "CONFIRMED",
  "PAID",
  "COMPLETED",
];

type StayNightsClient = Pick<typeof prisma, "bookingGuestNight">;

/**
 * Count the distinct nights a member has personally stayed at the lodge.
 *
 * Counts distinct stay dates across the member's own member-guest rows
 * (BookingGuest.isMember = true, memberId = member) in committed, non-deleted
 * bookings. Used by the nomination eligibility gate.
 *
 * IT COUNTS ROWS, so a strand that holds its nights only through its stay
 * envelope contributes NOTHING here until those rows exist. #3214's strand
 * reconcile creates them, and a member can therefore cross `minimumNights` from
 * an officer recording what their nights sold for. That is a correction —
 * `INV-CAP-032` is that a guest with no night rows is one the system believes is
 * nowhere — and it is analysed where it is caused, in
 * `stored-night-price-strand-reconcile.ts`'s module docblock.
 */
export async function countMemberStayNights(
  memberId: string,
  client: StayNightsClient = prisma,
): Promise<number> {
  const where: Prisma.BookingGuestNightWhereInput = {
    bookingGuest: {
      isMember: true,
      memberId,
      booking: {
        status: { in: COMMITTED_BOOKING_STATUSES },
        deletedAt: null,
      },
    },
  };

  const rows = await client.bookingGuestNight.findMany({
    where,
    select: { stayDate: true },
    distinct: ["stayDate"],
  });

  return rows.length;
}
