import { prisma } from "./prisma";
import { bookingPromoRedemptions } from "@/lib/booking-promo-redemptions";
import { BookingStatus, type AgeTier, type Prisma } from "@prisma/client";
import { acquireLodgeCapacityLock, checkCapacityForGuestRanges } from "./capacity";
import { bookingOwner } from "@/lib/booking-owner";
import { nonMemberHoldEnd } from "@/lib/non-member-hold-end";
import { getDefaultLodgeId } from "@/lib/lodges";
import { isMemberEligibleToBookLodge } from "@/lib/lodge-access";
import {
  confirmCrossLodgeWaitlistOffer,
  quoteWaitlistEntryAtLodge,
} from "@/lib/waitlist-cross-lodge";
import {
  WAITLIST_QUEUE_ORDER_BY,
  compareWaitlistJoinOrder,
  getWaitlistCrossLodgeOrder,
  getWaitlistPositionOf,
  getWaitlistPositions,
  orderWaitlistOffers,
  splitWaitlistOpportunities,
  waitlistCandidateWhere,
  type WaitlistLapse,
} from "@/lib/waitlist-queue";
import { getNonMemberHoldPolicy } from "./cancellation";
import {
  deliverWaitlistOfferNotices,
  findNeverToldWaitlistOffers,
  recordWaitlistOfferNoticesOwed,
  type OwedWaitlistOffer,
  type WaitlistOfferNotice,
} from "@/lib/waitlist-offer-notices";
import {
  deliverWaitlistLapseNotice,
  recordWaitlistLapseNoticesOwed,
} from "@/lib/waitlist-offer-expired-notice";
import { waitlistOfferExpiresAt } from "@/lib/waitlist-offer-window";
import { retireReplayableOfferEmails } from "@/lib/waitlist-offer-email-state";
import { logAudit } from "./audit";
import logger from "@/lib/logger";
import { isTransactionContention } from "@/lib/prisma-errors";
import { reconcileBedAllocationsForBookingWithGlobalLockHeld } from "@/lib/bed-allocation-lifecycle";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import {
  HOSTING_COVERAGE_RETRY_CODE,
  HOSTING_COVERAGE_RETRY_MESSAGE,
  isHostingCoverageParticipantRetry,
} from "@/lib/adult-member-hosting-queue-participants";
import {
  reconcileAdultMemberHostingReviewWithSiblings,
} from "@/lib/adult-member-hosting-review";
import { AdultMemberHostingRequiredError, buildAdultMemberHostingRefusalBody } from "@/lib/adult-member-hosting-refusal";
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
import { requiredNightPriceCents } from "@/lib/required-price-cents";
import { carriesUnvaluedStoredNight } from "@/lib/stored-night-price-write";
import {
  recordBookingNightAdjustments,
  type PromoAdjustmentTarget,
} from "@/lib/night-adjustment-write";
import { bookingFinalPriceCents } from "@/lib/booking-final-price";
import type { ClubFormat } from "@/lib/club-format";
import { WAITLIST_CROSS_LODGE_WEBSITE_ONLY_CODE } from "@/lib/waitlist-confirm-recovery-contract";
import { LOCK1_HOLDER_TRANSACTION_BUDGET } from "@/lib/db-transaction";

export { WAITLIST_OFFER_HOURS } from "@/lib/waitlist-offer-window";

