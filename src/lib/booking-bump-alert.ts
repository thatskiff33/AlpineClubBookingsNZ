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
 * booking. Sent for both variants, as the pre-#738 alert was for every
 * whole-booking bump; the reason line tells them apart. Recipients are
 * `sendToAdmins`'s rule for the `adminBookingBumped` preference.
 *
 * #5407: called by `booking-bump-notice-owed.ts`, which holds the bump's owed
 * marker. Right after the bump commits it sends this once; if the job stopped
 * or this threw first, the marker makes a later run of the same job send it.
 * So officers receive it at least once, and very rarely twice: a crash after
 * the send and before the marker is cleared repeats it on a later run.
 *
 * Never throws: a failure is logged and reported as `false` so it can never
 * undo the bump, the member's email or the rest of the run, and the caller
 * keeps the marker. `true` means the send returned, whatever each recipient's
 * outcome; a failed transport leaves the usual FAILED row for the email retry
 * cron, so the marker is cleared rather than sending the alert again.
 */
export async function alertOfficersOfBump(booking: BumpedBooking, flagged: boolean): Promise<boolean> {
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
    return true;
  } catch (err) {
    logger.error({ err, bookingId: booking.id, job: "confirmPendingBookings" }, "Failed to send admin booking-bumped alert");
    return false;
  }
}
