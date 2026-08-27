import { prisma } from "./prisma";
import { BookingStatus } from "@prisma/client";
import { clubToday, dateOnlyInstantOf } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import logger from "@/lib/logger";
import { reconcileBedAllocationsForBookingWithLodgeLockHeld } from "@/lib/bed-allocation-lifecycle";
import { acquireLodgeCapacityLock } from "@/lib/capacity";

export interface CompleteBookingsResult {
  completedCount: number;
  completedBookingIds: string[];
}

/**
 * Transition PAID bookings to COMPLETED once their check-out date has fully
 * passed (issue #2029). Runs daily. A booking stays PAID — and therefore
 * editable/extendable — through the ENTIRE check-out day (NZ time): guests may
 * still be at the lodge on their check-out morning and must be able to extend
 * their stay. The stay is only "completed" once the NZ calendar date is
 * strictly AFTER `checkOut` (`checkOut < today`), i.e. from the first cron run
 * after 11:59pm NZ on the check-out date. `checkOut` is the departure date
 * (exclusive of the last night), so `checkOut < today` means every booked
 * night, and the whole check-out day, is behind us.
 */
export async function completeBookings(): Promise<CompleteBookingsResult> {
  const today = dateOnlyInstantOf(clubToday(await readClubTimeZoneOutsideRequest()));

  const candidates = await prisma.booking.findMany({
    where: { status: BookingStatus.PAID, checkOut: { lt: today } },
    select: { id: true },
  });
  const bookingsToComplete: Array<{
    id: string;
    checkIn: Date;
    checkOut: Date;
    lodgeId: string;
  }> = [];
  for (const candidate of candidates) {
    const completed = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      const key = await tx.booking.findUnique({
        where: { id: candidate.id },
        select: { lodgeId: true },
      });
      if (!key) return null;
      await acquireLodgeCapacityLock(tx, key.lodgeId);
      const booking = await tx.booking.findUnique({
        where: { id: candidate.id },
        select: { id: true, checkIn: true, checkOut: true, lodgeId: true, status: true },
      });
      if (
        !booking ||
        booking.status !== BookingStatus.PAID ||
        booking.checkOut >= today
      ) {
        return null;
      }
      const claimed = await tx.booking.updateMany({
        where: {
          id: booking.id,
          status: BookingStatus.PAID,
          checkOut: { lt: today },
        },
        data: { status: BookingStatus.COMPLETED },
      });
      if (claimed.count === 0) return null;
      await reconcileBedAllocationsForBookingWithLodgeLockHeld({
        bookingId: booking.id,
        db: tx,
        previousRange: {
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        },
      });
      return booking;
    });
    if (completed) bookingsToComplete.push(completed);
  }

  if (bookingsToComplete.length === 0) {
    return { completedCount: 0, completedBookingIds: [] };
  }

  const ids = bookingsToComplete.map((b) => b.id);

  logger.info(
    { job: "complete-bookings", count: ids.length },
    "Transitioned PAID bookings to COMPLETED"
  );

  return { completedCount: ids.length, completedBookingIds: ids };
}
