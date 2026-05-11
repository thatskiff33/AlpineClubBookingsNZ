import { prisma } from "./prisma";
import { BookingStatus } from "@prisma/client";
import { checkCapacity } from "./capacity";
import { getNonMemberHoldDays } from "./cancellation";
import {
  sendWaitlistOfferEmail,
  sendWaitlistOfferExpiredEmail,
  sendAdminWaitlistOfferAlert,
} from "./email";
import { logAudit } from "./audit";
import logger from "@/lib/logger";

const WAITLIST_OFFER_HOURS = Number(process.env.WAITLIST_OFFER_HOURS) || 48;

/**
 * Get the FIFO position for a waitlisted booking.
 * Counts WAITLISTED bookings with overlapping dates created before this one.
 */
export async function getWaitlistPosition(bookingId: string): Promise<number> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { checkIn: true, checkOut: true, createdAt: true, status: true },
  });

  if (!booking || (booking.status !== BookingStatus.WAITLISTED && booking.status !== BookingStatus.WAITLIST_OFFERED)) {
    return 0;
  }

  const ahead = await prisma.booking.count({
    where: {
      status: BookingStatus.WAITLISTED,
      checkIn: { lt: booking.checkOut },
      checkOut: { gt: booking.checkIn },
      createdAt: { lt: booking.createdAt },
    },
  });

  return ahead + 1;
}

/**
 * Get all WAITLISTED bookings overlapping a date range, ordered FIFO.
 */
