import { bookingBumpReason } from "@/lib/booking-bump-reason";
import { BOOKING_OWNER_NAME_SELECT, bookingOwnerName } from "@/lib/booking-owner-name";
import { formatBookingReference } from "@/lib/booking-reference";
import { sendAdminBookingBumpedAlert } from "@/lib/email";
import logger from "@/lib/logger";
import { bookingListLodgeLabel, countActiveLodgesForBookingList } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

type BumpedBooking = Prisma.BookingGetPayload<{ select: typeof BOOKING_OWNER_NAME_SELECT }> & {
  id: string;
  lodgeId: string;
  checkIn: Date;
  checkOut: Date;
  guests: unknown[];
};

/**
 * The lodge line for the alert, or null to leave it out: the booking's own
 * lodge under the one ADR-002 presentation rule (`bookingListLodgeLabel`), so
 * it is hidden in a one-lodge club but always named when archived. The count
 * reads 0 if it fails, which names the lodge; a failed name read leaves the
 * line out. It is display only, so neither failure costs the officers the
 * alert, and a database id is never shown in its place.
 */
async function bumpedBookingLodgeName(lodgeId: string): Promise<string | null> {
  let lodge: { name: string; active: boolean } | null;
  try {
    lodge = await prisma.lodge.findUnique({ where: { id: lodgeId }, select: { name: true, active: true } });
  } catch (err) {
    logger.warn({ err, lodgeId }, "Could not read the lodge for the booking-bumped alert; leaving it out");
    return null;
  }
  if (!lodge) return null;
  return bookingListLodgeLabel(await countActiveLodgesForBookingList(prisma), lodge);
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
