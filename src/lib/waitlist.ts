import { prisma } from "./prisma";
import { BookingStatus, type AgeTier, type Prisma } from "@prisma/client";
import { acquireLodgeCapacityLock, checkCapacityForGuestRanges } from "./capacity";
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
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { priceBookingGuestsWithMembershipTypePolicy } from "@/lib/membership-type-policy";
import {
  loadSeasonRateData,
  recalculateBookingPromo,
} from "@/lib/booking-guest-removal-service";
import {
  calculateBookingHoldDecision,
  toGroupDiscountConfig,
} from "@/lib/policies/booking-route-decisions";
import { getSeasonYear } from "@/lib/utils";

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
  lodgeId: string
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
      seasonYear: getSeasonYear(candidate.checkIn),
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
    });
    const newFinalPriceCents =
      newTotalPriceCents + promoResult.newPromoAdjustmentCents;

    await Promise.all(
      candidate.guests.map((guest, index) =>
        tx.bookingGuest.update({
          where: { id: guest.id },
          data: { priceCents: priceBreakdown.guests[index].priceCents },
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

  try {
    await prisma.$transaction(async (tx) => {
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
        await reconcileBedAllocationsForBooking({
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
    sendWaitlistOfferEmail(
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
        : null
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
 * Confirm a waitlist offer. Re-checks capacity and transitions to
 * PAYMENT_PENDING or PENDING based on member/non-member rules.
 *
 * A cross-lodge offer (ADR-004, waitlistOfferedLodgeId set) takes the
 * create-and-cancel path instead: a fresh booking at the offered lodge and
 * the entry cancelled, with `newBookingId` pointing at the replacement.
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
  // Machine-readable rejection code forwarded from the cross-lodge path
  // (e.g. "DUPLICATE_STAY") so the API route can surface it to the client.
  code?: string;
}> {
  const offerKind = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { waitlistOfferedLodgeId: true },
  });
  if (offerKind?.waitlistOfferedLodgeId) {
    return confirmCrossLodgeWaitlistOffer(bookingId, memberId);
  }

  let result: { success: boolean; newStatus?: BookingStatus; error?: string };

  try {
    result = await prisma.$transaction(async (tx) => {
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

      if (booking.waitlistOfferExpiresAt && booking.waitlistOfferExpiresAt < new Date()) {
        return { success: false, error: "Waitlist offer has expired" };
      }

      const bookingLodgeId = booking.lodgeId ?? (await getDefaultLodgeId(tx));
      await acquireLodgeCapacityLock(tx, bookingLodgeId);

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
        await tx.booking.update({
          where: { id: bookingId },
          data: {
            status: BookingStatus.WAITLISTED,
            waitlistOfferedAt: null,
            waitlistOfferExpiresAt: null,
            waitlistOfferedLodgeId: null,
            waitlistOfferedPriceCents: null,
          },
        });
        await reconcileBedAllocationsForBooking({
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
        ? await getNonMemberHoldPolicy(booking.checkIn, booking.lodgeId)
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
        const holdDate = new Date(booking.checkIn);
        holdDate.setDate(holdDate.getDate() - holdPolicy.holdDays);
        updateData.nonMemberHoldUntil = holdDate;
      }

      await tx.booking.update({
        where: { id: bookingId },
        data: updateData,
      });
      await reconcileBedAllocationsForBooking({
        bookingId,
        db: tx,
        previousRange: {
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        },
      });

      return { success: true, newStatus };
    });
  } catch (err) {
    logger.error({ err, bookingId }, "Failed to confirm waitlist offer");
    return { success: false, error: "An error occurred while confirming your booking" };
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

  return result;
}

/**
 * Expire stale WAITLIST_OFFERED bookings and re-offer to next candidates.
 */
export async function expireStaleOffers(): Promise<{
  expiredCount: number;
  reofferedCount: number;
}> {
  const { staleOffers, affectedRanges } = await prisma.$transaction(async (tx) => {
    const defaultLodgeId = await getDefaultLodgeId(tx);
    await acquireLodgeCapacityLock(tx, defaultLodgeId);

    const offers = await tx.booking.findMany({
      where: {
        status: BookingStatus.WAITLIST_OFFERED,
        waitlistOfferExpiresAt: { lt: new Date() },
      },
      include: {
        member: { select: { email: true, firstName: true } },
      },
    });

    for (const offer of offers) {
      await tx.booking.update({
        where: { id: offer.id },
        data: {
          status: BookingStatus.WAITLISTED,
          waitlistOfferedAt: null,
          waitlistOfferExpiresAt: null,
          waitlistOfferedLodgeId: null,
          waitlistOfferedPriceCents: null,
        },
      });
      await reconcileBedAllocationsForBooking({
        bookingId: offer.id,
        db: tx,
        previousRange: {
          checkIn: offer.checkIn,
          checkOut: offer.checkOut,
        },
      });
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
