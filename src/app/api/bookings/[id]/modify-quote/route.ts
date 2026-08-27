import { NextRequest, NextResponse } from "next/server";
import type { AgeTier } from "@prisma/client";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import { buildShiftPreviewResponse } from "@/lib/booking-shift-preview";
import { getDefaultLodgeId, lodgeNullTolerantScope } from "@/lib/lodges";
import { getLodgeCapacity } from "@/lib/lodge-capacity";
import {
  getStayNights,
  type SeasonRateData,
} from "@/lib/pricing";
import {
  resolveGuestRateMembershipTypes,
  assertMembershipTypeBookingAllowed,
  getMembershipTypeBookingPolicyErrorBody,
  MembershipTypeBookingPolicyError,
  priceBookingGuestsWithMembershipTypePolicy,
  resolveOtherLodgeRateEligibleGuestIds,
} from "@/lib/membership-type-policy";
import {
  groupDiscountEditNotice,
  toEditTimeGroupDiscountConfig,
  toSeasonRateData,
} from "@/lib/policies/booking-route-decisions";
import { calculateChangeFee } from "@/lib/change-fee";
import {
  daysUntilDate,
  loadCancellationPolicy,
} from "@/lib/cancellation";
import { parseJsonRequestBody } from "@/lib/api-json";
import { ApiError } from "@/lib/api-error";
import {
  assertOtherLodgeExists,
  OTHER_LODGE_RATE_IN_PROGRESS_MESSAGE,
  requestCarriesOtherLodgeElection,
  requestIsOtherLodgeRateElectionOnly,
  resolveOtherLodgeRateElection,
  type OtherLodgeRateElection,
} from "@/lib/booking-other-lodge-rate";
import {
  aggregatePolicyExceptionViolations,
  type AggregatedPolicyExceptions,
} from "@/lib/booking-policy-exceptions";
import type { MinimumStayViolation } from "@/lib/booking-policies";
import {
  assertCheckInClearsXeroLockDate,
  assertDateEditClearsXeroLockDate,
  getXeroLockGuardErrorResponse,
} from "@/lib/xero-period-lock-guard";
import {
  validateAndCalculatePromoDiscount,
  validatePromoCodeFull,
} from "@/lib/promo";
import {
  describePromoCapCoverage,
  type PromoCoverageNotice,
} from "@/lib/promo-cap-coverage";
import {
  modifyQuoteSchema,
  OVERRIDE_DATE_ONLY_QUOTE_FIELDS,
  type NormalizedAddGuest,
} from "@/lib/booking-modify-quote-request";
import {
  assertLinkedBookingMembersCanBeBooked,
  BookingGuestValidationError,
  getBookingGuestValidationErrorResponse,
  normalizeBookingGuestInputs,
  resolveLinkedBookingMembersWithBoundary,
} from "@/lib/booking-guests";
import {
  loadMemberGuestAddPolicy,
  markCrossFamilyGuestsOnBooking,
  markCrossFamilyMemberGuests,
} from "@/lib/member-guest-add-policy";
import { isOperationallyPresentConsent } from "@/lib/member-guest-consent";
import {
  applyMemberGuestPartyProbeThrottle,
  createMemberGuestAddThrottleLedger,
  handleMemberGuestAddRefusal,
  memberGuestAddThrottleHook,
  MemberGuestAddThrottledError,
  startMemberGuestRefusalClock,
} from "@/lib/member-guest-probe-guard";
import { findUnpaidMemberGuestNames } from "@/lib/booking-member-guest-subscriptions";
import { resolveSubscriptionLockoutMode } from "@/lib/member-subscription-eligibility";
import {
  buildPaidUpAdultRefusalBody,
  evaluateNonMemberPricingRequirements,
} from "@/lib/subscription-lockout-enforcement";
import { BookingGuestStayRangeValidationError } from "@/lib/booking-guest-stay-range-input";
import {
  resolveModificationStayRanges,
  type LiveGuestStayRow,
  type ResolvedModificationStayRanges,
  type StayRangeDeltaInput,
} from "@/lib/booking-modification-stay-ranges";
import {
  canModifyBookingStatusForRole,
  getBookingEditPolicy,
  usesActiveBookingEditLifecycle,
} from "@/lib/booking-edit-policy";
import { clubTime } from "@/lib/club-time/server";
import { dateOnlyInstantOf } from "@/lib/club-time";
import {
  calculateModificationSettlementOptions,
  GUEST_MEMBER_LINK_IN_PROGRESS_MESSAGE,
  lockedNightPricesForGuest,
  resolveGuestMemberLinks,
  resolveGuestNameUpdates,
  isMemberWholeLodgeBooking,
  isQuotePricedBooking,
  QUOTE_PRICED_EDIT_BLOCK_MESSAGE,
  resolvePartnerSharedCapacity,
  resolvePromoBeneficiarySelection,
} from "@/lib/booking-modify";
import {
  buildInProgressGuestRangePlan,
  type BookingEditGuestRangePlan,
} from "@/lib/booking-edit-guest-ranges";
import { formatDateOnly, parseDateOnly } from "@/lib/date-only";
import { seasonYearOfStoredDate } from "@/lib/financial-year";
import { storedDateOnly } from "@/lib/stored-calendar-day";
import { bookingManagementAuthorizationRole } from "@/lib/admin-permissions";
import {
  findBookingMemberNightConflicts,
  getBookingMemberNightConflictResponse,
} from "@/lib/booking-member-night-conflicts";
import { getMemberCreditBalance } from "@/lib/member-credit";
import logger from "@/lib/logger";

type PromoRedemptionWithTargets = {
  promoCode: {
    assignedMembersOnlyOwnNights?: boolean | null;
    assignments: Array<{ memberId: string }>;
    lodges?: Array<{ lodgeId: string }>;
  };
  guestTargets?: Array<{ bookingGuestId: string }>;
};

function promoRequiresStoredGuestTargets(redemption: PromoRedemptionWithTargets) {
  return (
    redemption.promoCode.assignments.length > 0 &&
    redemption.promoCode.assignedMembersOnlyOwnNights === false
  );
}

function selectedIndexesForStoredGuestTargets(
  redemption: PromoRedemptionWithTargets,
  guestNightRates: Array<{ bookingGuestId?: string | null }>
) {
  if (!promoRequiresStoredGuestTargets(redemption)) {
    return undefined;
  }

  const targetIds = new Set((redemption.guestTargets ?? []).map((target) => target.bookingGuestId));
  if (targetIds.size === 0) {
    return guestNightRates.map((_, index) => index);
  }

  return guestNightRates
    .map((guest, index) => (guest.bookingGuestId && targetIds.has(guest.bookingGuestId) ? index : -1))
    .filter((index) => index >= 0);
}

/*
  #2563: this preview holds NO stay-range arithmetic of its own.

  It used to. #2526 extracted the canonical resolution to
  `src/lib/booking-modification-stay-ranges.ts`
  (`resolveModificationStayRanges` / `deltaHasStayRangeInputs`) and routed
  `resolveTargetDates` and `prepareGuestPlan` through it, but this route kept a
  local copy — its own `hasStayRangeInput` / `hasStayRangeValue` / `minDate` /
  `maxDate`, its own envelope-expansion loop and its own per-guest pass — held in
  step with the apply path only by inspection. That copy is gone rather than
  fenced behind parity tests: the preview is money-adjacent (a wrong resolution
  quotes a wrong price), and two implementations of one rule is exactly what let
  the policy-exception workflow freeze a party the planner never built.

  The preview now makes the SAME TWO CALLS the apply path makes, in the same
  order, so the answer is identical by construction:

   1. the envelope call, mirroring `resolveTargetDates` — in range-input mode the
      effective envelope is the UNION of every resolved range (so a stored range
      can pin it open wider than the member asked for, #713, and a shortened
      check-out that another guest still spans is not honoured); with no range
      inputs anywhere it is the requested envelope untouched;
   2. the per-guest call after the in-progress clamp, mirroring
      `prepareGuestPlan`, which passes the CLAMPED envelope as `requested` so an
      in-progress edit resolves against the envelope actually being applied.

  WHY THE SECOND CALL CANNOT MOVE THE ENVELOPE THE FIRST ONE SETTLED. This is the
  load-bearing argument for making two calls at all: the route prices and
  capacity-checks `newCheckIn`/`newCheckOut` from call 1, while call 2 normalises
  every guest against an envelope it re-derives internally. If those two differed,
  guests would be priced on nights outside the quoted envelope.

  Call 2 re-runs the resolver's own envelope pass over the SAME delta and the same
  guests, and every term of that min/max is identical to call 1's bar one:

   - an entry that carries any dates (a start and an end, or an explicit night
     set) resolves envelope-INDEPENDENTLY — `normalizeGuestStayRange` reads its
     `booking` argument only to default an entry that supplies no dates at all;
   - a remaining guest with no range entry contributes its STORED range, falling
     back to the ORIGINAL booking bounds, which does not depend on `requested`
     either. READ THAT TWICE: it does NOT contribute the requested bounds, which
     is why a shortened check-out that another guest's stored range still spans
     comes back pinned open rather than honoured;
   - the one term that does depend on `requested` is a range-less ADDED guest,
     which contributes exactly the `requested` bounds.

  So call 2's envelope is `min/max(fixed terms, requested)` where `requested` is
  call 1's answer — and call 1's answer is already the min/max over those same
  fixed terms, so it dominates them and the second min/max returns it unchanged.
  With no range inputs the resolver skips the pass entirely and returns
  `requested` verbatim. Either way the pass is idempotent, and `prepareGuestPlan`
  rests on the same property.

  TWO PRECONDITIONS, because the argument fails without them:

   a. `requested` for call 2 must be call 1's answer. The in-progress branch is
      the one place it is not — `newCheckIn` is clamped back to `booking.checkIn`
      — and there the argument rests entirely on the in-progress check-in guard
      below, which 400s any delta whose RESOLVED check-in moved off the stored
      day. That guard makes the clamp a no-op by the time call 2 runs. Relax it
      and a range-less added guest can be handed an envelope reaching back to the
      stored check-in, wider than the one being priced.
   b. Nothing between the two calls may SHRINK the envelope. A downward clamp of
      `newCheckOut` would leave call 2's min/max dominated by the stored and
      explicit ranges instead, so call 2 would resolve against a wider envelope
      than the quote prices.

  (a) is pinned: `modify-quote-planner-stay-range-parity` drives a mid-stay edit
  through this route and the planner together, and asserts the guard's own 400.
  (b) cannot be pinned by a test — a test would have to introduce the shrinking
  clamp to observe it — so it is a standing constraint on whoever next edits the
  lines between the two calls, not a covered case. Treat this paragraph as the
  design note that has to be re-derived if that code moves.

  The invariant is that preview and save resolve ranges identically (see
  `GUEST_MEMBER_LINK_IN_PROGRESS_MESSAGE` on the same theme), and it is now
  proven by test rather than by comment. `modify-quote-planner-stay-range-parity`
  drives this route, the real `resolveTargetDates` -> `prepareGuestPlan` pair and
  the officer-facing freeze over one delta and compares the envelope, every
  guest's nights, the capacity input, the adult-supervision input, the refusal
  wording (with its member-facing "Guest N" number) and the cents; its
  source-shape suite is what keeps a second copy from growing back here.
*/

