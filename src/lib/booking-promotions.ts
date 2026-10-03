import type { MemberGuestConsentStatus, Prisma } from "@prisma/client";

import { calendarDateOfDateOnlyInstant, type CalendarDate } from "@/lib/club-time";
import { isOperationallyPresentConsent } from "@/lib/member-guest-consent";
import type { PromoAdjustmentTarget } from "@/lib/night-adjustment-write";
import type { PromoDiscountGuest } from "@/lib/pricing";
import {
  deletePromoRedemptionAndAdjustCount,
  lockAndRefreshPromoCodeUsage,
  lockPromoCodeRowsForUpdate,
  promoGuestCountRefusal,
  replacePromoRedemptionAllocations,
  validateAndCalculatePromoDiscount,
  type PromoApplicationResult,
  type PromoApplicationSubject,
} from "@/lib/promo";
import {
  describePromoCapCoverage,
  mergePromoCoverageNotices,
  promoReleasedNotice,
  type PromoCoverageNotice,
} from "@/lib/promo-cap-coverage";
import {
  assignmentRequiresGuestSelection,
  normalizeSelectedGuestIndexes,
} from "@/lib/promo-guest-scope";
import {
  selectedIndexesForStoredGuestTargets,
  targetBookingGuestIdsForSelectedIndexes,
  type PromoRedemptionWithTargets,
} from "@/lib/promo-stored-guest-targets";
import type { PromoUsageClient } from "@/lib/promo-usage-counts";

/**
 * THE ONE ORCHESTRATOR for pricing a booking's promo codes (#3827, epic #3813
 * C2). A booking may carry several codes (#3826); every write path that prices
 * one — create, every edit and re-price, the waitlist offer, the review re-base,
 * a guest accepting their place — runs them through `applyBookingPromotions`.
 *
 * It adds no arithmetic. The single-code engine
 * (`validateAndCalculatePromoDiscount`) runs once per code, unchanged, over the
 * nights no earlier code has claimed (`INV-SSOT-001`: a second pricing engine
 * for several codes was the rejected alternative on #3827). The rules — the
 * order, what claims a night, who may benefit — are `INV-MONEY-037` and
 * `INV-MONEY-038` in `docs/invariants/money.md`; this file implements them.
 *
 * With ONE code and every guest present, the engine is handed exactly the
 * arguments it was handed before #3827 — the same guest objects, in the same
 * order — so single-code money is byte-identical
 * (`promo-money-byte-identical.test.ts`). The one deliberate change is
 * D-3813-4: a guest still awaiting their acceptance is not shown to any code.
 */

/** A guest as the orchestrator prices it: the engine's guest, plus who is staying. */
export interface PromotionGuest extends PromoDiscountGuest {
  firstNight?: Date | null;
  bookingGuestId?: string | null;
  /**
   * REQUIRED (D-3813-4): only a guest actually staying — consent `null` (family
   * or non-member) or `CONFIRMED` (a cross-family guest who accepted) — can
   * benefit from a code. Required, not optional, so every caller states it
   * rather than a consent-free projection silently counting a pending guest.
   */
  consentStatus: MemberGuestConsentStatus | null;
}

/** One code to apply, in the booker's order. */
export interface PromotionApplicationInput {
  /** The code as stored — used to name an earlier code in a refusal. */
  code: string;
  promoCode: PromoApplicationSubject;
  assignedMemberIds: string[] | null;
  /** Indexes over the caller's full guest list (pending guests included). */
  selectedGuestIndexes?: number[];
  /**
   * `"reject"` for a code being applied now, `"coverExisting"` for a code the
   * booking already carries (INV-MONEY-024, per code).
   */
  capOverflow: "reject" | "coverExisting";
}

export interface PromotionApplicationOutcome<A extends PromotionApplicationInput> {
  application: A;
  /** This code's place in the effective order (work-party discount first). */
  applicationOrder: number;
  /**
   * The engine's answer, with every guest index over the CALLER's list and every
   * adjustment target naming this code. `error` set means refused.
   */
  result: PromoApplicationResult;
}

