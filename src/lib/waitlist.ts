import { prisma } from "./prisma";
import { BookingStatus, type AgeTier, type Prisma } from "@prisma/client";
import { acquireLodgeCapacityLock, checkCapacityForGuestRanges } from "./capacity";
import { addDaysDateOnly } from "@/lib/date-only";
import { getDefaultLodgeId } from "@/lib/lodges";
import { isMemberEligibleToBookLodge } from "@/lib/lodge-access";
import {
  confirmCrossLodgeWaitlistOffer,
  getWaitlistCrossLodgeOrder,
  quoteWaitlistEntryAtLodge,
} from "@/lib/waitlist-cross-lodge";
import { getNonMemberHoldPolicy } from "./cancellation";
import {
  sendWaitlistOfferEmail,
  sendWaitlistOfferExpiredEmail,
  sendAdminWaitlistOfferAlert,
} from "./email";
import { logAudit } from "./audit";
import logger from "@/lib/logger";
import { reconcileBedAllocationsForBookingWithGlobalLockHeld } from "@/lib/bed-allocation-lifecycle";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import {
  HOSTING_COVERAGE_RETRY_CODE,
  HOSTING_COVERAGE_RETRY_MESSAGE,
  isHostingCoverageParticipantRetry,
} from "@/lib/adult-member-hosting-queue-participants";
import {
  AdultMemberHostingRequiredError,
  buildAdultMemberHostingRefusalBody,
  reconcileAdultMemberHostingReviewWithSiblings,
} from "@/lib/adult-member-hosting-review";
import { priceBookingGuestsWithMembershipTypePolicy } from "@/lib/membership-type-policy";
import {
  loadSeasonRateData,
  recalculateBookingPromo,
} from "@/lib/booking-guest-removal-service";
import {
  calculateBookingHoldDecision,
  toGroupDiscountConfig,
} from "@/lib/policies/booking-route-decisions";
import { seasonYearOfStoredDate } from "@/lib/financial-year";
import type { SubscriptionLockoutMode } from "@/lib/membership-lockout-settings";
import { resolveSubscriptionLockoutMode } from "@/lib/member-subscription-eligibility";
import { clubToday, type CalendarDate } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import {
  buildPaidUpAdultRefusalBody,
  evaluateNonMemberPricingRequirements,
  toSubscriptionLockoutParticipants,
} from "@/lib/subscription-lockout-enforcement";
import { formatMissingPaidUpAdultWaitlistRefusal } from "@/lib/policies/subscription-lockout-pricing";
import { formatAdultMemberHostingWaitlistRefusal } from "@/lib/policies/adult-member-hosting";

export const WAITLIST_OFFER_HOURS =
  Number(process.env.WAITLIST_OFFER_HOURS) || 48;

// test seam
/**
 * Get the FIFO position for a waitlisted booking.
 * Counts WAITLISTED bookings with overlapping dates created before this one.
 */
export async function getWaitlistPosition(bookingId: string): Promise<number> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { checkIn: true, checkOut: true, createdAt: true, status: true, lodgeId: true },
  });

  if (!booking || (booking.status !== BookingStatus.WAITLISTED && booking.status !== BookingStatus.WAITLIST_OFFERED)) {
    return 0;
  }

  const ahead = await prisma.booking.count({
    where: {
      status: BookingStatus.WAITLISTED,
      // Positions are per-lodge: each lodge runs its own FIFO queue, so only
      // count entries waiting for the same lodge (multi-lodge).
      lodgeId: booking.lodgeId,
      checkIn: { lt: booking.checkOut },
      checkOut: { gt: booking.checkIn },
      createdAt: { lt: booking.createdAt },
    },
  });

  return ahead + 1;
}

// test seam
/**
 * Get all WAITLISTED bookings for one lodge overlapping a date range, ordered
 * FIFO. Scoped to a single lodge because each lodge runs its own queue
 * (multi-lodge).
 */