type PreviewStayRangeResolution<Guest extends LiveGuestStayRow> =
  | { ok: true; ranges: ResolvedModificationStayRanges<Guest> }
  | { ok: false; response: NextResponse };

/**
 * The route boundary for the shared resolver (#2563).
 *
 * The resolver raises a STRUCTURED `BookingGuestStayRangeValidationError` — the
 * same error the apply path maps to `ApiError(message, 400)` in
 * `resolveStayRangesOrApiError` — and this adapter maps that one error type onto
 * this route's 400 body. The message is the resolver's, verbatim, so the member
 * reads the same refusal (including the same "Guest N: ..." index) from the
 * preview and from the save; the presentation lives here and the business rule
 * lives in the resolver, in one place.
 */
function resolveStayRangesForPreview<Guest extends LiveGuestStayRow>(args: {
  booking: { checkIn: Date; checkOut: Date };
  guests: ReadonlyArray<Guest>;
  input: StayRangeDeltaInput;
  requested: { checkIn: Date; checkOut: Date };
}): PreviewStayRangeResolution<Guest> {
  try {
    return { ok: true, ranges: resolveModificationStayRanges(args) };
  } catch (error) {
    if (error instanceof BookingGuestStayRangeValidationError) {
      return {
        ok: false,
        response: NextResponse.json({ error: error.message }, { status: 400 }),
      };
    }
    throw error;
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // #2388: taken at the top so the collapsed-refusal timing floor covers the
  // whole request.
  const startedAt = startMemberGuestRefusalClock();
  // HIGH-1 (privacy re-review of MG3 #2308). This route has TWO places that can
  // spend the #2388 throttle — the boundary hook when the request names a
  // beyond-family member, and the whole-party charge when the booking merely
  // carries one — and on a request that does both they are one attempt. The
  // ledger is what makes them share a single unit.
  const memberGuestThrottleLedger = createMemberGuestAddThrottleLedger();
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }
  // Issue #1313 (option A2): a Booking Officer (bookings:edit) resolves to ADMIN
  // so the quote preview mirrors the admin-on-behalf modify they will perform —
  // every isAdmin branch below (skip member-night authorization, locked-period,
  // unpaid-subscription, and minimum-stay checks) applies to them identically to
  // a Full Admin. Full Admin already resolves to ADMIN; member/read-only stay USER.
  const actorRole = bookingManagementAuthorizationRole(session.user);
  const isAdmin = actorRole === "ADMIN";

  const { id: bookingId } = await params;

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      // Per-night sets (issue #713): preserve unedited guests' gaps in the
      // quote. Deterministic order (#2266 MED-4): must match the apply path's
      // fetch so preview and apply price and target the same guest order.
      guests: {
        include: { nights: { select: { stayDate: true, priceCents: true } } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
      payment: true,
      promoRedemption: {
        include: {
          guestTargets: { select: { bookingGuestId: true } },
          promoCode: {
            include: {
              assignments: { select: { memberId: true } },
              lodges: { select: { lodgeId: true } },
            },
          },
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

  if (!canModifyBookingStatusForRole(booking.status, actorRole)) {
    return NextResponse.json(
      { error: "This booking cannot be modified in its current status" },
      { status: 400 }
    );
  }

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;

  const parsed = modifyQuoteSchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const {
    checkIn: newCheckInStr,
    checkOut: newCheckOutStr,
    addGuests,
    removeGuestIds,
    guestStayRanges,
    guestUpdates,
    linkGuestToMember,
    otherLodgeId: requestedOtherLodgeId,
    otherLodgeMemberGuestIds,
    promoCode: newPromoCode,
    promoGuestIds,
    promoAddedGuestIndexes,
    removePromoCode,
    applyCreditCents,
    pricingMode,
    confirmOverCapacity,
  } = parsed.data;

  // Issue #1668: admin-only date override. Gate the flags, then compute the
  // edit policy WITH the override so its mode is "admin-override" and every
  // downstream guard (in-progress clamp, "NZ today locked", change-fee gate)
  // falls out on its own — the same code path the apply services take, so the
  // preview mirrors apply without a parallel branch.
  const overrideFlagsPresent =
    parsed.data.adminOverride !== undefined ||
    pricingMode !== undefined ||
    confirmOverCapacity !== undefined;
  if (overrideFlagsPresent && !isAdmin) {
    return NextResponse.json(
      { error: "Admin override is not available for this account" },
      { status: 403 },
    );
  }
  // #1746: partner-shared placement is admin-initiated by owner decision.
  if (parsed.data.partnerSharedGuests?.length && !isAdmin) {
    return NextResponse.json(
      { error: "Partner-shared placement is not available for this account" },
      { status: 403 },
    );
  }
  const partnerSharedGuests = isAdmin ? (parsed.data.partnerSharedGuests ?? []) : [];
  const adminOverride = isAdmin && Boolean(parsed.data.adminOverride);
  if (adminOverride && !pricingMode) {
    return NextResponse.json(
      { error: "Choose a pricing mode for the admin override" },
      { status: 400 },
    );
  }
  if (
    !adminOverride &&
    (pricingMode !== undefined || confirmOverCapacity !== undefined)
  ) {
    return NextResponse.json(
      { error: "adminOverride is required for pricingMode/confirmOverCapacity" },
      { status: 400 },
    );
  }
  if (
    adminOverride &&
    (OVERRIDE_DATE_ONLY_QUOTE_FIELDS.some((field) => {
      const value = parsed.data[field];
      return Array.isArray(value) ? value.length > 0 : Boolean(value);
    }) ||
      // #2266: checked explicitly — `Boolean(0)` is false, so a credit
      // election of 0 cents would otherwise slip past the date-only contract.
      applyCreditCents !== undefined ||
      // Same trap, same fix: `otherLodgeId: null` CLEARS the election and is
      // falsy, so the list membership above would let it through a date-only
      // override.
      requestedOtherLodgeId !== undefined)
  ) {
    return NextResponse.json(
      { error: "Admin override edits change dates only" },
      { status: 400 },
    );
  }

  // #3123 — the CLUB's day, from its persisted zone (`INV-CONFIG-002`),
  // resolved ONCE for this whole quote. Five decisions below read it: the edit
  // policy here, the late-notice change fee's two `daysUntilDate` operands, the
  // promotion's validity window, and the reduction refund's settlement tier.
  // They are the same question, so they must not be able to answer it
  // differently — a quote whose fee said one day and whose refund tier said
  // another would be internally inconsistent across club midnight.
  const todayAtClub = (await clubTime()).today();
  const editPolicy = getBookingEditPolicy({
    status: booking.status,
    role: actorRole,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    adminOverride,
    today: dateOnlyInstantOf(todayAtClub),
  });
  if (!editPolicy.canModify) {
    return NextResponse.json(
      { error: editPolicy.reason ?? "This booking cannot be modified" },
      { status: 400 }
    );
  }

  // Shift preview (issue #1668): a pure translation quote. Validate parity and
  // derive the missing bound identically to the apply path, translate the guest
  // ranges by the same day-delta, run the capacity check, and echo the stored
  // money with zero deltas so the UI's preview matches what apply will write.
  if (adminOverride && pricingMode === "shift") {
    // Quote-priced bookings are blocked here too (#1032): the shift apply path
    // refuses them (assertBookingNotQuotePriced), so the preview must not show
    // a clean $0 quote it cannot deliver.
    if (await isQuotePricedBooking(prisma, bookingId)) {
      return NextResponse.json(
        { error: QUOTE_PRICED_EDIT_BLOCK_MESSAGE },
        { status: 400 },
      );
    }
    return buildShiftPreviewResponse({
      // The quote's one club day, so the shift preview's person-night guard
      // answers on the same day as everything above it.
      todayAtClub,
      booking,
      bookingId,
      actorMemberId: session.user.id,
      actorRole,
      newCheckInStr,
      newCheckOutStr,
    });
  }
  // Xero lock-date guard: the preview rejects a locked-period check-in with
  // the same 409/503 the apply services throw, instead of showing a quote
  // that apply cannot deliver. The scopes mirror apply exactly (see
  // xero-period-lock-guard): the recalculate OVERRIDE keeps the deliberately
  // conservative always-check (#1697, re-affirmed on #1718; only recalculate
  // reaches here — shift returned above and stays unguarded, it writes no
  // Xero documents), while an ORDINARY edit gets the narrow guard (#1729)
  // that fires only when apply would queue the check-in-dated invoice update,
  // with member-appropriate error text for non-admin actors. Identity-only
  // previews carry no date fields and are never guarded.
  try {
    if (adminOverride) {
      await assertCheckInClearsXeroLockDate(
        newCheckInStr ? parseDateOnly(newCheckInStr) : booking.checkIn,
      );
    } else {
      await assertDateEditClearsXeroLockDate(
        booking,
        { checkIn: newCheckInStr, checkOut: newCheckOutStr },
        { audience: isAdmin ? "admin" : "member" },
      );
    }
  } catch (error) {
    const xeroLockGuardResponse = getXeroLockGuardErrorResponse(error);
    if (xeroLockGuardResponse) {
      return NextResponse.json(xeroLockGuardResponse.body, {
        status: xeroLockGuardResponse.status,
      });
    }
    throw error;
  }
  // Quote-priced bookings are blocked at preview time too (#1032) — except
  // for identity-only requests (#1099), which never touch the pricing engine
  // and therefore cannot disturb the negotiated basis.
  const requestedStructuralChange = Boolean(
    newCheckInStr ||
      newCheckOutStr ||
      addGuests?.length ||
      removeGuestIds?.length ||
      guestStayRanges?.length ||
      // #2337: a link re-rates a guest — structural, so the preview prices it
      // rather than echoing the stored totals.
      linkGuestToMember?.length ||
      // The other-lodge rate election re-rates guests for the same reason.
      requestedOtherLodgeId !== undefined ||
      otherLodgeMemberGuestIds !== undefined ||
      newPromoCode ||
      removePromoCode,
  );
  const requestIsIdentityOnly =
    !requestedStructuralChange && Boolean(guestUpdates?.length);
  // #2266: a credit election with nothing structural is price-preserving by the
  // same argument as an identity-only name fix — the apply route only writes
  // Booking.creditElectionCents (#2265) and touches neither price nor capacity,
  // so the preview must echo the stored money rather than reprice at current
  // rates (a season-rate change would otherwise surface a phantom price diff).
  const requestIsCreditElectionOnly =
    !requestedStructuralChange &&
    !guestUpdates?.length &&
    applyCreditCents !== undefined;
  // #2337: mirror the apply path's member-link gate exactly. The member-ORIGIN
  // fence keeps a SCHOOL whole-lodge booking's students out of the re-rate, and a
  // member-whole-lodge link-only request is exempt from the quote-priced block
  // (its placeholders were flat-split at approval — the link is the sanctioned
  // re-rate). Preview and apply must agree on every gate or the panel shows a
  // quote the save then refuses.
  const hasLinks = Boolean(linkGuestToMember?.length);
  const memberWholeLodgeForLink = hasLinks
    ? await isMemberWholeLodgeBooking(prisma, bookingId)
    : false;
  if (hasLinks && !memberWholeLodgeForLink) {
    return NextResponse.json(
      {
        error:
          "Linking a placeholder to a member is only available on member whole-lodge bookings.",
      },
      { status: 400 },
    );
  }
  const requestIsMemberLinkExempt =
    hasLinks &&
    memberWholeLodgeForLink &&
    !(
      newCheckInStr ||
      newCheckOutStr ||
      addGuests?.length ||
      removeGuestIds?.length ||
      guestStayRanges?.length ||
      newPromoCode ||
      removePromoCode
    );
  /**
   * The other-lodge re-rate is exempt from the quote-priced edit block on the
   * same terms as the #2337 link, and for the same reason. The rule itself —
   * election-only, and which fields count as disturbing — lives in
   * `requestIsOtherLodgeRateElectionOnly`, which the SAVE path calls too.
   *
   * That sharing is a fix, not tidying. This list used to be written out here
   * and nowhere else: `modifyBookingBatch` had no other-lodge exemption at all,
   * so an election-only edit on a negotiated booking previewed 200 and saved
   * 400 (owner decision, 21 Aug 2026). Two hand-maintained lists drift; one
   * cannot. Only the officer check stays local to each caller.
   */
  const requestIsOtherLodgeRateExempt =
    isAdmin &&
    requestIsOtherLodgeRateElectionOnly({
      otherLodgeId: requestedOtherLodgeId,
      otherLodgeMemberGuestIds,
      checkIn: newCheckInStr,
      checkOut: newCheckOutStr,
      addGuests,
      removeGuestIds,
      guestStayRanges,
      promoCode: newPromoCode,
      removePromoCode,
    });
  const quotePriced = await isQuotePricedBooking(prisma, bookingId);
  if (
    !requestIsIdentityOnly &&
    !requestIsCreditElectionOnly &&
    !requestIsMemberLinkExempt &&
    !requestIsOtherLodgeRateExempt &&
    quotePriced
  ) {
    return NextResponse.json(
      { error: QUOTE_PRICED_EDIT_BLOCK_MESSAGE },
      { status: 400 },
    );
  }

  // #2337: the synchronous narrow gate (admin, whole-lodge, placeholder-only). It
  // shares the resolver the apply path uses, so a bad link is refused with the
  // same message before pricing runs.
  let guestMemberLinks: ReturnType<typeof resolveGuestMemberLinks> = [];
  try {
    guestMemberLinks = resolveGuestMemberLinks({
      booking,
      input: { linkGuestToMember, removeGuestIds, guestUpdates },
      role: actorRole,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
  const linkByGuestId = new Map(
    guestMemberLinks.map((link) => [link.guestId, link]),
  );

  // Other Lodges epic: the same resolver the apply path runs, so a refused tick
  // is refused here with the same message before pricing, and the effective
  // per-guest flag below is identical to the one the save will persist.
  // #2543 — resolved ONCE for this request. The member-guest refusal, the
  // paid-up-adult requirement, the pricing calls and (since #2978) the
  // other-lodge eligibility fence must all branch on the same answer: an admin
  // saving the lockout panel mid-request could otherwise have one of them
  // decide under one regime and another under the other, and this route
  // differences two pricing calls into the member's settlement delta. Hoisted
  // to here rather than resolved twice, which is what
  // `subscription-lockout-call-sites.test.ts` exists to catch.
  //
  // HOISTED FROM ~500 LINES BELOW BY #2978, AND THAT MOVED MORE THAN THE READ.
  // There are roughly fifteen early returns between here and where this used to
  // sit, so a preview that refuses at one of them now performs this settings
  // read where before it short-circuited first. Two consequences worth having in
  // the open: the read is cached but can reach Xero for the organisation's
  // accounting year when the Xero module is on, and — the reason the hoist is a
  // net improvement rather than a cost — it reseeds the financial-year cache
  // BEFORE the `seasonYearOfStoredDate(booking.checkIn)` calls below, so a cold
  // process at a club with a non-March year end no longer judges the season
  // against the March default.
  const subscriptionLockoutMode = await resolveSubscriptionLockoutMode();

  let otherLodgeElection: OtherLodgeRateElection;
  try {
    // #2978: who may be ticked is a RATE question, so it needs the season's
    // membership-type policies and the unpaid-subscription set. Resolved from
    // the BOOKING's own season rather than any new dates this edit proposes:
    // the edit panel decides which rows get a tick box from the stored booking,
    // so keying the fence to the same season is what keeps the screen and the
    // save from disagreeing. A date move across a season boundary can therefore
    // judge eligibility on the old season - accepted, because the alternative
    // is a tick the officer can see and cannot save.
    const otherLodgeInput = {
      otherLodgeId: requestedOtherLodgeId,
      otherLodgeMemberGuestIds,
    };
    // Only when the request actually mentions the rate, and only for an actor
    // who could act on the answer. Almost no modification mentions it, and
    // resolving eligibility costs several reads — which an ordinary member could
    // otherwise force on every request, since `resolveOtherLodgeRateElection`
    // does not raise its 403 until after this. Nothing leaks either way (the set
    // never reaches the response on that path); this is about not doing the work.
    const otherLodgeEligibleGuestIds =
      isAdmin && requestCarriesOtherLodgeElection(otherLodgeInput)
        ? await resolveOtherLodgeRateEligibleGuestIds(prisma, {
            seasonYear: seasonYearOfStoredDate(booking.checkIn),
            guests: booking.guests,
          })
        : new Set<string>();
    otherLodgeElection = resolveOtherLodgeRateElection({
      booking,
      input: otherLodgeInput,
      role: actorRole,
      eligibleGuestIds: otherLodgeEligibleGuestIds,
    });
    await assertOtherLodgeExists(prisma, otherLodgeElection.otherLodgeId);
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }

  // #2266: the member's live credit balance rides every non-shift preview, the
  // same field the create-flow quote returns (api/bookings/quote/route.ts) —
  // the edit panel's credit card keys off it. The BOOKING OWNER's balance, not
  // the actor's: an admin editing on behalf must see the member's credit.
  const availableCreditCents = await getMemberCreditBalance(booking.memberId);

  let normalizedAddGuests: NormalizedAddGuest[] | undefined = addGuests;
  let guestNameUpdates: ReturnType<typeof resolveGuestNameUpdates> = [];

  try {
    guestNameUpdates = resolveGuestNameUpdates({
      booking,
      input: { guestUpdates, removeGuestIds },
      // Quoted bookings rename placeholder students even after payment.
      allowWhenFullyPaid: quotePriced,
      // Preview mirrors the server gate (#1386): identity-only typo fixes on a
      // fully-paid booking are allowed; swaps are rejected the same way.
      allowTypoFixWhenFullyPaid: requestIsIdentityOnly,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }

  // Identity-only preview (#1099): a name fix never reprices, so the quote is
  // the stored state with zero deltas — no pricing engine, no capacity check,
  // safe for quoted and legacy bookings alike. #2266 routes a credit-only
  // election through the same echo for the same reason.
  if (requestIsIdentityOnly || requestIsCreditElectionOnly) {
    return NextResponse.json({
      availableCreditCents,
      newTotalPriceCents: booking.totalPriceCents,
      newDiscountCents: booking.discountCents,
      newPromoAdjustmentCents: booking.promoAdjustmentCents,
      newFinalPriceCents: booking.finalPriceCents,
      priceDiffCents: 0,
      changeFeeCents: 0,
      netChargeCents: 0,
      settlementOptions: null,
      capacityAvailable: true,
      minimumStayValid: true,
      minimumStayViolations: [],
      exceptionReview: { violations: [], capacityMode: null },
      promoStillValid: true,
      // An identity-only edit re-prices nothing, so no cap is re-run.
      promoCoverage: null,
      promoValidation: null,
      itemizedChanges:
        guestNameUpdates.length > 0
          ? [
              {
                label:
                  guestNameUpdates.length === 1
                    ? "Guest name update"
                    : "Guest name updates",
                amountCents: 0,
              },
            ]
          : [],
    });
  }

  // "+ Add Member Guest" (epic #2305, MG2 #2307). A PREVIEW: it writes no rows, so
  // it plans no consent and notifies nobody, but it must resolve a cross-family
  // member or the quote it shows disagrees with what the apply path will charge.
  const memberGuestPolicy = await loadMemberGuestAddPolicy();

  try {
    const { members: linkedMembers, boundary } =
      await resolveLinkedBookingMembersWithBoundary(
        prisma,
        booking.memberId,
        [
          ...(addGuests ?? []).map((guest) => guest.memberId),
          // #2337: linked members resolve through the same eligibility/boundary
          // path as an added member guest, so the preview refuses an ineligible
          // link exactly as the save will.
          ...guestMemberLinks.map((link) => link.memberId),
        ],
        {
          skipAuthorization: isAdmin,
          memberGuestWideningEnabled: memberGuestPolicy.wideningEnabled,
          // #2388: per-acting-member throttling, counted only when the attempt
          // names a beyond-family member. This route is a side-effect-free
          // PREVIEW, which puts it in the same class as `/api/bookings/quote` —
          // the cheap surface a probe run would actually use. Spent BEFORE the
          // member records are read (H1) so a real member and an id with nobody
          // behind it get the same answer once the budget is gone.
          //
          // This hook covers the ADD half only: with an empty `addGuests` there
          // is nothing to resolve and it never runs. The other half — a preview
          // over a booking that already carries a beyond-family member guest —
          // is charged by `applyMemberGuestPartyProbeThrottle` further down,
          // against the same ledger (HIGH-1).
          onBoundaryResolved: memberGuestAddThrottleHook({
            request,
            actorMemberId: session.user.id,
            skipAuthorization: isAdmin,
            ledger: memberGuestThrottleLedger,
          }),
        }
      );

    await assertLinkedBookingMembersCanBeBooked(
      prisma,
      linkedMembers,
      session.user.id,
      {
        actorRole,
        onBehalfOfMemberId: isAdmin ? booking.memberId : null,
        // D-8: neutral refusal for a blocked cross-family member.
        crossFamilyMemberIds: boundary.beyondFamilyMemberIds,
      }
    );
    normalizedAddGuests = addGuests
      ? markCrossFamilyMemberGuests(
          normalizeBookingGuestInputs(addGuests, linkedMembers).map((guest, index) => ({
            ...guest,
            stayStart: addGuests[index]?.stayStart ?? null,
            stayEnd: addGuests[index]?.stayEnd ?? null,
            nights: addGuests[index]?.nights ?? null,
          })),
          boundary,
        )
      : undefined;
  } catch (error) {
    if (error instanceof MemberGuestAddThrottledError) return error.response;
    if (error instanceof BookingGuestValidationError) {
      await handleMemberGuestAddRefusal({
        request,
        actorMemberId: session.user.id,
        error,
        route: "bookings/modify-quote",
        startedAt,
        // Two conditional charge points on this route, so no refusal can honestly
        // assert either "already charged" or "charge now" — the ledger decides.
        throttle: "CHARGE_IF_UNCHARGED",
        ledger: memberGuestThrottleLedger,
        skipAuthorization: isAdmin,
      });
      return NextResponse.json(
        getBookingGuestValidationErrorResponse(error),
        { status: error.status }
      );
    }
    throw error;
  }

  // Determine new dates
  const requestedCheckIn = newCheckInStr ? parseDateOnly(newCheckInStr) : booking.checkIn;
  const requestedCheckOut = newCheckOutStr ? parseDateOnly(newCheckOutStr) : booking.checkOut;
  if (
    Number.isNaN(requestedCheckIn.getTime()) ||
    Number.isNaN(requestedCheckOut.getTime())
  ) {
    return NextResponse.json(
      { error: "Invalid booking dates" },
      { status: 400 }
    );
  }

  // The delta this request asks for, in the shape the shared resolver reads. The
  // ADD guests are the NORMALIZED ones (`normalizeBookingGuestInputs` preserves
  // input order and length), so the range entries the resolver sees are the same
  // objects the pricing rows are built from.
  const stayRangeDelta: StayRangeDeltaInput = {
    checkIn: newCheckInStr,
    checkOut: newCheckOutStr,
    addGuests: normalizedAddGuests,
    removeGuestIds,
    guestStayRanges,
  };

  // Pass 1 — the effective envelope, the SAME call `resolveTargetDates` makes on
  // the apply path (#2563). `requested` carries the dates this route already
  // parsed and NaN-checked above, so the resolver never re-parses them.
  const envelopeRanges = resolveStayRangesForPreview({
    booking: { checkIn: booking.checkIn, checkOut: booking.checkOut },
    guests: booking.guests,
    input: stayRangeDelta,
    requested: { checkIn: requestedCheckIn, checkOut: requestedCheckOut },
  });
  if (!envelopeRanges.ok) return envelopeRanges.response;
  const finalRequestedCheckIn = envelopeRanges.ranges.checkIn;
  const finalRequestedCheckOut = envelopeRanges.ranges.checkOut;

  const isInProgressEdit = editPolicy.mode === "in-progress";
  const bookingCheckIn = storedDateOnly(booking.checkIn);
  const editableFrom = editPolicy.editableFrom;

  if (isInProgressEdit) {
    if (
      formatDateOnly(storedDateOnly(finalRequestedCheckIn)) !==
        formatDateOnly(bookingCheckIn)
    ) {
      return NextResponse.json(
        { error: "Check-in cannot be changed for an in-progress booking" },
        { status: 400 }
      );
    }
    if (editableFrom && storedDateOnly(finalRequestedCheckOut) < editableFrom) {
      return NextResponse.json(
        { error: "NZ today and earlier are locked for self-service changes" },
        { status: 400 }
      );
    }
    if (newPromoCode || removePromoCode) {
      return NextResponse.json(
        { error: "Promo code changes are not available for in-progress bookings" },
        { status: 400 }
      );
    }
    // #2337: mirror the apply path's mid-stay link refusal exactly, so the
    // preview shows the officer the refusal instead of a phantom $0 quote (a
    // mid-stay link never reaches the in-progress pricing plan). The remove-and-
    // re-add path settles correctly mid-stay; admin override is date-only and
    // rejects links, so it is not the escape hatch.
    if (linkGuestToMember?.length) {
      return NextResponse.json(
        { error: GUEST_MEMBER_LINK_IN_PROGRESS_MESSAGE },
        { status: 400 }
      );
    }
    // Other Lodges epic: the same mid-stay refusal, mirrored from the apply path
    // so preview and save agree — the in-progress plan prices the stored rows,
    // so an election here would preview a $0 re-rate.
    if (
      requestedOtherLodgeId !== undefined ||
      otherLodgeMemberGuestIds !== undefined
    ) {
      return NextResponse.json(
        { error: OTHER_LODGE_RATE_IN_PROGRESS_MESSAGE },
        { status: 400 }
      );
    }
    // TRANSCRIBED, not imported: `booking-date-modification-frame-parity.test.ts`
    // → `previewRefusesSelfServiceWindow` copies this gate, so nothing here can
    // fail that file. Change this and update the oracle in the same commit (#3088).
  } else if (
    !isAdmin &&
    storedDateOnly(finalRequestedCheckIn) <= editPolicy.today
  ) {
    return NextResponse.json(
      { error: "NZ today and earlier are locked for self-service changes" },
      { status: 400 }
    );
  }

  const newCheckIn = isInProgressEdit ? booking.checkIn : finalRequestedCheckIn;
  const newCheckOut = finalRequestedCheckOut;
  const skipBookingLifecycleRules =
    isAdmin &&
    !usesActiveBookingEditLifecycle(booking.status);

  if (newCheckOut <= newCheckIn) {
    return NextResponse.json(
      { error: "Check-out must be after check-in" },
      { status: 400 }
    );
  }
  const targetDatesChanged =
    newCheckIn.getTime() !== new Date(booking.checkIn).getTime() ||
    newCheckOut.getTime() !== new Date(booking.checkOut).getTime();

  // Determine new guest list
  const removeSet = new Set(removeGuestIds ?? []);
  const remainingGuests = booking.guests.filter((g) => !removeSet.has(g.id));
  const removedGuests = booking.guests.filter((g) => removeSet.has(g.id));

  if (
    !isInProgressEdit &&
    remainingGuests.length === 0 &&
    (!normalizedAddGuests || normalizedAddGuests.length === 0)
  ) {
    return NextResponse.json(
      { error: "Booking must have at least one guest" },
      { status: 400 }
    );
  }

  // Pass 2 — every guest's final range, the SAME call `prepareGuestPlan` makes on
  // the apply path (#2563), with the post-clamp envelope as `requested` so an
  // in-progress edit resolves against the envelope actually being applied.
  const guestRanges = resolveStayRangesForPreview({
    booking: { checkIn: booking.checkIn, checkOut: booking.checkOut },
    guests: remainingGuests,
    input: stayRangeDelta,
    requested: { checkIn: newCheckIn, checkOut: newCheckOut },
  });
  if (!guestRanges.ok) return guestRanges.response;
  const proposedRemainingGuests = guestRanges.ranges.remaining;
  // Each field assigned explicitly rather than spread, exactly as
  // `prepareGuestPlan` does: `normalizedAddGuests` carries its own raw `nights`
  // (date STRINGS from the request payload) and the resolved range carries the
  // normalised `Date[]`, so a spread leaves the property typed as the union of the
  // two and the pricing input rejects it.
  //
  // The positional join is sound because `stayRangeDelta.addGuests` IS
  // `normalizedAddGuests` — the same array instance — and the resolver builds
  // `added` with a plain `.map` over it, so the two are the same length in the
  // same order by construction. Re-order, filter or re-sort either side and that
  // stops being true: `modify-quote-planner-stay-range-parity` carries a
  // two-added-guest case with different ranges specifically so a mis-ordered join
  // fails rather than silently pricing one added guest on the other's nights.
  const normalizedAddGuestsWithRanges = normalizedAddGuests
    ? normalizedAddGuests.map((guest, index) => ({
        ...guest,
        stayStart: guestRanges.ranges.added[index].stayStart,
        stayEnd: guestRanges.ranges.added[index].stayEnd,
        nights: guestRanges.ranges.added[index].nights,
      }))
    : undefined;

  const proposedGuestRows = [
    ...proposedRemainingGuests.map((entry) => {
      const link = linkByGuestId.get(entry.guest.id);
      // Other Lodges epic: the flag this guest will carry once saved — the
      // election's end state when this request carried one, the stored value
      // otherwise, so an ordinary date change still prices an already-recognised
      // other-club guest at the member rate.
      const otherLodgeMember = otherLodgeElection.flaggedGuestIds.has(
        entry.guest.id,
      );
      const otherLodgeRateChanged = otherLodgeElection.repriceGuestIds.has(
        entry.guest.id,
      );
      return {
        bookingGuestId: entry.guest.id,
        ageTier: entry.guest.ageTier as AgeTier,
        // #2337: preview the linked placeholder with the MEMBER identity so the
        // quote prices it at the member rate — matching what the save writes.
        isMember: link ? true : entry.guest.isMember,
        memberId: link ? link.memberId : (entry.guest.memberId ?? null),
        otherLodgeMember,
        stayStart: entry.stayStart,
        stayEnd: entry.stayEnd,
        nights: entry.nights,
        // Preview with the same locked booked-night prices the mutating
        // endpoints charge (#1036) — but a linked placeholder CLEARS them, exactly
        // as the apply path does, so the preview's re-rate delta equals the save's.
        //
        // A guest whose other-lodge tick CHANGED clears them for the same reason,
        // in both directions: ticked, the locked non-member prices would pin every
        // night and the member rate would never apply; unticked, the locked member
        // prices would pin it the other way and the rate would never come back.
        lockedNightPrices:
          link || otherLodgeRateChanged
            ? []
            : lockedNightPricesForGuest(entry.guest),
      };
    }),
    ...(normalizedAddGuestsWithRanges ?? []).map((g) => ({
      bookingGuestId: null,
      ageTier: g.ageTier as AgeTier,
      isMember: g.isMember,
      memberId: g.memberId ?? null,
      stayStart: g.stayStart,
      stayEnd: g.stayEnd,
      nights: g.nights,
      // D-8 (MG2 #2307): this list is rebuilt field by field, so the marker has
      // to be carried across explicitly or the person-night guard below would
      // answer a cross-family member's occupancy in full detail.
      crossFamilyMemberGuest: g.crossFamilyMemberGuest,
    })),
  ];

  // C1 (privacy review of MG3 #2308). Re-derive the marker over EVERY
  // member-linked guest on the proposed booking, not just the ones being added.
  // Without this, a cross-family member guest added on an earlier request is
  // unmarked forever, and this route — a side-effect-free preview reachable with
  // an EMPTY `addGuests`, so no throttle, no audit row and no timing floor — hands
  // back their name and their exact booked nights on every date change. See
  // `markCrossFamilyGuestsOnBooking`.
  const guestsForPricing = await markCrossFamilyGuestsOnBooking(
    prisma,
    booking.memberId,
    proposedGuestRows,
    // `bookingId` arms the owner's gate (finding 4): with the module off and no
    // consent row on this booking, the family-boundary recomputation is skipped.
    { skipAuthorization: isAdmin, bookingId: booking.id },
  );

  // HIGH-1 (privacy re-review of MG3 #2308). The marking above closed the
  // read-out; it did not CAP it. Every preview over a party that carries a
  // beyond-family member guest asks the person-night guard a fresh question
  // about that member's occupancy, and with an empty `addGuests` the boundary
  // hook never fired, so the whole sweep — roughly one request per night of the
  // season — cost nothing but the 250 ms floor. Charge the request's unit here,
  // on EVERY such preview rather than only the refused ones: the "no clash"
  // answer maps the calendar just as well as the refusal does.
  //
  // Safe to answer 429 from here for the same reason the boundary hook is safe:
  // the set comes from the booker's own booking and their own family groups, and
  // nothing has been read about the target. The ledger means a request that
  // already paid at the hook is not billed twice.
  const partyThrottled = await applyMemberGuestPartyProbeThrottle({
    request,
    actorMemberId: session.user.id,
    guests: guestsForPricing,
    skipAuthorization: isAdmin,
    ledger: memberGuestThrottleLedger,
  });
  if (partyThrottled) return partyThrottled;

  const totalGuestCount = guestsForPricing.length;
  const seasonYear = seasonYearOfStoredDate(newCheckIn);

  const bookingLodgeId = booking.lodgeId ?? (await getDefaultLodgeId(prisma));
  const lodgeCapacity = await getLodgeCapacity(bookingLodgeId);
  if (totalGuestCount > lodgeCapacity) {
    return NextResponse.json(
      { error: `A booking cannot exceed ${lodgeCapacity} guests` },
      { status: 400 }
    );
  }

  // D-8: a clash on ANY cross-family member guest in the proposed party refuses
  // neutrally rather than returning that member's already-booked nights —
  // whether this request is adding them or they were added weeks ago. The booker
  // can of course see who is on their own booking; what they may not see is where
  // ELSE that person is booked, which is exactly what `conflictingNights` is.
  // The unit for this question was already spent above — on this request whether
  // it is refused or not — and the refusal path below adds the audit row and the
  // timing floor.
  let memberNightConflicts;
  try {
    memberNightConflicts = await findBookingMemberNightConflicts(prisma, {
      actorMemberId: session.user.id,
      actorRole,
      checkIn: newCheckIn,
      checkOut: newCheckOut,
      guests: guestsForPricing,
      excludeBookingId: booking.id,
      // The one club day this quote resolved above — the same value the edit
      // policy, the change fee and the settlement tier read (`INV-LOCK-004`).
      today: dateOnlyInstantOf(todayAtClub),
    });
  } catch (error) {
    if (error instanceof BookingGuestValidationError) {
      await handleMemberGuestAddRefusal({
        request,
        actorMemberId: session.user.id,
        error,
        route: "bookings/modify-quote",
        startedAt,
        throttle: "CHARGE_IF_UNCHARGED",
        ledger: memberGuestThrottleLedger,
        skipAuthorization: isAdmin,
      });
      return NextResponse.json(
        getBookingGuestValidationErrorResponse(error),
        { status: error.status },
      );
    }
    throw error;
  }
  if (memberNightConflicts.length > 0) {
    return NextResponse.json(
      getBookingMemberNightConflictResponse(memberNightConflicts),
      { status: 409 },
    );
  }

  try {
    await assertMembershipTypeBookingAllowed(prisma, {
      ownerMemberId: booking.memberId,
      guests: guestsForPricing,
      seasonYear,
      // Finding 2 (privacy re-review of MG3 #2308). `guestsForPricing` is the
      // C1-marked party, so a beyond-family member guest already on the booking
      // collapses here without a second boundary read.
      skipAuthorization: isAdmin,
    });
  } catch (error) {
    if (error instanceof MembershipTypeBookingPolicyError) {
      // Finding 2 (privacy re-review of MG3 #2308). The membership-type refusal
      // is D-8's FOURTH collapsing refusal, so when it collapsed it owes the
      // same three mitigations as its siblings — the throttle unit, the audit
      // row naming actor and target, and the timing floor. A no-op for every
      // other membership-type block: the handler returns immediately unless the
      // error carries `crossFamilyMemberIds`, which only a collapsed one does.
      await handleMemberGuestAddRefusal({
        request,
        actorMemberId: session.user.id,
        error: error,
        route: "bookings/modify-quote",
        startedAt,
        throttle: "CHARGE_IF_UNCHARGED",
        ledger: memberGuestThrottleLedger,
        skipAuthorization: isAdmin,
      });
      return NextResponse.json(
        getMembershipTypeBookingPolicyErrorBody(error),
        { status: error.status },
      );
    }
    throw error;
  }

  if (!isAdmin) {
    // D-8: throws the neutral refusal for a cross-family guest rather than
    // previewing their name and subscription status.
    let unpaidMemberGuests;
    try {
      unpaidMemberGuests = await findUnpaidMemberGuestNames(prisma, {
        bookingMemberId: booking.memberId,
        checkIn: isInProgressEdit && editableFrom ? editableFrom : newCheckIn,
        guests: normalizedAddGuests ?? [],
      });
    } catch (error) {
      if (error instanceof BookingGuestValidationError) {
        // H3 (privacy review of MG3 #2308). This catch used to answer the
        // collapsed refusal directly, skipping the handler — so an
        // unpaid-subscription refusal wrote no audit row and raised no
        // repeated-refusal warning. Routing it through the handler buys those
        // two things.
        //
        // WHAT IT DOES NOT BUY, stated because the earlier version of this
        // comment claimed it did (privacy re-review, MEDIUM-3): it does not
        // equalise this refusal with the ones raised at the top of the handler.
        // The floor is a MINIMUM, not a budget, and by the time this branch runs
        // the whole pricing path has executed — so once that exceeds 250 ms, the
        // late refusals still report their own duration and remain separable
        // from the early ones by stopwatch. `MEMBER_GUEST_REFUSAL_FLOOR_MS` says
        // why raising the floor to cover it was rejected.
        await handleMemberGuestAddRefusal({
          request,
          actorMemberId: session.user.id,
          error,
          route: "bookings/modify-quote",
          startedAt,
          throttle: "CHARGE_IF_UNCHARGED",
          ledger: memberGuestThrottleLedger,
          skipAuthorization: isAdmin,
        });
        return NextResponse.json(
          getBookingGuestValidationErrorResponse(error),
          { status: error.status },
        );
      }
      throw error;
    }

    // #2543: under NON_MEMBER_PRICING an unpaid member guest is repriced by the
    // quote rather than refused by it — and the quote is exactly where the
    // member SEES the higher price, which is what makes the notice below the
    // honest place to tell them why. `findUnpaidMemberGuestNames` above still
    // runs in that mode so the D-8 cross-family refusal is unaffected.
    if (subscriptionLockoutMode === "HARD_BLOCK" && unpaidMemberGuests.length > 0) {
      return NextResponse.json(
        {
          error: `The following member guests have unpaid subscriptions: ${unpaidMemberGuests.join(", ")}. All member guests must have a paid subscription before booking.`,
          code: "GUEST_SUBSCRIPTION_REQUIRED",
          unpaidMembers: unpaidMemberGuests,
        },
        { status: 403 }
      );
    }
  }

  // #2543 — the paid-up-adult requirement over the PROPOSED party (remaining +
  // added guests), so the preview refuses exactly what the save would refuse.
  // Skipped for admins, like every other eligibility gate on this route.
  let subscriptionMemberRateNotice: string | null = null;
  if (!isAdmin) {
    // The stored D-12 fact for every row already on this booking, read from the
    // rows this route already loaded (no extra query).
    const consentStatusByGuestId = new Map(
      booking.guests.map((guest) => [guest.id, guest.consentStatus]),
    );
    const nonMemberPricing = await evaluateNonMemberPricingRequirements(prisma, {
      mode: subscriptionLockoutMode,
      lodgeId: bookingLodgeId,
      seasonYear,
      checkIn: newCheckIn,
      checkOut: newCheckOut,
      // Owner decision, 3 Aug 2026: an unfinancial owner triggers the requirement
      // whether or not they are one of the rows being priced, so the preview
      // refuses exactly what the apply path refuses.
      bookingOwnerMemberId: booking.memberId,
      // D-12. `proposedGuestRows` is rebuilt field by field and deliberately
      // carries no consent column, so passing it raw made a PENDING cross-family
      // adult count as the party's paid-up adult HERE while the guest-add path
      // correctly excluded them on the same booking — the two disagreed about the
      // same party. A row already on the booking is judged by its STORED
      // consentStatus; a row this preview would ADD is judged by whether it is a
      // cross-family member guest, which is exactly the add that lands PENDING.
      participants: guestsForPricing.map((guest) => ({
        isMember: guest.isMember,
        memberId: guest.memberId ?? null,
        stayStart: guest.stayStart,
        stayEnd: guest.stayEnd,
        nights: guest.nights,
        operationallyPresent: guest.bookingGuestId
          ? isOperationallyPresentConsent(
              consentStatusByGuestId.get(guest.bookingGuestId) ?? null,
            )
          : !(
              guest.crossFamilyMemberGuest === true &&
              memberGuestPolicy.wideningEnabled &&
              memberGuestPolicy.approvalRequired &&
              !isAdmin
            ),
      })),
    });
    if (nonMemberPricing?.violation) {
      return NextResponse.json(
        buildPaidUpAdultRefusalBody(nonMemberPricing.violation),
        { status: 409 },
      );
    }
    subscriptionMemberRateNotice = nonMemberPricing?.memberRateNotice ?? null;
  }

  // Minimum stay policy validation (skip for admins). #2124: an in-progress
  // extension keeps its original (past) check-in fixed — for in-progress edits
  // `newCheckIn` is the booking's stored check-in (see the isInProgressEdit
  // branch above), so validating `[newCheckIn, newCheckOut]` evaluates the
  // policy over the WHOLE contiguous stay (the already-valid original plus the
  // added nights), never the added nights in isolation. A genuine
  // night-by-night extension therefore passes even across a weekend
  // minimum-stay rule (the whole stay is at least as long as the already-valid
  // original), while a genuinely-short whole stay is still reported. Pre-stay
  // (future) edits are unchanged: `newCheckIn` is the requested check-in.
  //
  // #2363: gated on `targetDatesChanged` so this preview reports exactly what
  // `modifyBookingBatch` will enforce on the save. The two predicates are
  // deliberately identical — both compare the RESOLVED envelope (after any
  // `guestStayRanges` widening) against the stored one — because an edit that
  // moves no night cannot admit a new violation, and the apply path exempts it
  // rather than hard-blocking an unrelated fix on a booking that already sat
  // outside the policy. Any change to one of these two gates must change the
  // other in the same commit, or preview and apply start disagreeing.
  let minimumStayViolations: MinimumStayViolation[] = [];
  if (!isAdmin && targetDatesChanged) {
    const { validateMinimumStay } = await import("@/lib/booking-policies");
    const stayResult = await validateMinimumStay(newCheckIn, newCheckOut, bookingLodgeId);
    minimumStayViolations = stayResult.violations;
  }
  const exceptionReview: AggregatedPolicyExceptions =
    aggregatePolicyExceptionViolations(minimumStayViolations);

  // Load seasons for pricing
  const seasons = await prisma.season.findMany({
    where: { active: true, ...lodgeNullTolerantScope(bookingLodgeId) },
    include: { membershipTypeRates: true },
  });

  // #2756: through the shared mapper, which carries the season's `type`. Mapped
  // by hand here without it, the group discount's default `summerOnly` test could
  // never pass, so every one of this route's pricing passes quoted the full rate
  // for a club on the default setting — including the in-progress preview, which
  // then agreed with an apply path broken the same way rather than with the price
  // the club had configured.
  const seasonRateData: SeasonRateData[] = toSeasonRateData(seasons);

  // The preview must quote what the mutating paths will charge (#1095): the
  // group discount applies to newly priced nights on every pricing pass below.
  //
  // Read the row once and resolve it through the EDIT-time mapper (#2770,
  // INV-MOD-026), because this route is a preview OF AN EDIT. Quoting through
  // the creation mapper would show a discount the save path then refuses to
  // give — the same quote/charge divergence #1095 exists to prevent. The raw
  // row is kept so the response can tell the member WHY the number is not
  // discounted, which is the other half of the switch.
  const groupDiscountSetting = await prisma.groupDiscountSetting.findUnique({
    where: { id: "default" },
  });
  const groupDiscount = toEditTimeGroupDiscountConfig(groupDiscountSetting);
  /**
   * Plain-English note shown beside the number when the club HAS a group
   * discount, has switched it off for later edits, AND this edit would otherwise
   * have been discounted (#2770 D2). Derived from the same mapper the pricing
   * passes above use, so the note and the number can never disagree; null in
   * every other state, including an edit whose party or season could not have
   * qualified anyway — there is no higher number to explain there.
   *
   * The proposed stay and party are what it judges, which is what this route is
   * quoting.
   */
  const editDiscountNotice = groupDiscountEditNotice(groupDiscountSetting, {
    checkIn: newCheckIn,
    checkOut: newCheckOut,
    guests: guestsForPricing,
    seasons: seasonRateData,
  });

  // Resolve each guest's rate membership type + rateSource once (#1930, E4);
  // the rated guests feed every pricing pass below and carry the snapshot.
  const policyAdjustedGuestsForPricing = await resolveGuestRateMembershipTypes(prisma, {
    seasonYear,
    guests: guestsForPricing,
    // #2543: this route performs SEVEN or more pricing passes in one request and
    // differences two of them into the member's settlement delta, so every pass
    // is handed the one mode resolved above. Left to peek independently, an admin
    // save landing between two passes made the delta wrong by the entire
    // member/non-member spread on every remaining guest.
    subscriptionLockoutMode,
  });
  const policyAdjustedAddGuests = normalizedAddGuestsWithRanges
    ? await resolveGuestRateMembershipTypes(prisma, {
        seasonYear,
        guests: normalizedAddGuestsWithRanges,
        subscriptionLockoutMode,
      })
    : undefined;
  const policyAdjustedExistingGuests = await resolveGuestRateMembershipTypes(prisma, {
    seasonYear,
    guests: booking.guests.map((guest) => ({
      ...guest,
      ageTier: guest.ageTier as AgeTier,
    })),
    subscriptionLockoutMode,
  });

  let inProgressPlan: BookingEditGuestRangePlan | null = null;
  try {
    inProgressPlan =
      isInProgressEdit && editableFrom
        ? buildInProgressGuestRangePlan({
          booking: {
            checkIn: booking.checkIn,
            checkOut: booking.checkOut,
            totalPriceCents: booking.totalPriceCents,
            discountCents: booking.discountCents,
            promoAdjustmentCents: booking.promoAdjustmentCents,
            finalPriceCents: booking.finalPriceCents,
            guests: policyAdjustedExistingGuests,
          },
          editableFrom,
          newCheckOut,
          addGuests: policyAdjustedAddGuests,
          removeGuestIds,
          seasons: seasonRateData,
          // #2756: the same config every other pricing pass in this route gets.
          // The preview has to quote what the save will charge, so an in-progress
          // edit's newly bought nights carry the group discount here exactly as
          // they now do on apply (INV-MOD-006).
          groupDiscount,
        })
        : null;
  } catch (error) {
    logger.error({ err: error, bookingId }, "Failed to price booking modification quote");
    return NextResponse.json(
      { error: "Unable to price the requested future-night changes" },
      { status: 400 }
    );
  }

  // Capacity check (exclude current booking)
  // #1746: with admin-flagged partner-sharers the preview runs the same
  // reserved-slot split the apply service uses (resolvePartnerSharedCapacity),
  // reporting the outcome + reason instead of the ordinary capacity verdict.
  let partnerSharedReason: string | null = null;
  let capacity: Awaited<ReturnType<typeof checkCapacityForGuestRanges>>;
  if (skipBookingLifecycleRules) {
    capacity = { available: true, minAvailable: Number.POSITIVE_INFINITY, nightDetails: [] };
  } else if (partnerSharedGuests.length > 0) {
    let shared;
    try {
      shared = await resolvePartnerSharedCapacity({
        lodgeId: bookingLodgeId,
        // #2029: capacityRangeStart (not editableFrom) so the preview checks a
        // check-out-day extension's new night — keeping quote and apply in
        // lockstep; equals editableFrom for mid-stay / last-night edits.
        rangeStart:
          inProgressPlan && editableFrom
            ? inProgressPlan.capacityRangeStart
            : newCheckIn,
        rangeEnd: newCheckOut,
        proposedRanges:
          inProgressPlan && editableFrom
            ? inProgressPlan.capacityGuestRanges
            : policyAdjustedGuestsForPricing,
        partnerSharedGuests,
        excludeBookingId: bookingId,
      });
    } catch (error) {
      // Mirror the apply route's status for splitter input errors (an
      // unmatched or duplicated sharer flag) — a 400-class payload must not
      // 500 the preview while 400ing the apply.
      if (error instanceof ApiError) {
        return NextResponse.json(
          { error: error.message },
          { status: error.status },
        );
      }
      throw error;
    }
    partnerSharedReason = shared.available ? null : shared.reason;
    capacity = {
      available: shared.available,
      minAvailable: shared.minAvailable,
      nightDetails: shared.nightDetails,
    };
  } else {
    capacity =
      inProgressPlan && editableFrom
        ? await checkCapacityForGuestRanges(
            bookingLodgeId,
            // #2029: capacityRangeStart, not editableFrom — see above.
            inProgressPlan.capacityRangeStart,
            newCheckOut,
            inProgressPlan.capacityGuestRanges,
            bookingId
          )
        : await checkCapacityForGuestRanges(
            bookingLodgeId,
            newCheckIn,
            newCheckOut,
            policyAdjustedGuestsForPricing,
            bookingId
          );
  }

  // Calculate new total price
  let newTotalPriceCents: number;
  let priceBreakdown: {
    totalPriceCents: number;
    guests: Array<{ priceCents: number; perNightCents: number[]; nightDates: Date[] }>;
  } | null = null;
  try {
    if (inProgressPlan) {
      newTotalPriceCents = inProgressPlan.newTotalPriceCents;
    } else {
      priceBreakdown = await priceBookingGuestsWithMembershipTypePolicy(prisma, {
        ownerMemberId: booking.memberId,
        checkIn: newCheckIn,
        checkOut: newCheckOut,
        guests: policyAdjustedGuestsForPricing,
        seasons: seasonRateData,
        groupDiscount,
        seasonYear,
        subscriptionLockoutMode,
      });
      newTotalPriceCents = priceBreakdown.totalPriceCents;
    }
  } catch (error) {
    if (error instanceof MembershipTypeBookingPolicyError) {
      // Finding 2 (privacy re-review of MG3 #2308). The membership-type refusal
      // is D-8's FOURTH collapsing refusal, so when it collapsed it owes the
      // same three mitigations as its siblings — the throttle unit, the audit
      // row naming actor and target, and the timing floor. A no-op for every
      // other membership-type block: the handler returns immediately unless the
      // error carries `crossFamilyMemberIds`, which only a collapsed one does.
      await handleMemberGuestAddRefusal({
        request,
        actorMemberId: session.user.id,
        error: error,
        route: "bookings/modify-quote",
        startedAt,
        throttle: "CHARGE_IF_UNCHARGED",
        ledger: memberGuestThrottleLedger,
        skipAuthorization: isAdmin,
      });
      return NextResponse.json(
        getMembershipTypeBookingPolicyErrorBody(error),
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: "No season rate found for the requested dates" },
      { status: 400 }
    );
  }

  // --- Build itemized changes ---
  const itemizedChanges: Array<{ label: string; amountCents: number }> = [];
  if (guestNameUpdates.length > 0) {
    itemizedChanges.push({
      label:
        guestNameUpdates.length === 1
          ? "Guest name update"
          : "Guest name updates",
      amountCents: 0,
    });
  }

  // #2337: a per-link re-rate line so the officer sees the money each link moves
  // BEFORE committing (quote-first). The linked guest is a remaining guest, so its
  // new member-rate price sits at its position in priceBreakdown; the delta is
  // that minus the stored (non-member) price the placeholder was booked at. This
  // mirrors the apply path EXACTLY (same repriced value, same stored old value),
  // so preview and settlement can never disagree.
  if (guestMemberLinks.length > 0 && priceBreakdown) {
    const indexByGuestId = new Map(
      proposedRemainingGuests.map((entry, index) => [entry.guest.id, index]),
    );
    for (const link of guestMemberLinks) {
      const index = indexByGuestId.get(link.guestId);
      const guest = remainingGuests.find((g) => g.id === link.guestId);
      if (index === undefined || !guest) continue;
      const newPriceCents = priceBreakdown.guests[index]?.priceCents ?? 0;
      itemizedChanges.push({
        label: `Linked ${link.previousFirstName} ${link.previousLastName} to member (re-rated)`,
        amountCents: newPriceCents - guest.priceCents,
      });
    }
  }

  /**
   * The re-rated guests' new fees, and one itemised line each (Other Lodges
   * epic).
   *
   * `guestPrices` is the whole remaining party, not just the re-rated rows: the
   * edit panel shows a fee beside every name, and a party-wide reprice (a date
   * change, a group discount that starts or stops qualifying) moves numbers on
   * rows nobody ticked. Sending only the ticked rows would leave the others
   * showing their stored price beside a total that no longer matches them.
   *
   * Absent on an in-progress edit, which prices through the range planner rather
   * than this breakdown; the panel then keeps showing the stored fees.
   */
  const guestPrices =
    priceBreakdown
      ? proposedRemainingGuests.map((entry, index) => ({
          guestId: entry.guest.id,
          priceCents: priceBreakdown.guests[index]?.priceCents ?? entry.guest.priceCents,
        }))
      : null;
  if (priceBreakdown && otherLodgeElection.repriceGuestIds.size > 0) {
    const indexByGuestId = new Map(
      proposedRemainingGuests.map((entry, index) => [entry.guest.id, index]),
    );
    for (const guestId of otherLodgeElection.repriceGuestIds) {
      const index = indexByGuestId.get(guestId);
      const guest = remainingGuests.find((g) => g.id === guestId);
      if (index === undefined || !guest) continue;
      const newPriceCents = priceBreakdown.guests[index]?.priceCents ?? 0;
      const nowFlagged = otherLodgeElection.flaggedGuestIds.has(guestId);
      itemizedChanges.push({
        label: `${guest.firstName} ${guest.lastName} re-rated at the ${
          nowFlagged ? "other-lodge member" : "non-member"
        } rate`,
        amountCents: newPriceCents - guest.priceCents,
      });
    }
  }

  const oldNights = getStayNights(booking.checkIn, booking.checkOut).length;
  const newNights = getStayNights(newCheckIn, newCheckOut).length;
  const datesChanged = targetDatesChanged;
  const guestRangesChanged = proposedRemainingGuests.some((entry) => {
    const currentStayStart = storedDateOnly(
      entry.guest.stayStart ?? booking.checkIn
    );
    const currentStayEnd = storedDateOnly(
      entry.guest.stayEnd ?? booking.checkOut
    );
    return (
      currentStayStart.getTime() !== entry.stayStart.getTime() ||
      currentStayEnd.getTime() !== entry.stayEnd.getTime()
    );
  });

  // 1. Date change cost: price remaining guests at new dates vs old dates
  if (inProgressPlan) {
    if (inProgressPlan.futureExistingDeltaCents !== 0) {
      itemizedChanges.push({
        label:
          newCheckOut.getTime() !== new Date(booking.checkOut).getTime()
            ? "Future-night date change"
            : "Future-night guest range change",
        amountCents: inProgressPlan.futureExistingDeltaCents,
      });
    }
  } else if ((datesChanged || guestRangesChanged) && remainingGuests.length > 0) {
    const oldRemainingForPricing = remainingGuests.map((g) => ({
      ageTier: g.ageTier as AgeTier,
      isMember: g.isMember,
      memberId: g.memberId ?? null,
      stayStart: storedDateOnly(g.stayStart ?? booking.checkIn),
      stayEnd: storedDateOnly(g.stayEnd ?? booking.checkOut),
    }));
    const newRemainingForPricing = proposedRemainingGuests.map((entry) => ({
      ageTier: entry.guest.ageTier as AgeTier,
      isMember: entry.guest.isMember,
      memberId: entry.guest.memberId ?? null,
      stayStart: entry.stayStart,
      stayEnd: entry.stayEnd,
    }));

    try {
      const oldPriceForRemaining = await priceBookingGuestsWithMembershipTypePolicy(prisma, {
        ownerMemberId: booking.memberId,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        guests: oldRemainingForPricing,
        seasons: seasonRateData,
        groupDiscount,
        subscriptionLockoutMode,
      });
      const newPriceForRemaining = await priceBookingGuestsWithMembershipTypePolicy(prisma, {
        ownerMemberId: booking.memberId,
        checkIn: newCheckIn,
        checkOut: newCheckOut,
        guests: newRemainingForPricing,
        seasons: seasonRateData,
        groupDiscount,
        seasonYear,
        subscriptionLockoutMode,
      });
      const dateChangeCost =
        newPriceForRemaining.totalPriceCents -
        oldPriceForRemaining.totalPriceCents;

      if (dateChangeCost !== 0) {
        const nightLabel =
          oldNights !== newNights
            ? `Date change: ${oldNights} night${oldNights !== 1 ? "s" : ""} → ${newNights} night${newNights !== 1 ? "s" : ""}`
            : guestRangesChanged
              ? "Guest stay range change"
            : "Date change (rate difference)";
        itemizedChanges.push({ label: nightLabel, amountCents: dateChangeCost });
      }
    } catch {
      // If pricing fails for old dates (unlikely), skip itemization
    }
  }

  // 2. Change fee
  let changeFeeCents = 0;
  const checkInChanged =
    newCheckIn.getTime() !== new Date(booking.checkIn).getTime();

  // #2266: no change fee on a DRAFT — nothing has been committed to, exactly
  // like fiddling with dates in the wizard before saving. Mirrors the
  // calculateModificationChangeFee guard on the apply path.
  if (
    !skipBookingLifecycleRules &&
    checkInChanged &&
    !isInProgressEdit &&
    booking.status !== "DRAFT"
  ) {
    const policy = await loadCancellationPolicy(booking.checkIn, bookingLodgeId);
    const feeResult = calculateChangeFee({
      // #3123 — one club day for both operands, so the two day-counts cannot
      // straddle club midnight and quote a fee neither tier justifies.
      daysUntilOriginalCheckIn: daysUntilDate(booking.checkIn, todayAtClub),
      daysUntilNewCheckIn: daysUntilDate(newCheckIn, todayAtClub),
      originalFinalPriceCents: booking.finalPriceCents,
      policyRules: policy,
    });
    changeFeeCents = feeResult.feeCents;

    if (changeFeeCents > 0) {
      itemizedChanges.push({
        label: "Late-notice change fee",
        amountCents: changeFeeCents,
      });
    }
  }

  // 3. Per-added-guest costs
  if (inProgressPlan) {
    for (const entry of inProgressPlan.proposedAddedGuests) {
      const guest = entry.guest;
      const tierLabel = guest.ageTier.charAt(0) + guest.ageTier.slice(1).toLowerCase();
      const memberLabel = guest.isMember ? "Member" : "Non-member";
      itemizedChanges.push({
        label: `Added: ${guest.firstName} ${guest.lastName} (${tierLabel}, ${memberLabel})`,
        amountCents: entry.priceCents,
      });
    }
  } else if (normalizedAddGuestsWithRanges && normalizedAddGuestsWithRanges.length > 0) {
    for (const guest of normalizedAddGuestsWithRanges) {
      try {
        const guestPrice = await priceBookingGuestsWithMembershipTypePolicy(prisma, {
          ownerMemberId: booking.memberId,
          checkIn: newCheckIn,
          checkOut: newCheckOut,
          guests: [
            {
              ageTier: guest.ageTier,
              isMember: guest.isMember,
              memberId: guest.memberId ?? null,
              stayStart: guest.stayStart,
              stayEnd: guest.stayEnd,
            },
          ],
          seasons: seasonRateData,
          groupDiscount,
          seasonYear,
          subscriptionLockoutMode,
        });
        const tierLabel = guest.ageTier.charAt(0) + guest.ageTier.slice(1).toLowerCase();
        const memberLabel = guest.isMember ? "Member" : "Non-member";
        itemizedChanges.push({
          label: `Added: ${guest.firstName} ${guest.lastName} (${tierLabel}, ${memberLabel})`,
          amountCents: guestPrice.totalPriceCents,
        });
      } catch {
        // skip itemization if pricing fails
      }
    }
  }

  // 4. Per-removed-guest credits (use their stored priceCents)
  if (inProgressPlan) {
    for (const entry of inProgressPlan.proposedExistingGuests.filter(
      (guest) => guest.removedFromFuture
    )) {
      const tierLabel = entry.guest.ageTier.charAt(0) + entry.guest.ageTier.slice(1).toLowerCase();
      const memberLabel = entry.guest.isMember ? "Member" : "Non-member";
      itemizedChanges.push({
        label: `Removed from future nights: ${entry.guest.firstName} ${entry.guest.lastName} (${tierLabel}, ${memberLabel})`,
        amountCents: -entry.oldFuturePriceCents,
      });
    }
  } else {
    for (const guest of removedGuests) {
      const tierLabel = guest.ageTier.charAt(0) + guest.ageTier.slice(1).toLowerCase();
      const memberLabel = guest.isMember ? "Member" : "Non-member";
      itemizedChanges.push({
        label: `Removed: ${guest.firstName} ${guest.lastName} (${tierLabel}, ${memberLabel})`,
        amountCents: -guest.priceCents,
      });
    }
  }

  // 5. Promo code handling
  let newDiscountCents = 0;
  let newPromoAdjustmentCents = 0;
  let promoStillValid = true;
  // #2390: who the promotion will still cover once this edit is saved. The
  // preview MUST run the same rule as the save, or the panel would announce
  // "your promo code will be removed" and the save would quietly keep a partial
  // discount — the exact drift the owner decision warns about.
  let promoCoverage: PromoCoverageNotice | null = null;
  let promoValidation: {
    valid: boolean;
    error?: string;
    code?: string;
    discountCents?: number;
    promoAdjustmentCents?: number;
  } | null = null;

  // Helper: get per-night rates per guest for promo calculation
  function getGuestNightRates() {
    return guestsForPricing.map((guest, index) => ({
      bookingGuestId: guest.bookingGuestId,
      memberId: guest.memberId ?? null,
      isMember: guest.isMember,
      perNightRates: priceBreakdown?.guests[index]?.perNightCents ?? [],
      nightDates: priceBreakdown?.guests[index]?.nightDates ?? [],
      // Dates the positional rates so internal work-party promos restrict
      // the discount to the event's night window.
      firstNight: guest.stayStart ?? newCheckIn,
    }));
  }

  if (inProgressPlan) {
    newDiscountCents = inProgressPlan.newDiscountCents;
    newPromoAdjustmentCents = inProgressPlan.newPromoAdjustmentCents;
  } else if (removePromoCode) {
    // User wants to remove existing promo (for reuse later)
    newDiscountCents = 0;
    newPromoAdjustmentCents = 0;
    promoValidation = null;
  } else if (newPromoCode) {
    // User wants to apply a new promo code. #2266 (MED-4): beneficiaries ride
    // along bound the same way the apply route (applyPromoCodeChanges)
    // resolves them — existing guests by bookingGuestId, added guests by
    // request-local index — so preview and apply can never disagree about who
    // the code covers, and a stale id 400s here exactly as it would on save.
    const quoteGuestNightRates = getGuestNightRates();
    let quoteSelectedGuestIndexes: number[] | undefined;
    try {
      quoteSelectedGuestIndexes = resolvePromoBeneficiarySelection({
        guestNightRates: quoteGuestNightRates,
        addedGuestCount: normalizedAddGuestsWithRanges?.length ?? 0,
        promoGuestIds,
        promoAddedGuestIndexes,
      });
    } catch (error) {
      if (error instanceof ApiError) {
        return NextResponse.json(
          { error: error.message },
          { status: error.status },
        );
      }
      throw error;
    }
    const validation = await validatePromoCodeFull(newPromoCode, {
      totalPriceCents: newTotalPriceCents,
      memberId: booking.memberId,
      guests: quoteGuestNightRates,
    }, todayAtClub, bookingId, bookingLodgeId, {
      selectedGuestIndexes: quoteSelectedGuestIndexes,
    });

    if (validation.valid) {
      newDiscountCents = validation.discountCents ?? 0;
      newPromoAdjustmentCents = validation.promoAdjustmentCents ?? 0;
      promoValidation = {
        valid: true,
        code: validation.promoCode?.code,
        discountCents: validation.discountCents ?? 0,
        promoAdjustmentCents: validation.promoAdjustmentCents ?? 0,
      };
    } else {
      // A guest-targeted code that still needs a selection surfaces here as
      // its plain error text. The panel does not re-open guest selection from
      // the quote (INFO-9): PromoCodeInput owns selection via
      // /api/promo-codes/validate, and the panel resets an applied code
      // whenever the guest set changes, so the member re-selects there.
      promoValidation = {
        valid: false,
        error: validation.error,
      };
      // Invalid new promo — discount stays 0, don't fall back to old promo
    }
  } else if (booking.promoRedemption?.promoCode) {
    // Keep existing promo, recalculate with new price
    const promo = booking.promoRedemption.promoCode;
    const guestNightRates = getGuestNightRates();
    const selectedGuestIndexes = selectedIndexesForStoredGuestTargets(
      booking.promoRedemption,
      guestNightRates
    );
    const application = await validateAndCalculatePromoDiscount(
      promo,
      {
        memberId: booking.memberId,
        bookingCheckIn: newCheckIn,
        totalPriceCents: newTotalPriceCents,
        guests: guestNightRates,
      },
      promo.assignments.length > 0
        ? promo.assignments.map((assignment) => assignment.memberId)
        : null,
      {
        excludeBookingId: bookingId,
        db: prisma,
        selectedGuestIndexes,
        lodgeId: bookingLodgeId,
        // Same rule as `applyPromoCodeChanges`' reprice branch, so the preview
        // and the save cannot tell different stories (#2390).
        capOverflow: "coverExisting",
        todayAtClub,
      },
    );

    if (application.error || !application.discount) {
      promoStillValid = false;
    } else {
      const promoResult = application.discount;
      newDiscountCents = promoResult.discountCents;
      newPromoAdjustmentCents = promoResult.priceAdjustmentCents;
      promoCoverage = await describePromoCapCoverage(prisma, {
        promoCode: promo.code,
        capCoverage: application.capCoverage,
      });
    }
  }

  // Add promo line item
  if (newPromoAdjustmentCents !== 0) {
    const promoLabel = newPromoCode
      ? `Promo '${newPromoCode.toUpperCase()}'`
      : booking.promoRedemption?.promoCode
        ? `Promo '${booking.promoRedemption.promoCode.code}'`
        : "Promo discount";
    itemizedChanges.push({
      label: promoLabel,
      amountCents: newPromoAdjustmentCents,
    });
  }

  // Show removed promo as the inverse of its previous signed adjustment.
  if (removePromoCode && booking.promoAdjustmentCents !== 0) {
    itemizedChanges.push({
      label: `Removed promo '${booking.promoRedemption?.promoCode?.code || "adjustment"}'`,
      amountCents: -booking.promoAdjustmentCents,
    });
  }

  const newFinalPriceCents = inProgressPlan
    ? inProgressPlan.newFinalPriceCents
    : newTotalPriceCents + newPromoAdjustmentCents;
  const priceDiffCents = inProgressPlan
    ? inProgressPlan.priceDiffCents
    : newFinalPriceCents - booking.finalPriceCents;
  const netChargeCents = priceDiffCents + changeFeeCents;
  const settlementOptions = await calculateModificationSettlementOptions({
    booking,
    netChargeCents,
    db: prisma, // advisory quote: no transaction, no lock held
    todayAtClub,
  });

  return NextResponse.json({
    newTotalPriceCents,
    newDiscountCents,
    newPromoAdjustmentCents,
    newFinalPriceCents,
    priceDiffCents,
    changeFeeCents,
    netChargeCents,
    settlementOptions,
    // #2266: create-flow parity (api/bookings/quote/route.ts) — the member's
    // live balance so the edit panel can offer credit against the new price.
    availableCreditCents,
    capacityAvailable: capacity.available,
    // #2543 — "tell them why". Non-null only when this quote prices somebody at
    // non-member rates because their season subscription is unpaid; the member
    // is looking at the higher number on this very screen, so the explanation
    // travels with it. Null in every other mode and for every paid-up party.
    subscriptionMemberRateNotice,
    // #2770 D2 — the same "tell them why" rule for the edit-time group discount
    // switch. Non-null only when the club runs a group discount AND has turned
    // it off for later edits, so the officer reading the price knows the higher
    // number is the club's policy rather than a mispricing.
    groupDiscountEditNotice: editDiscountNotice,
    minimumStayValid: minimumStayViolations.length === 0,
    minimumStayViolations,
    exceptionReview,
    promoStillValid,
    promoCoverage,
    promoValidation,
    itemizedChanges,
    // Other Lodges epic: the per-person fees this edit would write, so the panel
    // can show each guest's recalculated fee beside their name before saving.
    ...(guestPrices ? { guestPrices } : {}),
    // #1746: why the partner-shared admission rejected — the UI shows this
    // verbatim; a partner-shared preview never offers the #1668 overbook
    // confirm (leave sharers unflagged to overbook the blunt way).
    ...(partnerSharedReason !== null ? { partnerSharedReason } : {}),
    // Issue #1668: under an admin override an over-capacity target does not hard
    // block — the UI keys its explicit confirm control off this flag.
    ...(adminOverride && !capacity.available && partnerSharedGuests.length === 0
      ? { overCapacityConfirmRequired: true }
      : {}),
    ...(capacity.available
      ? {}
      : {
          nightDetails: capacity.nightDetails.map((n) => ({
            date: formatDateOnly(n.date),
            availableBeds: n.availableBeds,
          })),
        }),
  });
}