export interface BookingPromotionsResult<A extends PromotionApplicationInput> {
  outcomes: PromotionApplicationOutcome<A>[];
  /** Σ over the applied codes, each its own integer cents (no cross-code rounding). */
  discountCents: number;
  priceAdjustmentCents: number;
  /** Every applied code's targets, each naming its code, by caller guest index. */
  adjustmentTargets: PromoAdjustmentTarget[];
}

export const PROMO_PENDING_GUEST_MESSAGE =
  "A guest who has not yet accepted their place on this booking cannot receive a promo code until they accept.";

/** The refusal a code earns when every night it could cover already carries an earlier code (D-3813-2). */
export function promoAlreadyCoveredMessage(earlierCode: string): string {
  return `Already covered by ${earlierCode}: every night this code could discount already carries that code.`;
}

/**
 * The order codes apply in (D-3813-2, D-3813-3): the work-party discount — an
 * internal, system-applied code — claims its nights first, then every other code
 * in the caller's order. Stable, so equal ranks keep the booker's order.
 */
export function promotionApplicationOrder<A extends { promoCode: { internal?: boolean | null } }>(
  applications: readonly A[],
): A[] {
  return [
    ...applications.filter((application) => application.promoCode.internal),
    ...applications.filter((application) => !application.promoCode.internal),
  ];
}

type GuestClaim = { wholeGuestBy: string | null; nights: Map<string, string> };

function nightKey(stayDate: Date): string {
  return calendarDateOfDateOnlyInstant(stayDate);
}

/**
 * The guests one code is shown: everyone staying, less the nights earlier codes
 * claimed. A guest with no unclaimed night left is not shown at all, so they
 * cannot hold a `maxGuestsPerBooking` slot or count as an eligible guest. A
 * guest nobody has claimed from is passed as the caller's own object, which is
 * what keeps the first code's arguments byte-identical.
 */
function promotionView(
  guests: readonly PromotionGuest[],
  claims: ReadonlyMap<number, GuestClaim> | null,
): { view: PromotionGuest[]; toOriginal: number[] } {
  const view: PromotionGuest[] = [];
  const toOriginal: number[] = [];
  guests.forEach((guest, index) => {
    if (!isOperationallyPresentConsent(guest.consentStatus)) return;
    const claim = claims?.get(index);
    if (!claim) {
      view.push(guest);
      toOriginal.push(index);
      return;
    }
    if (claim.wholeGuestBy !== null) return;
    const kept: number[] = [];
    guest.perNightRates.forEach((_, nightIndex) => {
      const date = guest.nightDates?.[nightIndex];
      if (!date) {
        throw new Error(
          `INV-MONEY-038: guest ${index + 1} has a night with no date, so a later promo code cannot tell which nights are still unclaimed (#3827).`,
        );
      }
      if (!claim.nights.has(nightKey(date))) kept.push(nightIndex);
    });
    if (kept.length === 0) return;
    view.push({
      ...guest,
      perNightRates: kept.map((nightIndex) => guest.perNightRates[nightIndex]!),
      nightDates: kept.map((nightIndex) => guest.nightDates![nightIndex]!),
    });
    toOriginal.push(index);
  });
  return { view, toOriginal };
}

function toViewIndexes(
  selected: readonly number[] | undefined,
  toOriginal: readonly number[],
): number[] | undefined {
  if (selected === undefined) return undefined;
  const viewIndexByOriginal = new Map(toOriginal.map((original, viewIndex) => [original, viewIndex]));
  return selected
    .map((index) => viewIndexByOriginal.get(index))
    .filter((index): index is number => index !== undefined);
}

function mapResultToCaller(
  result: PromoApplicationResult,
  toOriginal: readonly number[],
  promoCodeId: string,
  callerSelection: number[] | undefined,
): PromoApplicationResult {
  const original = (viewIndex: number) => {
    const index = toOriginal[viewIndex];
    if (index === undefined) {
      throw new Error(`INV-MONEY-029: a promo code priced a guest at position ${viewIndex} that the orchestrator did not show it (#3827).`);
    }
    return index;
  };
  return {
    ...result,
    ...(result.selectableGuestIndexes
      ? { selectableGuestIndexes: result.selectableGuestIndexes.map(original) }
      : {}),
    // The booker's choice, untrimmed (as the engine returns it, #2390): a
    // chosen guest who is pending or whose nights another code holds stays
    // chosen, so a later acceptance or a removed code restores them.
    ...(result.selectedGuestIndexes !== undefined ? { selectedGuestIndexes: callerSelection ?? [] } : {}),
    ...(result.discount
      ? {
          discount: {
            ...result.discount,
            adjustmentTargets: result.discount.adjustmentTargets.map((target) => ({
              ...target,
              guestIndex: original(target.guestIndex),
              promoCodeId,
            })),
          },
        }
      : {}),
  };
}