export async function getWaitlistForDates(checkIn: Date, checkOut: Date) {
  return prisma.booking.findMany({
    where: {
      status: BookingStatus.WAITLISTED,
      checkIn: { lt: checkOut },
      checkOut: { gt: checkIn },
    },
    include: {
      guests: true,
      member: { select: { id: true, email: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Main orchestrator: when capacity is freed, find the top FIFO candidate
 * whose full date range has capacity and offer them the spot.
 */
export async function processWaitlistForDates(freedDates: {
  checkIn: Date;
  checkOut: Date;
}): Promise<{ offeredBookingId: string | null }> {
  let offeredBookingId: string | null = null;
  type OfferDetails = {
    email: string;
    firstName: string;
    checkIn: Date;
    checkOut: Date;
    guestCount: number;
    expiresAt: Date;
    bookingId: string;
    memberId: string;
    memberName: string;
    position: number;
  };
  let offerDetails = null as OfferDetails | null;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

      const candidates = await tx.booking.findMany({
        where: {
          status: BookingStatus.WAITLISTED,
          checkIn: { lt: freedDates.checkOut },
          checkOut: { gt: freedDates.checkIn },
        },
        include: {
          guests: true,
          member: { select: { id: true, email: true, firstName: true, lastName: true } },
        },
        orderBy: { createdAt: "asc" },
      });

      for (const candidate of candidates) {
        // Check if ALL nights in the candidate's range have capacity
        const { available } = await checkCapacity(
          candidate.checkIn,
          candidate.checkOut,
          candidate.guests.length
        );

        if (available) {
          const expiresAt = new Date(Date.now() + WAITLIST_OFFER_HOURS * 60 * 60 * 1000);

          await tx.booking.update({
            where: { id: candidate.id },
            data: {
              status: BookingStatus.WAITLIST_OFFERED,
              waitlistOfferedAt: new Date(),
              waitlistOfferExpiresAt: expiresAt,
            },
          });

          offeredBookingId = candidate.id;

          // Count position (how many were ahead in queue)
          const position = await tx.booking.count({
            where: {
              status: BookingStatus.WAITLISTED,
              checkIn: { lt: candidate.checkOut },
              checkOut: { gt: candidate.checkIn },
              createdAt: { lt: candidate.createdAt },
            },
          });

          offerDetails = {
            email: candidate.member.email,
            firstName: candidate.member.firstName,
            checkIn: candidate.checkIn,
            checkOut: candidate.checkOut,
            guestCount: candidate.guests.length,
            expiresAt,
            bookingId: candidate.id,
            memberId: candidate.memberId,
            memberName: `${candidate.member.firstName} ${candidate.member.lastName}`,
            position: position + 1,
          };

          break; // Only offer to the top candidate
        }
      }
    });
  } catch (err) {
    logger.error({ err }, "Failed to process waitlist for dates");
    return { offeredBookingId: null };
  }

  // Send emails after transaction commits
  if (offerDetails) {
    sendWaitlistOfferEmail(
      offerDetails.email,
      offerDetails.firstName,
      offerDetails.checkIn,
      offerDetails.checkOut,
      offerDetails.guestCount,
      offerDetails.expiresAt,
      offerDetails.bookingId
    ).catch((err) => logger.error({ err }, "Failed to send waitlist offer email"));

    sendAdminWaitlistOfferAlert({
      memberName: offerDetails.memberName,
      checkIn: offerDetails.checkIn,
      checkOut: offerDetails.checkOut,
      guestCount: offerDetails.guestCount,
      position: offerDetails.position,
    }).catch((err) => logger.error({ err }, "Failed to send admin waitlist offer alert"));

    logAudit({
      action: "waitlist.offer_sent",
      memberId: null,
      targetId: offerDetails.bookingId,
      subjectMemberId: offerDetails.memberId,
      entityType: "Booking",
      entityId: offerDetails.bookingId,
      category: "booking",
      outcome: "success",
      summary: "Waitlist offer sent",
      details: `Waitlist offer sent to ${offerDetails.memberName}`,
      metadata: {
        checkIn: offerDetails.checkIn.toISOString(),
        checkOut: offerDetails.checkOut.toISOString(),
        guestCount: offerDetails.guestCount,
        position: offerDetails.position,
        expiresAt: offerDetails.expiresAt.toISOString(),
      },
    });
  }

  return { offeredBookingId };
}

/**
 * Confirm a waitlist offer. Re-checks capacity and transitions to
 * PAYMENT_PENDING or PENDING based on member/non-member rules.
 */
export async function confirmWaitlistOffer(
  bookingId: string,
  memberId: string
): Promise<{
  success: boolean;
  newStatus?: BookingStatus;
  error?: string;
}> {
  let result: { success: boolean; newStatus?: BookingStatus; error?: string };

  try {
    result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        include: { guests: true },
      });

      if (!booking) {
        return { success: false, error: "Booking not found" };
      }

      if (booking.memberId !== memberId) {
        return { success: false, error: "Forbidden" };
      }

      if (booking.status !== BookingStatus.WAITLIST_OFFERED) {
        return { success: false, error: "Booking is not in WAITLIST_OFFERED status" };
      }

      if (booking.waitlistOfferExpiresAt && booking.waitlistOfferExpiresAt < new Date()) {
        return { success: false, error: "Waitlist offer has expired" };
      }

      // Re-check capacity
      const { available } = await checkCapacity(
        booking.checkIn,
        booking.checkOut,
        booking.guests.length
      );

      if (!available) {
        // Revert to WAITLISTED
        await tx.booking.update({
          where: { id: bookingId },
          data: {
            status: BookingStatus.WAITLISTED,
            waitlistOfferedAt: null,
            waitlistOfferExpiresAt: null,
          },
        });
        return { success: false, error: "Capacity is no longer available. You've been returned to the waitlist." };
      }

      // Determine new status using the same logic as booking creation.
      // Math.ceil mirrors bookings/route.ts: fractional days over threshold → PENDING.
      const hasNonMembers = booking.guests.some((g) => !g.isMember);
      const holdDays = hasNonMembers ? await getNonMemberHoldDays(booking.checkIn) : 7;
      const daysUntilCheckIn = Math.ceil(
        (booking.checkIn.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      );
      const shouldBePending = hasNonMembers && daysUntilCheckIn > holdDays;
      const newStatus = shouldBePending ? BookingStatus.PENDING : BookingStatus.PAYMENT_PENDING;

      const updateData: Record<string, unknown> = {
        status: newStatus,
        waitlistPosition: null,
        waitlistOfferedAt: null,
        waitlistOfferExpiresAt: null,
      };

      if (newStatus === BookingStatus.PENDING) {
        const holdDate = new Date(booking.checkIn);
        holdDate.setDate(holdDate.getDate() - holdDays);
        updateData.nonMemberHoldUntil = holdDate;
      }

      await tx.booking.update({
        where: { id: bookingId },
        data: updateData,
      });

      return { success: true, newStatus };
    });
  } catch (err) {
    logger.error({ err, bookingId }, "Failed to confirm waitlist offer");
    return { success: false, error: "An error occurred while confirming your booking" };
  }

  if (result.success) {
    logAudit({
      action: "waitlist.offer_confirmed",
      memberId,
      targetId: bookingId,
      subjectMemberId: memberId,
      entityType: "Booking",
      entityId: bookingId,
      category: "booking",
      outcome: "success",
      summary: "Waitlist offer confirmed",
      details: `Waitlist offer confirmed, new status: ${result.newStatus}`,
      metadata: {
        newStatus: result.newStatus,
      },
    });
  }

  return result;
}

