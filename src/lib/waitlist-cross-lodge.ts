import type { AgeTier, Prisma, WaitlistCrossLodgeOrder } from "@prisma/client";
import { BookingEventType, BookingStatus } from "@prisma/client";
import {
  calculateBookingHoldDecision,
  toGroupDiscountConfig,
  toGuestPricingInputs,
  toSeasonRateData,
} from "@/lib/policies/booking-route-decisions";
import { priceBookingGuestsWithMembershipTypePolicy } from "@/lib/membership-type-policy";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { clubToday } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { prisma } from "@/lib/prisma";
import {
  acquireLodgeCapacityLock,
  checkCapacityForGuestRanges,
} from "@/lib/capacity";
import { isMemberEligibleToBookLodge } from "@/lib/lodge-access";
import { DUPLICATE_STAY_BOOKING_STATUSES } from "@/lib/booking-status";
import {
  createConfirmedBooking,
  type BookingGuestInput,
} from "@/lib/booking-create";
// Import the guard's typed error from the leaf types module, not from
// "@/lib/booking-create": the cross-lodge confirm test mocks the whole
// booking-create module, which would replace this binding with undefined and
// break the `instanceof` check below. booking-create re-exports the same class.
import { DuplicateStayConflictError } from "@/lib/booking-create-types";
import { getNonMemberHoldDays } from "@/lib/cancellation";
import { resolveSubscriptionLockoutMode } from "@/lib/member-subscription-eligibility";
import { formatMissingPaidUpAdultWaitlistRefusal } from "@/lib/policies/subscription-lockout-pricing";
import { formatAdultMemberHostingWaitlistRefusal } from "@/lib/policies/adult-member-hosting";
import {
  AdultMemberHostingRequiredError,
  buildAdultMemberHostingRefusalBody,
} from "@/lib/adult-member-hosting-review";
import {
  HOSTING_COVERAGE_RETRY_CODE,
  HOSTING_COVERAGE_RETRY_MESSAGE,
  isHostingCoverageParticipantRetry,
} from "@/lib/adult-member-hosting-queue-participants";
import {
  buildPaidUpAdultRefusalBody,
  evaluateNonMemberPricingRequirements,
  toSubscriptionLockoutParticipants,
} from "@/lib/subscription-lockout-enforcement";
import { seasonYearOfStoredDate } from "@/lib/financial-year";
import {
  reconcileBedAllocationsForBookingWithLodgeLockHeld,
} from "@/lib/bed-allocation-lifecycle";
import { logAudit } from "@/lib/audit";
import { recordBookingEvent } from "@/lib/booking-events";
import logger from "@/lib/logger";
import { DEFAULT_BOOKING_DEFAULTS } from "@/config/club-settings-defaults";

// Cross-lodge waitlist support (ADR-004). The processor consults these
// helpers when a member has opted into alternate lodges: the queue-order
// policy decides who is considered first, and the quote decides whether an
// alternate lodge can actually host the entry and at what price. The quoted
// price is persisted on the offer and re-checked at confirm time, so both
// sides must price the same way.

type CrossLodgeDb = Pick<Prisma.TransactionClient, "bookingDefaults">;

/**
 * Club-wide queue-order policy (ADR-004 owner decision 1). Missing settings
 * row falls back to the schema default so pre-seed databases behave like
 * OWN_LODGE_FIRST.
 */
export async function getWaitlistCrossLodgeOrder(
  db: CrossLodgeDb,
): Promise<WaitlistCrossLodgeOrder> {
  const defaults = await db.bookingDefaults.findUnique({
    where: { id: "default" },
    select: { waitlistCrossLodgeOrder: true },
  });
  return (
    defaults?.waitlistCrossLodgeOrder ??
    DEFAULT_BOOKING_DEFAULTS.waitlistCrossLodgeOrder
  );
}

export interface WaitlistQuoteGuest {
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string | null;
  stayStart?: Date | null;
  stayEnd?: Date | null;
  nights?: ReadonlyArray<{ stayDate: Date }> | null;
}

export interface WaitlistQuoteEntry {
  memberId: string;
  checkIn: Date;
  checkOut: Date;
  guests: WaitlistQuoteGuest[];
  // Truthy when the entry carries a promo redemption. Promo-bearing entries
  // are never offered cross-lodge: revalidating a promo at another lodge
  // collides with usage-limit counting of the entry's own redemption, and
  // silently dropping the promo would quote the member a higher price than
  // they signed up for. Their same-lodge flow is unchanged.
  hasPromoRedemption: boolean;
}

export type CrossLodgeQuote =
  | { offerable: true; finalPriceCents: number }
  | { offerable: false; reason: "promo" | "unpriceable" };

type QuoteDb = Pick<Prisma.TransactionClient, "season" | "groupDiscountSetting">;