/** The targets a code that APPLIED decided — none for a refused code. */
function appliedTargets(result: PromoApplicationResult): PromoAdjustmentTarget[] {
  return !result.error && result.discount ? result.discount.adjustmentTargets : [];
}

/**
 * Price a booking's codes in order, each over the nights no earlier code has
 * claimed (INV-MONEY-037/038). Read-only: the caller persists.
 *
 * Claims are recomputed from scratch on every call — nothing about a previous
 * pricing is carried — so a re-price, a reorder or a removed code always lands
 * where a fresh application in that order would.
 */
export async function applyBookingPromotions<A extends PromotionApplicationInput>(
  applications: readonly A[],
  context: {
    memberId: string | null;
    bookingCheckIn?: Date;
    totalPriceCents: number;
    guests: readonly PromotionGuest[];
    db: PromoUsageClient;
    lodgeId: string | null;
    todayAtClub: CalendarDate;
    excludeBookingId?: string;
  },
): Promise<BookingPromotionsResult<A>> {
  const ordered = promotionApplicationOrder(applications);
  const claims = new Map<number, GuestClaim>();
  const outcomes: PromotionApplicationOutcome<A>[] = [];
  let discountCents = 0;
  let priceAdjustmentCents = 0;
  const adjustmentTargets: PromoAdjustmentTarget[] = [];

  const run = async (application: A, view: PromotionGuest[], selection: number[] | undefined) =>
    validateAndCalculatePromoDiscount(
      application.promoCode,
      {
        memberId: context.memberId,
        bookingCheckIn: context.bookingCheckIn,
        // What is left to discount after the earlier codes: the engine's
        // safety cap, so codes together never take the booking below zero.
        totalPriceCents: Math.max(0, context.totalPriceCents + priceAdjustmentCents),
        guests: view,
      },
      application.assignedMemberIds,
      {
        db: context.db,
        todayAtClub: context.todayAtClub,
        lodgeId: context.lodgeId,
        selectedGuestIndexes: selection,
        capOverflow: application.capOverflow,
        ...(context.excludeBookingId ? { excludeBookingId: context.excludeBookingId } : {}),
      },
    );

  for (const [position, application] of ordered.entries()) {
    const later = position < ordered.length - 1;
    const callerSelection =
      application.selectedGuestIndexes === undefined
        ? undefined
        : normalizeSelectedGuestIndexes(application.selectedGuestIndexes, context.guests.length);
    if (callerSelection?.error) {
      outcomes.push({
        application,
        applicationOrder: position,
        result: { error: callerSelection.error, beneficiaryMemberIds: [] },
      });
      continue;
    }
    const { view, toOriginal } = promotionView(context.guests, claims.size > 0 ? claims : null);
    const viewSelection = toViewIndexes(callerSelection?.indexes, toOriginal);

    let result: PromoApplicationResult | null = null;
    const hidden = (callerSelection?.indexes ?? []).filter(
      (index) => !toOriginal.includes(index),
    );
    if (hidden.length > 0 && assignmentRequiresGuestSelection(application.promoCode, application.assignedMemberIds)) {
      // Guests the engine is not shown still count toward the booker's choice:
      // they are restored by an acceptance or a removed code, and must not
      // then push the choice past the code's guest cap.
      const countRefusal = promoGuestCountRefusal(
        application.promoCode.maxGuestsPerBooking,
        callerSelection!.indexes.length,
      );
      if (countRefusal) {
        result = { error: countRefusal, requiresGuestSelection: true, beneficiaryMemberIds: [] };
      } else if (
        viewSelection!.length === 0 &&
        hidden.some((index) => !isOperationallyPresentConsent(context.guests[index]!.consentStatus))
      ) {
        result = { error: PROMO_PENDING_GUEST_MESSAGE, beneficiaryMemberIds: [] };
      }
    }
    if (result === null) {
      result = mapResultToCaller(
        await run(application, view, viewSelection),
        toOriginal,
        application.promoCode.id,
        callerSelection?.indexes,
      );
    }

    // D-3813-2: a code that would claim nothing because earlier codes hold its
    // nights is refused as "already covered", naming the code that holds them.
    // Asked only when an earlier code claimed something, so a lone code — and
    // every single-code booking — is answered exactly as before.
    if (claims.size > 0 && appliedTargets(result).length === 0) {
      const unclaimed = promotionView(context.guests, null);
      const probe = mapResultToCaller(
        await run(application, unclaimed.view, toViewIndexes(callerSelection?.indexes, unclaimed.toOriginal)),
        unclaimed.toOriginal,
        application.promoCode.id,
        callerSelection?.indexes,
      );
      const holder = appliedTargets(probe)
        .map((target) => {
          const claim = claims.get(target.guestIndex);
          if (!claim) return undefined;
          if (claim.wholeGuestBy) return claim.wholeGuestBy;
          if (target.scope === "guest") return claim.nights.values().next().value;
          return target.stayDate ? claim.nights.get(nightKey(target.stayDate)) : undefined;
        })
        .find((code): code is string => Boolean(code));
      if (holder) {
        result = { error: promoAlreadyCoveredMessage(holder), beneficiaryMemberIds: [] };
      }
    }

    outcomes.push({ application, applicationOrder: position, result });
    if (result.error || !result.discount) continue;
    discountCents += result.discount.discountCents;
    priceAdjustmentCents += result.discount.priceAdjustmentCents;
    const targets = result.discount.adjustmentTargets;
    adjustmentTargets.push(...targets);
    if (!later) continue;
    // INV-MONEY-038: any target claims — a partial (`maxNightlyValueCents`) or
    // zero-amount night included; a per-guest target claims the guest's
    // remaining nights.
    for (const target of targets) {
      const claim = claims.get(target.guestIndex) ?? { wholeGuestBy: null, nights: new Map() };
      claims.set(target.guestIndex, claim);
      if (target.scope === "guest") {
        claim.wholeGuestBy ??= application.code;
        continue;
      }
      if (!target.stayDate) {
        throw new Error(
          "INV-MONEY-038: a promo code discounted a night with no date, so a later code cannot tell it is taken (#3827).",
        );
      }
      const key = nightKey(target.stayDate);
      if (!claim.nights.has(key)) claim.nights.set(key, application.code);
    }
  }

  return { outcomes, discountCents, priceAdjustmentCents, adjustmentTargets };
}

