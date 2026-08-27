/**
 * Guest-persistence and capacity-range helpers for the booking-creation
 * service, plus the admin-review field resolver.
 *
 * Extracted verbatim from `booking-create.ts`. Depends only on the shared
 * `booking-create-types` module, never on the orchestrator, to avoid an import
 * cycle.
 */
import { AdminReviewStatus } from "@prisma/client";
import {
  ADULT_SUPERVISION_REVIEW_REASON,
  requiresAdultSupervisionReview,
} from "@/lib/booking-review";
import {
  addCalendarDays,
  calendarDateOfDateOnlyInstant,
  calendarDateOfSerialisedDbDate,
  dateOnlyInstantOf,
  type CalendarDate,
} from "@/lib/club-time";
import { addDaysDateOnly, formatDateOnly } from "@/lib/date-only";
import type { GuestNightInput } from "@/lib/booking-guest-stay-ranges";
import {
  type BookingGuestInput,
  BookingReviewJustificationRequiredError,
} from "./booking-create-types";

/**
 * Resolve the admin-review fields for a booking based on guest mix and
 * whether the booking is being created by an admin on behalf of a member.
 *
 * Admin-created bookings auto-approve the review (no second pass on their
 * own work). Member-created bookings that trip the rule require a written
 * justification and land with adminReviewStatus = PENDING so an admin can
 * decide via the booking requests queue.
 *
 * The one on-behalf create that does NOT auto-approve is a policy-exception
 * approval (`reviewedMemberProposal`): the officer reviewed a named set of rules
 * and adult supervision was not among them, so it takes the member path.
 */
export function resolveAdminReviewFields(args: {
  guests: BookingGuestInput[];
  isOnBehalf: boolean;
  sessionUserId: string;
  memberReviewJustification: string | undefined;
  /**
   * #2526: this on-behalf create is EXECUTING A MEMBER'S ALREADY-REVIEWED
   * proposal (an approved booking-policy exception), so only the rules on the
   * officer's card were reviewed. Adult supervision is not one of them, so it
   * opens PENDING with the member's own words, exactly as a member self-create
   * does, instead of being stamped approved by an officer who was never shown it.
   */
  reviewedMemberProposal?: boolean;
}): {
  requiresAdminReview: boolean;
  adminReviewReason: string | null;
  memberReviewJustification: string | null;
  adminReviewStatus: AdminReviewStatus | null;
  adminReviewNotes: string | null;
  adminReviewedById: string | null;
  adminReviewedAt: Date | null;
  blockForReview: boolean;
} {
  const flagged = requiresAdultSupervisionReview(args.guests);
  if (!flagged) {
    return {
      requiresAdminReview: false,
      adminReviewReason: null,
      memberReviewJustification: null,
      adminReviewStatus: null,
      adminReviewNotes: null,
      adminReviewedById: null,
      adminReviewedAt: null,
      blockForReview: false,
    };
  }

  // #2526: an on-behalf create that is EXECUTING A MEMBER'S REVIEWED PROPOSAL
  // (a policy-exception approval) must not auto-approve this review. The rule is
  // adult supervision, which is neither policy-exception reason code, so the
  // officer's card never mentioned it and the drift gate cannot evaluate it.
  // Auto-approving there would un-park a party of minors with no adult in the
  // officer's name, defeating the #1422 check-in block, and would drop the
  // member's own words. Member parity instead: PENDING, blocked, justification
  // kept.
  if (args.isOnBehalf && !args.reviewedMemberProposal) {
    return {
      requiresAdminReview: true,
      adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
      memberReviewJustification: args.memberReviewJustification?.trim() || null,
      adminReviewStatus: AdminReviewStatus.APPROVED,
      adminReviewNotes: "Approved at creation by admin.",
      adminReviewedById: args.sessionUserId,
      adminReviewedAt: new Date(),
      blockForReview: false,
    };
  }

  const justification = args.memberReviewJustification?.trim();
  if (!justification) {
    throw new BookingReviewJustificationRequiredError();
  }

  return {
    requiresAdminReview: true,
    adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
    memberReviewJustification: justification,
    adminReviewStatus: AdminReviewStatus.PENDING,
    adminReviewNotes: null,
    adminReviewedById: null,
    adminReviewedAt: null,
    blockForReview: true,
  };
}

/**
 * Turn an admin's on-behalf hosting confirmation into the decision the
 * reconciler records, or `null` for "nobody has decided this yet" (#2364, D-R4).
 *
 * Two things it deliberately will NOT do. It never produces a decision for a
 * MEMBER-created booking — a member cannot approve their own exception, so their
 * hazard opens PENDING and waits for an admin. And it never produces one from
 * the admin ROLE alone: an admin who supplies no reason gets `null`, which opens
 * the review PENDING rather than waving it through. The route refuses that
 * request outright and asks for the reason, so an admin never accidentally
 * leaves a member's booking sitting in a queue they did not know about — but
 * even if a future caller forgets that refusal, the failure mode here is an
 * extra review, never a silent approval.
 */