export async function getWaitlistForDates(
  checkIn: Date,
  checkOut: Date,
  lodgeId: string
) {
  return prisma.booking.findMany({
    where: {
      status: BookingStatus.WAITLISTED,
      lodgeId,
      checkIn: { lt: checkOut },
      checkOut: { gt: checkIn },
    },
    include: {
      guests: true,
      member: { select: { id: true, email: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: "asc" },
  });
}

type WaitlistCandidateForReprice = Prisma.BookingGetPayload<{
  include: {
    guests: { include: { nights: true } };
    promoRedemption: {
      include: {
        guestTargets: { select: { bookingGuestId: true } };
        promoCode: { include: { assignments: { select: { memberId: true } } } };
      };
    };
  };
}>;

/**
 * Reprice a waitlisted booking at current season rates, membership-type
 * policy, group discount, and promo validity, persisting the new totals and
 * per-guest prices (#1035). Returns the price the member will pay on
 * confirmation. On failure the stored snapshot is kept and returned — an
 * offer must never be blocked by a repricing edge case.
 */
async function repriceWaitlistCandidate(
  tx: Prisma.TransactionClient,
  candidate: WaitlistCandidateForReprice,
  // Lodge whose seasons price this entry (multi-lodge): the candidate's
  // own lodge. Upstream #1035 priced club-wide; per-lodge seasons make
  // that a lodge-scoped read here.
  lodgeId: string,
  // #3123 — the club's own calendar day, resolved by the sweep BEFORE it opened
  // this transaction, for exactly the same reason as the mode below and passed
  // the same way. It decides the promotion's validity window in the reprice, and
  // reading the club's persisted timezone here would be a
  // `clubTimeSettings.findUnique` on a second pooled connection while this
  // transaction holds every active lodge's capacity key (`INV-LOCK-004`).
  //
  // REQUIRED, and positioned ahead of the optional mode so it cannot be
  // defaulted: the default is what put this decision on the container's zone.
  todayAtClub: CalendarDate,
  // #2543 — the club's mode, resolved by the sweep BEFORE it opened this
  // transaction. This reprice inherits the unpaid-subscription reprice like every
  // other pricing call, and it passes no locked night prices, so the WHOLE stay
  // re-bases at current rates; being handed the mode keeps that consistent with
  // the offer the member is about to be sent and keeps a settings read out from
  // under the per-lodge capacity lock this transaction holds.
  subscriptionLockoutMode?: SubscriptionLockoutMode,
): Promise<number> {
  try {
    const seasonRateData = await loadSeasonRateData(tx, lodgeId);
    const groupDiscountSetting = await tx.groupDiscountSetting.findUnique({
      where: { id: "default" },
    });
    const guestsForPricing = candidate.guests.map((guest) => ({
      bookingGuestId: guest.id,
      ageTier: guest.ageTier as AgeTier,
      isMember: guest.isMember,
      memberId: guest.memberId ?? null,
      stayStart: guest.stayStart,
      stayEnd: guest.stayEnd,
      nights: guest.nights,
    }));

    const priceBreakdown = await priceBookingGuestsWithMembershipTypePolicy(tx, {
      ownerMemberId: candidate.memberId,
      checkIn: candidate.checkIn,
      checkOut: candidate.checkOut,
      guests: guestsForPricing,
      seasons: seasonRateData,
      groupDiscount: toGroupDiscountConfig(groupDiscountSetting),
      seasonYear: seasonYearOfStoredDate(candidate.checkIn),
      subscriptionLockoutMode,
      // Finding 2 (privacy re-review of MG3 #2308). An unattended sweep with no
      // member on the other end of the response: there is nobody to collapse the
      // refusal FOR, and the operator reading the failure needs the name.
      skipAuthorization: true,
    });

    const newTotalPriceCents = priceBreakdown.totalPriceCents;
    const guestNightRates = guestsForPricing.map((guest, index) => ({
      bookingGuestId: guest.bookingGuestId,
      memberId: guest.memberId,
      isMember: guest.isMember,
      perNightRates: priceBreakdown.guests[index].perNightCents,
      nightDates: priceBreakdown.guests[index].nightDates,
      firstNight: candidate.checkIn,
    }));
    const promoResult = await recalculateBookingPromo({
      tx,
      bookingId: candidate.id,
      booking: candidate,
      newTotalPriceCents,
      guestNightRates,
      todayAtClub,
    });
    const newFinalPriceCents =
      newTotalPriceCents + promoResult.newPromoAdjustmentCents;

    await Promise.all(
      candidate.guests.map((guest, index) =>
        tx.bookingGuest.update({
          where: { id: guest.id },
          // Reprice overwrites the rate-membership-type snapshot alongside the
          // price (#1930, E4): the offer re-bases the whole booking at current
          // rates before the member confirms.
          data: {
            priceCents: priceBreakdown.guests[index].priceCents,
            rateMembershipTypeId:
              priceBreakdown.guests[index].rateMembershipTypeId,
          },
        })
      )
    );
    await tx.booking.update({
      where: { id: candidate.id },
      data: {
        totalPriceCents: newTotalPriceCents,
        discountCents: promoResult.newDiscountCents,
        promoAdjustmentCents: promoResult.newPromoAdjustmentCents,
        finalPriceCents: newFinalPriceCents,
      },
    });

    if (newFinalPriceCents !== candidate.finalPriceCents) {
      logger.info(
        {
          bookingId: candidate.id,
          previousFinalPriceCents: candidate.finalPriceCents,
          newFinalPriceCents,
          promoRemoved: promoResult.promoRemoved,
          // #2390: this reprice shares `recalculateBookingPromo` with guest
          // removal, so it inherits the same rule — nobody already benefiting
          // loses the discount. An offer-time reprice has no member in front of
          // it to tell, so the split is logged for the admin instead.
          promoCoverageNote: promoResult.promoCoverage?.message ?? null,
        },
        "Repriced waitlisted booking at offer time"
      );
    }

    return newFinalPriceCents;
  } catch (err) {
    logger.error(
      { err, bookingId: candidate.id },
      "Failed to reprice waitlisted booking at offer time; offering at the stored snapshot"
    );
    return candidate.finalPriceCents;
  }
}

/**
 * Main orchestrator: when capacity is freed, find the top FIFO candidate
 * whose full date range has capacity and offer them the spot.
 *
 * Cross-lodge pass (ADR-004): pass the lodge where capacity actually freed
 * via `freedDates.lodgeId` and candidates from other lodges who opted into
 * that lodge become eligible for a cross-lodge offer there — after that
 * lodge's own queue under OWN_LODGE_FIRST, or purely by join order under
 * MERGED. Same-lodge offers behave exactly as before; callers that omit
 * lodgeId get the pre-ADR-004 behaviour against the default lodge.
 */
export async function processWaitlistForDates(freedDates: {
  checkIn: Date;
  checkOut: Date;
  lodgeId?: string | null;
}): Promise<{ offeredBookingId: string | null }> {
  let offeredBookingId: string | null = null;
  type OfferDetails = {
    email: string;
    firstName: string;
    checkIn: Date;
    checkOut: Date;
    guestCount: number;
    expiresAt: Date;
    bookingId: string;
    memberId: string;
    memberName: string;
    position: number;
    lodgeId: string | null;
    // Price the member pays on confirmation: the offer-time reprice
    // (upstream #1035) for own-lodge offers, or the offered lodge's quote
    // for cross-lodge offers (ADR-004).
    finalPriceCents: number;
    // Set only for a cross-lodge offer: the alternate lodge being offered
    // and the price quoted for it (ADR-004).
    offeredLodgeId: string | null;
    offeredLodgeName: string | null;
    offeredPriceCents: number | null;
  };
  let offerDetails = null as OfferDetails | null;

  // #2543 — resolved ONCE, before the transaction below takes the per-lodge
  // capacity lock. `resolveSubscriptionLockoutMode` can refresh the
  // financial-year cache from Xero, which must never happen inside it.
  const subscriptionLockoutMode = await resolveSubscriptionLockoutMode();
  // #3123 — and the club's own day, resolved here for the same reason: the
  // offer-time reprice inside the transaction below judges the booking's
  // promotion against it, and the club's persisted timezone must not be read
  // while every active lodge's capacity key is held (`INV-LOCK-004`). The
  // runtime reader, not `club-time/server`: this module is reachable from
  // `src/instrumentation.node.ts` through `cron-waitlist.ts`.
  const todayAtClub = clubToday(await readClubTimeZoneOutsideRequest());

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      const defaultLodgeId = await getDefaultLodgeId(tx);
      const freedLodgeId = freedDates.lodgeId ?? defaultLodgeId;
      // Own-lodge checks span every candidate's lodge and the cross-lodge
      // pass offers at the freed lodge, so hold every active lodge's
      // capacity lock. Sorted order keeps concurrent processors
      // deadlock-free; the club has a handful of lodges at most.
      //
      // Accepted trade-off (#1565, owner-decided 2026-07-08): this
      // serializes the whole waitlist path club-wide, partly negating the
      // per-lodge lock isolation the booking path gained in the multi-lodge
      // work. Keep it — correctness (stable candidate statuses, no
      // cross-call double-offers) beats throughput at club scale. Narrow
      // the lock set to {freed lodge} ∪ {eligible candidates' alternate
      // lodges} only if real-world contention is ever observed, and only
      // with careful re-validation under lock to stay double-offer-safe.
      const activeLodges = await tx.lodge.findMany({
        where: { active: true },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      const lockLodgeIds = Array.from(
        new Set([...activeLodges.map((lodge) => lodge.id), defaultLodgeId]),
      ).sort();
      for (const lockLodgeId of lockLodgeIds) {
        await acquireLodgeCapacityLock(tx, lockLodgeId);
      }

      const candidates = await tx.booking.findMany({
        where: {
          status: BookingStatus.WAITLISTED,
          checkIn: { lt: freedDates.checkOut },
          checkOut: { gt: freedDates.checkIn },
          // #2258: a waitlist entry with the "No emails" switch on is NOT a
          // candidate. Making an offer stamps waitlistOfferExpiresAt inside this
          // transaction and starts the offer clock; the offer email goes out
          // un-awaited after commit. If that email were withheld, the entry
          // would hold a bed for the whole offer window with the member never
          // told, then lapse via expireStaleOffers() — and the admin board would
          // render it as a missing/undeliverable offer email, indistinguishable
          // from a bounce. Excluding the entry means the clock never starts: the
          // place goes to the next candidate and the suppressed entry keeps its
          // WAITLISTED position for when the switch is cleared.
          noEmails: false,
        },
        include: {
          guests: { include: { nights: true } }, // per-night sets (issue #713)
          member: { select: { id: true, email: true, firstName: true, lastName: true } },
          waitlistAlternateLodges: { select: { lodgeId: true } },
          // Full promo shape for the offer-time reprice (upstream #1035);
          // the cross-lodge quote only needs its existence.
          promoRedemption: {
            include: {
              guestTargets: { select: { bookingGuestId: true } },
              promoCode: {
                include: { assignments: { select: { memberId: true } } },
              },
            },
          },
        },
        orderBy: { createdAt: "asc" },
      });

      // One "opportunity" is a candidate considered at one lodge. Every
      // candidate gets an own-lodge opportunity (pre-ADR-004 behaviour);
      // candidates from other lodges who opted into the freed lodge also
      // get a cross-lodge opportunity there.
      type Opportunity = {
        candidate: (typeof candidates)[number];
        offerLodgeId: string;
        cross: boolean;
      };
      const ownOpportunities: Opportunity[] = candidates.map((candidate) => ({
        candidate,
        offerLodgeId: candidate.lodgeId ?? defaultLodgeId,
        cross: false,
      }));
      const crossOpportunities: Opportunity[] = candidates
        .filter(
          (candidate) =>
            (candidate.lodgeId ?? defaultLodgeId) !== freedLodgeId &&
            candidate.waitlistAlternateLodges.some(
              (alternate) => alternate.lodgeId === freedLodgeId,
            ),
        )
        .map((candidate) => ({
          candidate,
          offerLodgeId: freedLodgeId,
          cross: true,
        }));

      let opportunities: Opportunity[];
      if (crossOpportunities.length === 0) {
        opportunities = ownOpportunities;
      } else {
        const order = await getWaitlistCrossLodgeOrder(tx);
        opportunities =
          order === "MERGED"
            ? [...ownOpportunities, ...crossOpportunities].sort(
                (a, b) =>
                  a.candidate.createdAt.getTime() -
                    b.candidate.createdAt.getTime() ||
                  // Same entry considered at two lodges: its own lodge first.
                  Number(a.cross) - Number(b.cross),
              )
            : [...ownOpportunities, ...crossOpportunities];
      }

      for (const { candidate, offerLodgeId, cross } of opportunities) {
        // Check if ALL nights in the candidate's range have capacity
        const { available } = await checkCapacityForGuestRanges(
          offerLodgeId,
          candidate.checkIn,
          candidate.checkOut,
          candidate.guests,
          undefined,
          tx
        );
        if (!available) continue;

        let offeredLodgeId: string | null = null;
        let offeredLodgeName: string | null = null;
        let offeredPriceCents: number | null = null;
        let offerPriceCents: number;
        if (cross) {
          // Cross-lodge gates (ADR-004): the member must still be eligible
          // for the offered lodge and its seasons must price the dates. The
          // entry itself is NOT repriced — the quote is what a fresh
          // booking at the offered lodge costs, re-checked at confirm.
          const eligible = await isMemberEligibleToBookLodge(
            tx,
            candidate.memberId,
            offerLodgeId,
          );
          if (!eligible) continue;
          const quote = await quoteWaitlistEntryAtLodge(
            tx,
            {
              memberId: candidate.memberId,
              checkIn: candidate.checkIn,
              checkOut: candidate.checkOut,
              guests: candidate.guests,
              hasPromoRedemption: Boolean(candidate.promoRedemption),
            },
            offerLodgeId,
          );
          if (!quote.offerable) continue;
          const offeredLodge = await tx.lodge.findUnique({
            where: { id: offerLodgeId },
            select: { name: true },
          });
          offeredLodgeId = offerLodgeId;
          offeredLodgeName = offeredLodge?.name ?? null;
          offeredPriceCents = quote.finalPriceCents;
          offerPriceCents = quote.finalPriceCents;
        } else {
          // Reprice at current rates when the offer is issued (upstream
          // #1035): the creation-time snapshot is not a price lock. Season
          // rates, membership types, or the promo's validity may have
          // changed while it waited; the offer email shows the price the
          // member will actually pay. A repricing failure falls back to
          // the stored snapshot rather than blocking the offer.
          offerPriceCents = await repriceWaitlistCandidate(
            tx,
            candidate,
            offerLodgeId,
            todayAtClub,
            subscriptionLockoutMode,
          );
        }

        const expiresAt = new Date(Date.now() + WAITLIST_OFFER_HOURS * 60 * 60 * 1000);

        await tx.booking.update({
          where: { id: candidate.id },
          data: {
            status: BookingStatus.WAITLIST_OFFERED,
            waitlistOfferedAt: new Date(),
            waitlistOfferExpiresAt: expiresAt,
            waitlistOfferedLodgeId: offeredLodgeId,
            waitlistOfferedPriceCents: offeredPriceCents,
          },
        });
        await reconcileBedAllocationsForBookingWithGlobalLockHeld({
          bookingId: candidate.id,
          db: tx,
          previousRange: {
            checkIn: candidate.checkIn,
            checkOut: candidate.checkOut,
          },
        });

                offeredBookingId = candidate.id;

        // Count position (how many were ahead in queue). Per-lodge: the
        // position shown to the member counts only entries waiting for their
        // own lodge, matching the per-lodge FIFO queue (multi-lodge).
        const position = await tx.booking.count({
          where: {
            status: BookingStatus.WAITLISTED,
            lodgeId: candidate.lodgeId ?? defaultLodgeId,
            checkIn: { lt: candidate.checkOut },
            checkOut: { gt: candidate.checkIn },
            createdAt: { lt: candidate.createdAt },
          },
        });

        offerDetails = {
          email: candidate.member.email,
          firstName: candidate.member.firstName,
          checkIn: candidate.checkIn,
          checkOut: candidate.checkOut,
          guestCount: candidate.guests.length,
          expiresAt,
          bookingId: candidate.id,
          memberId: candidate.memberId,
          memberName: `${candidate.member.firstName} ${candidate.member.lastName}`,
          position: position + 1,
          lodgeId: candidate.lodgeId,
          finalPriceCents: offerPriceCents,
          offeredLodgeId,
          offeredLodgeName,
          offeredPriceCents,
        };

        break; // Only offer to the top candidate
      }
    });
  } catch (err) {
    logger.error({ err }, "Failed to process waitlist for dates");
    return { offeredBookingId: null };
  }

  // Send emails after transaction commits
  if (offerDetails) {
    // #2543 — "tell them why", on the surface the member actually reads BEFORE
    // deciding. The reprice above can raise a stored waitlisted price by the whole
    // member/non-member spread, and the offer email states that number; without
    // this the member is shown a bigger figure and no reason for it. Evaluated
    // after the commit, on the module client, so no read is added under the
    // capacity lock; a failure degrades to the old wording rather than losing the
    // offer, because an offer must never be blocked by an explanatory sentence.
    let subscriptionMemberRateNotice: string | null = null;
    try {
      const nonMemberPricing = await evaluateNonMemberPricingRequirements(prisma, {
        mode: subscriptionLockoutMode,
        lodgeId: offerDetails.offeredLodgeId ?? offerDetails.lodgeId ?? "",
        seasonYear: seasonYearOfStoredDate(offerDetails.checkIn),
        checkIn: offerDetails.checkIn,
        checkOut: offerDetails.checkOut,
        // Owner decision, 3 Aug 2026. Threaded for consistency with the confirm
        // path below, which is where the refusal lives; this call reads only the
        // rate notice, and that notice is keyed on an actual reprice, so an
        // unfinancial owner who holds no bed changes nothing here.
        bookingOwnerMemberId: offerDetails.memberId,
        participants: toSubscriptionLockoutParticipants(
          await prisma.bookingGuest.findMany({
            where: { bookingId: offerDetails.bookingId },
          }),
        ),
      });
      subscriptionMemberRateNotice = nonMemberPricing?.memberRateNotice ?? null;
    } catch (err) {
      logger.error(
        { err, bookingId: offerDetails.bookingId },
        "Failed to resolve the #2543 member-rate notice for a waitlist offer",
      );
    }

    sendWaitlistOfferEmail(
      {
        bookingId: offerDetails.bookingId,
        recipientMemberId: offerDetails.memberId,
      },
      offerDetails.email,
      offerDetails.firstName,
      offerDetails.checkIn,
      offerDetails.checkOut,
      offerDetails.guestCount,
      offerDetails.expiresAt,
      offerDetails.bookingId,
      // Price the member pays on confirmation (upstream #1035): the
      // offer-time reprice, or the offered lodge's quote for cross offers.
      offerDetails.finalPriceCents,
      // A cross-lodge offer speaks with the offered lodge's identity and
      // must name that lodge (ADR-004 owner decision 2).
      offerDetails.offeredLodgeId ?? offerDetails.lodgeId,
      offerDetails.offeredLodgeId
        ? { lodgeName: offerDetails.offeredLodgeName }
        : null,
      // #2543 — why the price is what it is, when somebody on this booking is
      // being priced as a non-member. Null for every other offer.
      subscriptionMemberRateNotice
    ).catch((err) => logger.error({ err }, "Failed to send waitlist offer email"));

    sendAdminWaitlistOfferAlert({
      memberName: offerDetails.memberName,
      checkIn: offerDetails.checkIn,
      checkOut: offerDetails.checkOut,
      guestCount: offerDetails.guestCount,
      position: offerDetails.position,
    }).catch((err) => logger.error({ err }, "Failed to send admin waitlist offer alert"));

    logAudit({
      action: "waitlist.offer_sent",
      memberId: null,
      targetId: offerDetails.bookingId,
      subjectMemberId: offerDetails.memberId,
      entityType: "Booking",
      entityId: offerDetails.bookingId,
      category: "booking",
      outcome: "success",
      summary: "Waitlist offer sent",
      details: `Waitlist offer sent to ${offerDetails.memberName}`,
      metadata: {
        checkIn: offerDetails.checkIn.toISOString(),
        checkOut: offerDetails.checkOut.toISOString(),
        guestCount: offerDetails.guestCount,
        position: offerDetails.position,
        expiresAt: offerDetails.expiresAt.toISOString(),
        ...(offerDetails.offeredLodgeId
          ? {
              offeredLodgeId: offerDetails.offeredLodgeId,
              offeredPriceCents: offerDetails.offeredPriceCents,
            }
          : {}),
      },
    });
  }

  return { offeredBookingId };
}

/**
 * Put a same-lodge offer back on the waitlist, in its own short transaction
 * under the lodge's capacity lock. Same writes as the capacity-lost branch
 * inside `confirmWaitlistOffer`, status-guarded so it can never resurrect an
 * offer a concurrent expiry or cancel has already moved on.
 */
async function revertSameLodgeOfferToWaitlisted(
  bookingId: string,
  lodgeId: string,
  previousRange: { checkIn: Date; checkOut: Date }
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    await acquireLodgeCapacityLock(tx, lodgeId);
    const restored = await tx.booking.updateMany({
      where: { id: bookingId, status: BookingStatus.WAITLIST_OFFERED },
      data: {
        status: BookingStatus.WAITLISTED,
        waitlistOfferedAt: null,
        waitlistOfferExpiresAt: null,
        waitlistOfferedLodgeId: null,
        waitlistOfferedPriceCents: null,
      },
    });
    if (restored.count === 1) {
      await reconcileBedAllocationsForBookingWithGlobalLockHeld({
        bookingId,
        db: tx,
        previousRange,
      });
    }
  });
}

