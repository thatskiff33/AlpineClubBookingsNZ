// Split out of src/lib/booking-modify.ts (issue #1138): edit-eligibility
// validation and the shared loaded-booking types for the modification
// boundary. Code moved verbatim; import via the "@/lib/booking-modify" barrel.

import {
  BookingStatus,
  type AgeTier,
  type Booking,
  type BookingGuest,
  type Member,
  type Payment,
  type Prisma,
  type PromoCode,
  type PromoRedemption,
  type Role,
} from "@prisma/client";

import { ApiError } from "@/lib/api-error";
import { OTHER_LODGE_RATE_IN_PROGRESS_MESSAGE } from "@/lib/booking-other-lodge-rate";
import {
  getBookingEditPolicy,
  canModifyBookingStatusForRole,
  usesActiveBookingEditLifecycle,
} from "@/lib/booking-edit-policy";
import { BookingGuestStayRangeValidationError } from "@/lib/booking-guest-stay-range-input";
import {
  resolveModificationStayRanges,
  type LiveGuestStayRow,
  type ResolvedModificationStayRanges,
  type StayRangeDeltaInput,
} from "@/lib/booking-modification-stay-ranges";
import { hasCapturedPayment } from "@/lib/booking-payment-state";
import { formatDateOnly, parseDateOnly } from "@/lib/date-only";
import { storedDateOnly } from "@/lib/stored-calendar-day";