export function resolveAdultMemberHostingDecision(args: {
  isOnBehalf: boolean;
  sessionUserId: string;
  adultMemberHostingReason: string | undefined;
}): { reason: string; byMemberId: string } | null {
  if (!args.isOnBehalf) return null;
  const reason = args.adultMemberHostingReason?.trim();
  if (!reason) return null;
  return { reason, byMemberId: args.sessionUserId };
}

export type PricedGuest = {
  priceCents: number;
  perNightCents: number[];
  nightDates: Date[];
  // Rate-membership-type snapshot resolved at pricing time (#1930, E4).
  // Persisted on the BookingGuest so Xero line building picks the matching
  // item code. Optional so pre-refactor callers/tests still compile; a missing
  // value stores NULL and the Xero read falls back isMember -> FULL/NON_MEMBER.
  rateMembershipTypeId?: string | null;
};

/**
 * Build the nested guest create payload, including one BookingGuestNight row
 * per included night (issue #713). The guest's stayStart/stayEnd envelope is
 * derived from the priced nights (min night, last night + 1 day); a guest with
 * no priced nights falls back to the booking range. Every guest — contiguous or
 * not — gets per-night rows so the data model is uniform.
 */
export function buildGuestCreateData(
  guests: BookingGuestInput[],
  price: { guests: PricedGuest[] },
  checkIn: Date,
  checkOut: Date
) {
  return guests.map((g, i) => {
    const priced = price.guests[i];
    const nightDates = priced.nightDates ?? [];
    const hasNights = nightDates.length > 0;
    const stayStart = hasNights ? nightDates[0] : (g.stayStart ?? checkIn);
    const stayEnd = hasNights
      ? addDaysDateOnly(nightDates[nightDates.length - 1], 1)
      : (g.stayEnd ?? checkOut);
    return {
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: g.ageTier,
      isMember: g.isMember,
      memberId: g.memberId || null,
      stayStart,
      stayEnd,
      priceCents: priced.priceCents,
      rateMembershipTypeId: priced.rateMembershipTypeId ?? null,
      // Member-guest consent ("+ Add Member Guest", epic #2305, MG2 #2307). The
      // five columns arrive already decided by `buildMemberGuestConsentWrite` —
      // the single writer of the eight-shape table — so this layer persists them
      // and takes no view on what they should be. SPREAD ONLY WHEN PRESENT: a
      // family-scope or non-member guest carries nothing, and spreading five
      // explicit nulls instead would write the same values through a different
      // code path for every booking the club has ever made, for no gain.
      ...(g.memberGuestConsent ?? {}),
      nights: {
        create: nightDates.map((stayDate, k) => ({
          stayDate,
          priceCents: priced.perNightCents[k] ?? 0,
        })),
      },
    };
  });
}

export function getCapacityGuestRanges(
  guests: BookingGuestInput[],
  checkIn: Date,
  checkOut: Date
) {
  return guests.map((guest) => ({
    stayStart: guest.stayStart ?? checkIn,
    stayEnd: guest.stayEnd ?? checkOut,
    // Pass the explicit night set through so capacity counts a non-contiguous
    // guest only on the nights they actually stay (issue #713).
    nights: guest.nights ?? undefined,
  }));
}