/**
 * The member-facing sentence for a same-lodge offer the minimum-stay policy no
 * longer allows (#2363). It names the situation and the remedy without naming
 * the rule, its night counts or its trigger days: this is the same discretion
 * the public group-join surfaces keep, and the member cannot act on the detail
 * anyway — a waitlist entry's dates are fixed. The frozen review snapshot stays
 * server-side in the log line beside it.
 */
const WAITLIST_MINIMUM_STAY_ERROR =
  "The minimum stay for these nights has changed since you joined the waitlist, " +
  "so this offer can no longer be confirmed. You've been returned to the waitlist.";

/**
 * The answer when the offer moved between the UNLOCKED pre-read that decides
 * which checks to run and the locked transaction that claims it (#2363).
 *
 * This is not a refusal of the offer and it is not a policy verdict: nothing has
 * been written, no offer consumed and no status changed, so the member simply
 * confirms again and that attempt re-reads the row from scratch — with the
 * minimum-stay guard evaluating for real this time.
 */
const WAITLIST_CONFIRM_RETRY_ERROR =
  "This offer was updated a moment ago. Please try confirming it again.";

/**
 * Confirm a waitlist offer. Re-checks capacity and transitions to
 * PAYMENT_PENDING or PENDING based on member/non-member rules.
 *
 * A cross-lodge offer (ADR-004, waitlistOfferedLodgeId set) takes the
 * create-and-cancel path instead: a fresh booking at the offered lodge and
 * the entry cancelled, with `newBookingId` pointing at the replacement.
 *
 * #2363: both paths re-check the CURRENT minimum-stay policy set before the
 * offer is turned into held capacity. An offer lives 48 hours, and an admin or
 * a config import can tighten or add a rule inside that window, so a confirm is
 * a fresh commitment to those nights and is held to the same rule as every
 * other one. There is no admin branch here BY CONSTRUCTION: the transaction
 * below refuses any actor other than the booking's own member with "Forbidden",
 * so the only actor that ever reaches the check is a non-admin confirming their
 * own offer. The same-lodge check runs on an unlocked pre-read, so the claiming
 * transaction carries a backstop: an offer it finds live but that the pre-read
 * did not classify the same way is refused with "CONFIRM_RETRY" and no write,
 * rather than claimed with the policy unevaluated.
 */
