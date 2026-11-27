import { bookingBumpReason } from "@/lib/booking-bump-reason";
import { BOOKING_OWNER_NAME_SELECT, bookingOwnerName } from "@/lib/booking-owner-name";
import { formatBookingReference } from "@/lib/booking-reference";
import { sendAdminBookingBumpedAlert } from "@/lib/email";
import { adminAlertNeedsResend } from "@/lib/email/admin-alert-send-result";
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
 * Never throws, and says what the marker should do:
 * - `settled` clears it: an officer has it, a failed copy's FAILED row is the
 *   email retry cron's to replay, or nobody is meant to get it (the alert
 *   switched off, nobody opted in, every copy refused or withheld on purpose);
 * - `unreached` keeps it for a day: nobody got the alert and at least one
 *   officer's copy failed before its EmailLog row existed, so nothing will
 *   replay it (`adminAlertNeedsResend`);
 * - `threw` keeps it for the sweep's usual wait.
 * None of them can undo the bump, the member's email or the rest of the run.
 */
export async function alertOfficersOfBump(
  booking: BumpedBooking,
  flagged: boolean,
  /** #5433: the job sending it, for the logs (the confirm-pending job, or the email retry job's sweep). */
  job: string,
): Promise<"settled" | "unreached" | "threw"> {
  try {
    const result = await sendAdminBookingBumpedAlert({
      bumpedMemberName: bookingOwnerName(booking),
      bookingReference: formatBookingReference(booking.id),
      lodgeName: await bumpedBookingLodgeName(booking.lodgeId),
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      guestCount: booking.guests.length,
      reason: bookingBumpReason(flagged),
    });
    if (!adminAlertNeedsResend(result)) return "settled";
    logger.warn(
      { bookingId: booking.id, failedBeforeLogged: result.failedBeforeLogged, job },
      "No officer received the booking-bumped alert and nothing will replay it; it stays owed for a day",
    );
    return "unreached";
  } catch (err) {
    logger.error({ err, bookingId: booking.id, job }, "Failed to send admin booking-bumped alert");
    return "threw";
  }
}
