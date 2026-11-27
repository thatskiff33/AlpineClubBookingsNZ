/**
 * #5433 PR 4: the booking every member notice of the confirm-pending job reads
 * after its commit, and the officers' "Booking email not sent" alert those
 * notices raise, once per marker, when the email did not reach the owner or
 * passed its cut-off (`booking-notice-unsent-note.ts` says what each says).
 *
 * Through `alertOfficersOncePastCutoff`, the once-ever claim keyed on the
 * marker's id that the paid confirmation and the waitlist offer use, so a
 * rerun of the step for the same marker sends nothing more. Never throws.
 */
import { Prisma } from "@prisma/client";

import { bookingOwner } from "@/lib/booking-owner";
import type { BookingNoticeUnsent } from "@/lib/booking-notice-unsent-note";
import { sendAdminBookingNoticeUnsentAlert } from "@/lib/email/admin-alerts-booking-notice-unsent";
import type { OwedNoticeOutcome } from "@/lib/owed-notice/deliver";
import { OWED_MEMBER_NOTICE_SWEEP_AFTER_MS } from "@/lib/owed-notice/member-email";
import { alertOfficersOncePastCutoff } from "@/lib/owed-notice/past-cutoff-once";
import type { OwedNoticeMarker } from "@/lib/owed-notice/store";

/** What a member notice of the confirm-pending job reads of its booking, read again by the sweep. */
export const OWED_BOOKING_NOTICE_SELECT = Prisma.validator<Prisma.BookingSelect>()({
  id: true,
  status: true,
  deletedAt: true,
  lodgeId: true,
  checkIn: true,
  checkOut: true,
  finalPriceCents: true,
  memberId: true,
  parentBookingId: true,
  member: { select: { firstName: true, lastName: true, email: true } },
  // #3369: the owner may be an Organisation; bookingOwner() reads both.
  organisation: { select: { name: true, email: true } },
  guests: { select: { id: true } },
});

export type OwedBookingNotice = Prisma.BookingGetPayload<{ select: typeof OWED_BOOKING_NOTICE_SELECT }>;

/** The owner's name as the officers' alerts of this job have always written it. */
export function owedNoticeOwnerName(booking: Pick<OwedBookingNotice, "memberId" | "member" | "organisation">): string {
  const owner = bookingOwner(booking).member;
  return `${owner.firstName} ${owner.lastName}`;
}

/** Alert the officers, once per marker, that this member notice did not reach the booking's owner. */
export function alertOfficersBookingNoticeUnsent(
  marker: OwedNoticeMarker,
  notice: BookingNoticeUnsent,
  booking: Pick<OwedBookingNotice, "id" | "checkIn" | "checkOut" | "memberId" | "member" | "organisation">,
): Promise<OwedNoticeOutcome> {
  return alertOfficersOncePastCutoff(marker, {
    label: "booking email not sent",
    inFlightMs: OWED_MEMBER_NOTICE_SWEEP_AFTER_MS,
    send: () =>
      sendAdminBookingNoticeUnsentAlert({
        notice,
        memberName: owedNoticeOwnerName(booking).trim(),
        bookingId: booking.id,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
      }),
  });
}