export async function confirmWaitlistOffer(
  bookingId: string,
  memberId: string
): Promise<{
  success: boolean;
  newStatus?: BookingStatus;
  error?: string;
  newBookingId?: string;
  updatedPriceCents?: number;
  // Machine-readable rejection code the API route surfaces to the client:
  // "DUPLICATE_STAY" forwarded from the cross-lodge path,
  // "MINIMUM_STAY_VIOLATION" from the policy re-check below, or
  // "CONFIRM_RETRY" when the offer changed under the pre-read and the claim
  // refused without writing anything (the route answers 409 — retry), or
  // "PAID_UP_ADULT_MEMBER_REQUIRED" from the #2543 re-check below, or
  // "ADULT_MEMBER_HOSTING_REQUIRED" from the #2569 ENFORCED consequence, raised
  // by the in-transaction reconciler and translated in the catch below.
  code?: string;
  /**
   * The shared #2543 refusal body — frozen violation, HOLD promise and the path
   * to ask a Booking Officer — present ONLY on the paid-up-adult refusal, so this
   * path answers with the same shape as the five booking write paths instead of a
   * bare message the member cannot act on.
   */
  paidUpAdultRefusal?: ReturnType<typeof buildPaidUpAdultRefusalBody>;
  /**
   * The shared #2569 refusal body — frozen violation, redacted host identities,
   * capacity mode and the path to ask a Booking Officer — present ONLY on the
   * ENFORCED hosting refusal. Named identically on the cross-lodge result so the
   * route spreads whichever one it gets, exactly as `paidUpAdultRefusal` is.
   */
  adultMemberHostingRefusal?: ReturnType<
    typeof buildAdultMemberHostingRefusalBody
  >;
  /**
   * #2543 "tell them why": non-null when this offer prices somebody at non-member
   * rates for an unpaid season subscription. Returned so the confirming member
   * sees the reason alongside the figure they just accepted, matching the offer
   * email.
   */
  subscriptionMemberRateNotice?: string | null;
}> {
  const offerKind = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      waitlistOfferedLodgeId: true,
      memberId: true,
      status: true,
      lodgeId: true,
      checkIn: true,
      checkOut: true,
      waitlistOfferExpiresAt: true,
    },
  });
  if (offerKind?.waitlistOfferedLodgeId) {
    return confirmCrossLodgeWaitlistOffer(bookingId, memberId);
  }

  // Did the same-lodge minimum-stay check below ACTUALLY run against this offer?
  // The check is conditional (the pre-read has to have seen a live same-lodge
  // offer this member owns), and its inputs come from an unlocked read, so this
  // flag — not the presence of the check in the source — is what the claiming
  // transaction treats as evidence that the policy was evaluated.
  let minimumStayCheckedOffer = false;
  // #2543 — set by the pre-transaction check below and returned on success.
  let subscriptionMemberRateNotice: string | null = null;

  // #2363, same-lodge offer: evaluate the booking's own lodge against the
  // current policy set. Deliberately OUTSIDE the transaction below, like every
  // other pre-write policy check in this repo — that transaction holds the
  // per-lodge capacity lock, and a policy read on a second pool connection
  // underneath it is the shape `member-guest-add-policy.ts` forbids. Only an
  // offer this member actually owns is evaluated, so the check cannot answer
  // anything about somebody else's booking; the transaction re-derives
  // ownership, status and expiry regardless.
  if (
    offerKind &&
    offerKind.memberId === memberId &&
    offerKind.status === BookingStatus.WAITLIST_OFFERED &&
    // An already-expired offer keeps its existing "offer has expired" answer
    // from the transaction below rather than being re-explained as a refusal.
    !(
      offerKind.waitlistOfferExpiresAt &&
      offerKind.waitlistOfferExpiresAt < new Date()
    )
  ) {
    const { validateMinimumStay } = await import("@/lib/booking-policies");
    const { aggregatePolicyExceptionViolations } = await import(
      "@/lib/booking-policy-exceptions"
    );
    const offerLodgeId = offerKind.lodgeId ?? (await getDefaultLodgeId(prisma));
    const stay = await validateMinimumStay(
      offerKind.checkIn,
      offerKind.checkOut,
      offerLodgeId
    );
    if (!stay.valid) {
      const exceptionReview = aggregatePolicyExceptionViolations(stay.violations);
      logger.warn(
        {
          bookingId,
          offerLodgeId,
          violations: exceptionReview.violations.map((violation) => ({
            policyId: violation.policyId,
            policyVersion: violation.policyVersion,
          })),
        },
        "Waitlist confirm refused: minimum-stay policy no longer satisfied"
      );
      // Fail closed WITHOUT consuming the offer: put the entry back on the
      // waitlist exactly as the capacity-lost branch below does, so the member
      // keeps their place and the next sweep can re-offer these nights (or the
      // admin can relax the rule) instead of the offer being burnt.
      await revertSameLodgeOfferToWaitlisted(bookingId, offerLodgeId, {
        checkIn: offerKind.checkIn,
        checkOut: offerKind.checkOut,
      }).catch((err) =>
        logger.error(
          { err, bookingId },
          "Failed to revert waitlist offer after minimum-stay refusal"
        )
      );
      return {
        success: false,
        error: WAITLIST_MINIMUM_STAY_ERROR,
        code: "MINIMUM_STAY_VIOLATION",
      };
    }
    // #2543 — the paid-up-adult requirement, on the sixth money path.
    //
    // The sweep above rewrites this stored booking's money at current rates and
    // inherits the unpaid-subscription reprice, but neither of the two things that
    // make that reprice FAIR to the member reached this path: the explanation, and
    // the refusal when no paid-up adult member is on the booking. So a party the
    // create path would have refused with a 409 and an override door could be
    // confirmed here and charged non-member rates instead — the reprice was
    // universal, the safeguards were wired to five hand-picked routes.
    //
    // Same shape as the minimum-stay check above, deliberately: evaluated OUTSIDE
    // the transaction (which holds the per-lodge capacity lock), and it fails
    // closed WITHOUT consuming the offer, so the member keeps their place and can
    // fix the party or ask a Booking Officer instead of the offer being burnt.
    const nonMemberPricing = await evaluateNonMemberPricingRequirements(prisma, {
      mode: await resolveSubscriptionLockoutMode(),
      lodgeId: offerLodgeId,
      seasonYear: seasonYearOfStoredDate(offerKind.checkIn),
      checkIn: offerKind.checkIn,
      checkOut: offerKind.checkOut,
      // Owner decision, 3 Aug 2026. The guard above has already established that
      // this offer belongs to `memberId`, so the booking's owner is the member
      // confirming it.
      bookingOwnerMemberId: offerKind.memberId,
      participants: toSubscriptionLockoutParticipants(
        await prisma.bookingGuest.findMany({ where: { bookingId } }),
      ),
    });
    if (nonMemberPricing?.violation) {
      logger.warn(
        { bookingId, offerLodgeId },
        "Waitlist confirm refused: no paid-up adult member on the booking (#2543)",
      );
      await revertSameLodgeOfferToWaitlisted(bookingId, offerLodgeId, {
        checkIn: offerKind.checkIn,
        checkOut: offerKind.checkOut,
      }).catch((err) =>
        logger.error(
          { err, bookingId },
          "Failed to revert waitlist offer after a paid-up-adult refusal",
        ),
      );
      return {
        success: false,
        // The waitlist flavour of the shared refusal: identical to the cross-lodge
        // promotion's, and distinct from the booking-time paths' because this one
        // rejected the offer WITHOUT consuming it, and the member needs telling.
        error: formatMissingPaidUpAdultWaitlistRefusal(),
        code: "PAID_UP_ADULT_MEMBER_REQUIRED",
        paidUpAdultRefusal: buildPaidUpAdultRefusalBody(
          nonMemberPricing.violation,
        ),
      };
    }
    subscriptionMemberRateNotice = nonMemberPricing?.memberRateNotice ?? null;

    minimumStayCheckedOffer = true;
  }

  let result: {
    success: boolean;
    newStatus?: BookingStatus;
    error?: string;
    code?: string;
  };

  try {
    result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      const lockTarget = await tx.booking.findUnique({
        where: { id: bookingId },
        select: { lodgeId: true },
      });
      if (!lockTarget) {
        return { success: false, error: "Booking not found" };
      }
      const bookingLodgeId = lockTarget.lodgeId ?? (await getDefaultLodgeId(tx));
      await acquireLodgeCapacityLock(tx, bookingLodgeId);

      // Expiry takes the same lodge lock. Re-read all transition inputs only
      // after the lock so a completed expiry cannot be resurrected from a stale
      // WAITLIST_OFFERED snapshot.
      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        include: { guests: { include: { nights: true } } }, // per-night sets (issue #713)
      });

      if (!booking) {
        return { success: false, error: "Booking not found" };
      }

      if (booking.memberId !== memberId) {
        return { success: false, error: "Forbidden" };
      }

      if (booking.status !== BookingStatus.WAITLIST_OFFERED) {
        return { success: false, error: "Booking is not in WAITLIST_OFFERED status" };
      }

      const confirmedAt = new Date();
      if (booking.waitlistOfferExpiresAt && booking.waitlistOfferExpiresAt < confirmedAt) {
        return { success: false, error: "Waitlist offer has expired" };
      }

      // #2363 policy backstop for the check above, which ran on an UNLOCKED
      // pre-read and only when that read saw a live same-lodge offer this member
      // owns. `processWaitlistForDates` performs exactly the transition that
      // invalidates it — WAITLISTED -> WAITLIST_OFFERED — and this route carries
      // no rate limit, so an entry read as WAITLISTED (or as expired, or as
      // somebody else's) can be a live same-lodge offer by the time this locked
      // read happens. Without this gate the claim below would spend that offer
      // with the current minimum-stay policy never evaluated.
      //
      // `waitlistOfferedLodgeId` is re-read here for the mirror image: an offer
      // that became a CROSS-lodge one after the dispatch decision at the top of
      // this function must go back through that dispatch, not be claimed as a
      // same-lodge offer whose policy was checked at the wrong lodge.
      //
      // Refusing is retry-safe BY CONSTRUCTION: nothing is written, no status
      // moves, no allocation is touched and the offer is not consumed, so the
      // caller re-enters with a fresh pre-read and the guard evaluates for real.
      if (!minimumStayCheckedOffer || booking.waitlistOfferedLodgeId) {
        return {
          success: false,
          error: WAITLIST_CONFIRM_RETRY_ERROR,
          code: "CONFIRM_RETRY",
        };
      }

      // Re-check capacity
      const { available } = await checkCapacityForGuestRanges(
        bookingLodgeId,
        booking.checkIn,
        booking.checkOut,
        booking.guests,
        undefined,
        tx
      );

      if (!available) {
        // Revert to WAITLISTED
        await tx.booking.updateMany({
          where: { id: bookingId, status: BookingStatus.WAITLIST_OFFERED },
          data: {
            status: BookingStatus.WAITLISTED,
            waitlistOfferedAt: null,
            waitlistOfferExpiresAt: null,
            waitlistOfferedLodgeId: null,
            waitlistOfferedPriceCents: null,
          },
        });
        await reconcileBedAllocationsForBookingWithGlobalLockHeld({
          bookingId,
          db: tx,
          previousRange: {
            checkIn: booking.checkIn,
            checkOut: booking.checkOut,
          },
        });
        return { success: false, error: "Capacity is no longer available. You've been returned to the waitlist." };
      }

      // Determine new status using the same logic as booking creation.
      // Math.ceil mirrors bookings/route.ts: fractional days over threshold → PENDING.
      const hasNonMembers = booking.guests.some((g) => !g.isMember);
      const holdPolicy = hasNonMembers
        ? await getNonMemberHoldPolicy(booking.checkIn, booking.lodgeId, tx)
        : { enabled: false, holdDays: 0, source: "default" as const };
      const holdDecision = calculateBookingHoldDecision({
        hasNonMembers,
        checkIn: booking.checkIn,
        holdDays: holdPolicy.holdDays,
        holdEnabled: holdPolicy.enabled,
      });
      const shouldBePending = holdDecision.shouldBePending;
      const newStatus = shouldBePending ? BookingStatus.PENDING : BookingStatus.PAYMENT_PENDING;

      const updateData: Record<string, unknown> = {
        status: newStatus,
        waitlistPosition: null,
        waitlistOfferedAt: null,
        waitlistOfferExpiresAt: null,
        nonMemberHoldUntil: null,
      };

      if (newStatus === BookingStatus.PENDING) {
        // INV-DATE-014: calendar arithmetic, never the host's clock face.
        const holdDate = addDaysDateOnly(booking.checkIn, -holdPolicy.holdDays);
        updateData.nonMemberHoldUntil = holdDate;
      }

      const claimed = await tx.booking.updateMany({
        where: {
          id: bookingId,
          status: BookingStatus.WAITLIST_OFFERED,
          OR: [
            { waitlistOfferExpiresAt: null },
            { waitlistOfferExpiresAt: { gte: confirmedAt } },
          ],
        },
        data: updateData,
      });
      if (claimed.count === 0) {
        return { success: false, error: "Waitlist offer has expired or is no longer available" };
      }
        await reconcileBedAllocationsForBookingWithGlobalLockHeld({
        bookingId,
        db: tx,
        previousRange: {
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        },
      });

      // #2364, for the same reason the minimum-stay check above re-runs here: an
      // offer lives 48 hours, and the club's hosting policy — or a participant's
      // membership, age tier or active/cancelled/archived state — can move under
      // it. Confirming turns a queue placeholder into a capacity-holding
      // booking, so the hazard is re-derived against TODAY's facts rather than
      // the ones that applied when the booking joined the queue.
      //
      // Under the REVIEW consequence this cannot refuse the confirmation: the
      // member gets their booking and the club gets the review. Under #2569's
      // ENFORCED consequence it throws, which rolls this whole claim back — the
      // status flip, the bed allocations and the price rebase — and the catch
      // below turns it into the member's exception door.
      await reconcileAdultMemberHostingReviewWithSiblings(bookingId, tx);

      return { success: true, newStatus };
    });
  } catch (err) {
    if (isHostingCoverageParticipantRetry(err)) {
      return {
        success: false,
        error: HOSTING_COVERAGE_RETRY_MESSAGE,
        code: HOSTING_COVERAGE_RETRY_CODE,
      };
    }
    // #2569 — the ENFORCED hosting refusal, BEFORE the generic handler below,
    // which reported it as "an error occurred" and answered 400. That was the
    // worst of the available answers: the member was refused for a rule they
    // could act on, told nothing about it, and given no exception door.
    //
    // The offer is deliberately NOT reverted to WAITLISTED. The transaction rolled
    // back, so the booking is still WAITLIST_OFFERED on its original expiry, and
    // the member keeps the chance to fix the party (or to be approved) and confirm
    // again inside their window. Same reasoning as the cross-lodge duplicate-stay
    // rejection, and the opposite of the #2543 refusal, which reverts because an
    // unpaid subscription is not something a member can clear inside 48 hours.
    if (err instanceof AdultMemberHostingRequiredError) {
      logger.warn(
        { bookingId },
        "Waitlist confirm refused: non-member guest nights are not covered by an adult member (#2569)",
      );
      const refusal = buildAdultMemberHostingRefusalBody(err.violation);
      return {
        success: false,
        error: formatAdultMemberHostingWaitlistRefusal(refusal.error),
        code: refusal.code,
        adultMemberHostingRefusal: refusal,
      };
    }
    logger.error({ err, bookingId }, "Failed to confirm waitlist offer");
    return { success: false, error: "An error occurred while confirming your booking" };
  }


  // #2576 §7. Every path that can ENQUEUE bounded re-evaluation work must also
  // drain it: a queue row with nobody draining it turns the owner's "immediate
  // re-evaluation" into "within three hours", which is how long an officer-created
  // booking that has just RESTORED cover would leave a critical incident standing,
  // or one that removed it would leave the owner un-notified. Best-effort and
  // scoped to this booking's owner; the cron sweep is the authority on completion.
  if (result.success) {
    await settleHostingCoverageAfterCommit({ bookingId });
  }

  if (result.success) {
    logAudit({
      action: "waitlist.offer_confirmed",
      memberId,
      targetId: bookingId,
      subjectMemberId: memberId,
      entityType: "Booking",
      entityId: bookingId,
      category: "booking",
      outcome: "success",
      summary: "Waitlist offer confirmed",
      details: `Waitlist offer confirmed, new status: ${result.newStatus}`,
      metadata: {
        newStatus: result.newStatus,
      },
    });
  }

  // #2543 — carry the "why" onto the confirm response too, so the member who has
  // just accepted a repriced offer sees the same explanation the offer email gave
  // them rather than only a higher number. Spread conditionally: every other
  // outcome keeps its exact previous shape, so a caller (or a test) comparing the
  // whole object sees no new key on a refusal or a paid-up party.
  return subscriptionMemberRateNotice
    ? { ...result, subscriptionMemberRateNotice }
    : result;
}

