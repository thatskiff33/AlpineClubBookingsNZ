import type { AgeTier } from "@prisma/client";

import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { ApiError } from "@/lib/api-error";
import {
  createDraftBooking,
  type BookingGuestInput as DraftBookingGuestInput,
} from "@/lib/booking-create";
import {
  assertLinkedBookingMembersCanBeBooked,
  BookingGuestValidationError,
  normalizeBookingGuestInputs,
  resolveLinkedBookingMembersWithBoundary,
  type ResolvedLinkedBookingMembers,
} from "@/lib/booking-guests";
import {
  loadMemberGuestAddPolicy,
  matchMemberGuestNotificationRows,
  planMemberGuestConsentWrites,
} from "@/lib/member-guest-add-policy";
import type { MemberGuestAddActor } from "@/lib/member-guest-consent";
import {
  addDaysDateOnly,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { prisma } from "@/lib/prisma";
import { storedDateOnly } from "@/lib/stored-calendar-day";

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
  if (newCheckIn < (await clubTodayDateOnlyInstant())) {
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

  // ALL FOUR STORED DATES IN THIS FUNCTION DECODE, AND THEY MOVE TOGETHER
  // (#3107). These two, and the guest bounds below, all used to project through
  // the configured zone, and the four errors CANCELLED: `shiftDays` is measured
  // from a projected `sourceCheckIn` to a zone-free `newCheckIn`, so it absorbed
  // exactly the offset the projected guest bounds then carried back out. The
  // copy therefore came out right on every zone whose UTC offset keeps one sign.
  //
  // So fixing only the guest bounds would have BROKEN a working path: measured
  // on America/Denver, decoding the guest bounds while `shiftDays` still
  // compensated moved a copied stay from 2026-08-05 to 2026-08-06, a day late.
  // Only the whole set may move, and moving the whole set is a no-op there.
  //
  // What it is NOT a no-op for is a zone whose offset CHANGES SIGN across DST,
  // where the projection is not a uniform shift and the cancellation fails.
  // Measured on Atlantic/Azores, whose 2026 change is 29 March: a source
  // booking of 03-28 -> 03-31 projected to 03-27 -> 03-31, so `nights` came out
  // 4 instead of 3 and the copy gained a night it never had, while the guest
  // stay landed a day late. Decoded, both are right.
  const sourceCheckIn = storedDateOnly(source.checkIn);
  const sourceCheckOut = storedDateOnly(source.checkOut);
  const nights = dayDiff(sourceCheckIn, sourceCheckOut);
  if (nights <= 0) {
    throw new ApiError("Source booking has invalid dates", 400);
  }

  const newCheckOut = addDaysDateOnly(newCheckIn, nights);
  const shiftDays = dayDiff(sourceCheckIn, newCheckIn);
  const memberGuestIds = source.guests
    .map((guest) => guest.memberId)
    .filter((memberId): memberId is string => Boolean(memberId));

  // "+ Add Member Guest" (epic #2305, MG2 #2307). Read before `createDraftBooking`
  // opens its transaction.
  const memberGuestPolicy = await loadMemberGuestAddPolicy();
  // MG4-D-a: the copy is an ADMIN add. This is also where CONSENT IS NOT
  // TRANSITIVE — see the re-stamp note below.
  const memberGuestActor: MemberGuestAddActor = {
    kind: "ADMIN",
    adminMemberId: adminMemberId,
  };

  let resolved: ResolvedLinkedBookingMembers;
  try {
    resolved = await resolveLinkedBookingMembersWithBoundary(
      prisma,
      source.memberId,
      memberGuestIds,
      {
        skipAuthorization: true,
        memberGuestWideningEnabled: memberGuestPolicy.wideningEnabled,
      },
    );
    await assertLinkedBookingMembersCanBeBooked(
      prisma,
      resolved.members,
      adminMemberId,
      {
        actorRole: "ADMIN",
        onBehalfOfMemberId: source.memberId,
        // D-8: a blocked cross-family member is refused neutrally, even here —
        // the admin copying the booking may be looking at a member whose details
        // the source booking's owner should not have handed over in the first
        // place, and the refusal text is the club's, not the admin's.
        crossFamilyMemberIds: resolved.boundary.beyondFamilyMemberIds,
      },
    );
  } catch (error) {
    throw toApiError(error);
  }
  const linkedMembers = resolved.members;

  const copiedGuestInputs = source.guests.map((guest) => {
    if (guest.isMember && !guest.memberId) {
      throw new ApiError(
        "Source booking has a member guest without a linked member reference",
        400,
      );
    }

    // The other half of the set above: these are `@db.Date` reads too, and
    // `shiftDays` is now the true shift rather than a compensating one.
    const stayStart = addDaysDateOnly(
      storedDateOnly(guest.stayStart ?? source.checkIn),
      shiftDays,
    );
    const stayEnd = addDaysDateOnly(
      storedDateOnly(guest.stayEnd ?? source.checkOut),
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

  /**
   * CONSENT IS NOT TRANSITIVE ACROSS BOOKINGS, and this is the only place that
   * could have made it look like it is.
   *
   * The copy reads the SOURCE booking's guest rows, which may carry a
   * TARGET_APPROVED consent — a member who agreed to be on THAT stay, on those
   * nights, made by that person. Copying those columns forward would silently
   * assert that they also agreed to a different stay on different dates they have
   * never been told about. So the source consent columns are never read: every
   * copied cross-family guest is re-stamped here through
   * `buildMemberGuestConsentWrite` against the COPYING admin (MG4-D-a,
   * ADMIN_ASSIGNED), and the target is told about the new booking.
   *
   * Note that `copiedGuestInputs` above is built field by field from the source
   * rows and deliberately does NOT include the consent columns — that omission is
   * what makes the re-stamp the only possible outcome rather than a correction
   * applied on top.
   */
  const consentPlan = planMemberGuestConsentWrites({
    guests: normalizeBookingGuestInputs(
      copiedGuestInputs,
      linkedMembers,
    ) as DraftBookingGuestInput[],
    boundary: resolved.boundary,
    actor: memberGuestActor,
    now: new Date(),
    bookingCheckIn: newCheckIn,
    policy: memberGuestPolicy,
  });
  const guests = consentPlan.guests;

  const booking = await createDraftBooking({
    effectiveMemberId: source.memberId,
    isOnBehalf: true,
    sessionUserId: adminMemberId,
    // A copy stays at the source booking's authoritative lodge. Omitting this
    // used the create service's legacy default-lodge fallback and silently
    // moved a copied lodge-B booking to lodge A (#2701 / INV-CAP-034).
    lodgeId: source.lodgeId,
    checkIn: newCheckIn,
    checkOut: newCheckOut,
    guests,
    notes: source.notes ?? undefined,
    expectedArrivalTime: source.expectedArrivalTime ?? undefined,
  });

  // AFTER the draft's transaction has committed. Awaited so a copy that could not
  // reach anybody has already been logged and audited by the time the caller
  // returns.
  // Nothing planned means nothing written and nobody owed — every copy on a club
  // with the module off, and every copy whose guests are all inside the owner's
  // family. Checked first so the ordinary copy does no work at all.
  const memberGuestRows =
    consentPlan.entriesByMemberId.size === 0
      ? []
      : matchMemberGuestNotificationRows({
          createdGuests: booking.guests,
          entriesByMemberId: consentPlan.entriesByMemberId,
        });
  if (memberGuestRows.length > 0) {
    /**
     * SENT ON THE DRAFT, DELIBERATELY (MG4 #2309 review, declared decision).
     *
     * The review asked whether a copy that lands in DRAFT should hold this back
     * until the copy becomes a real booking. It should not, and the reason is
     * that the premise does not hold: the ORDINARY member create path already
     * notifies on a draft — `api/bookings/route.ts` calls the same dispatcher
     * immediately after `createDraftBooking` in its `if (draft)` branch — so
     * deferring here would make the copy the ONLY writer that behaves
     * differently, for the same booking in the same status.
     *
     * And the deferral would be worse than inconsistent. A cross-family row is
     * written PENDING on an ask-first club and PENDING HOLDS A BED (D-4): the
     * nightly sweep will expire it after N days whether or not anybody was
     * asked. Waiting for the draft to be confirmed would leave a member holding
     * a bed nobody had put a question to, and then take it away again with a
     * "your request lapsed" notice for a request that was never sent. Telling
     * them late is not a smaller harm than telling them early; it is a
     * different, larger one.
     *
     * It would also need a column MG2 explicitly does not add — "has this row
     * been notified?" — because without one a deferred send has no way to know
     * whether the confirm step owes mail or would duplicate it. See the
     * SEND-ONCE HONESTY note in `member-guest-consent-notifications.ts`: whoever
     * adds that column adds the retry with it, and that is the issue in which
     * deferral becomes buildable.
     *
     * What a DRAFT copy genuinely costs the target is stated rather than hidden:
     * a copy an officer abandons leaves them told about a stay that never
     * happens. The withdrawal notice covers the case where the draft is deleted
     * or the guest removed; an abandoned draft that simply sits is the residue,
     * and it is the same residue every abandoned member-created draft already
     * has.
     *
     * Loaded lazily on purpose: the sender pulls in the whole email/template
     * graph, and only a booking that actually added a cross-family member guest
     * needs it. A club with the module off never loads the mailer through this
     * path at all.
     */
    const { sendMemberGuestAddNotifications } = await import(
      "@/lib/member-guest-consent-notifications"
    );
    // Belt and braces around a function that is documented never to reject: the
    // booking is ALREADY COMMITTED at this point, so an unexpected throw here
    // would hand the member an error for a booking that exists and was paid for.
    // A notification problem is logged, never surfaced as a booking failure.
    try {
      await sendMemberGuestAddNotifications({
        bookingId: booking.id,
        rows: memberGuestRows,
        actor: memberGuestActor,
      });
    } catch (err) {
      logger.error(
        { err, bookingId: booking.id },
        "Failed to dispatch member-guest add notifications",
      );
    }
  }

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
