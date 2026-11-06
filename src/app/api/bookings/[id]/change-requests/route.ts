import { NextRequest, NextResponse } from "next/server";
import { bookingOwner } from "@/lib/booking-owner";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { getBookingEditPolicy } from "@/lib/booking-edit-policy";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { formatDateOnly } from "@/lib/date-only";
import {
  calendarDateOfDateOnlyInstant,
} from "@/lib/club-time";
import { storedDateOnly } from "@/lib/stored-calendar-day";
import { getDefaultLodgeId } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { sendAdminBookingChangeRequestAlert } from "@/lib/email";
import { getLodgeCapacity } from "@/lib/lodge-capacity";
import { checkRateLimit, getClientIp, rateLimiters } from "@/lib/rate-limit";
import logger from "@/lib/logger";
import { z } from "zod";
import { bookingManagementAuthorizationRole } from "@/lib/admin-permissions";
import {
  memberBookingChangeRequestSelect,
  projectMemberBookingChangeRequest,
} from "@/lib/booking-change-request-member-view";
import { deletedBookingRefusalResponse } from "@/lib/deleted-booking-refusal";
import { lodgeGuestLimitMessage } from "@/lib/lodge-booking-readiness";
import {
  addedGuestFirstNights,
  buildChangeRequestSummary,
  CHANGE_REQUEST_NEEDS_STRUCTURED_CHANGE_MESSAGE,
  changeRequestValidationMessage,
  isAppliedChangeRequestRange,
  namesStayRangeChange,
  CHANGE_REQUEST_DEPENDANT_TYPED_MESSAGE,
} from "@/lib/booking-change-request-guests";
import {
  changeRequestDeltaSchema,
  unknownChangeRequestGuestRefusal,
  validateChangeRequestDatesAndNights,
} from "@/lib/booking-change-request-input";
import { changeRequestStoredProposal } from "@/lib/booking-change-request-stored";
import {
  checkOwnDependantIdentityForParty,
  claimedMemberPathIds,
} from "@/lib/booking-dependant-identity";
import { changeRequestPromoChangeSchema } from "@/lib/booking-change-request-promo";
import { finishedStayPromoCorrectionRequestResponse } from "@/lib/booking-change-request-promo-submit";

const createChangeRequestSchema = changeRequestDeltaSchema.extend({
  reason: z.string().max(2000).optional(),
  // #4533: an officer's promo correction on a finished stay (Edit Booking).
  promoChange: changeRequestPromoChangeSchema.optional(),
});

