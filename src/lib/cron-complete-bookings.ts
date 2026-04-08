import { prisma } from "./prisma";
import { BookingStatus } from "@prisma/client";
import { getNZSTToday } from "@/lib/nzst-date";
import logger from "@/lib/logger";

export interface CompleteBookingsResult {
  completedCount: number;
  completedBookingIds: string[];
}

/**
 * Transition PAID bookings to COMPLETED once their check-in date has passed.
 * Runs daily. A booking is considered "completed" (i.e. the stay has started
 * and it's too late to amend) once checkIn <= today.
 */
export async function completeBookings(): Promise<CompleteBookingsResult> {
  const today = getNZSTToday();

  const bookingsToComplete = await prisma.booking.findMany({
    where: {
      status: BookingStatus.PAID,
      checkIn: { lte: today },
    },
    select: { id: true },
  });

  if (bookingsToComplete.length === 0) {
    return { completedCount: 0, completedBookingIds: [] };
  }

  const ids = bookingsToComplete.map((b) => b.id);

  await prisma.booking.updateMany({
    where: { id: { in: ids } },
    data: { status: BookingStatus.COMPLETED },
  });

  logger.info(
    { job: "complete-bookings", count: ids.length },
    "Transitioned PAID bookings to COMPLETED"
  );

  return { completedCount: ids.length, completedBookingIds: ids };
}
