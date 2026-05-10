import { prisma } from "@/lib/prisma";

export const LODGE_VISIBLE_BOOKING_STATUSES = [
  "CONFIRMED",
  "PAID",
  "COMPLETED",
] as const;

export async function findLodgeGuestForDate(bookingGuestId: string, date: Date) {
  return prisma.bookingGuest.findFirst({
    where: {
      id: bookingGuestId,
      booking: {
        status: { in: [...LODGE_VISIBLE_BOOKING_STATUSES] },
        checkIn: { lte: date },
        checkOut: { gt: date },
      },
    },
    select: {
      id: true,
      bookingId: true,
      arrivedAt: true,
      departedAt: true,
    },
  });
}

export async function assignmentExistsForDate(assignmentId: string, date: Date) {
  const assignment = await prisma.choreAssignment.findFirst({
    where: {
      id: assignmentId,
      date,
    },
    select: { id: true },
  });

  return Boolean(assignment);
}

export async function validateRosterAllocationsForDate(
  allocations: Array<{ bookingGuestId: string; bookingId: string }>,
  date: Date
) {
  const guestIds = Array.from(
    new Set(allocations.map((allocation) => allocation.bookingGuestId))
  );

  const guests = await prisma.bookingGuest.findMany({
    where: {
      id: { in: guestIds },
      booking: {
        status: { in: [...LODGE_VISIBLE_BOOKING_STATUSES] },
        checkIn: { lte: date },
        checkOut: { gt: date },
      },
    },
    select: {
      id: true,
      bookingId: true,
    },
  });

  const guestBookingMap = new Map(
    guests.map((guest) => [guest.id, guest.bookingId])
  );

  return allocations.every(
    (allocation) =>
      guestBookingMap.get(allocation.bookingGuestId) === allocation.bookingId
  );
}
