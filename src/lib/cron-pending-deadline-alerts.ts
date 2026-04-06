import { prisma } from "./prisma";
import { BookingStatus } from "@prisma/client";
import { sendAdminPendingDeadlineAlert } from "./email";
import logger from "@/lib/logger";

/**
 * N-06: Send admin alert for pending bookings approaching their hold deadline.
 * Runs daily at 8:00 AM NZST.
 * Sends a single digest email to admins listing all pending bookings
 * where nonMemberHoldUntil is within the next 48 hours.
 */
export async function checkPendingDeadlines(): Promise<{ alertedCount: number }> {
  const now = new Date();
  const in48Hours = new Date(now.getTime() + 48 * 60 * 60 * 1000);

  const pendingBookings = await prisma.booking.findMany({
    where: {
      status: BookingStatus.PENDING,
      nonMemberHoldUntil: {
        gt: now,
        lte: in48Hours,
      },
    },
    include: {
      member: true,
      guests: true,
    },
    orderBy: { nonMemberHoldUntil: "asc" },
  });

  if (pendingBookings.length === 0) {
    return { alertedCount: 0 };
  }

  const bookingData = pendingBookings.map((b) => {
    const hoursRemaining = (b.nonMemberHoldUntil!.getTime() - now.getTime()) / (1000 * 60 * 60);
    return {
      memberName: `${b.member.firstName} ${b.member.lastName}`,
      checkIn: b.checkIn,
      checkOut: b.checkOut,
      guestCount: b.guests.length,
      deadline: b.nonMemberHoldUntil!,
      hoursRemaining,
    };
  });

  try {
    await sendAdminPendingDeadlineAlert(bookingData);
  } catch (err) {
    logger.error({ err }, "Failed to send pending deadline admin alert");
  }

  return { alertedCount: pendingBookings.length };
}