/**
 * Resolve the booking's effective date envelope from its guests (issue #713).
 *
 * Creation is expand-only: the range never shrinks below the member's stated
 * checkIn/checkOut, but auto-expands to cover any guest night that falls
 * outside it. In single-range mode (no explicit night sets, guest dates within
 * the stated range) the result equals the stated range exactly, so existing
 * behaviour is unchanged. Manage-guests editing recomputes the envelope from
 * the night sets directly (allowing shrink) on its own path.
 *
 * IT DECODES, AND IT DOES NOT PROJECT (#3107). This answer is used TWICE, and
 * that is why the frame it lands in is not a detail: it is written as
 * `booking.checkIn` / `checkOut`, and it is the admission window handed to
 * `checkCapacityForGuestRanges` inside `acquireLodgeCapacityLock`. The values it
 * reads are stored calendar days - the member's parsed request, a
 * `BookingGuest.stayStart` / `stayEnd`, a `BookingGuestNight.stayDate` - so the
 * day is read straight back out in UTC (`INV-DATE-019`'s first exact boundary,
 * over the columns `INV-DATE-026` declares date-only) and no zone is consulted.
 *
 * THE SEEDS ALWAYS DECODED AND THE CONTRIBUTIONS PROJECTED, which is the shape of
 * the defect rather than an aside: `formatDateOnly` seeded the min and max keys
 * on the true calendar, then every guest-derived key and BOTH returned bounds
 * went through `normalizeDateOnlyForTimeZone`. Behind Greenwich that is the
 * previous day, and it was applied TWICE on the path every ordinary create takes
 * - once to the contribution and once to the return - so the low bound came back
 * TWO days early, not one. `normalizeGuestStayRange` fills `stayStart` /
 * `stayEnd` from the booking range for every guest that supplies neither, so the
 * branch below always ran; a single day was lost only by a guest contributing
 * nothing at all, which no caller can produce.
 *
 * That is also why one consequence was LOUD. `createConfirmedBooking` re-checks
 * this resolved envelope against the club's own day, so behind Greenwich a
 * member whose stay started TODAY OR TOMORROW had a low bound already in the
 * past and was refused with `Cannot book in the past` - a 400 on an ordinary
 * create. The route's own gate reads the unresolved request and would have let
 * both through.
 *
 * Measured on `America/Denver`, two guests over the three nights
 * 2026-07-04/05/06 requested as 07-04 -> 07-07: the envelope stored 07-02 ->
 * 07-06, the admission check therefore inspected 07-02..07-05 and counted 0
 * proposed beds on two of those four nights and never looked at 07-06 at all -
 * the same under-count, on the same lock, that the night-key fix in
 * `booking-guest-stay-ranges.ts` closed one call deeper. And
 * because `BookingGuestNight.stayDate` is written true-calendar by
 * `pricing.ts`'s `normalizeBookingDate`, the created row STRADDLED ITSELF: an
 * envelope on one frame around night rows on another.
 *
 * THE DECODE HERE IS THE PERMISSIVE ONE, deliberately. `dateOnlyKey` in
 * `booking-guest-stay-ranges.ts` refuses a value carrying a time of day, because
 * everything reaching it is already a lodge-night key; the inputs here are the
 * booking service's own `Date` parameters, whose declared types are wider than
 * their callers currently are. `src/lib/stored-calendar-day.ts` holds the full
 * reasoning for that split, and the two cannot disagree about a DAY: both are
 * zone-free, so they differ only in whether a non-midnight value is floored or
 * refused.
 */
export function resolveBookingDateEnvelope(
  guests: BookingGuestInput[],
  checkIn: Date,
  checkOut: Date
): { checkIn: Date; checkOut: Date } {
  let minKey = calendarDateOfDateOnlyInstant(checkIn);
  let maxNightKey = addCalendarDays(calendarDateOfDateOnlyInstant(checkOut), -1);

  const consider = (startKey: CalendarDate, lastNightKey: CalendarDate) => {
    if (startKey < minKey) minKey = startKey;
    if (lastNightKey > maxNightKey) maxNightKey = lastNightKey;
  };

  for (const guest of guests) {
    if (guest.nights && guest.nights.length > 0) {
      for (const entry of guest.nights) {
        const nightKey = nightEntryKey(entry);
        consider(nightKey, nightKey);
      }
    } else if (guest.stayStart && guest.stayEnd) {
      consider(
        calendarDateOfDateOnlyInstant(guest.stayStart),
        addCalendarDays(calendarDateOfDateOnlyInstant(guest.stayEnd), -1)
      );
    }
  }

  return {
    checkIn: dateOnlyInstantOf(minKey),
    checkOut: dateOnlyInstantOf(addCalendarDays(maxNightKey, 1)),
  };
}

/**
 * The lodge night one explicit entry names, on the true calendar (#3107).
 *
 * The string branch reads the leading day rather than reparsing, which is
 * {@link calendarDateOfSerialisedDbDate}'s reason for existing: a reparse would
 * resolve an offset first, so `"2026-07-04T12:00:00+13:00"` would decode a day
 * early. It replaces appending a UTC-midnight suffix to the string and then
 * projecting the result, which turned a `yyyy-mm-dd` entry into the previous day
 * behind Greenwich and threw on any longer ISO form, because the suffix landed
 * after the one the value already carried. `nightEntryKey` in
 * `booking-guest-stay-ranges.ts` derives the same key for the same entry, which
 * is what keeps this envelope and the nights counted inside it on one frame.
 */
function nightEntryKey(entry: GuestNightInput): CalendarDate {
  if (typeof entry === "string") {
    return calendarDateOfSerialisedDbDate(entry);
  }
  if (entry instanceof Date) {
    return calendarDateOfDateOnlyInstant(entry);
  }
  return nightEntryKey(entry.stayDate);
}

export function getCapacityFullNights(
  nightDetails: Array<{ date: Date; availableBeds: number }>
): string[] {
  return nightDetails
    .filter((night) => night.availableBeds < 0)
    .map((night) => formatDateOnly(night.date));
}
