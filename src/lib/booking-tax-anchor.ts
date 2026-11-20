import type { Prisma } from "@prisma/client";
import { requireInstant, type Instant } from "@/lib/club-time";

/**
 * A BOOKING'S TAX ANCHOR (#4632, owner decision A; `INV-CONFIG-007`): the one
 * definition the member-money journal (`booking-journal-read.ts`) and every
 * Xero document for the booking (`xero-tax-anchors.ts`) read, so the two can
 * never split one charge under different treatments.
 *
 * A booking's anchor is the moment it was made. A group place (a booking with a
 * `parentBookingId`) takes its organiser's booking's moment instead: the
 * group's combined invoice renders every organiser-settled place's lines on
 * the organiser's booking, so the place's journal split must use that same
 * date. It is the organiser's for every place in the group, organiser-settled
 * or not, because `organiserSettled` can flip after the charge posts (a joiner
 * switched to paying for themselves keeps the treatment its charge took), while
 * `parentBookingId` and both `createdAt` values are written once at creation.
 * That immutability is also why the read needs no lock.
 */
export async function readBookingTaxAnchorInstant(
  db: Pick<Prisma.TransactionClient, "booking">,
  bookingId: string,
): Promise<Instant> {
  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: { createdAt: true, parentBooking: { select: { createdAt: true } } },
  });
  if (!booking) throw new Error(`Booking ${bookingId} does not exist, so its charges and documents have no tax anchor.`);
  return requireInstant(booking.parentBooking?.createdAt ?? booking.createdAt);
}
