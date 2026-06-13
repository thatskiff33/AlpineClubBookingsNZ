import { NextRequest, NextResponse } from "next/server";
import type { AgeTier } from "@prisma/client";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { getBookingEditPolicy } from "@/lib/booking-edit-policy";
import { formatDateOnly, normalizeDateOnlyForTimeZone, parseDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { sendAdminBookingChangeRequestAlert } from "@/lib/email";
import { ageTierEnum } from "@/lib/age-tier-schema";
import { nameField } from "@/lib/zod-helpers";
import { getLodgeCapacity } from "@/lib/lodge-capacity";
import { checkRateLimit, getClientIp, rateLimiters } from "@/lib/rate-limit";
import logger from "@/lib/logger";
import { z } from "zod";

const createChangeRequestSchema = z.object({
  checkIn: z.string().optional(),
  checkOut: z.string().optional(),
  addGuests: z
    .array(
      z.object({
        firstName: nameField(),
        lastName: nameField(),
        ageTier: ageTierEnum,
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
  return formatDateOnly(normalizeDateOnlyForTimeZone(value));
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
  const currentCheckIn = normalizeDateOnlyForTimeZone(booking.checkIn);
  const currentCheckOut = normalizeDateOnlyForTimeZone(booking.checkOut);

  // `today` is produced by getTodayDateOnly() (NZ-normalised midnight UTC).
  // `requestedEffectiveDate` and the booking dates come from parseDateOnly /
  // normalizeDateOnlyForTimeZone, which also yield midnight UTC. The
  // comparisons below rely on both sides being on the same midnight-UTC
  // date-only frame.
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

  if (booking.memberId !== session.user.id && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rl = checkRateLimit(rateLimiters.bookingChangeRequest, session.user.id);
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

  const nextCheckIn = requestedCheckIn ?? normalizeDateOnlyForTimeZone(booking.checkIn);
  const nextCheckOut = requestedCheckOut ?? normalizeDateOnlyForTimeZone(booking.checkOut);
  if (nextCheckOut <= nextCheckIn) {
    return NextResponse.json(
      { error: "Check-out must be after check-in" },
      { status: 400 }
    );
  }

  const editPolicy = getBookingEditPolicy({
    status: booking.status,
    role: session.user.role,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
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

  const lodgeCapacity = await getLodgeCapacity();
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

  return NextResponse.json(changeRequest, { status: 201 });
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

  const { id: bookingId } = await params;
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { memberId: true },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  if (booking.memberId !== session.user.id && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const requests = await prisma.bookingChangeRequest.findMany({
    where: { bookingId },
    include: {
      requestedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
      reviewedBy: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return NextResponse.json(requests);
}
