import type { Prisma } from "@prisma/client";

import { bookingFinalPriceCents } from "@/lib/booking-final-price";
import { postModificationLedgerLines } from "@/lib/booking-ledger-modification-sync";
import { pricingSideFromStoredGuests } from "@/lib/booking-modification-lines";
import { computeModificationPricing } from "@/lib/booking-modification-pricing";
import {
  applyLifecycleTransitions,
  applyPaymentAdjustments,
  calculateModificationSettlementOptions,
  isQuotePricedBooking,
  type LoadedBookingForModify,
} from "@/lib/booking-modify";
import { bookingOwner } from "@/lib/booking-owner";
import { hasCapturedPayment, hasIssuedPrimaryXeroInvoice } from "@/lib/booking-payment-state";
import { bookingPromoCodeLabel, bookingPromoRedemptions } from "@/lib/booking-promo-redemptions";
import {
  persistRepricedPromotions,
  priceStoredBookingPromotions,
} from "@/lib/booking-promotions";
import { SELF_REMOVABLE_GUEST_BOOKING_STATUSES } from "@/lib/booking-guest-self-removal";
import { readStrandNightPrices } from "@/lib/booking-strand-night-prices";
import type { CalendarDate } from "@/lib/club-time";
import type { ClubFormat } from "@/lib/club-format";
import {
  assertNoPendingEditFinancialReview,
  EditFinancialReviewPendingError,
} from "@/lib/edit-financial-review";
import { getDefaultLodgeId } from "@/lib/lodges";
import logger from "@/lib/logger";
import { createBookingModificationCredit, requireMemberCreditRecipient } from "@/lib/member-credit";
import { recordBookingNightAdjustments } from "@/lib/night-adjustment-write";

/**
 * #3827 (D-3813-4): A GUEST'S ACCEPTANCE RE-PRICES THE BOOKING'S CODES.
 *
 * A cross-family guest awaiting acceptance is shown to no promo code, so their
 * nights carry none (INV-MONEY-038). When they accept, the owner's decision is
 * that the booking is re-priced "under the ordinary edit rules": every code
 * the booking already carries runs again — in its stored order, over the
 * nights now present — exactly as a guest edit would run it. Nothing is
 * applied that the booker did not choose (no code is added here), and a decline
 * consumed nothing, so it needs no counterpart.
 *
 * THE MONEY IS SETTLED BY THE ORDINARY EDIT MACHINERY, never a parallel copy:
 * `calculateModificationSettlementOptions` (the cancellation-policy tier for a
 * reduction), `applyPaymentAdjustments`, `applyLifecycleTransitions`, a
 * `BookingModification` row with its price lines and ledger postings, and
 * account credit through `createBookingModificationCredit`. The Xero half is
 * queued after commit by the caller (`queueXeroBookingEditSettlement`), as the
 * guest-removal route queues it.
 *
 * WHO CHOOSES CARD OR CREDIT. A reduction on a settled booking needs an
 * election, and the person accepting is the guest, not the payer. As the
 * consent-expiry sweep does for the same reason (owner decision D-15), the
 * system elects ACCOUNT CREDIT to the booking owner: no card refund is issued
 * that nobody asked for, and the owner keeps the value.
 *
 * WHEN IT DOES NOT RE-PRICE, and the booking keeps the figures it had, to be
 * re-priced by its next ordinary edit — the same outcome a parked edit has:
 * - the booking carries no code (by far the common case: nothing to do);
 * - its status takes no guest change, it is quote-priced, or a parked edit's
 *   financial review is still open (`INV-MOD-028`);
 * - its nights cannot be read back as exact money (the review re-base's rule);
 * - the re-price would RAISE the price of a booking already paid or invoiced:
 *   collecting more needs an ask only the payer can answer, which an
 *   acceptance has no door for. (Only a `SET_PRICE` code can raise a night.)
 *
 * Runs inside the consent transaction, which holds `pg_advisory_xact_lock(1)`
 * and the per-lodge capacity key; the promo rows are locked after both, in
 * sorted-id order (INV-MONEY-023).
 */

export type GuestAcceptanceRepriceSkip =
  | "NO_PROMOTION"
  | "BOOKING_STATUS"
  | "QUOTE_PRICED"
  | "UNDER_FINANCIAL_REVIEW"
  | "STRANDS_UNREADABLE"
  | "INCREASE_NEEDS_COLLECTION";

export type GuestAcceptanceReprice =
  | { repriced: false; reason: GuestAcceptanceRepriceSkip }
  | {
      repriced: true;
      /** Null when the codes were re-decided but the booking's price did not move. */
      bookingModificationId: string | null;
      priceDiffCents: number;
      accountCreditAmountCents: number;
      xeroRefundAmountCents: number;
      xeroAdditionalAmountCents: number;
      settlementMethod: "card" | "credit" | null;
      hasIssuedXeroInvoice: boolean;
      hasSucceededPayment: boolean;
      paymentStatus: string | null;
      zeroDollarAutoPaid: boolean;
      /** Primary intents a zero-dollar auto-pay superseded, to cancel after commit. */
      supersededPrimaryPaymentIntentCount: number;
    };


