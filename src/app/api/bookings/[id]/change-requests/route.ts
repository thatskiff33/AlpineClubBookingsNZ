import { NextRequest, NextResponse } from "next/server";
import type { AgeTier } from "@prisma/client";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { getBookingEditPolicy } from "@/lib/booking-edit-policy";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { formatDateOnly, parseDateOnly } from "@/lib/date-only";
import {
  calendarDateOfDateOnlyInstant,
} from "@/lib/club-time";
import { storedDateOnly } from "@/lib/stored-calendar-day";
import { getDefaultLodgeId } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { sendAdminBookingChangeRequestAlert } from "@/lib/email";
import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import { nameField } from "@/lib/zod-helpers";
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

const createChangeRequestSchema = z.object({
  checkIn: z.string().optional(),
  checkOut: z.string().optional(),
  addGuests: z
    .array(
      z.object({
        firstName: nameField(),
        lastName: nameField(),
        ageTier: bookableAgeTierEnum,
        isMember: z.boolean(),
        memberId: z.string().trim().min(1).optional(),
        stayStart: z.string().optional(),
        stayEnd: z.string().optional(),
      })
    )
    .max(200)
    .optional(),
  removeGuestIds: z.array(z.string().trim().min(1)).max(200).optional(),
  guestStayRanges: z
    .array(
      z.object({
        guestId: z.string().trim().min(1),
        stayStart: z.string().optional(),
        stayEnd: z.string().optional(),
      })
    )
    .max(200)
    .optional(),
  requestedEffectiveDate: z.string().optional(),
  reason: z.string().max(2000).optional(),
});

function normalizeOptionalDateOnly(value: string | undefined) {
  if (!value) return null;
  const parsed = parseDateOnly(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

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
}: {
  booking: { checkIn: Date; checkOut: Date };
  editPolicy: ReturnType<typeof getBookingEditPolicy>;
  requestedCheckIn: Date | null;
  requestedCheckOut: Date | null;
  requestedEffectiveDate: Date | null;
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

function buildRequestedSummary({
  checkIn,
  checkOut,
  addGuests,
  removedGuests,
  guestStayRanges,
  requestedEffectiveDate,
}: {
  checkIn?: string;
  checkOut?: string;
  addGuests?: Array<{ firstName: string; lastName: string; ageTier: AgeTier; isMember: boolean }>;
  removedGuests: Array<{ firstName: string; lastName: string }>;
  guestStayRanges?: Array<{ guestId: string; stayStart?: string; stayEnd?: string }>;
  requestedEffectiveDate?: string;
}) {
  const parts: string[] = [];
  if (checkIn) parts.push(`check-in to ${checkIn}`);
  if (checkOut) parts.push(`check-out to ${checkOut}`);
  if (addGuests?.length) {
    parts.push(
      `add ${addGuests.map((guest) => `${guest.firstName} ${guest.lastName}`).join(", ")}`
    );
  }
  if (removedGuests.length) {
    parts.push(
      `remove ${removedGuests.map((guest) => `${guest.firstName} ${guest.lastName}`).join(", ")}`
    );
  }
  if (guestStayRanges?.length) {
    parts.push(`update ${guestStayRanges.length} guest stay range${guestStayRanges.length === 1 ? "" : "s"}`);
  }
  if (requestedEffectiveDate) {
    parts.push(`effective ${requestedEffectiveDate}`);
  }
  return parts.length ? parts.join("; ") : "Locked-period booking change";
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
      guests: true,
      member: true,
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

  if (booking.memberId !== session.user.id && !isAdmin) {
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
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const {
    checkIn,
    checkOut,
    addGuests,
    removeGuestIds,
    guestStayRanges,
    requestedEffectiveDate,
    reason,
  } = parsed.data;
  const hasRequestedChange =
    changedDate(checkIn, booking.checkIn) ||
    changedDate(checkOut, booking.checkOut) ||
    Boolean(addGuests?.length) ||
    Boolean(removeGuestIds?.length) ||
    Boolean(guestStayRanges?.length) ||
    Boolean(requestedEffectiveDate);

  if (!hasRequestedChange) {
    return NextResponse.json(
      { error: "At least one booking change is required" },
      { status: 400 }
    );
  }

  const requestedCheckIn = normalizeOptionalDateOnly(checkIn);
  const requestedCheckOut = normalizeOptionalDateOnly(checkOut);
  const effectiveDate = normalizeOptionalDateOnly(requestedEffectiveDate);
  if (
    (checkIn && !requestedCheckIn) ||
    (checkOut && !requestedCheckOut) ||
    (requestedEffectiveDate && !effectiveDate)
  ) {
    return NextResponse.json({ error: "Invalid booking date" }, { status: 400 });
  }

  const nextCheckIn = requestedCheckIn ?? storedDateOnly(booking.checkIn);
  const nextCheckOut = requestedCheckOut ?? storedDateOnly(booking.checkOut);
  if (nextCheckOut <= nextCheckIn) {
    return NextResponse.json(
      { error: "Check-out must be after check-in" },
      { status: 400 }
    );
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
  const invalidRemoveGuestIds = [...removeSet].filter(
    (guestId) => !booking.guests.some((guest) => guest.id === guestId)
  );
  if (invalidRemoveGuestIds.length > 0) {
    return NextResponse.json(
      { error: "One or more guests were not found on this booking" },
      { status: 400 }
    );
  }

  const lodgeCapacity = await getLodgeCapacity(
    booking.lodgeId ?? (await getDefaultLodgeId(prisma)),
  );
  const proposedGuestCount =
    booking.guests.length - removeSet.size + (addGuests?.length ?? 0);
  if (proposedGuestCount > lodgeCapacity) {
    return NextResponse.json(
      { error: `A booking cannot exceed ${lodgeCapacity} guests` },
      { status: 400 },
    );
  }

  const invalidRangeGuestIds = (guestStayRanges ?? [])
    .map((range) => range.guestId)
    .filter((guestId) => !booking.guests.some((guest) => guest.id === guestId));
  if (invalidRangeGuestIds.length > 0) {
    return NextResponse.json(
      { error: "One or more guest stay ranges referenced a guest not found on this booking" },
      { status: 400 }
    );
  }

  const removedGuests = booking.guests
    .filter((guest) => removeSet.has(guest.id))
    .map((guest) => ({
      id: guest.id,
      firstName: guest.firstName,
      lastName: guest.lastName,
      ageTier: guest.ageTier,
      isMember: guest.isMember,
      memberId: guest.memberId,
      stayStart: formatBookingDate(guest.stayStart),
      stayEnd: formatBookingDate(guest.stayEnd),
    }));
  const requestedSummary = buildRequestedSummary({
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
        original: {
          checkIn: formatBookingDate(booking.checkIn),
          checkOut: formatBookingDate(booking.checkOut),
          guests: booking.guests.map((guest) => ({
            id: guest.id,
            firstName: guest.firstName,
            lastName: guest.lastName,
            ageTier: guest.ageTier,
            isMember: guest.isMember,
            memberId: guest.memberId,
            stayStart: formatBookingDate(guest.stayStart),
            stayEnd: formatBookingDate(guest.stayEnd),
          })),
        },
        requested: {
          checkIn: checkIn ?? null,
          checkOut: checkOut ?? null,
          addGuests: addGuests ?? [],
          guestStayRanges: guestStayRanges ?? [],
          removeGuests: removedGuests,
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
    subjectMemberId: booking.memberId,
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
    memberName: `${booking.member.firstName} ${booking.member.lastName}`,
    memberEmail: booking.member.email,
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

  if (booking.memberId !== session.user.id && !isAdmin) {
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