/**
 * Expire stale WAITLIST_OFFERED bookings and re-offer to next candidates.
 */
export async function expireStaleOffers(): Promise<{
  expiredCount: number;
  reofferedCount: number;
}> {
  const { staleOffers, affectedRanges } = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const candidates = await tx.booking.findMany({
      where: {
        status: BookingStatus.WAITLIST_OFFERED,
        waitlistOfferExpiresAt: { lt: new Date() },
      },
      include: {
        member: { select: { email: true, firstName: true } },
      },
    });

    // #1881 — the revert (WAITLIST_OFFERED -> WAITLISTED) must serialise against
    // the member's own confirm of the same offer, which locks the offer's OWN
    // lodge (confirmWaitlistOffer: acquireLodgeCapacityLock(booking.lodgeId)).
    // The pre-#1881 code locked only the DEFAULT lodge, so for a non-default-
    // lodge offer it held a DIFFERENT key than that offer's confirm and could
    // clobber a just-confirmed offer back to WAITLISTED. Lock EACH offer's own
    // lodge, acquired in sorted lodgeId order so composing multiple per-lodge
    // locks in one transaction can never deadlock (the same discipline the
    // reconcile processor uses). lodgeId is immutable, so keying from this read
    // is safe.
    const defaultLodgeId = await getDefaultLodgeId(tx);
    const lockLodgeIds = Array.from(
      new Set(candidates.map((c) => c.lodgeId ?? defaultLodgeId))
    ).sort();
    for (const lodgeId of lockLodgeIds) {
      await acquireLodgeCapacityLock(tx, lodgeId);
    }

    // Status-guarded revert under the locks: skip any offer a concurrent confirm
    // already moved out of WAITLIST_OFFERED while we waited on its lodge lock.
    const offers: typeof candidates = [];
    for (const candidate of candidates) {
      const releasedRows = await tx.booking.updateMany({
        where: { id: candidate.id, status: BookingStatus.WAITLIST_OFFERED },
        data: {
          status: BookingStatus.WAITLISTED,
          waitlistOfferedAt: null,
          waitlistOfferExpiresAt: null,
          waitlistOfferedLodgeId: null,
          waitlistOfferedPriceCents: null,
        },
      });
      if (releasedRows.count === 0) continue;
      await reconcileBedAllocationsForBookingWithGlobalLockHeld({
        bookingId: candidate.id,
        db: tx,
        previousRange: {
          checkIn: candidate.checkIn,
          checkOut: candidate.checkOut,
        },
      });
      offers.push(candidate);
    }

    return {
      staleOffers: offers.map((offer) => ({
        ...offer,
        newPosition:
          offers.filter(
            (entry) =>
              // Per-lodge queue: only same-lodge expiring offers count toward
              // the position quoted in the expiry email (same scoping as M6).
              entry.lodgeId === offer.lodgeId &&
              entry.checkIn < offer.checkOut &&
              entry.checkOut > offer.checkIn &&
              entry.createdAt < offer.createdAt
          ).length + 1,
      })),
      affectedRanges: Array.from(
        new Map(
          offers.map((offer) => {
            // The freed spot is at the lodge whose place was being offered
            // (the offered lodge for a cross-lodge offer, else the entry's
            // own lodge). Read from the in-memory pre-revert snapshot: the
            // revert above nulled these fields in the DB, not on this object.
            const freedLodgeId = offer.waitlistOfferedLodgeId ?? offer.lodgeId;
            return [
              // Key by lodge as well as range so two lodges' same-range
              // expiries do not collapse into one processing call.
              `${freedLodgeId}_${offer.checkIn.toISOString()}_${offer.checkOut.toISOString()}`,
              {
                checkIn: offer.checkIn,
                checkOut: offer.checkOut,
                lodgeId: freedLodgeId,
              },
            ];
          })
        ).values()
      ),
    };
  });

  let reofferedCount = 0;

  for (const offer of staleOffers) {
    sendWaitlistOfferExpiredEmail(
      { bookingId: offer.id, recipientMemberId: offer.memberId },
      offer.member.email,
      offer.member.firstName,
      offer.checkIn,
      offer.checkOut,
      offer.newPosition,
      offer.lodgeId
    ).catch((err) => logger.error({ err }, "Failed to send waitlist offer expired email"));

    logAudit({
      action: "waitlist.offer_expired",
      memberId: null,
      targetId: offer.id,
      subjectMemberId: offer.memberId,
      entityType: "Booking",
      entityId: offer.id,
      category: "booking",
      outcome: "success",
      summary: "Waitlist offer expired",
      details: `Waitlist offer expired, reverted to WAITLISTED`,
      metadata: {
        checkIn: offer.checkIn.toISOString(),
        checkOut: offer.checkOut.toISOString(),
        newPosition: offer.newPosition,
      },
    });
  }

  for (const range of affectedRanges) {
    const { offeredBookingId } = await processWaitlistForDates(range);
    if (offeredBookingId) {
      reofferedCount++;
    }
  }

  return { expiredCount: staleOffers.length, reofferedCount };
}

// test seam
/**
 * Recalculate and update waitlistPosition for all WAITLISTED bookings
 * overlapping the given date range. Positions are numbered per-lodge: each
 * lodge runs its own FIFO queue, so a booking's position counts only entries
 * waiting for the same lodge (multi-lodge).
 */
export async function updateWaitlistPositions(
  checkIn: Date,
  checkOut: Date
): Promise<void> {
  const waitlisted = await prisma.booking.findMany({
    where: {
      status: BookingStatus.WAITLISTED,
      checkIn: { lt: checkOut },
      checkOut: { gt: checkIn },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, lodgeId: true },
  });

  // Number each lodge's queue independently, preserving the FIFO createdAt
  // order the query already applied.
  const positionByLodge = new Map<string, number>();
  for (const booking of waitlisted) {
    const nextPosition = (positionByLodge.get(booking.lodgeId) ?? 0) + 1;
    positionByLodge.set(booking.lodgeId, nextPosition);
    await prisma.booking.update({
      where: { id: booking.id },
      data: { waitlistPosition: nextPosition },
    });
  }
}