function normalizeReason(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function formatBookingDate(value: Date) {
  return calendarDateOfDateOnlyInstant(value);
}

function changedDate(
  requestedValue: string | undefined,
  currentValue: Date
) {
  return requestedValue && requestedValue !== formatBookingDate(currentValue);
}

function requestTouchesLockedPeriod({
  booking,
  editPolicy,
  requestedCheckIn,
  requestedCheckOut,
  requestedEffectiveDate,
  addedGuestStarts,
}: {
  booking: { checkIn: Date; checkOut: Date };
  editPolicy: ReturnType<typeof getBookingEditPolicy>;
  requestedCheckIn: Date | null;
  requestedCheckOut: Date | null;
  requestedEffectiveDate: Date | null;
  /** #4030: the first night of each guest the request adds. */
  addedGuestStarts: Date[];
}) {
  const today = editPolicy.today;
  const editableFrom = editPolicy.editableFrom;
  const currentCheckIn = storedDateOnly(booking.checkIn);
  const currentCheckOut = storedDateOnly(booking.checkOut);

  // Every value compared below is a calendar day at midnight UTC, which is what
  // makes the comparisons meaningful: `requestedEffectiveDate` from
  // `parseDateOnly`, the booking's own dates from `storedDateOnly`, and
  // `editPolicy.today` / `editPolicy.editableFrom` from `getBookingEditPolicy`.
  //
  // BE PRECISE ABOUT `today`, because a comment here once was not. Since #3123
  // it is the CLUB's day — the persisted `ClubTimeSettings.timeZone` that
  // `INV-CONFIG-002` names — supplied to `getBookingEditPolicy` as a REQUIRED
  // parameter by this route. It used to be the environment's day, read from
  // `APP_TIME_ZONE` inside that policy; migrating it as a threaded value rather
  // than an `await` is what kept that synchronous, widely-called pure function
  // synchronous. `editableFrom` was always on the club's frame: it is the
  // booking's own `@db.Date` check-in, and CT-4 (#2870) stopped that one being
  // projected through a zone on the way out.
  if (requestedEffectiveDate && requestedEffectiveDate <= today) {
    return true;
  }

  // #4030: a guest added from a night the member can no longer book themselves
  // (on an in-progress stay, today or earlier) is a locked-period change. A
  // guest added only from `editableFrom` on is an ordinary edit, which the
  // member makes in the guest editor.
  if (
    addedGuestStarts.some((start) =>
      editableFrom ? start < editableFrom : start <= today,
    )
  ) {
    return true;
  }

  if (requestedCheckIn && requestedCheckIn.getTime() !== currentCheckIn.getTime()) {
    return requestedCheckIn <= today || editPolicy.mode === "in-progress";
  }

  if (requestedCheckOut && requestedCheckOut.getTime() !== currentCheckOut.getTime()) {
    if (editableFrom) {
      return requestedCheckOut < editableFrom;
    }
    return requestedCheckOut <= today;
  }

  return false;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;
  // Issue #1313 (option A2): a Booking Officer (bookings:edit) resolves to ADMIN,
  // gaining the same authority and admin-on-behalf edit policy as a Full Admin;
  // member/read-only stay USER.
  const actorRole = bookingManagementAuthorizationRole(session.user);
  const isAdmin = actorRole === "ADMIN";

  const { id: bookingId } = await params;
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      // #4088: the night rows, which a grid night set is compared with and the request records.
      guests: { include: { nights: { select: { stayDate: true } } } },
      member: true,
      // #3369: the owner may be an Organisation; bookingOwner() reads both.
      organisation: { select: { name: true, email: true } },
      payment: {
        select: {
          id: true,
          amountCents: true,
          refundedAmountCents: true,
          status: true,
          stripePaymentIntentId: true,
          xeroInvoiceId: true,
          xeroInvoiceNumber: true,
        },
      },
    },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  if (bookingOwner(booking).memberId !== session.user.id && !isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rl = await checkRateLimit(rateLimiters.bookingChangeRequest, session.user.id);
  if (!rl.success) {
    const retryAfter = Math.ceil((rl.resetAt - Date.now()) / 1000);
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfter) },
      }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createChangeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: changeRequestValidationMessage(parsed.error), details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // #4533: a promo change is an officer's correction of a finished stay, raised
  // from Edit Booking, and takes its own path; nothing below sees one.
  if (parsed.data.promoChange) {
    const { promoChange, reason: promoReason, ...delta } = parsed.data;
    return finishedStayPromoCorrectionRequestResponse(req, {
      actorMemberId: session.user.id,
      actorIsOfficer: isAdmin,
      booking,
      delta,
      promoChange,
      reason: normalizeReason(promoReason),
      today: await clubTodayDateOnlyInstant(),
    });
  }

  const {
    checkIn,
    checkOut,
    addGuests,
    removeGuestIds,
    guestStayRanges: sentGuestStayRanges,
    requestedEffectiveDate,
    reason,
  } = parsed.data;
  // #4157: what approval applies, so what is judged and stored; per-entry refusals read what was sent.
  const guestStayRanges = sentGuestStayRanges?.filter(isAppliedChangeRequestRange);
  // #4030 (owner decision: "a structured delta is required"). A request must
  // name the change it asks for: new dates, guests added or removed, or a
  // guest's nights. `requestedEffectiveDate` and the note are context for the
  // officer, never a change on their own — a note-only request was the free
  // text the finished-stay approval (#3750) cannot apply or charge.
  const hasRequestedChange =
    changedDate(checkIn, booking.checkIn) ||
    changedDate(checkOut, booking.checkOut) ||
    Boolean(addGuests?.length) ||
    Boolean(removeGuestIds?.length) ||
    // #4030 review M2: a range only counts when it changes the guest's nights.
    namesStayRangeChange(guestStayRanges ?? [], booking.guests);

  if (!hasRequestedChange) {
    return NextResponse.json(
      { error: CHANGE_REQUEST_NEEDS_STRUCTURED_CHANGE_MESSAGE, code: "STRUCTURED_CHANGE_REQUIRED" },
      { status: 400 }
    );
  }

  const validated = validateChangeRequestDatesAndNights(booking, parsed.data);
  if (validated.error !== undefined) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  const { requestedCheckIn, requestedCheckOut, effectiveDate, nextCheckIn, nextCheckOut } = validated;
  // #4030 review M4 (`INV-GUEST-019`): the one dependant-identity rule.
  if (addGuests?.length) {
    const dependantRefusal = await checkOwnDependantIdentityForParty(prisma, {
      bookerMemberId: bookingOwner(booking).memberId,
      party: addGuests,
      memberPathMemberIds: claimedMemberPathIds(addGuests),
    });
    if (dependantRefusal) {
      return NextResponse.json(
        { error: CHANGE_REQUEST_DEPENDANT_TYPED_MESSAGE, code: dependantRefusal.code },
        { status: 409 },
      );
    }
  }

  // #2266 (LOW-7): DRAFT joined the member-editable statuses, which would
  // otherwise let a change request be filed against a member's own draft. A
  // draft is directly editable by its member — every change an admin could
  // "approve" here the member can simply make themselves — so a queue entry
  // for one is pure noise for the admins. Refuse it outright.
  if (booking.status === "DRAFT") {
    return NextResponse.json(
      {
        error:
          "Draft bookings can be edited directly — change requests are only for bookings you can no longer edit yourself",
      },
      { status: 400 }
    );
  }

  const editPolicy = getBookingEditPolicy({
    status: booking.status,
    role: actorRole,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    // #3123 — the CLUB's day, from its persisted zone. This policy's `today` and
    // `editableFrom` are quoted back to the member in the change-request copy.
    today: await clubTodayDateOnlyInstant(),
  });
  if (!editPolicy.canModify) {
    return NextResponse.json(
      { error: editPolicy.reason ?? "This booking cannot be modified" },
      { status: 400 }
    );
  }

  const touchesLockedPeriod = requestTouchesLockedPeriod({
    booking,
    editPolicy,
    requestedCheckIn,
    requestedCheckOut,
    requestedEffectiveDate: effectiveDate,
    addedGuestStarts: addedGuestFirstNights(addGuests ?? [], { checkIn: nextCheckIn, checkOut: nextCheckOut }),
  });

  if (!touchesLockedPeriod) {
    return NextResponse.json(
      {
        error:
          "Booking change requests are for NZ today or past-night changes that require admin review",
      },
      { status: 400 }
    );
  }

  const existing = await prisma.bookingChangeRequest.findFirst({
    where: {
      bookingId,
      requestedByMemberId: session.user.id,
      status: "REQUESTED",
    },
    select: { id: true },
  });

  if (existing) {
    return NextResponse.json(
      { error: "A booking change request is already pending for this booking" },
      { status: 409 }
    );
  }

  const removeSet = new Set(removeGuestIds ?? []);
  const unknownRemoved = unknownChangeRequestGuestRefusal(booking.guests, { removeGuestIds });
  if (unknownRemoved) {
    return NextResponse.json({ error: unknownRemoved }, { status: 400 });
  }

  const lodgeCapacity = await getLodgeCapacity(
    booking.lodgeId ?? (await getDefaultLodgeId(prisma)),
  );
  const proposedGuestCount =
    booking.guests.length - removeSet.size + (addGuests?.length ?? 0);
  if (proposedGuestCount > lodgeCapacity) {
    return NextResponse.json(
      { error: lodgeGuestLimitMessage(lodgeCapacity, (limit) => `A booking cannot exceed ${limit} guests`) },
      { status: 400 },
    );
  }

  const unknownRanged = unknownChangeRequestGuestRefusal(booking.guests, { guestStayRanges: sentGuestStayRanges });
  if (unknownRanged) {
    return NextResponse.json({ error: unknownRanged }, { status: 400 });
  }

  // #4203: the approval-relevant record, from the builder the card's estimate reads too (`INV-SSOT-001`).
  const stored = changeRequestStoredProposal(
    booking,
    { checkIn, checkOut, addGuests, removeGuestIds, guestStayRanges: sentGuestStayRanges },
    (guest) => ({
      firstName: guest.firstName,
      lastName: guest.lastName,
      ageTier: guest.ageTier,
      isMember: guest.isMember,
      memberId: guest.memberId,
    }),
  );
  const removedGuests = stored.requested.removeGuests;
  const requestedSummary = buildChangeRequestSummary({
    checkIn,
    checkOut,
    addGuests,
    removedGuests,
    guestStayRanges,
    requestedEffectiveDate,
  });
  const normalizedReason = normalizeReason(reason);
  const changeRequest = await prisma.bookingChangeRequest.create({
    data: {
      bookingId,
      requestedByMemberId: session.user.id,
      requestedChanges: {
        original: stored.original,
        requested: {
          ...stored.requested,
          requestedEffectiveDate: requestedEffectiveDate ?? null,
          summary: requestedSummary,
        },
        lockedPeriod: {
          today: formatDateOnly(editPolicy.today),
          editableFrom: editPolicy.editableFrom
            ? formatDateOnly(editPolicy.editableFrom)
            : null,
          touchesLockedPeriod,
        },
        payment: booking.payment
          ? {
              id: booking.payment.id,
              amountCents: booking.payment.amountCents,
              refundedAmountCents: booking.payment.refundedAmountCents,
              status: booking.payment.status,
              stripePaymentIntentId: booking.payment.stripePaymentIntentId,
              xeroInvoiceId: booking.payment.xeroInvoiceId,
              xeroInvoiceNumber: booking.payment.xeroInvoiceNumber,
            }
          : null,
      },
      reason: normalizedReason,
    },
    // The SAME member-readable manifest the GET on this route uses (#2562
    // review). Without it Prisma returns every scalar column and line 473 sends
    // that row straight to the member as the 201 body — so the response named
    // `internalNotes`. Nothing could leak TODAY (a row this new has no note on
    // it), but the boundary this lane wrote down was false for this handler, and
    // the census test that is supposed to make the leak impossible was not
    // watching it. Selecting the manifest brings the POST under that census, so
    // the next edit that returns a row which is NOT brand new — an upsert so a
    // member can resubmit into their open request, a re-read after
    // `linkedModificationId` is set, a shared helper reused here — cannot carry
    // the officer's private note out with it.
    select: memberBookingChangeRequestSelect,
  });

  logAudit({
    action: "booking-change-request.create",
    memberId: session.user.id,
    targetId: bookingId,
    subjectMemberId: bookingOwner(booking).memberId,
    entityType: "BookingChangeRequest",
    entityId: changeRequest.id,
    category: "booking",
    outcome: "success",
    summary: "Booking change request submitted",
    details: requestedSummary,
    metadata: {
      bookingId,
      requestId: changeRequest.id,
      requestedSummary,
      touchesLockedPeriod,
    },
    ipAddress: getClientIp(req),
  });

  sendAdminBookingChangeRequestAlert({
    memberName: `${bookingOwner(booking).member.firstName} ${bookingOwner(booking).member.lastName}`,
    memberEmail: bookingOwner(booking).member.email,
    bookingId,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    requestedSummary,
    reason: normalizedReason,
    requestId: changeRequest.id,
  }).catch((err) =>
    logger.error(
      { err, bookingId, requestId: changeRequest.id },
      "Failed to send booking change request admin alert"
    )
  );

  // Re-projected as well as selected, for the same reason the GET is: the select
  // is the guard that matters in production, and the whitelist copy is what still
  // holds if this query is ever an `include:` again.
  return NextResponse.json(projectMemberBookingChangeRequest(changeRequest), {
    status: 201,
  });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;
  // Issue #1313 (option A2): owner, Full Admin, or Booking Officer (bookings:edit)
  // may list a booking's change requests.
  const isAdmin =
    bookingManagementAuthorizationRole(session.user) === "ADMIN";

  const { id: bookingId } = await params;
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    // #2700: `deletedAt` selected beside the authority field, per
    // `INV-ADDPAY-031`'s house shape.
    select: { memberId: true, deletedAt: true },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  if (bookingOwner(booking).memberId !== session.user.id && !isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // The rule is `INV-ADDPAY-034`; `INV-ADDPAY-033`, which tracked this as an
  // open decision, is now a superseded stub pointing there.
  //
  // #2700 — the other read `INV-ADDPAY-033` tracked. It listed a deleted
  // booking's change requests (policy-exception rows among them) to its owner,
  // while `bookings/[id]/page.tsx` refuses the record to that same member. Owner
  // decision, 10 Aug 2026: refuse, sharing ONE sentence with the consent write
  // and the refund-appeal read rather than three variants that drift apart.
  //
  // AFTER the 403 above, so a caller with no claim gets the same answer either
  // way and this is never a deleted-or-live oracle.
  if (booking.deletedAt) {
    return deletedBookingRefusalResponse();
  }

  // #2562 — an EXPLICIT column projection, never `include:`.
  //
  // This read is authorised for the booking's own OWNER (line above), and it
  // selects every change request on the booking with no `kind` filter — so
  // POLICY_EXCEPTION rows come back here too. `include:` returns every scalar
  // column on the model, which meant the officer's private `internalNotes` went
  // to the member it was written about the moment that column existed. The
  // manifest in `booking-change-request-member-view.ts` names what a member may
  // read and what they may not, and its census test fails until a newly added
  // column is classified.
  const requests = await prisma.bookingChangeRequest.findMany({
    where: { bookingId },
    select: {
      ...memberBookingChangeRequestSelect,
      requestedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
      reviewedBy: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  // Projected again on the way out (see the manifest module): the select is the
  // guarantee, this is the backstop for the day somebody rewrites the query.
  return NextResponse.json(requests.map(projectMemberBookingChangeRequest));
}