/** A stored redemption the re-price reads, as the booking includes load it. */
export type RepricedRedemption = PromoRedemptionWithTargets & {
  id: string;
  promoCodeId: string;
  bookingId: string;
  memberId: string | null;
  promoCode: PromoRedemptionWithTargets["promoCode"] &
    PromoApplicationSubject & { code: string; currentRedemptions: number };
};

export interface BookingPromotionsReprice {
  newDiscountCents: number;
  newPromoAdjustmentCents: number;
  /** True when ANY code was released by this re-price. */
  promoRemoved: boolean;
  /** The codes this re-price released, in application order. */
  releasedPromoCodes: string[];
  /**
   * The sentence(s) a member reads: who a capped code still covers (#2390),
   * and — on a booking carrying several codes — which code was released and
   * why. One merged notice so every surface shows all of it; null when there
   * is nothing to say.
   */
  promoCoverage: PromoCoverageNotice | null;
  adjustmentTargets: PromoAdjustmentTarget[];
  /** The codes the booking still carries, joined for display, or null. */
  remainingPromoCodeLabel: string | null;
}

/**
 * Re-price every code a booking already carries, in its stored order, and
 * persist the answer (INV-MONEY-024 per code). Shared by every re-price path —
 * adding or removing guests, a date change, the waitlist offer, the review
 * re-base and a guest's acceptance — so none of them prices a code its own way.
 *
 * LOCKS (INV-MONEY-023): every code row in ONE sorted call
 * (`lockPromoCodeRowsForUpdate`), together with any code the caller is about to
 * bring in (`additionalLockIds`), then each code's counter re-read under that
 * lock and validated against the re-read object. Callers already hold the
 * per-lodge capacity lock, so the order stays lodge -> promo rows.
 *
 * A code that no longer applies — its holder left, its nights are now another
 * code's, its window closed — is released on its own
 * (`deletePromoRedemptionAndAdjustCount`); the others are re-priced in place.
 */