/**
 * Price a waitlist entry's guests and dates at another lodge (ADR-004): the
 * figure quoted in a cross-lodge offer. Returns not-offerable instead of
 * throwing when the lodge's seasons cannot price the dates or a membership
 * booking policy blocks the stay — the processor just skips the candidate.
 */
export async function quoteWaitlistEntryAtLodge(
  tx: QuoteDb,
  entry: WaitlistQuoteEntry,
  lodgeId: string,
): Promise<CrossLodgeQuote> {
  if (entry.hasPromoRedemption) {
    return { offerable: false, reason: "promo" };
  }

  const seasons = await tx.season.findMany({
    where: {
      active: true,
      startDate: { lte: entry.checkOut },
      endDate: { gte: entry.checkIn },
      ...lodgeNullTolerantScope(lodgeId),
    },
    include: { membershipTypeRates: true },
  });
  if (seasons.length === 0) {
    return { offerable: false, reason: "unpriceable" };
  }

  const groupDiscountSetting = await tx.groupDiscountSetting.findUnique({
    where: { id: "default" },
  });

  try {
    const price = await priceBookingGuestsWithMembershipTypePolicy(tx, {
      ownerMemberId: entry.memberId,
      checkIn: entry.checkIn,
      checkOut: entry.checkOut,
      guests: toGuestPricingInputs(
        entry.guests.map((guest) => ({
          ageTier: guest.ageTier,
          isMember: guest.isMember,
          memberId: guest.memberId ?? null,
          stayStart: guest.stayStart ?? null,
          stayEnd: guest.stayEnd ?? null,
          nights: guest.nights?.length ? guest.nights : null,
        })),
      ),
      seasons: toSeasonRateData(seasons),
      groupDiscount: toGroupDiscountConfig(groupDiscountSetting),
      // Finding 2 (privacy re-review of MG3 #2308). An unattended offer sweep
      // that DISCARDS the refusal entirely (see the catch below), so there is
      // nothing to collapse and no reason to spend a family-boundary read
      // working out whether it needed collapsing.
      skipAuthorization: true,
    });
    return { offerable: true, finalPriceCents: price.totalPriceCents };
  } catch {
    // No season rate for some night, or a membership-type booking policy
    // rejects the stay at quote time. Either way this lodge cannot make a
    // clean offer.
    return { offerable: false, reason: "unpriceable" };
  }
}

export interface CrossLodgeConfirmResult {
  success: boolean;
  error?: string;
  newStatus?: BookingStatus;
  // The fresh booking created at the offered lodge on success.
  newBookingId?: string;
  // Set when the confirm was rejected because the lodge's price moved
  // between offer and confirm; the stored offer is updated to this figure
  // so the member can re-confirm at the price they can actually see.
  updatedPriceCents?: number;
  // Machine-readable rejection code the API route forwards to the client
  // (e.g. "DUPLICATE_STAY"). The price-drift rejection is signalled by
  // `updatedPriceCents` instead and needs no code here.
  code?: string;
  /**
   * The shared #2543 refusal body — frozen violation, HOLD promise and the path
   * to ask a Booking Officer — present ONLY on the paid-up-adult refusal.
   *
   * Named identically to the same-lodge result's field on purpose: the
   * waitlist-confirm route spreads whichever one it gets, so promoting a
   * cross-lodge offer answers this refusal in exactly the shape the booking write
   * paths do, with no route change and no second mapping to keep in step.
   */
  paidUpAdultRefusal?: ReturnType<typeof buildPaidUpAdultRefusalBody>;
  /**
   * The shared #2569 refusal body — frozen violation with host identities
   * withheld, capacity mode and the path to ask a Booking Officer — present ONLY
   * on the ENFORCED hosting refusal.
   *
   * Named identically to the same-lodge result's field for the reason
   * `paidUpAdultRefusal` is: the waitlist-confirm route spreads whichever one it
   * gets, so a cross-lodge promotion answers this refusal in exactly the shape the
   * booking write paths do, with no route change and no second mapping.
   */
  adultMemberHostingRefusal?: ReturnType<
    typeof buildAdultMemberHostingRefusalBody
  >;
  /**
   * #2543 "tell them why": non-null when the promoted booking prices somebody at
   * non-member rates for an unpaid season subscription. The cross-lodge quote can
   * differ from the member's own lodge by the whole member/non-member spread, so
   * the figure they have just accepted is exactly the one that owes an
   * explanation.
   */
  subscriptionMemberRateNotice?: string | null;
}

// Shared by the pre-flight (Phase 1) guard and the in-transaction guard's
// rejection mapping (Phase 2) so both reject with the identical message. The
// duplicate-stay status set lives in booking-status.ts, imported above, so the
// two guards count the same booking statuses.
const DUPLICATE_STAY_ERROR =
  "You already have a booking at this lodge for these dates. Cancel it before accepting this offer.";

