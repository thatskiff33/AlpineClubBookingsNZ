import { prisma } from "./prisma";
import { BookingStatus } from "@prisma/client";
import { expireStaleOffers } from "./waitlist";
import logger from "@/lib/logger";

/**
 * Waitlist processor cron job.
 * - Expires stale WAITLIST_OFFERED bookings and re-offers to next candidates
 * - Auto-cancels WAITLISTED bookings where all dates are in the past
 */
export async function processWaitlistCron(): Promise<{
  expiredOffers: number;
  newOffers: number;
  autoCancelled: number;
}> {
  // 1. Expire stale offers and re-offer
  const { expiredCount, reofferedCount } = await expireStaleOffers();

  // 2. Auto-cancel waitlisted bookings where all dates are in the past
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const pastWaitlisted = await prisma.booking.findMany({
    where: {
      status: { in: [BookingStatus.WAITLISTED, BookingStatus.WAITLIST_OFFERED] },
      checkOut: { lte: today },
    },
    select: { id: true },
  });

  if (pastWaitlisted.length > 0) {
    await prisma.booking.updateMany({
      where: {
        id: { in: pastWaitlisted.map((b) => b.id) },
      },
      data: {
        status: BookingStatus.CANCELLED,
        waitlistPosition: null,
        waitlistOfferedAt: null,
        waitlistOfferExpiresAt: null,
      },
    });

    logger.info(
      { count: pastWaitlisted.length, job: "processWaitlistCron" },
      "Auto-cancelled past-date waitlisted bookings"
    );
  }

  return {
    expiredOffers: expiredCount,
    newOffers: reofferedCount,
    autoCancelled: pastWaitlisted.length,
  };
}
