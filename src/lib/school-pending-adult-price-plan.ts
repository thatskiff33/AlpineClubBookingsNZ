import type { AgeTier } from "@prisma/client";

import { BookingRequestError, type BookingRequestGuest } from "@/lib/booking-request";
import type { parseBookingRequestQuoteOptions } from "@/lib/booking-request-quotes";
import { buildApprovalGuestNights } from "@/lib/booking-request-shared";

/** Prove the original accepted ordinals before changing provisional held cents. */
export function planAcceptedSchoolHeldPrices(input: {
  accepted: ReturnType<typeof parseBookingRequestQuoteOptions>[number];
  guests: BookingRequestGuest[];
  teacherCount: number;
  pendingAdultCount: number;
  links: Map<number, string>;
  checkIn: Date;
  checkOut: Date;
  heldGuests: Array<{
    id: string; firstName: string; lastName: string; ageTier: AgeTier;
    memberId: string | null;
    nights: Array<{ id: string; stayDate: Date }>;
  }>;
}) {
  const refuse = () => {
    throw new BookingRequestError("The accepted party cannot be mapped uniquely to its held guests. Review the terms before naming adults.", 409);
  };
  const entries = input.accepted.guestBreakdown;
  const originalNamed = entries.filter((entry) => entry.kind !== "PENDING_ADULT");
  const pending = entries.filter((entry) => entry.kind === "PENDING_ADULT");
  const resolvedCount = pending.length - input.pendingAdultCount;
  const originalTeacherCount = originalNamed.findIndex((entry) => entry.ageTier !== "ADULT");
  const teacherCount = originalTeacherCount < 0 ? originalNamed.length : originalTeacherCount;
  const nightCount = buildApprovalGuestNights({ checkIn: input.checkIn, checkOut: input.checkOut, priceCents: input.accepted.totalCents }).length;
  if (resolvedCount < 0 || teacherCount === 0 ||
      nightCount === 0 || entries.some((entry) => entry.nightCount !== nightCount) ||
      input.teacherCount !== teacherCount + resolvedCount ||
      input.guests.length !== originalNamed.length + resolvedCount ||
      entries.some((entry, index) => entry.guestIndex !== index ||
        (index < originalNamed.length) !== (entry.kind !== "PENDING_ADULT")) ||
      originalNamed.slice(teacherCount).some((entry) => entry.ageTier === "ADULT") ||
      pending.some((entry) => entry.ageTier !== "ADULT" || entry.isMember || entry.memberId !== null || entry.firstName !== undefined || entry.lastName !== undefined) ||
      entries.reduce((sum, entry) => sum + entry.totalCents, 0) !== input.accepted.totalCents) refuse();

  const key = (guest: { firstName: string; lastName: string; ageTier: AgeTier }) =>
    `${guest.firstName}\u0000${guest.lastName}\u0000${guest.ageTier}`;
  const heldByName = new Map(input.heldGuests.map((guest) => [key(guest), guest]));
  if (heldByName.size !== input.heldGuests.length || input.heldGuests.length !== input.guests.length ||
      new Set(input.guests.map(key)).size !== input.guests.length) refuse();

  return input.guests.map((guest, index) => {
    const isResolvedAdult = index >= teacherCount && index < input.teacherCount;
    const originalIndex = index < teacherCount ? index : index - resolvedCount;
    const entry = isResolvedAdult ? pending[index - teacherCount] : originalNamed[originalIndex];
    const held = heldByName.get(key(guest));
    const memberId = input.links.get(index) ?? null;
    if (!entry || !held || entry.ageTier !== guest.ageTier || held.memberId !== memberId ||
        entry.memberId !== memberId || entry.isMember !== Boolean(memberId) ||
        (!isResolvedAdult && (entry.firstName !== guest.firstName || entry.lastName !== guest.lastName))) refuse();
    // The preceding proof makes both values present; no price or identity fallback.
    const acceptedEntry = entry!;
    const heldGuest = held!;
    const nights = buildApprovalGuestNights({ checkIn: input.checkIn, checkOut: input.checkOut, priceCents: acceptedEntry.totalCents });
    const heldDates = heldGuest.nights.map((night) => night.stayDate.getTime());
    if (acceptedEntry.nightCount !== nights.length || heldDates.length !== nights.length ||
        new Set(heldDates).size !== nights.length || nights.some((night) => !heldDates.includes(night.stayDate.getTime()))) refuse();
    return { guestId: heldGuest.id, priceCents: acceptedEntry.totalCents, nights: nights.map((night) => ({
      ...night, id: heldGuest.nights.find((heldNight) => heldNight.stayDate.getTime() === night.stayDate.getTime())!.id,
    })) };
  });
}