export type BatchModifyInput = {
  checkIn?: string;
  checkOut?: string;
  addGuests?: Array<{
    firstName: string;
    lastName: string;
    ageTier: AgeTier;
    isMember: boolean;
    memberId?: string;
    stayStart?: string | null;
    stayEnd?: string | null;
    // Explicit included nights for a non-contiguous stay (issue #713).
    nights?: ReadonlyArray<string> | null;
  }>;
  removeGuestIds?: string[];
  guestStayRanges?: Array<{
    guestId: string;
    stayStart?: string | null;
    stayEnd?: string | null;
    // Explicit included nights for a non-contiguous stay (issue #713).
    nights?: ReadonlyArray<string> | null;
  }>;
  guestUpdates?: Array<{
    guestId: string;
    firstName: string;
    lastName: string;
  }>;
  // #2337: link an unnamed placeholder guest on a MEMBER whole-lodge booking to a
  // real member, re-rating that guest at the member rate in place. A first-class
  // sibling of `guestUpdates` — NOT a loosened rename: a rename can never touch
  // isMember/memberId/rateMembershipTypeId (booking-modify-plan.ts:250-252 stays
  // intact), whereas this deliberately does, for the one narrow case the owner
  // sanctioned (option 2, quote-first, 1 Aug 2026). Gated hard by
  // `resolveGuestMemberLinks` (admin-only, whole-lodge-only, placeholder-only) and
  // by the member-origin check on the apply/quote paths.
  linkGuestToMember?: Array<{ guestId: string; memberId: string }>;
  /**
   * The reciprocal "other club member" rate election (Other Lodges epic,
   * follow-up to #2749): the partner lodge for the whole booking, and the
   * complete END-STATE set of NON-MEMBER guests to price at the club's own
   * member rate.
   *
   * Both are absent on an edit that says nothing about the rate, which leaves
   * the stored election exactly as it is. `otherLodgeId: null` clears the lodge
   * and, with it, every guest tick. `otherLodgeMemberGuestIds` is a SET, not a
   * delta — a guest missing from a present array is unticked and reprices back
   * to the non-member rate. Gated by `resolveOtherLodgeRateElection`
   * (admin-only, non-member guests only, lodge required).
   */
  otherLodgeId?: string | null;
  otherLodgeMemberGuestIds?: string[];
  promoCode?: string;
  // #2266 (MED-4): a guest-targeted promo's beneficiaries. EXISTING guests are
  // bound by bookingGuestId — a positional index would be re-bound to whatever
  // the guest list is at apply time, so a concurrent edit between preview and
  // save could silently redeem the discount for the wrong guest. Indexes exist
  // only for TO-BE-ADDED guests within this same request (no id exists yet),
  // relative to the `addGuests` array. A stale bookingGuestId refuses loudly.
  promoGuestIds?: string[];
  promoAddedGuestIndexes?: number[];
  removePromoCode?: boolean;
  // #2266: the member's credit election, integer cents. The modify path never
  // moves credit itself — it stores the election on the booking
  // (Booking.creditElectionCents, #2265) for the pay step to consume, exactly
  // like a saved draft. `0` clears a stored election; absent leaves it alone.
  applyCreditCents?: number;
  memberReviewJustification?: string;
  settlementMethod?: BookingModificationSettlementMethod;
  // Admin-only date override (issue #1668). Only honoured for role === "ADMIN";
  // the callers enforce the date-only contract (no guest/promo inputs) and
  // require pricingMode when adminOverride is set.
  adminOverride?: boolean;
  pricingMode?: "shift" | "recalculate";
  confirmOverCapacity?: boolean;
  // Owner decision (#1668 review): the admin chooses per override edit whether
  // the member receives the change-notification email. Absent = notify.
  notifyMember?: boolean;
  // Admin-only (#1746): flags a proposed member guest as the second occupant
  // of a shared double with their CONFIRMED partner, routing capacity through
  // the #1745 reserved-slot admission check. Rejected for non-admin actors.
  partnerSharedGuests?: Array<{ memberId: string; partnerMemberId: string }>;
  /**
   * This ADMIN call is EXECUTING A MEMBER'S ALREADY-REVIEWED PROPOSAL, so judge
   * every rule that was NOT reviewed as if the booking's own member were acting
   * (#2526).
   *
   * WHY THIS EXISTS. `role === "ADMIN"` is overloaded: the policy-exception
   * approval borrows it for one narrow purpose — the canonical service enforces
   * minimum stay only for non-admin actors, so ADMIN is the mechanism that
   * applies the reviewed override. But the same condition ALSO grants
   * `skipAuthorization` (which drops the beyond-family member-guest refusal),
   * makes a member-guest add consent-free and always-notify, skips the D-8
   * profile/bookability gate, skips the cross-family marker, and skips the
   * member-guest unpaid-subscription check. None of those rules was reviewed, and
   * the officer queue promises in so many words that "membership and privacy
   * rules all still apply".
   *
   * The same overload auto-APPROVES the adult-supervision (child-safety) review
   * in the officer's name (`resolveModifyReviewUpdate`), un-parking a booking of
   * minors with no adult on a card that only ever said "minimum stay" — a
   * different rule from either policy-exception reason code, so the drift gate
   * cannot see it either.
   *
   * So the approval sets this flag: it keeps the reviewed minimum-stay override
   * and gives back every rule the requesting member would have faced. A
   * beyond-family member guest is refused (module off) or opens a PENDING consent
   * request (module on) exactly as on the member's own path, and a newly-tripped
   * adult-supervision hazard opens PENDING for a human rather than being stamped
   * approved by the officer who was never shown it.
   *
   * NOT a general admin restraint: an ordinary admin edit leaves it unset and
   * behaves exactly as before. It is also not an escape hatch in the other
   * direction — it can only ever make the guest rules STRICTER.
   */
  reviewedMemberProposal?: boolean;
};

export type BookingModificationSettlementMethod = "card" | "credit";

/*
  Four helpers used to live here — `hasStayRangeInput`, `hasGuestStayRangeInputs`,
  `normalizeRangeOrApiError` and `getGuestStayRangeInputMap`. They were the pieces
  `resolveTargetDates` and `prepareGuestPlan` each assembled into their OWN copy of
  the stay-range resolution, and two copies of one rule is exactly what let the
  policy-exception workflow freeze a party the planner never built (#2526). Both
  call `resolveStayRangesOrApiError` below now, so the pieces are gone; the global
  range-input predicate lives with the resolution it switches, as
  `deltaHasStayRangeInputs` in `@/lib/booking-modification-stay-ranges`.
*/