type CrossLodgeOfferEntry = Prisma.BookingGetPayload<{
  include: {
    guests: { include: { nights: true } };
    promoRedemption: { select: { id: true } };
  };
}>;

async function revertOfferToWaitlisted(
  tx: Prisma.TransactionClient,
  entry: {
    id: string;
    checkIn: Date;
    checkOut: Date;
    lodgeId: string;
    updatedAt: Date;
    waitlistOfferedAt: Date | null;
    waitlistOfferExpiresAt: Date | null;
    waitlistOfferedLodgeId: string | null;
    waitlistOfferedPriceCents: number | null;
  },
): Promise<boolean> {
  const reverted = await tx.booking.updateMany({
    where: {
      id: entry.id,
      status: BookingStatus.WAITLIST_OFFERED,
      updatedAt: entry.updatedAt,
      waitlistOfferedAt: entry.waitlistOfferedAt,
      waitlistOfferExpiresAt: entry.waitlistOfferExpiresAt,
      waitlistOfferedLodgeId: entry.waitlistOfferedLodgeId,
      waitlistOfferedPriceCents: entry.waitlistOfferedPriceCents,
    },
    data: {
      status: BookingStatus.WAITLISTED,
      waitlistOfferedAt: null,
      waitlistOfferExpiresAt: null,
      waitlistOfferedLodgeId: null,
      waitlistOfferedPriceCents: null,
    },
  });
  if (reverted.count === 0) return false;
  await reconcileBedAllocationsForBookingWithLodgeLockHeld({
    bookingId: entry.id,
    db: tx,
    previousRange: { checkIn: entry.checkIn, checkOut: entry.checkOut },
  });
  return true;
}

/**
 * The member-facing sentence for a cross-lodge offer the OFFERED lodge's
 * minimum-stay rules refuse (#2363). Per-lodge policy resolution is
 * replace-not-merge (ADR-001 resolved question 3), so the offered lodge's rules
 * can differ entirely from the lodge the member queued at — this is not only a
 * "the rule changed" case. Plain sentence to the member; the frozen review
 * snapshot stays in the server log beside it.
 */
const CROSS_LODGE_MINIMUM_STAY_ERROR =
  "That lodge's minimum stay for these nights is longer than your stay, so " +
  "this offer cannot be confirmed. You've been returned to the waitlist.";

/**
 * Accept a cross-lodge waitlist offer (ADR-004): create-and-cancel, never
 * mutate. The waitlist entry keeps its lodge; a fresh booking is created at
 * the offered lodge through the standard creation path (which re-checks
 * capacity under that lodge's lock and re-prices from its seasons), then
 * the entry is cancelled with audit links between the two.
 *
 * The price quoted on the offer is re-checked first; if the lodge's rates
 * moved since the offer, the confirm is rejected, the stored quote is
 * refreshed, and the member re-confirms at the visible figure (owner
 * decision 2 — never silently charge a different price).
 */
