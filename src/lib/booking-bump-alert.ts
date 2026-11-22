import { bookingBumpReason } from "@/lib/booking-bump-reason";
import { BOOKING_OWNER_NAME_SELECT, bookingOwnerName } from "@/lib/booking-owner-name";
import { formatBookingReference } from "@/lib/booking-reference";
import { sendAdminBookingBumpedAlert } from "@/lib/email";
import logger from "@/lib/logger";
import { adminAlertLodgeName, countActiveLodges } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

// The confirm-pending cron reads both from here, so it takes one import.
export { bookingBumpReason };

type BumpedBooking = Prisma.BookingGetPayload<{ select: typeof BOOKING_OWNER_NAME_SELECT }> & {
  id: string;
  lodgeId: string;
  checkIn: Date;
  checkOut: Date;
  guests: unknown[];
};

/**
 * The lodge line for the alert: the booking's own lodge, hidden in a one-lodge
 * club exactly as the capacity warning hides it (`adminAlertLodgeName`). It is
 * display only, so a failed read never costs the officers the alert: it falls
 * back to the lodge id rather than dropping the line.
 */
async function bumpedBookingLodgeName(lodgeId: string): Promise<string | null> {
  try {
    const [lodge, activeLodgeCount] = await Promise.all([
      prisma.lodge.findUnique({ where: { id: lodgeId }, select: { name: true } }),
      countActiveLodges(prisma),
    ]);
    return adminAlertLodgeName(activeLodgeCount, lodge?.name ?? lodgeId);
  } catch (err) {
    logger.warn({ err, lodgeId }, "Could not read the lodge for the booking-bumped alert; naming it by id");
    return lodgeId;
  }
}

/**
 * #5403: tell the Booking Officers the confirm-pending cron bumped a pending
 * booking. The cron calls this only after its bump transaction committed and
 * only for the run that won the status claim, so it is once per bump exactly
 * as the member's own email is: a rerun finds the booking CANCELLED and never
 * gets here. Sent for both variants, as the pre-#738 alert was for every
 * whole-booking bump; the reason line tells them apart. Recipients are
 * `sendToAdmins`'s rule for the `adminBookingBumped` preference. A failure is
 * logged and swallowed so it can never undo the bump, the member's email or
 * the rest of the run; a failed transport leaves the usual FAILED row for the
 * email retry cron.
 */
export async function alertOfficersOfBump(booking: BumpedBooking, flagged: boolean): Promise<void> {
  try {
    await sendAdminBookingBumpedAlert({
      bumpedMemberName: bookingOwnerName(booking),
      bookingReference: formatBookingReference(booking.id),
      lodgeName: await bumpedBookingLodgeName(booking.lodgeId),
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      guestCount: booking.guests.length,
      reason: bookingBumpReason(flagged),
    });
  } catch (err) {
    logger.error({ err, bookingId: booking.id, job: "confirmPendingBookings" }, "Failed to send admin booking-bumped alert");
  }
}