export async function repriceBookingPromotions(
  tx: Prisma.TransactionClient,
  params: {
    bookingId: string;
    /** In application order (`bookingPromoRedemptions`). */
    redemptions: readonly RepricedRedemption[];
    memberId: string | null;
    bookingCheckIn?: Date;
    totalPriceCents: number;
    guests: readonly PromotionGuest[];
    lodgeId: string | null;
    todayAtClub: CalendarDate;
  },
): Promise<BookingPromotionsReprice> {
  const { bookingId, redemptions, guests } = params;
  if (redemptions.length === 0) {
    return {
      newDiscountCents: 0,
      newPromoAdjustmentCents: 0,
      promoRemoved: false,
      releasedPromoCodes: [],
      promoCoverage: null,
      adjustmentTargets: [],
      remainingPromoCodeLabel: null,
    };
  }

  await lockPromoCodeRowsForUpdate(tx, redemptions.map((redemption) => redemption.promoCodeId));
  const applications = [];
  for (const redemption of redemptions) {
    // Re-read the counter under the lock just taken (INV-MONEY-023); the
    // snapshot came with the booking, before it.
    const promo = await lockAndRefreshPromoCodeUsage(tx, redemption.promoCode);
    applications.push({
      redemption,
      code: promo.code,
      promoCode: promo,
      assignedMemberIds:
        promo.assignments.length > 0 ? promo.assignments.map((assignment) => assignment.memberId) : null,
      selectedGuestIndexes: selectedIndexesForStoredGuestTargets(redemption, [...guests]),
      capOverflow: "coverExisting" as const,
    });
  }

  const priced = await applyBookingPromotions(applications, {
    memberId: params.memberId,
    bookingCheckIn: params.bookingCheckIn,
    totalPriceCents: params.totalPriceCents,
    guests,
    db: tx,
    lodgeId: params.lodgeId,
    todayAtClub: params.todayAtClub,
    excludeBookingId: bookingId,
  });

  const several = redemptions.length > 1;
  const notices: Array<PromoCoverageNotice | null> = [];
  const released: string[] = [];
  const kept: string[] = [];
  for (const { application, result } of priced.outcomes) {
    if (result.error || !result.discount) {
      await deletePromoRedemptionAndAdjustCount(tx, application.redemption);
      released.push(application.code);
      // A lone code's removal is reported the way it always was (`promoRemoved`);
      // with several, the member is told which one went and why.
      if (several) {
        notices.push(promoReleasedNotice(application.code, result.error ?? "it no longer applies"));
      }
      continue;
    }
    const discount = result.discount;
    kept.push(application.code);
    notices.push(
      await describePromoCapCoverage(tx, {
        promoCode: application.code,
        capCoverage: result.capCoverage,
      }),
    );
    await replacePromoRedemptionAllocations(
      tx,
      application.redemption,
      discount.discountCents,
      discount.priceAdjustmentCents,
      discount.freeNightsUsed,
      discount.eligibleGuestCount,
      discount.allocations,
      targetBookingGuestIdsForSelectedIndexes([...guests], result.selectedGuestIndexes),
    );
  }

  return {
    newDiscountCents: priced.discountCents,
    newPromoAdjustmentCents: priced.priceAdjustmentCents,
    promoRemoved: released.length > 0,
    releasedPromoCodes: released,
    promoCoverage: mergePromoCoverageNotices(notices),
    adjustmentTargets: priced.adjustmentTargets,
    remainingPromoCodeLabel: kept.length > 0 ? kept.join(", ") : null,
  };
}