type WaitlistCandidateForReprice = Prisma.BookingGetPayload<{
  include: {
    guests: { include: { nights: true } };
    promoRedemptions: {
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
 * offer must never be blocked by a repricing edge case. The same fallback covers
 * the one reprice this DECLINES to do: a booking carrying a night whose sold
 * price is not known (#3166, `INV-MOD-028`) is offered at its stored snapshot
 * rather than having the blank rewritten as a guess.
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
  format: ClubFormat,
  // #2543 — the club's mode, resolved by the sweep BEFORE it opened this
  // transaction. This reprice inherits the unpaid-subscription reprice like every
  // other pricing call, and it passes no locked night prices, so the WHOLE stay
  // re-bases at current rates; being handed the mode keeps that consistent with
  // the offer the member is about to be sent and keeps a settings read out from
  // under the per-lodge capacity lock this transaction holds.
  subscriptionLockoutMode?: SubscriptionLockoutMode,
): Promise<number> {
  /**
   * #3166 (`INV-MOD-028`): A BLANK IS NEVER REPAIRED BY A REPRICE.
   *
   * This reprice passes no locked night prices, deletes every night row and
   * rewrites the lot at today's rates — so a night whose stored price is `NULL`
   * ("not known", written by a parked edit under #3170) would come back as a
   * real integer that nobody decided, in the very column the next edit reads as
   * sold-price evidence. Nothing else ever clears a blank: settling a review
   * writes an amount to the TASK, not a price to the night row.
   *
   * REACHABLE, not theoretical. `ADMIN_FUTURE_EDIT_STATUSES` includes
   * `WAITLISTED`, so an admin edit can park a waitlisted booking and write
   * `NULL`s into it; this sweep would then convert them into guesses while the
   * review task raised by that very edit is still OPEN, and the officer pricing
   * it would be reading rows the application had invented after the fact.
   *
   * The offer still goes out. Falling back to the stored snapshot is this
   * function's own documented behaviour for a reprice it cannot do, and for a
   * parked booking the snapshot is the last figure a person stood behind. Logged
   * at warn rather than error because nothing failed — a decision was declined.
   */
  if (carriesUnvaluedStoredNight(candidate.guests)) {
    logger.warn(
      { bookingId: candidate.id },
      "Waitlisted booking carries a night with no known sold price; offering at the stored snapshot rather than repricing over it (#3166)"
    );
    return candidate.finalPriceCents;
  }

  // #3276 (INV-MONEY-029): the recorder runs AFTER this try/catch, not inside
  // it. The catch below degrades to the stored snapshot instead of rolling
  // back, so a refusal raised inside it after the night rewrite would commit a
  // half-reprice. Outside it, a refusal fails the sweep transaction like any
  // other post-mutation error, and the recorder itself refuses before it writes.
  let repriced: {
    newFinalPriceCents: number;
    adjustmentTargets: PromoAdjustmentTarget[];
  } | null = null;
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
      ownerMemberId: bookingOwner(candidate).memberId,
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
    // Each guest's own priced row, read once. The breakdown was built from
    // `guestsForPricing`, so a guest with no row is a wiring defect and there
    // is no amount to promo-allocate against — refused, not guessed (#2800).
    const guestNightRates = guestsForPricing.map((guest, index) => {
      const priced = priceBreakdown.guests[index];
      if (priced === undefined) {
        throw new Error(
          `The waitlist offer reprice has no priced guest at breakdown position ${index} of ${priceBreakdown.guests.length} (#3031).`,
        );
      }
      return {
        bookingGuestId: guest.bookingGuestId,
        memberId: guest.memberId,
        isMember: guest.isMember,
        perNightRates: priced.perNightCents,
        nightDates: priced.nightDates,
        firstNight: candidate.checkIn,
        // #3827 (D-3813-4): a guest still awaiting acceptance takes no code.
        consentStatus: candidate.guests[index]!.consentStatus,
      };
    });
    const promoResult = await recalculateBookingPromo({
      tx,
      bookingId: candidate.id,
      booking: candidate,
      newTotalPriceCents,
      guestNightRates,
      todayAtClub,
    });
    const newFinalPriceCents =
      bookingFinalPriceCents({
        totalPriceCents: newTotalPriceCents,
        promoAdjustmentCents: promoResult.newPromoAdjustmentCents,
      });

    // #3031 (epic #2797): THE NIGHT ROWS THIS REPRICE PRICED, built and checked
    // BEFORE anything is written.
    //
    // This used to move `BookingGuest.priceCents` and leave `BookingGuestNight`
    // untouched, so after any rate change between the waitlist entry and the
    // offer the rows summed to the OLD total while the guest carried the NEW
    // one. That is a strand that does not reconcile — INV-MOD-028's
    // `STORED_TOTAL_MISMATCH` — manufactured fresh, on a healthy live booking,
    // every time this ran. Every subsequent in-progress edit on that booking
    // would then be REFUSED, and every single-guest removal would commit with
    // its money PARKED for a person to price (#3032) — both for a mismatch the
    // application itself had created.
    //
    // The amounts were already in hand: `perNightCents` and `nightDates` are the
    // same values `guestNightRates` hands to the promo allocator above, so this
    // writes what the offer is actually charging rather than deriving anything.
    //
    // BUILT FIRST, and that ordering is load-bearing. This function's catch
    // degrades to the stored snapshot and lets the offer go out, so a throw
    // BETWEEN two writes would commit half a reprice — a guest at the new total
    // with its night rows already deleted. Everything that can refuse is
    // therefore resolved here, before the first mutation.
    //
    // Each guest is paired with its own priced row here, so the writes below
    // read the pair rather than the breakdown by position again (#2800).
    const repricedGuests = candidate.guests.map((guest, index) => {
      const priced = priceBreakdown.guests[index];
      if (priced === undefined) {
        throw new Error(
          `The waitlist offer reprice has no priced guest at breakdown position ${index} for booking guest ${guest.id} (#3031).`,
        );
      }
      const nightDates = priced.nightDates ?? [];
      const nightRows = nightDates.map((stayDate, k) => ({
        bookingGuestId: guest.id,
        stayDate,
        // NO `?? 0`. These rows become the booking's sold-price history from
        // here on, and a magic zero would be read back by the next edit as
        // evidence the member paid nothing for the night. The rule itself, why
        // it refuses rather than defaults, and the caller census behind it are
        // stated once in `required-price-cents.ts` (#3031, #3167); all this
        // site says is which writer it is.
        priceCents: requiredNightPriceCents(
          priced.perNightCents,
          k,
          stayDate,
          "the waitlist offer reprice",
        ),
        priceSource: "SOLD" as const,
      }));
      return { guest, priced, nightRows };
    });

    await Promise.all(
      repricedGuests.map(async ({ guest, priced, nightRows }) => {
        await tx.bookingGuest.update({
          where: { id: guest.id },
          // Reprice overwrites the rate-membership-type snapshot alongside the
          // price (#1930, E4): the offer re-bases the whole booking at current
          // rates before the member confirms.
          data: {
            priceCents: priced.priceCents,
            rateMembershipTypeId: priced.rateMembershipTypeId,
          },
        });
        // Delete-then-create, exactly as every other night writer does, because
        // the repriced night SET can differ from the stored one.
        await tx.bookingGuestNight.deleteMany({
          where: { bookingGuestId: guest.id },
        });
        if (nightRows.length > 0) {
          await tx.bookingGuestNight.createMany({ data: nightRows });
        }
      })
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

    repriced = { newFinalPriceCents, adjustmentTargets: promoResult.adjustmentTargets };
  } catch (err) {
    logger.error(
      { err, bookingId: candidate.id },
      "Failed to reprice waitlisted booking at offer time; offering at the stored snapshot"
    );
    return candidate.finalPriceCents;
  }
  // #3276: after the last night write and the promotion write, and outside the
  // degrade path above (see the comment at the top of the try).
  await recordBookingNightAdjustments(tx, {
    format,
    bookingId: candidate.id,
    guestIds: candidate.guests.map((guest) => guest.id),
    targets: repriced.adjustmentTargets,
    writer: "the waitlist offer reprice",
  });
  return repriced.newFinalPriceCents;
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
 *
 * `lapse` (#5410, `INV-CAP-042`): passed only by `expireStaleOffers`; others walk
 * the plain order. `failed`: the transaction failed and was logged (#5410).
 */
export async function processWaitlistForDates(freedDates: {
  checkIn: Date;
  checkOut: Date;
  lodgeId?: string | null;
},
  format: ClubFormat,
  lapse?: WaitlistLapse,
): Promise<{ offeredBookingId: string | null; failed?: true }> {
  let offeredBookingId: string | null = null;
  // #5433: what the offer's owed notices say, and their markers' descriptor.
  let offered = null as { notice: WaitlistOfferNotice; owed: OwedWaitlistOffer } | null;

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
  const clubZone = await readClubTimeZoneOutsideRequest();
  const todayAtClub = clubToday(clubZone);

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
        // The queue's candidate filter and join order live in
        // `waitlist-queue.ts` (#5402), so the position members are shown is
        // read from the same queue this pass walks. #2258: the filter leaves
        // out entries with the "No emails" switch on; see its note.
        where: waitlistCandidateWhere(freedDates),
        include: {
          guests: { include: { nights: true } }, // per-night sets (issue #713)
          member: { select: { id: true, email: true, firstName: true, lastName: true } },
          // #3369: the owner may be an Organisation; bookingOwner() reads both.
          organisation: { select: { name: true, email: true } },
          waitlistAlternateLodges: { select: { lodgeId: true } },
          // Full promo shape for the offer-time reprice (upstream #1035);
          // the cross-lodge quote only needs its existence.
          promoRedemptions: {
            include: {
              guestTargets: { select: { bookingGuestId: true } },
              promoCode: {
                include: { assignments: { select: { memberId: true } } },
              },
            },
          },
        },
        orderBy: WAITLIST_QUEUE_ORDER_BY,
      });

      // One "opportunity" is a candidate considered at one lodge, walked in
      // `waitlist-queue.ts`'s order (#5402, rotated after a lapse by #5410);
      // the cross-lodge order is read only when a cross-lodge one exists.
      const split = splitWaitlistOpportunities(candidates, {
        freedLodgeId,
        defaultLodgeId,
      });
      const crossOrder = split.cross.length === 0 ? null : await getWaitlistCrossLodgeOrder(tx);
      const opportunities = orderWaitlistOffers(split, crossOrder, lapse);

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
            bookingOwner(candidate).memberId,
            offerLodgeId,
          );
          if (!eligible) continue;
          const quote = await quoteWaitlistEntryAtLodge(
            tx,
            {
              memberId: bookingOwner(candidate).memberId,
              checkIn: candidate.checkIn,
              checkOut: candidate.checkOut,
              guests: candidate.guests,
              hasPromoRedemption: bookingPromoRedemptions(candidate).length > 0,
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
            format,
            subscriptionLockoutMode,
          );
        }

        // One instant: the offer's identity, its owed markers' event time and
        // the start of its window (#5433).
        const offeredAt = new Date();
        const expiresAt = waitlistOfferExpiresAt(offeredAt);

        // The place the officer's alert and the audit row quote: the entry's
        // own lodge's queue, read before it leaves it, under this pass's locks
        // (#5402, `INV-CAP-041`).
        const position = await getWaitlistPositionOf(tx, {
          id: candidate.id,
          lodgeId: candidate.lodgeId ?? defaultLodgeId,
          checkIn: candidate.checkIn,
          checkOut: candidate.checkOut,
          createdAt: candidate.createdAt,
        });

        await tx.booking.update({
          where: { id: candidate.id },
          data: {
            status: BookingStatus.WAITLIST_OFFERED,
            waitlistOfferedAt: offeredAt,
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
        const owner = bookingOwner(candidate);
        offered = {
          // #5433 (WL-1): the member's email and the officers' alert are owed
          // from this commit; delivered after it, and swept if never sent.
          owed: await recordWaitlistOfferNoticesOwed(tx, { bookingId: candidate.id, offeredAt, position }),
          notice: {
            bookingId: candidate.id,
            status: BookingStatus.WAITLIST_OFFERED,
            offeredAt,
            expiresAt,
            checkIn: candidate.checkIn,
            checkOut: candidate.checkOut,
            guestCount: candidate.guests.length,
            recipientMemberId: owner.memberId ?? "",
            email: owner.member.email,
            firstName: owner.member.firstName,
            memberName: `${owner.member.firstName} ${owner.member.lastName}`,
            // The offer-time reprice (upstream #1035), or the offered lodge's
            // quote for a cross-lodge offer (ADR-004).
            priceCents: offerPriceCents,
            lodgeId: candidate.lodgeId,
            offeredLodgeId,
            offeredLodgeName,
            zone: clubZone,
            format,
            lockoutMode: subscriptionLockoutMode,
          },
        };

        break; // Only offer to the top candidate
      }
    }, LOCK1_HOLDER_TRANSACTION_BUDGET);
  } catch (err) {
    logger.error({ err, ...freedDates, lapsedBookingId: lapse?.key.id }, "Failed to process waitlist for dates");
    return { offeredBookingId: null, failed: true };
  }

  // #5433: the owed notices, sent after the commit and awaited, so a stop
  // before them is the sweep's to recover (`waitlist-offer-notices.ts`).
  if (offered) {
    const { notice, owed } = offered;
    await deliverWaitlistOfferNotices(notice, owed);

    logAudit({
      action: "waitlist.offer_sent",
      memberId: null,
      targetId: notice.bookingId,
      subjectMemberId: notice.recipientMemberId,
      entityType: "Booking",
      entityId: notice.bookingId,
      category: "booking",
      outcome: "success",
      summary: "Waitlist offer sent",
      details: `Waitlist offer sent to ${notice.memberName}`,
      metadata: {
        checkIn: notice.checkIn.toISOString(),
        checkOut: notice.checkOut.toISOString(),
        guestCount: notice.guestCount,
        position: owed.position,
        expiresAt: notice.expiresAt!.toISOString(),
        ...(notice.offeredLodgeId
          ? {
              offeredLodgeId: notice.offeredLodgeId,
              offeredPriceCents: notice.priceCents,
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
  }, LOCK1_HOLDER_TRANSACTION_BUDGET);
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

/** A connection's cross-lodge accept (`WAITLIST_CROSS_LODGE_WEBSITE_ONLY_CODE`). */
const WAITLIST_CROSS_LODGE_WEBSITE_ONLY_REFUSAL = Object.freeze({
  success: false,
  error: "Accept this offer at another lodge on the club website.",
  code: WAITLIST_CROSS_LODGE_WEBSITE_ONLY_CODE,
});

/**
 * Confirm a waitlist offer. Re-checks capacity and transitions to
 * PAYMENT_PENDING or PENDING based on member/non-member rules.
 *
 * A cross-lodge offer (ADR-004, waitlistOfferedLodgeId set) takes the
 * create-and-cancel path instead: a fresh booking at the offered lodge and
 * the entry cancelled, with `newBookingId` pointing at the replacement.
 *
 * ALP-794: an AI app connection (`crossLodgeOnWebsiteOnly`) is refused a
 * cross-lodge offer with nothing written, since the app cannot show the
 * offered lodge or price. Only the offer's own member is told so; anyone else
 * gets the cross-lodge path's own refusal. An offer that turns cross-lodge
 * after the dispatch read is sent back to it by the CONFIRM_RETRY backstop.
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
  memberId: string,
  /** The club's format (#3565), resolved once by the request, before any transaction. */
  format: ClubFormat,
  options: { crossLodgeOnWebsiteOnly?: boolean } = {},
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
    if (options.crossLodgeOnWebsiteOnly && bookingOwner(offerKind).memberId === memberId) {
      return { ...WAITLIST_CROSS_LODGE_WEBSITE_ONLY_REFUSAL };
    }
    return confirmCrossLodgeWaitlistOffer(bookingId, memberId, format);
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
    bookingOwner(offerKind).memberId === memberId &&
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
      bookingOwnerMemberId: bookingOwner(offerKind).memberId,
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

      if (bookingOwner(booking).memberId !== memberId) {
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
        // INV-DATE-014: whole 24-hour (UTC-day) spans, never the host's clock face.
        const holdDate = nonMemberHoldEnd(booking.checkIn, holdPolicy.holdDays);
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
    }, LOCK1_HOLDER_TRANSACTION_BUDGET);
  } catch (err) {
    // The claim rolled back (INV-LOCK-006): the route answers its retryable 503.
    if (isTransactionContention(err)) throw err;
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
  // or one that removed it would leave the owner un-notified. Best-effort, for this
  // booking and its Group Trip siblings (#3039); the cron sweep is the authority.
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

/** Of these bookings, the ones still WAITLISTED: one read, outside any transaction; none when it fails. */
async function stillWaitlistedIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  try {
    const rows = await prisma.booking.findMany({
      where: { id: { in: ids }, status: BookingStatus.WAITLISTED },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id));
  } catch (err) {
    logger.error({ err, count: ids.length }, "Failed to re-read lapsed waitlist entries; their notices are left for the sweep");
    return new Set();
  }
}

/**
 * Expire stale WAITLIST_OFFERED bookings and re-offer to next candidates.
 * `failedReofferCount`: re-offer passes that failed (#5410); the cron surfaces it.
 */
export async function expireStaleOffers(format: ClubFormat): Promise<{
  expiredCount: number;
  reofferedCount: number;
  failedReofferCount: number;
}> {
  const { staleOffers } = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const candidates = await tx.booking.findMany({
      where: {
        status: BookingStatus.WAITLIST_OFFERED,
        waitlistOfferExpiresAt: { lt: new Date() },
      },
      include: {
        member: { select: { email: true, firstName: true, lastName: true } },
        // #3369: the owner may be an Organisation; bookingOwner() reads both.
        organisation: { select: { name: true, email: true } },
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

    // The place each expiry email quotes, read after every revert, so it
    // counts the entries already waiting ahead as well as the other lapsed
    // offers (#5402, `INV-CAP-041`). The revert keeps `createdAt`, so each
    // entry takes its original place back.
    const newPositions = await getWaitlistPositions(
      tx,
      offers.map((offer) => ({
        id: offer.id,
        lodgeId: offer.lodgeId ?? defaultLodgeId,
        checkIn: offer.checkIn,
        checkOut: offer.checkOut,
        createdAt: offer.createdAt,
      })),
    );

    // #5433 (WL-2): each lapse's notice is owed from this commit: the member's
    // "offer expired" email, or, for an offer the member was never told about,
    // no email (owner decision D2) and one officers' alert instead (D5). Read
    // and written under this transaction's locks; the lapse is unchanged. A
    // lapsed offer is over, so an offer email the retry cron could still replay
    // is retired first, in this transaction, so the decision below and the
    // retirement agree (round 3, item 2): a database-only write by primary key.
    const lapsedOffers = offers.map((offer) => ({ bookingId: offer.id, offeredAt: offer.waitlistOfferedAt }));
    await retireReplayableOfferEmails(tx, lapsedOffers, "the offer lapsed");
    const neverTold = await findNeverToldWaitlistOffers(tx, lapsedOffers);
    const expiredAt = new Date();
    const lapses = offers.map((offer) => ({
      bookingId: offer.id,
      expiredAt,
      untoldOfferedAt: neverTold.has(offer.id) ? offer.waitlistOfferedAt : null,
    }));
    await recordWaitlistLapseNoticesOwed(tx, lapses);

    return {
      staleOffers: offers.map((offer, index) => ({
        ...offer,
        newPosition: newPositions.get(offer.id)!,
        lapse: lapses[index]!,
      })),
    };
  }, LOCK1_HOLDER_TRANSACTION_BUDGET);

  let reofferedCount = 0;

  for (const offer of staleOffers) {
    logAudit({
      action: "waitlist.offer_expired",
      memberId: null,
      targetId: offer.id,
      subjectMemberId: bookingOwner(offer).memberId,
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

  // #5410 (`INV-CAP-042`): one offer pass per lapsed offer, in join order, each
  // told whose place lapsed and what else lapsed in this run. The place is at
  // the offered lodge (cross-lodge) or the entry's own, from the pre-revert
  // snapshot (the revert nulled `waitlistOfferedLodgeId` in the database only).
  // A pass that fails (it throws, or its transaction failed: `failed`) is logged
  // and counted, and the rest still run; the reverts are already committed.
  const lapses = staleOffers
    .map((offer) => ({ offer, key: { id: offer.id, createdAt: offer.createdAt, offeredLodgeId: offer.waitlistOfferedLodgeId ?? offer.lodgeId } }))
    .sort((a, b) => compareWaitlistJoinOrder(a.key, b.key));
  const run = lapses.map(({ key }) => key);
  let failedReofferCount = 0;
  for (const { offer, key } of lapses) {
    const freed = { checkIn: offer.checkIn, checkOut: offer.checkOut, lodgeId: key.offeredLodgeId };
    try {
      const pass = await processWaitlistForDates(freed, format, { key, run });
      if (pass.offeredBookingId) reofferedCount++;
      if (pass.failed) failedReofferCount++;
    } catch (err) {
      failedReofferCount++;
      logger.error({ err, bookingId: offer.id, lodgeId: key.offeredLodgeId }, "Failed to re-offer a lapsed waitlist place; continuing with the next");
    }
  }

  // #5433: each lapse's owed notice, after the re-offer passes (review F): a
  // stop during these sends loses nothing (the markers stand for the sweep),
  // and a stop before them no longer costs the re-offers. Only to a booking
  // still WAITLISTED, read once here outside any transaction (round 2, item
  // 8): these passes, another caller's offer pass or the member's own cancel
  // may have moved it on since the revert, and the sweep clears that notice
  // as moved on. A failed read sends nothing here; the sweep sends what is owed.
  const stillWaitlisted = await stillWaitlistedIds(staleOffers.map((offer) => offer.id));
  for (const offer of staleOffers) {
    if (!stillWaitlisted.has(offer.id)) continue;
    const owner = bookingOwner(offer);
    await deliverWaitlistLapseNotice(
      {
        bookingId: offer.id,
        status: BookingStatus.WAITLISTED,
        checkIn: offer.checkIn,
        checkOut: offer.checkOut,
        recipientMemberId: owner.memberId,
        email: owner.member.email,
        firstName: owner.member.firstName,
        memberName: `${owner.member.firstName} ${owner.member.lastName}`,
        lodgeId: offer.lodgeId,
        position: offer.newPosition,
      },
      offer.lapse,
    );
  }
  return { expiredCount: staleOffers.length, reofferedCount, failedReofferCount };
}
