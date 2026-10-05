import { AgeTier, type BookingGuestNightPriceSource, BookingRequestStatus, BookingStatus, Prisma } from "@prisma/client";

import { logAudit } from "@/lib/audit";
import { BookingRequestError, linkedGuestMemberMap, parseBookingRequestGuests } from "@/lib/booking-request";
import { buildApprovalGuestNights, toPipelineGuestCreateData } from "@/lib/booking-request-shared";
import { normaliseCorrectedTeachers, type CorrectedTeacher } from "@/lib/booking-request-correction-shape";
import { pendingAdultReservationNightsMatch, releasePendingAdultNights, reservePendingAdultNights } from "@/lib/booking-request-pending-adult-reservations";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { prisma } from "@/lib/prisma";
import { resolveBookingGuestDietary, resolveBookingGuestDietarySeeding } from "@/lib/member-dietary-booking-writes";
import { areOldSchoolAdultsRuntimesStopped } from "@/lib/pending-school-adults-gate";
import { storedSchoolTeacherListSchema } from "@/lib/school-teacher-schema";
import { resolveGuestRateMembershipTypes, resolveMembershipTypePoliciesForMembers } from "@/lib/membership-type-policy";
import { seasonYearOfStoredDate } from "@/lib/financial-year";
import { planAcceptedSchoolHeldPrices, readAcceptedSchoolTerms } from "@/lib/school-pending-adult-price-plan";
import { bookingFinalPriceCents } from "@/lib/booking-final-price";