/**
 * Expire stale WAITLIST_OFFERED bookings and re-offer to next candidates.
 */
export async function expireStaleOffers(): Promise<{
  expiredCount: number;
  reofferedCount: number;
}> {
  const { staleOffers, affectedRanges } = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

    const offers = await tx.booking.findMany({
      where: {
        status: BookingStatus.WAITLIST_OFFERED,
        waitlistOfferExpiresAt: { lt: new Date() },
      },
      include: {
        member: { select: { email: true, firstName: true } },
      },
    });

    for (const offer of offers) {
      await tx.booking.update({
        where: { id: offer.id },
        data: {
          status: BookingStatus.WAITLISTED,
          waitlistOfferedAt: null,
          waitlistOfferExpiresAt: null,
        },
      });
    }

    return {
      staleOffers: offers.map((offer) => ({
        ...offer,
        newPosition:
          offers.filter(
            (entry) =>
              entry.checkIn < offer.checkOut &&
              entry.checkOut > offer.checkIn &&
              entry.createdAt < offer.createdAt
          ).length + 1,
      })),
      affectedRanges: Array.from(
        new Map(
          offers.map((offer) => [
            `${offer.checkIn.toISOString()}_${offer.checkOut.toISOString()}`,
            {
              checkIn: offer.checkIn,
              checkOut: offer.checkOut,
            },
          ])
        ).values()
      ),
    };
  });

  let reofferedCount = 0;

  for (const offer of staleOffers) {
    sendWaitlistOfferExpiredEmail(
      offer.member.email,
      offer.member.firstName,
      offer.checkIn,
      offer.checkOut,
      offer.newPosition
    ).catch((err) => logger.error({ err }, "Failed to send waitlist offer expired email"));

    logAudit({
      action: "waitlist.offer_expired",
      memberId: null,
      targetId: offer.id,
      subjectMemberId: offer.memberId,
      entityType: "Booking",
      entityId: offer.id,
      category: "booking",
      outcome: "success",
      summary: "Waitlist offer expired",
      details: `Waitlist offer expired, reverted to WAITLISTED`,
      metadata: {
        checkIn: offer.checkIn.toISOString(),
        checkOut: offer.checkOut.toISOString(),
        newPosition: offer.newPosition,
      },
    });
  }

  for (const range of affectedRanges) {
    const { offeredBookingId } = await processWaitlistForDates(range);
    if (offeredBookingId) {
      reofferedCount++;
    }
  }

  return { expiredCount: staleOffers.length, reofferedCount };
}

/**
 * Recalculate and update waitlistPosition for all WAITLISTED bookings
 * overlapping the given date range.
 */
export async function updateWaitlistPositions(
  checkIn: Date,
  checkOut: Date
): Promise<void> {
  const waitlisted = await prisma.booking.findMany({
    where: {
      status: BookingStatus.WAITLISTED,
      checkIn: { lt: checkOut },
      checkOut: { gt: checkIn },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  for (let i = 0; i < waitlisted.length; i++) {
    await prisma.booking.update({
      where: { id: waitlisted[i].id },
      data: { waitlistPosition: i + 1 },
    });
  }
}