/**
 * The shared canonical stay-range resolution (#2526), with range-validation
 * errors mapped to the modify path's own `ApiError` 400. Both `resolveTargetDates`
 * and `prepareGuestPlan` go through this, so the envelope they compute and the
 * ranges they write can never disagree.
 */
export function resolveStayRangesOrApiError<Guest extends LiveGuestStayRow>(args: {
  booking: { checkIn: Date; checkOut: Date };
  guests: ReadonlyArray<Guest>;
  input: StayRangeDeltaInput;
  requested?: { checkIn: Date; checkOut: Date };
}): ResolvedModificationStayRanges<Guest> {
  try {
    return resolveModificationStayRanges(args);
  } catch (error) {
    if (error instanceof BookingGuestStayRangeValidationError) {
      throw new ApiError(error.message, 400);
    }
    throw error;
  }
}

export type LoadedPromoRedemption = PromoRedemption & {
  promoCode: PromoCode & {
    assignments: Array<{ memberId: string }>;
    lodges?: Array<{ lodgeId: string }>;
  };
  guestTargets?: Array<{ bookingGuestId: string }>;
};

export type LoadedBookingForModify = Booking & {
  // Guests carry their explicit night set (issue #713) so an edit preserves the
  // gaps of guests that are not being changed and re-syncs only edited guests.
  guests: Array<
    BookingGuest & { nights?: { stayDate: Date; priceCents?: number }[] }
  >;
  payment: Payment | null;
  member: Member;
  promoRedemption: LoadedPromoRedemption | null;
};

type BookingGuestNameEditPayment = Pick<
  Payment,
  "status" | "amountCents" | "additionalAmountCents" | "additionalPaymentStatus"
> | null;

const FULLY_PAID_BOOKING_STATUSES = new Set<BookingStatus | string>([
  BookingStatus.PAID,
  BookingStatus.COMPLETED,
]);

export function hasOutstandingAdditionalPayment(
  payment: BookingGuestNameEditPayment,
) {
  return Boolean(
    payment &&
      payment.additionalAmountCents > 0 &&
      payment.additionalPaymentStatus !== "SUCCEEDED",
  );
}

export function isBookingFullyPaidForGuestNameEdits(booking: {
  status: BookingStatus | string;
  finalPriceCents: number;
  payment: BookingGuestNameEditPayment;
}) {
  if (hasOutstandingAdditionalPayment(booking.payment)) {
    return false;
  }

  if (hasCapturedPayment(booking.payment)) {
    return true;
  }

  return (
    booking.finalPriceCents <= 0 &&
    FULLY_PAID_BOOKING_STATUSES.has(booking.status)
  );
}

export type ResolvedTargetDates = {
  newCheckIn: Date;
  newCheckOut: Date;
  isInProgressEdit: boolean;
  editableFrom: Date | null;
  skipBookingLifecycleRules: boolean;
  checkInChanged: boolean;
  datesChanged: boolean;
};

/**
 * #2337: the placeholder→member in-place re-rate is refused on a mid-stay
 * (in-progress) edit. A mid-stay edit prices through
 * `buildInProgressGuestRangePlan`, which is fed the ORIGINAL `booking.guests`
 * rather than the link-modified `guestsForPricing`, so the cleared
 * `lockedNightPrices` + member identity never reach pricing: the re-rate would
 * silently settle $0 while stamping the member. Rather than thread the link
 * through the in-progress plan (the riskier option b), the link is refused here
 * and the officer is pointed at the remove-and-re-add path (issue #2337 OD-A),
 * which DOES settle correctly mid-stay because the in-progress plan prices an
 * added member guest at the member rate and refunds the removed placeholder.
 *
 * NB: admin override is NOT an escape hatch here — an override edit is date-only
 * and rejects `linkGuestToMember` outright ("Admin override edits change dates
 * only", see `modifyBookingBatch` and the quote route), so the working mid-stay
 * route is remove-and-re-add, not override. Mid-stay in-place re-rate support
 * (option b) is a possible future enhancement.
 *
 * Shared verbatim by the apply path (`resolveTargetDates` below) and the quote
 * route so preview and save refuse identically — the officer sees the refusal,
 * never a phantom $0 quote.
 */