/** Replace accepted anonymous slots with real names without changing the deal. */
export async function resolveAcceptedSchoolPendingAdults(input: {
  requestId: string;
  adminMemberId: string;
  expectedVersion: number;
  teachers: CorrectedTeacher[];
}): Promise<{ pendingAdultCount: number; version: number }> {
  const proposed = normaliseCorrectedTeachers(input.teachers);
  if (proposed.length === 0 || proposed.length !== input.teachers.length) {
    throw new BookingRequestError("Enter a real first and last name for each pending adult.", 422);
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new BookingRequestError("Reload this request before naming its pending adults.", 422);
  }

  // Locate the immutable lodge key before taking locks. Re-read both rows
  // after global -> lodge, then claim the version before any guest write.
  const locator = await prisma.bookingRequest.findUnique({
    where: { id: input.requestId },
    select: { heldBookingId: true },
  });
  if (!locator?.heldBookingId) {
    throw new BookingRequestError("This accepted school request has no live held beds to resolve.", 409);
  }
  const heldLocator = await prisma.booking.findUnique({
    where: { id: locator.heldBookingId },
    select: { lodgeId: true },
  });
  if (!heldLocator?.lodgeId) {
    throw new BookingRequestError("The held booking could not be found. Reload the request.", 409);
  }

  const dietarySeeding = await resolveBookingGuestDietarySeeding();
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    await acquireLodgeCapacityLock(tx, heldLocator.lodgeId);

    const request = await tx.bookingRequest.findUnique({ where: { id: input.requestId } });
    const hold = await tx.booking.findUnique({
      where: { id: locator.heldBookingId! },
      include: { guests: { select: { id: true, memberId: true, firstName: true, lastName: true, ageTier: true, stayStart: true, stayEnd: true, priceCents: true, nights: { select: { id: true, stayDate: true, priceCents: true } } } } },
    });
    if (!request || request.type !== "SCHOOL" || request.status !== BookingRequestStatus.ACCEPTED ||
        request.version !== input.expectedVersion || request.heldBookingId !== locator.heldBookingId ||
        request.convertedBookingId || !hold || hold.status !== BookingStatus.AWAITING_REVIEW ||
        hold.lodgeId !== heldLocator.lodgeId) {
      throw new BookingRequestError("This accepted request or its held beds changed. Reload it before naming adults.", 409);
    }
    if (request.pendingAdultCount < proposed.length || request.pendingAdultCount === 0) {
      throw new BookingRequestError("There are fewer pending adult slots than the names supplied.", 409);
    }
    const parsedTeachers = storedSchoolTeacherListSchema.safeParse(request.teachers);
    if (!parsedTeachers.success) {
      throw new BookingRequestError("The stored teacher list needs officer repair before adults can be named.", 409);
    }
    const teachers = parsedTeachers.data;
    const guests = parseBookingRequestGuests(request.guests);
    if (guests.length < teachers.length || teachers.some((teacher, index) =>
      guests[index]?.firstName !== teacher.firstName || guests[index]?.lastName !== teacher.lastName ||
      guests[index]?.ageTier !== AgeTier.ADULT)) {
      throw new BookingRequestError("The named teachers and held guest list disagree. Review this request before resolving adults.", 409);
    }
    if (hold.guests.some((guest) => guest.stayStart.getTime() !== hold.checkIn.getTime() ||
          guest.stayEnd.getTime() !== hold.checkOut.getTime())) {
      throw new BookingRequestError("The held guest list changed after the quote. Review its beds before naming adults.", 409);
    }
    const existingNames = new Set(teachers.map((teacher) => `${teacher.firstName.toLowerCase()}\u0000${teacher.lastName.toLowerCase()}`));
    for (const teacher of proposed) {
      const key = `${teacher.firstName.toLowerCase()}\u0000${teacher.lastName.toLowerCase()}`;
      if (existingNames.has(key)) throw new BookingRequestError("Each teacher must have a distinct real name.", 422);
      existingNames.add(key);
      // A matching club member can change rate and consent. That needs an
      // explicit new terms review, never an automatic accepted-quote rewrite.
      const members = await tx.member.findMany({
        where: {
          active: true,
          OR: [
            { firstName: { equals: teacher.firstName, mode: "insensitive" }, lastName: { equals: teacher.lastName, mode: "insensitive" } },
            ...(teacher.email ? [{ email: { equals: teacher.email, mode: "insensitive" as const } }] : []),
          ],
        },
        select: { id: true, canLogin: true },
      });
      const policies = await resolveMembershipTypePoliciesForMembers(tx, {
        memberIds: members.map((member) => member.id),
        seasonYear: seasonYearOfStoredDate(hold.checkIn),
      });
      if (members.some((member) => member.canLogin || policies.get(member.id)?.bookingBehavior === "MEMBER_RATE")) {
        throw new BookingRequestError("A named adult may be a club member. Review their rate and consent, then issue new terms if needed.", 409);
      }
    }

    const accepted = await readAcceptedSchoolTerms(request, hold, guests.length + request.pendingAdultCount);
    const pendingPrices = accepted.guestBreakdown.filter((entry) => entry.kind === "PENDING_ADULT");
    const originalPendingCount = pendingPrices.length;
    const resolvedSoFar = originalPendingCount - request.pendingAdultCount;
    const heldPrices = planAcceptedSchoolHeldPrices({
      accepted, guests, teacherCount: teachers.length, pendingAdultCount: request.pendingAdultCount,
      links: linkedGuestMemberMap(request.linkedGuestMembers),
      checkIn: hold.checkIn, checkOut: hold.checkOut, heldGuests: hold.guests,
    });
    const selectedPrices = pendingPrices.slice(resolvedSoFar, resolvedSoFar + proposed.length);
    if (selectedPrices.length !== proposed.length) {
      throw new BookingRequestError("The accepted quote's pending adult breakdown is incomplete.", 409);
    }
    const remaining = request.pendingAdultCount - proposed.length;
    if (remaining > 0 && !areOldSchoolAdultsRuntimesStopped()) {
      throw new BookingRequestError("Partial naming cannot leave unnamed reservations while old web or workers are running. Stop them before continuing or name every remaining adult together.", 409);
    }
    if (!await pendingAdultReservationNightsMatch({
      db: tx,
      bookingRequestId: request.id,
      bookingId: hold.id,
      lodgeId: hold.lodgeId,
      checkIn: hold.checkIn,
      checkOut: hold.checkOut,
      adultCount: request.pendingAdultCount,
    })) {
      throw new BookingRequestError("The unnamed bed reservations do not match the held booking. Resolve the capacity discrepancy first.", 409);
    }

    const links = [...linkedGuestMemberMap(request.linkedGuestMembers).entries()].map(([guestIndex, memberId]) => ({
      guestIndex: guestIndex >= teachers.length ? guestIndex + proposed.length : guestIndex,
      memberId,
    }));
    const nextGuests = [
      ...guests.slice(0, teachers.length),
      ...proposed.map((teacher) => ({ firstName: teacher.firstName, lastName: teacher.lastName, ageTier: AgeTier.ADULT })),
      ...guests.slice(teachers.length),
    ];
    const claimed = await tx.bookingRequest.updateMany({
      where: {
        id: request.id,
        version: request.version,
        status: BookingRequestStatus.ACCEPTED,
        heldBookingId: hold.id,
        pendingAdultCount: request.pendingAdultCount,
        convertedBookingId: null,
      },
      data: {
        teachers: [...teachers, ...proposed] as unknown as Prisma.InputJsonValue,
        guests: nextGuests as unknown as Prisma.InputJsonValue,
        linkedGuestMembers: links as unknown as Prisma.InputJsonValue,
        pendingAdultCount: remaining,
        version: { increment: 1 },
      },
    });
    if (claimed.count !== 1) {
      throw new BookingRequestError("This request changed while adults were being named. Reload and try again.", 409);
    }
    // Only provisional held cents move, to the immutable accepted snapshot.
    // Guest/night ids and every identity/consent/dietary/bed field remain intact.
    const nightUpdates = new Map<string, { ids: string[]; priceCents: number; priceSource: BookingGuestNightPriceSource }>();
    for (const price of heldPrices) {
      await tx.bookingGuest.update({ where: { id: price.guestId }, data: { priceCents: price.priceCents } });
      for (const night of price.nights) {
        const key = `${night.priceCents}:${night.priceSource}`;
        const group = nightUpdates.get(key);
        if (group) group.ids.push(night.id);
        else nightUpdates.set(key, { ids: [night.id], priceCents: night.priceCents, priceSource: night.priceSource });
      }
    }
    // One statement per distinct amount/source, independent of stay length.
    // Every id was proved above; a lost row aborts the whole naming transaction.
    for (const group of nightUpdates.values()) {
      const updated = await tx.bookingGuestNight.updateMany({
        where: { id: { in: group.ids }, priceCents: { not: null } },
        data: { priceCents: group.priceCents, priceSource: group.priceSource },
      });
      if (updated.count !== group.ids.length) {
        throw new BookingRequestError("The held guest nights changed while adults were being named. Reload and review the held beds.", 409);
      }
    }
    const totalPriceCents = accepted.totalCents;
    await tx.booking.update({ where: { id: hold.id }, data: {
      totalPriceCents, discountCents: 0, promoAdjustmentCents: 0,
      finalPriceCents: bookingFinalPriceCents({ totalPriceCents, promoAdjustmentCents: 0 }),
    } });
    // Match the held-booking and approval writers' immutable rate-type snapshot.
    // The accepted cents stay fixed; these adults have no member identity.
    const ratedTeachers = await resolveGuestRateMembershipTypes(tx, {
      seasonYear: seasonYearOfStoredDate(hold.checkIn),
      guests: proposed.map((teacher) => ({ ...teacher, isMember: false })),
    });
    const dietaryWrites = await resolveBookingGuestDietary(
      tx, dietarySeeding, proposed.map(() => ({ memberId: null })),
    );
    for (const [index, teacher] of proposed.entries()) {
      const priceCents = selectedPrices[index]!.totalCents;
      await tx.bookingGuest.create({
        data: {
          bookingId: hold.id,
          priceCents,
          ...toPipelineGuestCreateData({
            firstName: teacher.firstName,
            lastName: teacher.lastName,
            ageTier: AgeTier.ADULT,
            isMember: false,
            rateMembershipTypeId: ratedTeachers[index]!.rateMembershipTypeId,
            stayStart: hold.checkIn,
            stayEnd: hold.checkOut,
            nights: buildApprovalGuestNights({ checkIn: hold.checkIn, checkOut: hold.checkOut, priceCents }),
          }, dietaryWrites[index]),
        },
      });
    }
    await releasePendingAdultNights({ db: tx, bookingId: hold.id });
    await reservePendingAdultNights({
      db: tx,
      bookingRequestId: request.id,
      bookingId: hold.id,
      lodgeId: hold.lodgeId,
      checkIn: hold.checkIn,
      checkOut: hold.checkOut,
      adultCount: remaining,
    });
    return { pendingAdultCount: remaining, version: request.version + 1 };
  });

  logAudit({
    action: "booking_request.pending_adults_named",
    memberId: input.adminMemberId,
    actorMemberId: input.adminMemberId,
    targetId: input.requestId,
    entityType: "BookingRequest",
    entityId: input.requestId,
    category: "booking",
    outcome: "success",
    summary: "Named adults in an accepted school request without changing the accepted terms",
    metadata: { namedCount: proposed.length, pendingAdultCount: outcome.pendingAdultCount },
  });
  return outcome;
}