export async function repriceBookingAfterGuestAcceptance(
  tx: Prisma.TransactionClient,
  params: {
    bookingId: string;
    acceptedGuestId: string;
    /** The member who accepted (the guest, or their delegate) — the history row's actor. */
    actorMemberId: string;
    /** The club's day, resolved before the transaction opened (`INV-LOCK-004`). */
    todayAtClub: CalendarDate;
    format: ClubFormat;
  },
): Promise<GuestAcceptanceReprice> {
  const { bookingId, todayAtClub, format } = params;
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    include: {
      guests: {
        include: {
          nights: { select: { stayDate: true, priceCents: true, priceSource: true } },
        },
      },
      payment: true,
      member: true,
      organisation: { select: { name: true, email: true } },
      promoRedemptions: {
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
  if (!booking) return { repriced: false, reason: "BOOKING_STATUS" };
  const redemptions = bookingPromoRedemptions(booking).filter((redemption) => redemption.promoCode);
  if (redemptions.length === 0) return { repriced: false, reason: "NO_PROMOTION" };
  if (booking.deletedAt || !SELF_REMOVABLE_GUEST_BOOKING_STATUSES.has(booking.status)) {
    return { repriced: false, reason: "BOOKING_STATUS" };
  }
  if (await isQuotePricedBooking(tx, bookingId)) return { repriced: false, reason: "QUOTE_PRICED" };
  try {
    await assertNoPendingEditFinancialReview({ bookingId, moneyAffecting: true, store: tx });
  } catch (error) {
    if (error instanceof EditFinancialReviewPendingError) {
      return { repriced: false, reason: "UNDER_FINANCIAL_REVIEW" };
    }
    throw error;
  }
  const strands = readStrandNightPrices(booking.guests);
  if (
    strands === null ||
    strands.reduce((sum, strand) => sum + strand.perNightRates.reduce((a, b) => a + b, 0), 0) !==
      booking.totalPriceCents
  ) {
    return { repriced: false, reason: "STRANDS_UNREADABLE" };
  }

  const lodgeId = booking.lodgeId ?? (await getDefaultLodgeId(tx));
  const decided = await priceStoredBookingPromotions(tx, {
    bookingId,
    redemptions,
    memberId: bookingOwner(booking).memberId,
    bookingCheckIn: booking.checkIn,
    totalPriceCents: booking.totalPriceCents,
    guests: strands.map((strand) => ({ ...strand, firstNight: booking.checkIn })),
    lodgeId,
    todayAtClub,
  });
  const newPromoAdjustmentCents = decided.priced.priceAdjustmentCents;
  const newFinalPriceCents = bookingFinalPriceCents({
    totalPriceCents: booking.totalPriceCents,
    promoAdjustmentCents: newPromoAdjustmentCents,
  });
  const priceDiffCents = newFinalPriceCents - booking.finalPriceCents;
  const loaded = booking as unknown as LoadedBookingForModify;
  if (
    priceDiffCents > 0 &&
    (hasCapturedPayment(booking.payment) || hasIssuedPrimaryXeroInvoice(loaded))
  ) {
    logger.warn(
      { bookingId, priceDiffCents },
      "A guest's acceptance would raise a paid or invoiced booking's price; its codes keep their figures until the next edit (#3827)",
    );
    return { repriced: false, reason: "INCREASE_NEEDS_COLLECTION" };
  }

  const promo = await persistRepricedPromotions(tx, decided);
  // INV-MONEY-029: the engine re-decided every code over the stored nights, so
  // the build-up is rewritten from its figures — after the redemption writes.
  await recordBookingNightAdjustments(tx, {
    format,
    bookingId,
    guestIds: strands.map((strand) => strand.bookingGuestId),
    targets: promo.adjustmentTargets,
    writer: "guest acceptance",
  });

  if (priceDiffCents === 0) {
    // The codes were re-decided and the price did not move; the discount half
    // of the headline may still have (a raise and a cut cancelling).
    await tx.booking.update({
      where: { id: bookingId },
      data: {
        totalPriceCents: booking.totalPriceCents,
        discountCents: promo.newDiscountCents,
        promoAdjustmentCents: promo.newPromoAdjustmentCents,
        finalPriceCents: bookingFinalPriceCents({
          totalPriceCents: booking.totalPriceCents,
          promoAdjustmentCents: promo.newPromoAdjustmentCents,
        }),
      },
    });
    return {
      repriced: true,
      bookingModificationId: null,
      priceDiffCents: 0,
      accountCreditAmountCents: 0,
      xeroRefundAmountCents: 0,
      xeroAdditionalAmountCents: 0,
      settlementMethod: null,
      hasIssuedXeroInvoice: hasIssuedPrimaryXeroInvoice(loaded),
      hasSucceededPayment: false,
      paymentStatus: booking.payment?.status ?? null,
      zeroDollarAutoPaid: false,
      supersededPrimaryPaymentIntentCount: 0,
    };
  }

  // The ordinary edit machinery from here (see the module docblock).
  const settlementOptions = await calculateModificationSettlementOptions({
    booking: loaded,
    netChargeCents: priceDiffCents,
    db: tx,
    todayAtClub,
  });
  const paymentImpact = await applyPaymentAdjustments(tx, {
    booking: loaded,
    priceDiffCents,
    changeFeeCents: 0,
    settlementOptions,
    // D-15's election: credit to the booking owner, never an unasked card refund.
    ...(settlementOptions?.requiresSettlementMethod ? { settlementMethod: "credit" as const } : {}),
  });
  const lifecycle = await applyLifecycleTransitions(tx, {
    booking: loaded,
    bookingId,
    newCheckIn: booking.checkIn,
    newFinalPriceCents,
    format,
    guestsForPricing: booking.guests,
    skipBookingLifecycleRules: false,
  });
  await tx.booking.update({
    where: { id: bookingId },
    data: {
      totalPriceCents: booking.totalPriceCents,
      discountCents: promo.newDiscountCents,
      promoAdjustmentCents: promo.newPromoAdjustmentCents,
      finalPriceCents: bookingFinalPriceCents({
        totalPriceCents: booking.totalPriceCents,
        promoAdjustmentCents: promo.newPromoAdjustmentCents,
      }),
      hasNonMembers: lifecycle.hasNonMembers,
      nonMemberHoldUntil: lifecycle.newNonMemberHoldUntil,
      status: lifecycle.newStatus,
      ...(lifecycle.clearDraftExpiresAt ? { draftExpiresAt: null } : {}),
    },
  });

  const promoCodeBefore = bookingPromoCodeLabel(booking);
  const { priceLines, sides } = await computeModificationPricing(
    { bookingId, site: "guest-acceptance" },
    () => ({
      before: pricingSideFromStoredGuests(booking.guests, {
        promoAdjustmentCents: booking.promoAdjustmentCents,
        promoCode: promoCodeBefore,
      }),
      after: pricingSideFromStoredGuests(booking.guests, {
        promoAdjustmentCents: newPromoAdjustmentCents,
        promoCode: promo.remainingPromoCodeLabel,
      }),
    }),
    priceDiffCents,
    logger,
  );
  const bookingModification = await tx.bookingModification.create({
    data: {
      bookingId,
      memberId: params.actorMemberId,
      modificationType: "PROMO_REPRICE",
      previousData: {
        acceptedGuestId: params.acceptedGuestId,
        totalPriceCents: booking.totalPriceCents,
        discountCents: booking.discountCents,
        promoAdjustmentCents: booking.promoAdjustmentCents,
        finalPriceCents: booking.finalPriceCents,
        promoCode: promoCodeBefore,
      },
      newData: {
        totalPriceCents: booking.totalPriceCents,
        discountCents: promo.newDiscountCents,
        promoAdjustmentCents: newPromoAdjustmentCents,
        finalPriceCents: newFinalPriceCents,
        promoCode: promo.remainingPromoCodeLabel,
        promoRemoved: promo.promoRemoved,
        settlementMethod: paymentImpact.settlementMethod,
        accountCreditAmountCents: paymentImpact.accountCreditAmountCents,
        policyRetainedAmountCents: paymentImpact.policyRetainedAmountCents,
        ...(promo.promoCoverage ? { promoCoverageNote: promo.promoCoverage.message } : {}),
      },
      priceDiffCents,
      changeFeeCents: 0,
      ...(priceLines ? { priceLines } : {}),
    },
  });
  await postModificationLedgerLines({
    store: tx,
    bookingId,
    lodgeId,
    bookingModification,
    sides,
    site: "guest-acceptance",
  });
  if (paymentImpact.accountCreditAmountCents > 0) {
    await createBookingModificationCredit(
      requireMemberCreditRecipient(bookingOwner(booking).memberId),
      paymentImpact.accountCreditAmountCents,
      bookingId,
      bookingModification.id,
      undefined,
      tx,
      booking.payment?.id,
    );
  }

  return {
    repriced: true,
    bookingModificationId: bookingModification.id,
    priceDiffCents,
    accountCreditAmountCents: paymentImpact.accountCreditAmountCents,
    xeroRefundAmountCents: paymentImpact.xeroRefundAmountCents,
    xeroAdditionalAmountCents: paymentImpact.xeroAdditionalAmountCents,
    settlementMethod: paymentImpact.settlementMethod,
    hasIssuedXeroInvoice: paymentImpact.hasIssuedXeroInvoice,
    hasSucceededPayment: paymentImpact.hasSucceededPayment,
    paymentStatus: booking.payment?.status ?? null,
    zeroDollarAutoPaid: lifecycle.zeroDollarAutoPaid,
    supersededPrimaryPaymentIntentCount: lifecycle.supersededPrimaryPaymentIntents.length,
  };
}