export const GUEST_MEMBER_LINK_IN_PROGRESS_MESSAGE =
  "Linking a placeholder guest to a member is not available once a booking has started. Remove the placeholder guest and add the member as a new guest to re-rate this stay.";

export function resolveTargetDates({
  booking,
  role,
  input,
  today,
}: {
  booking: LoadedBookingForModify;
  role: Role;
  input: BatchModifyInput;
  /**
   * The club's today, threaded straight into `getBookingEditPolicy` — see it for
   * why this is a required value rather than a read (#3123). This function is
   * SYNCHRONOUS and its only production caller runs it inside
   * `withOptionalTransaction`, so the day is resolved before that opens.
   */
  today: Date;
}): ResolvedTargetDates {
  // Issue #1668: only an admin may drive the override; a member request that
  // somehow carried the flag falls through to the normal date-window policy.
  const effectiveAdminOverride = Boolean(input.adminOverride) && role === "ADMIN";
  const editPolicy = getBookingEditPolicy({
    status: booking.status,
    role,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    adminOverride: effectiveAdminOverride,
    today,
  });
  if (!editPolicy.canModify) {
    throw new ApiError(
      editPolicy.reason ?? "This booking cannot be modified",
      400,
    );
  }

  const requestedCheckIn = input.checkIn
    ? parseDateOnly(input.checkIn)
    : booking.checkIn;
  const requestedCheckOut = input.checkOut
    ? parseDateOnly(input.checkOut)
    : booking.checkOut;
  if (
    Number.isNaN(requestedCheckIn.getTime()) ||
    Number.isNaN(requestedCheckOut.getTime())
  ) {
    throw new ApiError("Invalid booking dates", 400);
  }

  // The effective envelope after any guest-range-driven expansion (#713), and
  // the per-guest ranges that produced it. Resolved by the SHARED canonical
  // helper (#2526) so every surface that has to predict what this planner will
  // do — most importantly the policy-exception workflow, which freezes a
  // proposed party for an officer to review and then executes the delta —
  // computes the same answer rather than a lookalike.
  const resolvedRanges = resolveStayRangesOrApiError({
    booking: { checkIn: booking.checkIn, checkOut: booking.checkOut },
    guests: booking.guests,
    input,
    requested: { checkIn: requestedCheckIn, checkOut: requestedCheckOut },
  });
  const finalRequestedCheckIn = resolvedRanges.checkIn;
  const finalRequestedCheckOut = resolvedRanges.checkOut;

  const isInProgressEdit = editPolicy.mode === "in-progress";
  const editableFrom = editPolicy.editableFrom;
  // CT-4 (#2870), group F4b: THE APPLY HALF OF A CROSS-FILE FRAME PAIR, and the
  // four reads below are the whole of it. Read the next two paragraphs before
  // changing any of them.
  //
  // These were `normalizeDateOnlyForTimeZone`, which projects a `@db.Date`
  // lodge-night value through `APP_TIME_ZONE`. The PREVIEW twin — the matching
  // block in `src/app/api/bookings/[id]/modify-quote/route.ts` — was corrected
  // to `storedDateOnly` by group B (#3056) without its apply-path mirror, so for
  // a club behind Greenwich the quote route priced and allowed one window while
  // the save refused another, a day apart. The comment on `resolvedRanges` above
  // says the two surfaces "compute the same answer rather than a lookalike";
  // this is what makes that true of the date gates as well as the ranges.
  //
  // AND THE POLICY BESIDE THEM WAS ALREADY MIGRATED, which is why the straddle
  // was one-sided: `getBookingEditPolicy` reads `checkIn`/`checkOut` through
  // `storedDateOnly` and compares them against `today`/`tomorrow`. Since #3123
  // that `today` is the CLUB's day, arriving as a REQUIRED parameter this
  // function threads in from its caller — it used to default to the
  // environment's zone, which is the half CT-6 (#2991) left. So `storedDateOnly`
  // here is not merely zone-free, it is the frame `editPolicy.today` and
  // `editPolicy.editableFrom` are already expressed in. A projection on one side
  // of those comparisons and not the other is the defect.
  // Pinned in `src/lib/__tests__/booking-modify-validation-frame-parity.test.ts`,
  // which transcribes the preview's decision as its oracle.
  const bookingCheckIn = storedDateOnly(booking.checkIn);

  if (isInProgressEdit) {
    if (
      formatDateOnly(storedDateOnly(finalRequestedCheckIn)) !==
        formatDateOnly(bookingCheckIn)
    ) {
      throw new ApiError(
        "Check-in cannot be changed for an in-progress booking",
        400,
      );
    }
    if (editableFrom && storedDateOnly(finalRequestedCheckOut) < editableFrom) {
      throw new ApiError(
        "NZ today and earlier are locked for self-service changes",
        400,
      );
    }
    if (input.promoCode || input.removePromoCode) {
      throw new ApiError(
        "Promo code changes are not available for in-progress bookings",
        400,
      );
    }
    // #2337: a mid-stay re-rate silently settles $0 (the link never reaches the
    // in-progress pricing plan), so refuse it here and point the officer at the
    // remove-and-re-add path, which DOES settle correctly mid-stay. Mirrored on
    // the quote route so preview and save agree — the officer sees the refusal,
    // never $0. (Admin override is date-only and rejects links, so it is not the
    // escape hatch — see GUEST_MEMBER_LINK_IN_PROGRESS_MESSAGE.)
    if (input.linkGuestToMember?.length) {
      throw new ApiError(GUEST_MEMBER_LINK_IN_PROGRESS_MESSAGE, 400);
    }
    // Other Lodges epic: the same hazard, the same refusal. The in-progress plan
    // prices the STORED guest rows, so a mid-stay election would stamp the flag
    // and settle $0 — see OTHER_LODGE_RATE_IN_PROGRESS_MESSAGE.
    if (
      input.otherLodgeId !== undefined ||
      input.otherLodgeMemberGuestIds !== undefined
    ) {
      throw new ApiError(OTHER_LODGE_RATE_IN_PROGRESS_MESSAGE, 400);
    }
  } else if (
    role !== "ADMIN" &&
    storedDateOnly(finalRequestedCheckIn) <= editPolicy.today
  ) {
    throw new ApiError(
      "NZ today and earlier are locked for self-service changes",
      400,
    );
  }

  const newCheckIn = isInProgressEdit ? booking.checkIn : finalRequestedCheckIn;
  const newCheckOut = finalRequestedCheckOut;

  if (newCheckOut <= newCheckIn) {
    throw new ApiError("Check-out must be after check-in", 400);
  }

  const skipBookingLifecycleRules =
    role === "ADMIN" && !usesActiveBookingEditLifecycle(booking.status);

  const checkInChanged =
    newCheckIn.getTime() !== new Date(booking.checkIn).getTime();
  const datesChanged =
    checkInChanged ||
    newCheckOut.getTime() !== new Date(booking.checkOut).getTime();

  return {
    newCheckIn,
    newCheckOut,
    isInProgressEdit,
    editableFrom,
    skipBookingLifecycleRules,
    checkInChanged,
    datesChanged,
  };
}