export async function confirmCrossLodgeWaitlistOffer(
  bookingId: string,
  memberId: string,
): Promise<CrossLodgeConfirmResult> {
  // Phase 0 — #2363 minimum stay at the OFFERED lodge, evaluated OUTSIDE any
  // transaction (the house pattern for pre-write policy checks; Phase 1 below
  // holds that lodge's capacity lock, and a policy read on a second pool
  // connection underneath it is the shape `member-guest-add-policy.ts`
  // forbids). It matters here for two independent reasons: `createConfirmedBooking`
  // is called directly further down, so nothing else on this path would apply
  // the rule at all; and the offered lodge's policy set REPLACES rather than
  // merges with the club-wide set, so a lodge the member never chose can carry
  // rules their own lodge does not. Only an offer this member owns is
  // evaluated; Phase 1 re-derives ownership, status and expiry regardless.
  //
  // #2543 — set by the paid-up-adult check in Phase 0b below and returned on
  // success, so the member who has just accepted a repriced cross-lodge offer sees
  // the same explanation the offer email gave them rather than only a bigger
  // number. Null unless somebody on the promoted party is being repriced.
  let crossLodgeRateNotice: string | null = null;
  const preflight = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      memberId: true,
      status: true,
      checkIn: true,
      checkOut: true,
      waitlistOfferedLodgeId: true,
      waitlistOfferExpiresAt: true,
    },
  });
  if (
    preflight &&
    preflight.memberId === memberId &&
    preflight.status === BookingStatus.WAITLIST_OFFERED &&
    preflight.waitlistOfferedLodgeId &&
    // An already-expired offer keeps its existing "offer has expired" answer
    // from Phase 1 rather than being re-explained as a policy refusal.
    !(
      preflight.waitlistOfferExpiresAt &&
      preflight.waitlistOfferExpiresAt < new Date()
    )
  ) {
    const { validateMinimumStay } = await import("@/lib/booking-policies");
    const { aggregatePolicyExceptionViolations } = await import(
      "@/lib/booking-policy-exceptions"
    );
    const offeredLodgeId = preflight.waitlistOfferedLodgeId;
    const stay = await validateMinimumStay(
      preflight.checkIn,
      preflight.checkOut,
      offeredLodgeId,
    );
    if (!stay.valid) {
      const exceptionReview = aggregatePolicyExceptionViolations(stay.violations);
      logger.warn(
        {
          bookingId,
          offeredLodgeId,
          violations: exceptionReview.violations.map((violation) => ({
            policyId: violation.policyId,
            policyVersion: violation.policyVersion,
          })),
        },
        "Cross-lodge waitlist confirm refused: minimum-stay policy not satisfied",
      );
      // Fail closed WITHOUT consuming the offer, exactly as the no-longer-
      // eligible branch in Phase 1 does: the entry goes back to WAITLISTED so
      // the member keeps their place and the sweep can offer them their own
      // lodge (or this one again once the rule allows it).
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
          const current = await tx.booking.findUnique({
            where: { id: bookingId },
            select: {
              id: true,
              status: true,
              checkIn: true,
              checkOut: true,
              lodgeId: true,
              updatedAt: true,
              waitlistOfferedAt: true,
              waitlistOfferExpiresAt: true,
              waitlistOfferedLodgeId: true,
              waitlistOfferedPriceCents: true,
            },
          });
          if (current?.status !== BookingStatus.WAITLIST_OFFERED) return;
          for (const lodgeId of [offeredLodgeId, current.lodgeId].sort()) {
            await acquireLodgeCapacityLock(tx, lodgeId);
          }
          await revertOfferToWaitlisted(tx, current);
        });
      } catch (err) {
        logger.error(
          { err, bookingId },
          "Failed to revert cross-lodge offer after minimum-stay refusal",
        );
      }
      return {
        success: false,
        error: CROSS_LODGE_MINIMUM_STAY_ERROR,
        code: "MINIMUM_STAY_VIOLATION",
      };
    }

    // Phase 0b — #2543's paid-up-adult requirement, on the path that PROMOTES a
    // queue entry to a booking at another lodge.
    //
    // This path reached none of it. `confirmWaitlistOffer` gained the gate because
    // the sweep re-bases a stored waitlisted price at current rates and inherits
    // the unpaid-subscription reprice; the cross-lodge promotion does the same
    // thing and then calls `createConfirmedBooking` DIRECTLY, so the create
    // route's own gate never runs either. A party the create route would have
    // refused with a 409 and an override door could therefore be promoted here
    // and charged non-member rates instead — the reprice was universal, the
    // safeguards were not. Same defect the removal and modify-apply paths had, and
    // it is a consistency defect rather than a fresh policy question: the owner
    // decided the rule.
    //
    // Evaluated against the OFFERED lodge, like the minimum-stay check above it,
    // because that is the lodge the booking will exist at; club-wide as the rule
    // is, that is what the violation's `effectiveLodgeId` should name.
    //
    // Deliberately OUTSIDE any transaction, for both house reasons:
    // `resolveSubscriptionLockoutMode` can reseed the financial-year cache from
    // Xero, and Phase 1 below holds the offered lodge's capacity lock.
    const nonMemberPricing = await evaluateNonMemberPricingRequirements(prisma, {
      mode: await resolveSubscriptionLockoutMode(),
      lodgeId: offeredLodgeId,
      seasonYear: seasonYearOfStoredDate(preflight.checkIn),
      checkIn: preflight.checkIn,
      checkOut: preflight.checkOut,
      // Owner decision, 3 Aug 2026: the requirement follows the unfinancial
      // member, not only their bed. The enclosing condition has already
      // established that this offer belongs to `memberId`, so the entry's owner is
      // the member promoting it — and stays the owner of the booking Phase 2
      // creates, which is passed `effectiveMemberId: memberId`.
      bookingOwnerMemberId: preflight.memberId,
      participants: toSubscriptionLockoutParticipants(
        await prisma.bookingGuest.findMany({ where: { bookingId } }),
      ),
    });
    if (nonMemberPricing?.violation) {
      logger.warn(
        { bookingId, offeredLodgeId },
        "Cross-lodge waitlist confirm refused: no paid-up adult member on the booking (#2543)",
      );
      // Fail closed WITHOUT consuming the offer, exactly as the minimum-stay
      // branch above does, so the member keeps their place and can fix the party
      // or ask a Booking Officer instead of the offer being burnt.
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
          const current = await tx.booking.findUnique({
            where: { id: bookingId },
            select: {
              id: true,
              status: true,
              checkIn: true,
              checkOut: true,
              lodgeId: true,
              updatedAt: true,
              waitlistOfferedAt: true,
              waitlistOfferExpiresAt: true,
              waitlistOfferedLodgeId: true,
              waitlistOfferedPriceCents: true,
            },
          });
          if (current?.status !== BookingStatus.WAITLIST_OFFERED) return;
          for (const lodgeId of [offeredLodgeId, current.lodgeId].sort()) {
            await acquireLodgeCapacityLock(tx, lodgeId);
          }
          await revertOfferToWaitlisted(tx, current);
        });
      } catch (err) {
        logger.error(
          { err, bookingId },
          "Failed to revert cross-lodge offer after a paid-up-adult refusal",
        );
      }
      return {
        success: false,
        // The waitlist flavour of the shared refusal, byte-identical to the
        // same-lodge confirm's: both reject the offer WITHOUT consuming it, and the
        // bare sentence read as though the member had lost the offer AND their spot.
        // Shared through one formatter so the answer cannot depend on which lodge
        // the sweep happened to offer.
        error: formatMissingPaidUpAdultWaitlistRefusal(),
        code: "PAID_UP_ADULT_MEMBER_REQUIRED",
        paidUpAdultRefusal: buildPaidUpAdultRefusalBody(
          nonMemberPricing.violation,
        ),
      };
    }
    crossLodgeRateNotice = nonMemberPricing?.memberRateNotice ?? null;
  }

  // Phase 1 — validate the offer and re-check the quote under the offered
  // lodge's capacity lock.
  type Validated = {
    ok: true;
    entry: CrossLodgeOfferEntry;
    offeredLodgeId: string;
    quotedPriceCents: number;
  };
  let validated: Validated | { ok: false; result: CrossLodgeConfirmResult };
  try {
    validated = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      const entry = await tx.booking.findUnique({
        where: { id: bookingId },
        include: {
          guests: { include: { nights: true } },
          promoRedemption: { select: { id: true } },
        },
      });
      if (!entry) {
        return { ok: false as const, result: { success: false, error: "Booking not found" } };
      }
      if (entry.memberId !== memberId) {
        return { ok: false as const, result: { success: false, error: "Forbidden" } };
      }
      if (entry.status !== BookingStatus.WAITLIST_OFFERED) {
        return {
          ok: false as const,
          result: { success: false, error: "Booking is not in WAITLIST_OFFERED status" },
        };
      }
      if (entry.waitlistOfferExpiresAt && entry.waitlistOfferExpiresAt < new Date()) {
        return { ok: false as const, result: { success: false, error: "Waitlist offer has expired" } };
      }
      const offeredLodgeId = entry.waitlistOfferedLodgeId;
      if (!offeredLodgeId || entry.waitlistOfferedPriceCents === null) {
        return {
          ok: false as const,
          result: { success: false, error: "This offer is not a cross-lodge offer" },
        };
      }

      for (const lodgeId of [offeredLodgeId, entry.lodgeId].sort()) {
        await acquireLodgeCapacityLock(tx, lodgeId);
      }

      const offeredLodge = await tx.lodge.findUnique({
        where: { id: offeredLodgeId },
        select: { active: true },
      });
      const stillEligible =
        offeredLodge?.active &&
        (await isMemberEligibleToBookLodge(tx, memberId, offeredLodgeId));
      if (!stillEligible) {
        await revertOfferToWaitlisted(tx, entry);
        return {
          ok: false as const,
          result: {
            success: false,
            error:
              "That lodge is no longer available to you. You've been returned to the waitlist.",
          },
        };
      }

      // Duplicate-stay guard — layer 1 of 2 (#1587 item 2). If Phase 3 (cancel
      // the waitlist entry) failed on an earlier confirm, the entry is stranded
      // in WAITLIST_OFFERED with a booking already created at the offered lodge;
      // a re-confirm (or an expiry re-offer + confirm) would create a SECOND
      // booking and a second payment request for the same stay. Reject when the
      // member already holds an active booking overlapping the offer's dates at
      // the offered lodge. The offered lodge's capacity lock (taken above) spans
      // only THIS Phase-1 transaction, so this cheap pre-flight guard reliably
      // catches any COMMITTED earlier confirm (the stranded-offer re-confirm and
      // expiry-re-offer paths) and gives a friendly rejection before Phase 2
      // even starts. The concurrent-confirm window it once left open — two
      // in-flight confirms of the same offer both passing here before either
      // creates its booking in Phase 2 — is now closed by layer 2: the same
      // query re-runs INSIDE createConfirmedBooking under the offered lodge's
      // held capacity lock (duplicateStayGuard below), where the second
      // transaction serialises behind the first's commit and rolls back. The
      // entry itself is excluded by id, and waitlist placeholders never count.
      const duplicateStay = await tx.booking.findFirst({
        where: {
          memberId,
          lodgeId: offeredLodgeId,
          id: { not: entry.id },
          deletedAt: null,
          status: { in: [...DUPLICATE_STAY_BOOKING_STATUSES] },
          // Date-only overlap, matching the processor's overlap predicate.
          checkIn: { lt: entry.checkOut },
          checkOut: { gt: entry.checkIn },
        },
        select: { id: true },
      });
      if (duplicateStay) {
        return {
          ok: false as const,
          result: {
            success: false,
            error: DUPLICATE_STAY_ERROR,
            code: "DUPLICATE_STAY",
          },
        };
      }

      const { available } = await checkCapacityForGuestRanges(
        offeredLodgeId,
        entry.checkIn,
        entry.checkOut,
        entry.guests,
        undefined,
        tx,
      );
      if (!available) {
        await revertOfferToWaitlisted(tx, entry);
        return {
          ok: false as const,
          result: {
            success: false,
            error: "Capacity is no longer available. You've been returned to the waitlist.",
          },
        };
      }

      const quote = await quoteWaitlistEntryAtLodge(
        tx,
        {
          memberId: entry.memberId,
          checkIn: entry.checkIn,
          checkOut: entry.checkOut,
          guests: entry.guests,
          hasPromoRedemption: Boolean(entry.promoRedemption),
        },
        offeredLodgeId,
      );
      if (!quote.offerable) {
        await revertOfferToWaitlisted(tx, entry);
        return {
          ok: false as const,
          result: {
            success: false,
            error:
              "This lodge can no longer price your stay. You've been returned to the waitlist.",
          },
        };
      }
      if (quote.finalPriceCents !== entry.waitlistOfferedPriceCents) {
        // Rates moved between offer and confirm: refresh the stored quote
        // and ask the member to confirm the figure they can now see.
        await tx.booking.update({
          where: { id: entry.id },
          data: { waitlistOfferedPriceCents: quote.finalPriceCents },
        });
        return {
          ok: false as const,
          result: {
            success: false,
            error:
              "The price at this lodge has changed since your offer. Please review the updated price and confirm again.",
            updatedPriceCents: quote.finalPriceCents,
          },
        };
      }

      return {
        ok: true as const,
        entry,
        offeredLodgeId,
        quotedPriceCents: entry.waitlistOfferedPriceCents,
      };
    });
  } catch (err) {
    logger.error({ err, bookingId }, "Failed to validate cross-lodge waitlist confirm");
    return { success: false, error: "An error occurred while confirming your booking" };
  }
  if (!validated.ok) {
    return validated.result;
  }
  const { entry, offeredLodgeId, quotedPriceCents } = validated;

  // Phase 2 — create the fresh booking at the offered lodge through the
  // standard creation path. It re-acquires that lodge's capacity lock and
  // re-checks capacity itself, so the tiny window since phase 1 is safe.
  const guests: BookingGuestInput[] = entry.guests.map((guest) => ({
    firstName: guest.firstName,
    lastName: guest.lastName,
    ageTier: guest.ageTier,
    isMember: guest.isMember,
    memberId: guest.memberId ?? undefined,
    stayStart: guest.stayStart,
    stayEnd: guest.stayEnd,
    nights: guest.nights.length > 0 ? guest.nights : null,
  }));
  const hasNonMembers = guests.some((guest) => !guest.isMember);
  const holdDays = hasNonMembers ? await getNonMemberHoldDays(entry.checkIn, offeredLodgeId) : 7;
  const { shouldBePending, status } = calculateBookingHoldDecision({
    hasNonMembers,
    checkIn: entry.checkIn,
    holdDays,
  });

  let outcome;
  try {
    outcome = await createConfirmedBooking({
      // #3123 — the CLUB's day (`INV-CONFIG-002`). The three `prisma.$transaction`
      // spans this confirm runs have all closed by here, so this is a position
      // outside every lock; `createConfirmedBooking` is transaction-aware and
      // cannot resolve one for itself (`INV-LOCK-004`). The runtime reader
      // because `cron-waitlist.ts` reaches this module from
      // `src/instrumentation.node.ts`, where `server-only` throws at import.
      todayAtClub: clubToday(await readClubTimeZoneOutsideRequest()),
      effectiveMemberId: memberId,
      isOnBehalf: false,
      sessionUserId: memberId,
      checkIn: entry.checkIn,
      checkOut: entry.checkOut,
      guests,
      notes: entry.notes ?? undefined,
      expectedArrivalTime: entry.expectedArrivalTime ?? undefined,
      cancelIfGuestsBumped: entry.cancelIfGuestsBumped,
      memberReviewJustification: entry.memberReviewJustification ?? undefined,
      lodgeId: offeredLodgeId,
      status,
      shouldBePending,
      holdDays,
      // Layer 2 of the duplicate-stay guard (#1587 item 2): re-run the guard
      // inside the creation transaction, under the offered lodge's held lock,
      // so a fully-concurrent confirm of the same offer that slipped past
      // Phase 1 rolls back here instead of committing a duplicate booking.
      duplicateStayGuard: { excludeBookingId: entry.id },
      // A 48h offer accepted after NZ midnight can land past the entry's
      // check-in; the offered stay was validated when the offer was issued.
      allowPastCheckIn: true,
    });
  } catch (err) {
    if (isHostingCoverageParticipantRetry(err)) {
      return {
        success: false,
        error: HOSTING_COVERAGE_RETRY_MESSAGE,
        code: HOSTING_COVERAGE_RETRY_CODE,
      };
    }
    if (err instanceof DuplicateStayConflictError) {
      // A concurrent confirm committed a booking for the same stay after this
      // one passed Phase 1; the in-transaction guard rolled this creation back,
      // so no duplicate was created. Reject exactly as the Phase-1 guard does —
      // same message and code — and leave the offer intact (do NOT revert to
      // WAITLISTED) so the member can cancel the duplicate and re-confirm.
      return { success: false, error: DUPLICATE_STAY_ERROR, code: "DUPLICATE_STAY" };
    }
    // #2569 — the ENFORCED hosting refusal, raised by the reconciler inside
    // `createConfirmedBooking`'s transaction and answered here rather than being
    // swallowed by the generic handler below, which reported it as "an error
    // occurred": a member refused for a rule they can act on was told nothing and
    // given no exception door.
    //
    // The offer is left INTACT (not reverted to WAITLISTED), exactly as the
    // duplicate-stay rejection above leaves it: the creation rolled back, so the
    // entry is still WAITLIST_OFFERED on its original expiry and the member keeps
    // the chance to fix the party — or be approved — and confirm again. The
    // #2543 refusal a few lines up reverts instead, because an unpaid subscription
    // is not something a member can clear inside the offer window.
    if (err instanceof AdultMemberHostingRequiredError) {
      logger.warn(
        { bookingId, offeredLodgeId },
        "Cross-lodge waitlist confirm refused: non-member guest nights are not covered by an adult member (#2569)",
      );
      const refusal = buildAdultMemberHostingRefusalBody(err.violation);
      return {
        success: false,
        error: formatAdultMemberHostingWaitlistRefusal(refusal.error),
        code: refusal.code,
        adultMemberHostingRefusal: refusal,
      };
    }
    logger.error(
      { err, bookingId, offeredLodgeId },
      "Failed to create replacement booking for cross-lodge waitlist confirm",
    );
    return { success: false, error: "An error occurred while confirming your booking" };
  }

  if (outcome.type === "capacityExceeded") {
    try {
      const reverted = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        for (const lodgeId of [offeredLodgeId, entry.lodgeId].sort()) {
          await acquireLodgeCapacityLock(tx, lodgeId);
        }
        return revertOfferToWaitlisted(tx, entry);
      });
      if (!reverted) {
        return {
          success: false,
          error: "This waitlist offer changed while it was being confirmed. Refresh and try again.",
        };
      }
    } catch (err) {
      logger.error({ err, bookingId }, "Failed to revert cross-lodge offer after capacity loss");
    }
    return {
      success: false,
      error: "Capacity is no longer available. You've been returned to the waitlist.",
    };
  }

  const newBooking = outcome.booking;

  if (newBooking.finalPriceCents !== quotedPriceCents) {
    // The standard path must price exactly like the quote; a mismatch means
    // rates changed in the moments since phase 1. Never charge it silently:
    // cancel the fresh booking, refresh the stored quote, and ask again.
    try {
      const refreshedCurrentOffer = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        await acquireLodgeCapacityLock(tx, offeredLodgeId);
        const cancelled = await tx.booking.updateMany({
          where: { id: newBooking.id, status: newBooking.status },
          data: { status: BookingStatus.CANCELLED },
        });
        if (cancelled.count === 0) {
          throw new Error("Replacement booking changed before price-drift unwind");
        }
        await reconcileBedAllocationsForBookingWithLodgeLockHeld({
          bookingId: newBooking.id,
          db: tx,
          previousRange: { checkIn: newBooking.checkIn, checkOut: newBooking.checkOut },
        });
        const refreshedOffer = await tx.booking.updateMany({
          where: {
            id: entry.id,
            status: BookingStatus.WAITLIST_OFFERED,
            updatedAt: entry.updatedAt,
            waitlistOfferedAt: entry.waitlistOfferedAt,
            waitlistOfferExpiresAt: entry.waitlistOfferExpiresAt,
            waitlistOfferedLodgeId: entry.waitlistOfferedLodgeId,
            waitlistOfferedPriceCents: entry.waitlistOfferedPriceCents,
          },
          data: { waitlistOfferedPriceCents: newBooking.finalPriceCents },
        });
        return refreshedOffer.count === 1;
      });
      if (!refreshedCurrentOffer) {
        logger.warn(
          { bookingId, newBookingId: newBooking.id },
          "Price-drifted replacement was cancelled, but the waitlist offer epoch changed before its quote could be refreshed",
        );
        return {
          success: false,
          error: "This waitlist offer changed while it was being confirmed. Refresh and review the current offer.",
        };
      }
    } catch (err) {
      logger.error(
        { err, bookingId, newBookingId: newBooking.id },
        "Failed to unwind price-drifted cross-lodge confirm",
      );
      return { success: false, error: "An error occurred while confirming your booking" };
    }
    return {
      success: false,
      error:
        "The price at this lodge has changed since your offer. Please review the updated price and confirm again.",
      updatedPriceCents: newBooking.finalPriceCents,
    };
  }

  // Phase 3 — cancel the waitlist entry and link the two bookings. The
  // member already has the new booking; a failure here must not fail the
  // confirm, it just leaves cleanup for an admin (loudly logged).
  let waitlistEntryCleanupCompleted = false;
  try {
    const cancelledEntry = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await acquireLodgeCapacityLock(tx, entry.lodgeId);
      const cancelled = await tx.booking.updateMany({
        where: {
          id: entry.id,
          status: BookingStatus.WAITLIST_OFFERED,
          updatedAt: entry.updatedAt,
          waitlistOfferedAt: entry.waitlistOfferedAt,
          waitlistOfferExpiresAt: entry.waitlistOfferExpiresAt,
          waitlistOfferedLodgeId: entry.waitlistOfferedLodgeId,
          waitlistOfferedPriceCents: entry.waitlistOfferedPriceCents,
        },
        data: {
          status: BookingStatus.CANCELLED,
          waitlistPosition: null,
          waitlistOfferedAt: null,
          waitlistOfferExpiresAt: null,
          waitlistOfferedLodgeId: null,
          waitlistOfferedPriceCents: null,
          notes: [
            entry.notes,
            `Cross-lodge waitlist offer accepted; replaced by booking ${newBooking.id}.`,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      });
      if (cancelled.count === 0) return false;
      await reconcileBedAllocationsForBookingWithLodgeLockHeld({
        bookingId: entry.id,
        db: tx,
        previousRange: { checkIn: entry.checkIn, checkOut: entry.checkOut },
      });
      return true;
    });

    if (cancelledEntry) {
      waitlistEntryCleanupCompleted = true;
      await recordBookingEvent({
        bookingId: entry.id,
        type: BookingEventType.CANCELLED,
        actorMemberId: memberId,
      });
    } else {
      logger.warn(
        { waitlistBookingId: entry.id, newBookingId: newBooking.id },
        "Cross-lodge confirm created the new booking but lost the waitlist-entry cleanup claim",
      );
    }
  } catch (err) {
    logger.error(
      { err, waitlistBookingId: entry.id, newBookingId: newBooking.id },
      "Cross-lodge confirm created the new booking but failed to cancel the waitlist entry — needs admin cleanup",
    );
  }

  logAudit({
    action: "waitlist.cross_lodge_offer_confirmed",
    memberId,
    targetId: newBooking.id,
    subjectMemberId: memberId,
    entityType: "Booking",
    entityId: newBooking.id,
    category: "booking",
    outcome: "success",
    summary: "Cross-lodge waitlist offer confirmed",
    details: waitlistEntryCleanupCompleted
      ? `Waitlist entry ${entry.id} replaced by booking ${newBooking.id} at the offered lodge`
      : `Booking ${newBooking.id} was created at the offered lodge, but waitlist entry ${entry.id} changed before cleanup and needs review`,
    metadata: {
      waitlistBookingId: entry.id,
      newBookingId: newBooking.id,
      offeredLodgeId,
      priceCents: quotedPriceCents,
      newStatus: newBooking.status,
      waitlistEntryCleanupCompleted,
    },
  });

  return {
    success: true,
    newStatus: newBooking.status,
    newBookingId: newBooking.id,
    // #2543 — carry the "why" onto the confirm response, exactly as the same-lodge
    // path does. Spread conditionally so every other outcome keeps its previous
    // shape and a caller (or a test) comparing the whole object sees no new key on
    // a refusal or a paid-up party.
    ...(crossLodgeRateNotice
      ? { subscriptionMemberRateNotice: crossLodgeRateNotice }
      : {}),
  };
}
