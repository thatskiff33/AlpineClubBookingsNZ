import type { AgeTier } from "@prisma/client";

import { logAudit } from "@/lib/audit";
import { ApiError } from "@/lib/api-error";
import {
  createDraftBooking,
  type BookingGuestInput as DraftBookingGuestInput,
} from "@/lib/booking-create";
import {
  assertLinkedBookingMembersCanBeBooked,
  BookingGuestValidationError,
  normalizeBookingGuestInputs,
  resolveLinkedBookingMembers,
} from "@/lib/booking-guests";
import {
  addDaysDateOnly,
  formatDateOnly,
  getTodayDateOnly,
  normalizeDateOnlyForTimeZone,
  parseDateOnly,
} from "@/lib/date-only";
import { prisma } from "@/lib/prisma";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function dayDiff(start: Date, end: Date) {
  return Math.round((end.getTime() - start.getTime()) / MS_PER_DAY);
}

function toApiError(error: unknown) {
  if (error instanceof BookingGuestValidationError) {
    return new ApiError(error.message, error.status);
  }
  return error;
}

export async function copyBookingToDraft({
  sourceBookingId,
  targetCheckIn,
  adminMemberId,
}: {
  sourceBookingId: string;
  targetCheckIn: string;
  adminMemberId: string;
}) {
  const newCheckIn = parseDateOnly(targetCheckIn);
  if (Number.isNaN(newCheckIn.getTime())) {
    throw new ApiError("Invalid target check-in date", 400);
  }
  if (newCheckIn < getTodayDateOnly()) {
    throw new ApiError("Target check-in date cannot be in the past", 400);
  }

  const source = await prisma.booking.findUnique({
    where: { id: sourceBookingId },
    include: {
      guests: true,
      member: { select: { id: true, active: true } },
    },
  });
  if (!source) {
    throw new ApiError("Booking not found", 404);
  }
  if (source.deletedAt) {
    throw new ApiError("Deleted bookings cannot be copied", 400);
  }
  if (!source.member.active) {
    throw new ApiError("The booking member is inactive", 400);
  }
  if (source.guests.length === 0) {
    throw new ApiError("Cannot copy a booking with no guests", 400);
  }

  const sourceCheckIn = normalizeDateOnlyForTimeZone(source.checkIn);
  const sourceCheckOut = normalizeDateOnlyForTimeZone(source.checkOut);
  const nights = dayDiff(sourceCheckIn, sourceCheckOut);
  if (nights <= 0) {
    throw new ApiError("Source booking has invalid dates", 400);
  }

  const newCheckOut = addDaysDateOnly(newCheckIn, nights);
  const shiftDays = dayDiff(sourceCheckIn, newCheckIn);
  const memberGuestIds = source.guests
    .map((guest) => guest.memberId)
    .filter((memberId): memberId is string => Boolean(memberId));

  let linkedMembers: Awaited<ReturnType<typeof resolveLinkedBookingMembers>>;
  try {
    linkedMembers = await resolveLinkedBookingMembers(
      prisma,
      source.memberId,
      memberGuestIds,
      { skipAuthorization: true },
    );
    await assertLinkedBookingMembersCanBeBooked(
      prisma,
      linkedMembers,
      adminMemberId,
      {
        actorRole: "ADMIN",
        onBehalfOfMemberId: source.memberId,
      },
    );
  } catch (error) {
    throw toApiError(error);
  }

  const copiedGuestInputs = source.guests.map((guest) => {
    if (guest.isMember && !guest.memberId) {
      throw new ApiError(
        "Source booking has a member guest without a linked member reference",
        400,
      );
    }

    const stayStart = addDaysDateOnly(
      normalizeDateOnlyForTimeZone(guest.stayStart ?? source.checkIn),
      shiftDays,
    );
    const stayEnd = addDaysDateOnly(
      normalizeDateOnlyForTimeZone(guest.stayEnd ?? source.checkOut),
      shiftDays,
    );

    return {
      firstName: guest.firstName,
      lastName: guest.lastName,
      ageTier: guest.ageTier as AgeTier,
      isMember: guest.isMember,
      memberId: guest.memberId ?? undefined,
      stayStart,
      stayEnd,
    };
  });

  const guests = normalizeBookingGuestInputs(
    copiedGuestInputs,
    linkedMembers,
  ) as DraftBookingGuestInput[];

  const booking = await createDraftBooking({
    effectiveMemberId: source.memberId,
    isOnBehalf: true,
    sessionUserId: adminMemberId,
    checkIn: newCheckIn,
    checkOut: newCheckOut,
    guests,
    notes: source.notes ?? undefined,
    expectedArrivalTime: source.expectedArrivalTime ?? undefined,
  });

  logAudit({
    action: "booking.copy.created",
    memberId: adminMemberId,
    targetId: booking.id,
    subjectMemberId: source.memberId,
    entityType: "Booking",
    entityId: booking.id,
    category: "booking",
    outcome: "success",
    summary: "Booking copied to draft",
    details: `Copied booking ${sourceBookingId} to draft booking ${booking.id}`,
    metadata: {
      sourceBookingId,
      copiedBookingId: booking.id,
      checkIn: formatDateOnly(newCheckIn),
      checkOut: formatDateOnly(newCheckOut),
      guestCount: guests.length,
    },
  });

  return {
    bookingId: booking.id,
    sourceBookingId,
    checkIn: formatDateOnly(newCheckIn),
    checkOut: formatDateOnly(newCheckOut),
    status: booking.status,
  };
}