/**
 * Thrown by prepareGuestPlan when a member modification causes the no-adult
 * rule to trip for a booking that was not previously flagged, and the
 * caller did not supply `memberReviewJustification`.
 */
export class BookingModifyReviewJustificationRequiredError extends ApiError {
  // Machine-readable code (#2104) so the modify route can echo it and the member
  // edit panel can reveal the justification field even when the client-side
  // predicate missed the trip (client/server drift). Mirrors the pattern used by
  // OverCapacityConfirmationRequiredError.
  readonly code = "REVIEW_JUSTIFICATION_REQUIRED";

  constructor() {
    super(
      "Removing the last adult requires a written reason so an admin can review. Please add a justification and try again.",
      400,
    );
    this.name = "BookingModifyReviewJustificationRequiredError";
  }
}

export function assertBookingModifiable(
  booking: LoadedBookingForModify | null,
  { role, actorId }: { role: Role; actorId: string },
): asserts booking is LoadedBookingForModify {
  if (!booking) throw new ApiError("Booking not found", 404);
  if (booking.memberId !== actorId && role !== "ADMIN") {
    throw new ApiError("Forbidden", 403);
  }
  if (!canModifyBookingStatusForRole(booking.status, role)) {
    throw new ApiError(
      "This booking cannot be modified in its current status",
      400,
    );
  }
}

