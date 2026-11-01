import { NextResponse, type NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";

import { logAudit } from "@/lib/audit";
import { bookingOwner } from "@/lib/booking-owner";
import { finishedStayCorrectionEligibility } from "@/lib/booking-edit-policy";
import { changeRequestStoredProposal } from "@/lib/booking-change-request-stored";
import type { ChangeRequestDelta } from "@/lib/booking-change-request-input";
import {
  carriedPromoCodes,
  PROMO_CHANGE_ALONE_MESSAGE,
  PROMO_CHANGE_OFFICER_FINISHED_STAY_ONLY_MESSAGE,
  PROMO_CORRECTION_PENDING_REQUEST_MESSAGE,
  promoChangeCodes,
  withPromoChange,
  type ChangeRequestPromoChange,
} from "@/lib/booking-change-request-promo";
import {
  memberBookingChangeRequestSelect,
  projectMemberBookingChangeRequest,
} from "@/lib/booking-change-request-member-view";
import { sendAdminBookingChangeRequestAlert } from "@/lib/email";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { promoChangeRefusalFor } from "@/lib/booking-change-request-promo-server";
import { getClientIp } from "@/lib/rate-limit";
import { calendarDateOfDateOnlyInstant } from "@/lib/club-time";

/**
 * #4533, Edit Booking's entry point: an officer on a FINISHED stay raises a
 * LOCKED_PERIOD change request that carries only a promo change, on the
 * member's behalf, through `POST /api/bookings/[id]/change-requests`. Approving
 * it in the change-request queue applies the code through the #3750 executor —
 * this writes the request and nothing else, so there is still one writer of
 * the booking.
 *
 * WHY A REQUEST AND NOT A SAVE. A finished stay's edits stay inside the
 * approval transaction (`INV-LOCK-004`, the 0-day notice rule), and lifting
 * Edit Booking's lock for officers would be a second writer that drifts from
 * it. Edit Booking's promo control sends the officer here instead of offering a
 * Save that cannot apply.
 *
 * Every other change a request can carry stays where it was: a member's own
 * request on a running stay, and #4030's officer entry on approval. A promo
 * change is never sent by a member — an in-progress stay refuses promo changes
 * outright, and a member's own finished stay stays locked.
 */

type PromoRequestBooking = {
  id: string;
  memberId: string | null;
  status: string;
  checkIn: Date;
  checkOut: Date;
  member: { firstName: string; lastName: string; email: string } | null;
  organisation: { name: string; email: string | null } | null;
  guests: Array<{
    id: string;
    firstName: string;
    lastName: string;
    ageTier: string;
    isMember: boolean;
    memberId: string | null;
    stayStart: Date;
    stayEnd: Date;
    nights: Array<{ stayDate: Date }>;
  }>;
  payment: {
    id: string;
    amountCents: number;
    refundedAmountCents: number;
    status: string;
    stripePaymentIntentId: string | null;
    xeroInvoiceId: string | null;
    xeroInvoiceNumber: string | null;
  } | null;
};

/** Whether the request carries any part of a date or guest change. */
function carriesAnotherChange(delta: ChangeRequestDelta): boolean {
  return Boolean(
    delta.checkIn ||
      delta.checkOut ||
      delta.addGuests?.length ||
      delta.removeGuestIds?.length ||
      delta.guestStayRanges?.length ||
      delta.requestedEffectiveDate,
  );
}

export async function finishedStayPromoCorrectionRequestResponse(
  req: NextRequest,
  args: {
    actorMemberId: string;
    actorIsOfficer: boolean;
    booking: PromoRequestBooking;
    delta: ChangeRequestDelta;
    promoChange: ChangeRequestPromoChange;
    reason: string | null;
    /** The club's today, on the stored-date frame (`clubTodayDateOnlyInstant`). */
    today: Date;
  },
): Promise<NextResponse> {
  const { booking, promoChange } = args;
  if (!args.actorIsOfficer) {
    return NextResponse.json({ error: PROMO_CHANGE_OFFICER_FINISHED_STAY_ONLY_MESSAGE }, { status: 403 });
  }
  if (carriesAnotherChange(args.delta)) {
    return NextResponse.json({ error: PROMO_CHANGE_ALONE_MESSAGE }, { status: 400 });
  }
  // The one eligibility answer the executor asks again under its locks.
  const eligibility = finishedStayCorrectionEligibility(booking, args.today);
  if (!eligibility.eligible) {
    return NextResponse.json(
      {
        error:
          eligibility.reason === "not-finished" ? PROMO_CHANGE_OFFICER_FINISHED_STAY_ONLY_MESSAGE : eligibility.message,
      },
      { status: 400 },
    );
  }
  const onBooking = new Set(booking.guests.map((guest) => guest.id));
  const namedGuests = [
    ...(promoChange.promoGuestIds ?? []),
    ...(promoChange.promoCodes ?? []).flatMap((entry) => entry.promoGuestIds ?? []),
  ];
  if (namedGuests.some((guestId) => !onBooking.has(guestId))) {
    return NextResponse.json(
      { error: "A guest selected for the promo code is no longer on this booking — refresh and re-apply the code" },
      { status: 400 },
    );
  }
  // #4533 review: ANY pending locked-period request on the booking, whoever
  // sent it — its own approval card takes the code, and a second request about
  // the same finished stay would be judged against a booking the first changes.
  const existing = await prisma.bookingChangeRequest.findFirst({
    where: { bookingId: booking.id, kind: "LOCKED_PERIOD", status: "REQUESTED" },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json(
      { error: PROMO_CORRECTION_PENDING_REQUEST_MESSAGE, requestId: existing.id },
      { status: 409 },
    );
  }
  const carried = carriedPromoCodes(
    await prisma.promoRedemption.findMany({
      where: { bookingId: booking.id },
      select: { promoCode: { select: { code: true, internal: true } } },
    }),
  );
  // #4533 review: never a code taken off, never nothing — the one rule the
  // queue card's entry and the executor read too.
  const promoRefusal = await promoChangeRefusalFor(prisma, promoChange, carried);
  if (promoRefusal) {
    return NextResponse.json({ error: promoRefusal }, { status: 400 });
  }
  const codesNow = carried.map((entry) => entry.code);

  // The approval-relevant record from submission's own builder (`INV-SSOT-001`):
  // the booking as it stands, and no date or guest change.
  const proposal = changeRequestStoredProposal(booking, {}, (guest) => ({
    firstName: guest.firstName,
    lastName: guest.lastName,
    ageTier: guest.ageTier,
    isMember: guest.isMember,
    memberId: guest.memberId,
  }));
  const requestedChanges = withPromoChange(
    {
      original: proposal.original,
      requested: { ...proposal.requested, requestedEffectiveDate: null },
      lockedPeriod: { today: calendarDateOfDateOnlyInstant(args.today), editableFrom: null, touchesLockedPeriod: true },
      payment: booking.payment,
    },
    promoChange,
    { officerMemberId: args.actorMemberId, enteredAt: new Date(), enteredOn: "request" },
    codesNow,
  );
  const summary = String((requestedChanges.requested as { summary: string }).summary);
  const changeRequest = await prisma.bookingChangeRequest.create({
    data: {
      bookingId: booking.id,
      requestedByMemberId: args.actorMemberId,
      requestedChanges: requestedChanges as Prisma.InputJsonObject,
      reason: args.reason,
    },
    // The member-readable manifest, as the route's own create uses (#2562).
    select: memberBookingChangeRequestSelect,
  });
  const owner = bookingOwner(booking);
  logAudit({
    action: "booking-change-request.create",
    memberId: args.actorMemberId,
    targetId: booking.id,
    subjectMemberId: owner.memberId,
    entityType: "BookingChangeRequest",
    entityId: changeRequest.id,
    category: "booking",
    outcome: "success",
    summary: "Promo correction request raised by a booking officer on the member's behalf",
    details: summary,
    metadata: {
      bookingId: booking.id,
      requestId: changeRequest.id,
      requestedSummary: summary,
      promoChange: { codes: promoChangeCodes(promoChange), onMemberBehalf: true, enteredOn: "request" },
      touchesLockedPeriod: true,
    },
    ipAddress: getClientIp(req),
  });
  sendAdminBookingChangeRequestAlert({
    memberName: `${owner.member.firstName} ${owner.member.lastName}`,
    memberEmail: owner.member.email,
    bookingId: booking.id,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    requestedSummary: summary,
    reason: args.reason,
    requestId: changeRequest.id,
  }).catch((err) =>
    logger.error(
      { err, bookingId: booking.id, requestId: changeRequest.id },
      "Failed to send booking change request admin alert",
    ),
  );
  return NextResponse.json(projectMemberBookingChangeRequest(changeRequest), { status: 201 });
}