/**
 * Bookings converted from (or held for) a public/school booking request keep
 * an officer-negotiated price that was flat-split across the guest rows; the
 * quote's per-tier rates are not persisted on the booking. Every standard
 * edit path reprices the whole booking at current season rates, which would
 * silently replace the negotiated basis — a one-student addition can swing
 * the total by the full quote-vs-season delta (#1032) — so those paths
 * refuse instead and direct the admin to the booking-request re-quote /
 * re-price flow.
 */
export async function isQuotePricedBooking(
  db: Prisma.TransactionClient,
  bookingId: string,
): Promise<boolean> {
  const request = await db.bookingRequest.findFirst({
    where: {
      OR: [{ convertedBookingId: bookingId }, { heldBookingId: bookingId }],
    },
    select: { id: true },
  });
  return Boolean(request);
}

export const QUOTE_PRICED_EDIT_BLOCK_MESSAGE =
  "This booking keeps a negotiated booking-request price, so standard edits are disabled — they would reprice every guest at season rates. Re-price or issue a revised quote from its booking request instead.";

/**
 * True when this booking was created from an authenticated member whole-lodge
 * request (#2263) — `requestedByMemberId` set and `exclusivityRequested` — as
 * opposed to a public or SCHOOL booking request. Mirrors
 * `isMemberWholeLodgeRequest` at the booking level.
 *
 * The #2337 placeholder→member link keys on this, NOT on `Booking.wholeLodgeHold`
 * alone: a school whole-lodge booking ALSO carries `wholeLodgeHold` (the admin
 * capacity action), and its non-member student rows would pass the placeholder
 * gate — so re-rating one at a member rate would silently corrupt the school's
 * flat-split negotiated price. Member-origin is the fence that keeps the re-rate
 * to the one booking class whose placeholders were always meant to re-rate.
 *
 * Every member whole-lodge booking is also "quote-priced" (its placeholders were
 * flat-split at approval), so `isQuotePricedBooking` returns true for it and the
 * standard structural-edit block would refuse the link; the apply/quote paths
 * exempt a member-whole-lodge link-only request from that block for exactly this
 * reason.
 */
export async function isMemberWholeLodgeBooking(
  db: Prisma.TransactionClient,
  bookingId: string,
): Promise<boolean> {
  const request = await db.bookingRequest.findFirst({
    where: {
      OR: [{ convertedBookingId: bookingId }, { heldBookingId: bookingId }],
      requestedByMemberId: { not: null },
      exclusivityRequested: true,
    },
    select: { id: true },
  });
  return Boolean(request);
}

export async function assertBookingNotQuotePriced(
  db: Prisma.TransactionClient,
  bookingId: string,
): Promise<void> {
  if (await isQuotePricedBooking(db, bookingId)) {
    throw new ApiError(QUOTE_PRICED_EDIT_BLOCK_MESSAGE, 400);
  }
}
