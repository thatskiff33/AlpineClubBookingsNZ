import { Role, type Prisma } from "@prisma/client";

import {
  queueReissuedAskRecovery,
  readReductionAgainstUnpaidAsk,
  type RetiredAdditionalAsk,
} from "@/lib/additional-ask-reduction";
import { NO_ADDITIONAL_ASK, type AdditionalAsk } from "@/lib/additional-payment-ask";
import { logAudit } from "@/lib/audit";
import { getBookingEditPolicy } from "@/lib/booking-edit-policy";
import { bookingFinalPriceCents } from "@/lib/booking-final-price";
import { postModificationLedgerLines } from "@/lib/booking-ledger-modification-sync";
import {
  loadModificationLinesAuditFields,
  pricingSideFromStoredGuests,
  type ModificationLine,
} from "@/lib/booking-modification-lines";
import { computeModificationPricing } from "@/lib/booking-modification-pricing";
import {
  createModificationAdditionalPaymentIntent,
  drainSupersededPrimaryIntents,
  executeBookingModificationRefund,
} from "@/lib/booking-modification-settlement";
import {
  applyLifecycleTransitions,
  applyPaymentAdjustments,
  isQuotePricedBooking,
  type LoadedBookingForModify,
} from "@/lib/booking-modify";
import { bookingOwner } from "@/lib/booking-owner";
import {
  canAskCardForIncrease,
  hasCapturedPayment,
  hasIssuedPrimaryXeroInvoice,
} from "@/lib/booking-payment-state";
import { bookingPromoCodeLabel, bookingPromoRedemptions } from "@/lib/booking-promo-redemptions";
import {
  persistRepricedPromotions,
  priceStoredBookingPromotions,
} from "@/lib/booking-promotions";
import { isPaidLikeBookingStatus } from "@/lib/booking-status";
import { readStrandNightPrices } from "@/lib/booking-strand-night-prices";
import { dateOnlyInstantOf, type CalendarDate } from "@/lib/club-time";
import type { ClubFormat } from "@/lib/club-format";
import {
  assertNoPendingEditFinancialReview,
  EditFinancialReviewPendingError,
} from "@/lib/edit-financial-review";
import { sendBookingModifiedEmail } from "@/lib/email/booking";
import {
  editRefundGoesBackByHand,
  raiseEditRefundHandBackIfOwed,
} from "@/lib/edit-refund-hand-back";
import { fullReductionReturnRoute } from "@/lib/booking-guest-acceptance-return-route";
import { getDefaultLodgeId } from "@/lib/lodges";
import { reserveOrganiserChildModificationRefund } from "@/lib/organiser-child-refund";
import logger from "@/lib/logger";
import {
  clampAppliedCreditToBookingPrice,
} from "@/lib/member-credit";
import { recordBookingNightAdjustments } from "@/lib/night-adjustment-write";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";
import { queueXeroBookingEditSettlement } from "@/lib/xero-booking-edit-settlement";
import { unpaidAskOffsetHistory } from "@/lib/unpaid-ask-offset-marker";

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
 * THE MONEY GOES BACK IN FULL, THE WAY IT WAS PAID (D-3813-5). An acceptance
 * re-price is not a cancellation, so no cancellation-policy tier applies and
 * nobody is asked to choose:
 * - captured cash goes back first, up to what is still refundable, through the
 *   ordinary edit's "money back" arm (`applyPaymentAdjustments` with
 *   `calculateFullReductionSettlementOptions`): a Stripe refund after commit for
 *   a card, and for internet banking (or cash) an officer refund task in the
 *   money-to-settle queue (D-3813-6, `INV-PAY-117`) beside the Xero credit note;
 * - whatever the cash cannot cover went on account credit and goes back as
 *   account credit, the way an edit returns over-applied credit
 *   (`clampAppliedCreditToBookingPrice`, INV-MOD-012) — the whole reduction for
 *   a booking paid wholly with credit, the remainder for a split payment;
 * - a booking whose payment has not been captured simply costs less. In
 *   PENDING or PAYMENT_PENDING `applyLifecycleTransitions` also nets any
 *   over-applied credit down and settles a $0 booking, as an edit does; a
 *   CONFIRMED booking (its invoice issued, nothing yet paid) has the invoice
 *   corrected for the whole reduction and its applied credit left as it was,
 *   exactly as an ordinary edit of a CONFIRMED booking leaves it.
 * The ledger posting, the history row, the Xero correction (queued after commit
 * by `settleGuestAcceptanceRepriceAfterCommit`), the member's email and the
 * audit row are the ordinary edit's own.
 *
 * FREE NIGHTS ARE USED ONLY FOR WHAT IS RETURNED. The re-price is decided under
 * the locks and WRITTEN only once the settlement above is known to return the
 * whole reduction; where it cannot — the refundable cash and the credit applied
 * do not add up to the price (a slice an earlier edit kept, or a payment only
 * part made) — the re-price is not written at all, so no code's allocation
 * moves.
 *
 * WHEN IT DOES NOT RE-PRICE, and the booking keeps the figures it had, to be
 * re-priced by its next ordinary edit — the same outcome a parked edit has:
 * - the booking carries no code (by far the common case: nothing to do);
 * - a member could not edit it for a stay yet to start (`getBookingEditPolicy`
 *   in "future" mode: DRAFT, PENDING, PAYMENT_PENDING, CONFIRMED or PAID, check-in
 *   after today — so never AWAITING_REVIEW, `INV-MOD-013`, a waitlist status or
 *   a stay under way), it is quote-priced, or a parked edit's financial review is
 *   still open (`INV-MOD-028`);
 * - its nights cannot be read back as exact money (the review re-base's rule);
 * - the re-price would RAISE the price of a booking whose price is settled in
 *   any form — captured cash, paid with credit or at $0, or invoiced: collecting
 *   more needs an ask only the payer can answer, which an acceptance has no door
 *   for. Any combination of codes can raise it (a code's guest cap reshuffling
 *   who it covers, as well as a `SET_PRICE` code);
 * - the reduction cannot be returned in full (above).
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
  | "INCREASE_NEEDS_COLLECTION"
  | "REDUCTION_NOT_FULLY_RETURNABLE";

export type GuestAcceptanceReprice =
  | { repriced: false; reason: GuestAcceptanceRepriceSkip }
  | {
      repriced: true;
      /** Null when the codes were re-decided but the booking's price did not move. */
      bookingModificationId: string | null;
      priceDiffCents: number;
      refundAmountCents: number;
      /** The Stripe slice of `refundAmountCents`, refunded after commit. */
      pendingRefundAmountCents: number;
      /**
       * #3653 (composed by #3829): non-null when that slice goes back to the
       * group organiser's card out of the combined payment; its debt is reserved
       * in this transaction under the modification's key.
       */
      organiserChildRefund: { amountCents: number } | null;
      accountCreditAmountCents: number;
      xeroRefundAmountCents: number;
      xeroAdditionalAmountCents: number;
      settlementMethod: "card" | "credit" | null;
      /**
       * The reduction went back as the account credit the booking was paid
       * with (its applied credit netted down), not as a refund — the Xero
       * correction is then worded as account credit, never as a bank refund.
       */
      creditReturnedAsApplied: boolean;
      hasIssuedXeroInvoice: boolean;
      hasSucceededPayment: boolean;
      paymentStatus: string | null;
      paymentId: string | null;
      zeroDollarAutoPaid: boolean;
      /** Primary intents a zero-dollar auto-pay superseded, to cancel after commit. */
      supersededPrimaryPaymentIntentCount: number;
      /**
       * #3954: the unpaid asks this reduction retired, cancelled at Stripe after
       * commit, and the smaller ask it re-issues for what is still owed.
       */
      retiredAdditionalAsks: RetiredAdditionalAsk[];
      /** #3954: the reduction cancelled the unpaid ask outright, for the member's email. */
      unpaidAskCancelled: boolean;
      additionalAsk: AdditionalAsk;
      paymentCustomerId: string | null;
      /** What the member's email and the audit row read, as an ordinary edit carries them. */
      oldFinalPriceCents: number;
      newFinalPriceCents: number;
      checkIn: Date;
      checkOut: Date;
      guestCount: number;
      lodgeId: string | null;
      promoCoverageNote: string | null;
      priceLines: ModificationLine[] | null;
      owner: { memberId: string | null; email: string; firstName: string };
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
  // The member edit door for a stay yet to start (A4, #3827): the statuses a
  // member may edit (`INV-MOD-013` keeps AWAITING_REVIEW out) and check-in
  // after the club's today.
  const editPolicy = getBookingEditPolicy({
    status: booking.status,
    role: Role.USER,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    today: dateOnlyInstantOf(todayAtClub),
  });
  if (booking.deletedAt || editPolicy.mode !== "future") {
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
  // #3502: `canAskCardForIncrease` too, so a credit-paid ($0) booking in any
  // settled status is refused here rather than handed to
  // `applyPaymentAdjustments`, which would now size a card ask this path never
  // mints.
  const priceSettled =
    hasCapturedPayment(booking.payment) ||
    canAskCardForIncrease(booking) ||
    isPaidLikeBookingStatus(booking.status) ||
    hasIssuedPrimaryXeroInvoice(loaded);
  if (priceDiffCents > 0 && priceSettled) {
    logger.warn(
      { bookingId, priceDiffCents },
      "A guest's acceptance would raise a settled booking's price; its codes keep their figures until the next edit (#3827)",
    );
    return { repriced: false, reason: "INCREASE_NEEDS_COLLECTION" };
  }

  // D-3813-5: how the whole reduction goes back, decided BEFORE anything is
  // written, so a reduction that cannot be returned in full moves no code.
  // #3954: the unpaid ask, read ONCE for this re-price and handed to both the
  // return route and the save.
  const reduction = await readReductionAgainstUnpaidAsk(tx, loaded, priceDiffCents);
  const returnRoute = await fullReductionReturnRoute(tx, booking, loaded, priceDiffCents, reduction, todayAtClub);
  if (returnRoute === null) {
    logger.warn(
      { bookingId, priceDiffCents },
      "A guest's acceptance would lower a paid booking by more than can be returned the way it was paid; its codes keep their figures until the next edit (#3827)",
    );
    return { repriced: false, reason: "REDUCTION_NOT_FULLY_RETURNABLE" };
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
  const owner = bookingOwner(booking);
  const unmoved = {
    oldFinalPriceCents: booking.finalPriceCents,
    newFinalPriceCents,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    guestCount: booking.guests.length,
    lodgeId: booking.lodgeId,
    promoCoverageNote: promo.promoCoverage?.message ?? null,
    owner: { memberId: owner.memberId, email: owner.member.email, firstName: owner.member.firstName },
  };

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
      refundAmountCents: 0,
      pendingRefundAmountCents: 0,
      organiserChildRefund: null,
      accountCreditAmountCents: 0,
      xeroRefundAmountCents: 0,
      xeroAdditionalAmountCents: 0,
      settlementMethod: null,
      creditReturnedAsApplied: false,
      hasIssuedXeroInvoice: hasIssuedPrimaryXeroInvoice(loaded),
      hasSucceededPayment: false,
      paymentStatus: booking.payment?.status ?? null,
      paymentId: booking.payment?.id ?? null,
      zeroDollarAutoPaid: false,
      supersededPrimaryPaymentIntentCount: 0,
      retiredAdditionalAsks: [],
      unpaidAskCancelled: false,
      additionalAsk: NO_ADDITIONAL_ASK,
      paymentCustomerId: booking.payment?.stripeCustomerId ?? null,
      priceLines: null,
      ...unmoved,
    };
  }

  // The ordinary edit machinery from here (see the module docblock).
  const adjusted = await applyPaymentAdjustments(tx, {
    booking: loaded,
    priceDiffCents,
    changeFeeCents: 0,
    reduction,
    ...(returnRoute.kind === "money-back"
      ? { settlementOptions: returnRoute.settlementOptions, settlementMethod: "card" as const }
      : {}),
    todayAtClub,
    format,
    // D-3813-5: the credit share goes back below, in full, by the clamp - so
    // #3809's tiered give-back for an ordinary edit does not run as well.
    appliedCreditReturnedByCaller: true,
  });
  // What the cash arm above could not return went on account credit, and goes
  // back the way an edit returns over-applied credit (INV-MOD-012): the applied
  // credit is netted down to the new price, the member's balance regains it,
  // and an Internet-Banking invoice's credit allocation is reduced to match. A
  // booking paid wholly with credit captured no cash, so the arm above returns
  // nothing and corrects an issued invoice for the full reduction, as it does
  // for any booking with no captured payment; a split payment's cash went back
  // first, so this nets the credit down by exactly the remainder.
  let paymentImpact: typeof adjusted = adjusted;
  const creditReturn = returnRoute.kind === "account-credit" ? returnRoute : returnRoute.kind === "money-back" ? returnRoute.creditRemainder : null;
  if (creditReturn) {
    const clamp = await clampAppliedCreditToBookingPrice(
      {
        memberId: creditReturn.memberId,
        bookingId,
        // The PRICE, not the worth (#3955 round 3): the return route admitted
        // this booking only because its applied credit and returnable cash sum
        // to the price, so no credit here pays a recorded change fee — a fee
        // the card already paid, or one still owed beside the price. Counting
        // that fee would keep back credit the reduction returns, and the check
        // below would fail the guest's acceptance (`INV-PAY-119`).
        newWorthCents: newFinalPriceCents,
        format,
      },
      tx,
    );
    if (clamp.refundedExcessCents !== creditReturn.amountCents) {
      throw new Error(
        `INV-MONEY-038 (D-3813-5): a guest's acceptance would return ${formatCents(clamp.refundedExcessCents, format)} of credit for ${formatCents(creditReturn.amountCents, format)} of a reduction paid with credit on booking ${bookingId} (#3827).`,
      );
    }
    if (booking.payment) {
      // The mirror beside the ledger: cash net of refunds plus credit applied is
      // the price again (INV-PAY-024).
      await tx.payment.update({
        where: { id: booking.payment.id },
        data: { creditAppliedCents: clamp.appliedCreditCents },
      });
    }
    paymentImpact = { ...adjusted, accountCreditAmountCents: clamp.refundedExcessCents };
  }
  const lifecycle = await applyLifecycleTransitions(tx, {
    booking: loaded,
    bookingId,
    newCheckIn: booking.checkIn,
    newFinalPriceCents,
    // Records no change fee (`INV-PAY-119`).
    feeRecordedByThisEditCents: 0,
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
    { bookingId, site: "guest-acceptance", promoCodes: { store: tx, before: booking } },
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
        refundAmountCents: paymentImpact.refundAmountCents,
        accountCreditAmountCents: paymentImpact.accountCreditAmountCents,
        policyRetainedAmountCents: paymentImpact.policyRetainedAmountCents,
        // #3954: what an unpaid ask took of this reduction, for the Xero repair pass.
        ...unpaidAskOffsetHistory(adjusted),
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
  // D-3813-6 (`INV-PAY-117`): the cash share of a reduction on a booking paid
  // by internet banking or by hand is the treasurer's to send back.
  await raiseEditRefundHandBackIfOwed(tx, {
    bookingId,
    paymentId: booking.payment?.id ?? null,
    bookingModificationId: bookingModification.id,
    adjusted: paymentImpact,
    editLabel: "guest's acceptance re-price",
  });
  // #3954 review round 4: a smaller re-issued ask is durable from this
  // commit, not from the after-commit mint.
  await queueReissuedAskRecovery(tx, {
    bookingId,
    paymentId: booking.payment?.id ?? null,
    bookingModificationId: bookingModification.id,
    settled: paymentImpact,
  });
  // #3653 (composed by #3829): an organiser-settled child's refund debt, before
  // this re-price commits, as every edit door reserves it.
  await reserveOrganiserChildModificationRefund(tx, {
    plan: adjusted.organiserChildRefund,
    bookingId,
    payment: booking.payment,
    bookingModificationId: bookingModification.id,
  });

  return {
    repriced: true,
    bookingModificationId: bookingModification.id,
    priceDiffCents,
    refundAmountCents: paymentImpact.refundAmountCents,
    pendingRefundAmountCents: paymentImpact.pendingRefundAmountCents,
    organiserChildRefund: adjusted.organiserChildRefund
      ? { amountCents: adjusted.organiserChildRefund.amountCents }
      : null,
    accountCreditAmountCents: paymentImpact.accountCreditAmountCents,
    xeroRefundAmountCents: paymentImpact.xeroRefundAmountCents,
    xeroAdditionalAmountCents: paymentImpact.xeroAdditionalAmountCents,
    settlementMethod: paymentImpact.settlementMethod,
    creditReturnedAsApplied: returnRoute.kind === "account-credit",
    hasIssuedXeroInvoice: paymentImpact.hasIssuedXeroInvoice,
    hasSucceededPayment: paymentImpact.hasSucceededPayment,
    paymentStatus: booking.payment?.status ?? null,
    paymentId: booking.payment?.id ?? null,
    zeroDollarAutoPaid: lifecycle.zeroDollarAutoPaid,
    supersededPrimaryPaymentIntentCount: lifecycle.supersededPrimaryPaymentIntents.length,
    retiredAdditionalAsks: adjusted.retiredAdditionalAsks,
    unpaidAskCancelled: adjusted.unpaidAskCancelled,
    additionalAsk: adjusted.additionalAsk,
    paymentCustomerId: booking.payment?.stripeCustomerId ?? null,
    priceLines: priceLines ?? null,
    ...unmoved,
  };
}

/**
 * The after-commit half of a guest-acceptance re-price (#3827), as the guest
 * routes run theirs: cancel any primary intent a zero-dollar auto-pay
 * superseded, refund a card's share through Stripe, queue the Xero correction,
 * then tell the booking's owner and write the audit row an edit writes.
 * Best-effort for the reason every such drain is: the booking is committed,
 * and the recovery sweep and the Xero outbox are the authority on completion.
 */
export async function settleGuestAcceptanceRepriceAfterCommit(params: {
  bookingId: string;
  actorMemberId: string | null;
  reprice: Extract<GuestAcceptanceReprice, { repriced: true }>;
  format: ClubFormat;
}): Promise<void> {
  const { bookingId, reprice, format } = params;
  if (reprice.bookingModificationId === null) return;
  const bookingModificationId = reprice.bookingModificationId;
  await drainSupersededPrimaryIntents({
    bookingId,
    supersededPrimaryPaymentIntents: { length: reprice.supersededPrimaryPaymentIntentCount },
  });
  // The card's share, through the edit's own refund helper: a key scoped to
  // this modification and durable recovery on failure (#818).
  const paymentContext = {
    pendingRefundAmountCents: reprice.pendingRefundAmountCents,
    organiserChildRefund: reprice.organiserChildRefund,
    paymentId: reprice.paymentId,
    additionalAsk: reprice.additionalAsk,
    retiredAdditionalAsks: reprice.retiredAdditionalAsks,
    hasSucceededPayment: reprice.hasSucceededPayment,
    hasIssuedXeroInvoice: reprice.hasIssuedXeroInvoice,
    paymentCustomerId: reprice.paymentCustomerId,
    memberEmail: reprice.owner.email,
    memberName: reprice.owner.firstName,
    memberFirstName: reprice.owner.firstName,
    memberId: reprice.owner.memberId,
    bookingModificationId,
    priceLines: reprice.priceLines,
  };
  const stripeRefundId = await executeBookingModificationRefund({
    format,
    bookingId,
    result: paymentContext,
    metadataReason: "guest_accepted_promo_reprice",
    idempotencyKeyPrefix: `guest_accept_refund_${bookingId}`,
    failureMessage: "Stripe refund failed after a guest-acceptance re-price - enqueueing recovery",
    recoveryFailureMessage:
      "Failed to enqueue guest-acceptance re-price refund recovery - manual reconciliation required",
  });
  // #3954: the asks this reduction retired are cancelled at Stripe, and what is
  // still owed of them is re-issued, smaller, on a fresh ask. A re-price never
  // raises a settled price, so this is the only ask it can mint.
  await createModificationAdditionalPaymentIntent({
    format,
    bookingId,
    result: paymentContext,
    reason: "guest_accepted_promo_reprice_reissued_ask",
    idempotencyKey: `guest_accept_${bookingId}_${bookingModificationId}`,
    failureMessage: "Failed to re-issue an unpaid additional PaymentIntent after a guest-acceptance re-price",
  });
  try {
    await queueXeroBookingEditSettlement({
      bookingId,
      bookingModificationId,
      ...(params.actorMemberId ? { createdByMemberId: params.actorMemberId } : {}),
      hasIssuedXeroInvoice: reprice.hasIssuedXeroInvoice,
      originalPaymentStatus: reprice.paymentStatus,
      priceDiffCents: reprice.priceDiffCents,
      changeFeeCents: 0,
      datesChanged: false,
      settlementAmountCents: reprice.xeroRefundAmountCents,
      settlementMethod: reprice.settlementMethod,
      refundedThroughStripe: reprice.hasSucceededPayment,
      ...(reprice.creditReturnedAsApplied ? { refundMethod: "account-credit" as const } : {}),
      // An acceptance never raises a settled booking's price (see
      // `repriceBookingAfterGuestAcceptance`), so there is no Stripe ask to wait on.
      requiresAdditionalStripePayment: false,
      additionalPaymentIntentId: null,
      createPrimaryInvoiceWhenMissing: reprice.zeroDollarAutoPaid && !reprice.hasIssuedXeroInvoice,
      // #3653: the organiser's refund raises its own note once Stripe has made it.
      organiserChildRefundOwnsCreditNote: reprice.organiserChildRefund !== null,
    });
  } catch (err) {
    logger.error(
      { err, bookingId },
      "Failed to queue the Xero settlement for a guest-acceptance re-price",
    );
  }

  const audited = {
    acceptedPromoReprice: true,
    priceDiffCents: reprice.priceDiffCents,
    refundAmountCents: reprice.refundAmountCents,
    accountCreditAmountCents: reprice.accountCreditAmountCents,
    settlementMethod: reprice.settlementMethod,
    zeroDollarAutoPaid: reprice.zeroDollarAutoPaid,
    stripeRefundId: stripeRefundId ?? null,
    ...(await loadModificationLinesAuditFields(prisma, reprice.priceLines, logger, format)),
  };
  logAudit({
    action: "booking.modify.promo_reprice",
    ...(params.actorMemberId ? { actorMemberId: params.actorMemberId, memberId: params.actorMemberId } : {}),
    targetId: bookingId,
    subjectMemberId: reprice.owner.memberId,
    entityType: "BookingModification",
    entityId: bookingModificationId,
    category: "booking",
    outcome: "success",
    summary: "Booking re-priced after a guest accepted their place",
    details: JSON.stringify(audited),
    metadata: { bookingId, ...audited },
  });

  // The ordinary edit's email, to the booking's owner (or an organisation's
  // contact), with the same old/new price, refund or credit and coverage note.
  await sendBookingModifiedEmail(
    {
      bookingId,
      recipientMemberId: reprice.owner.memberId,
      email: reprice.owner.email,
      firstName: reprice.owner.firstName,
      modificationType: "PROMO_REPRICE",
      oldCheckIn: reprice.checkIn,
      oldCheckOut: reprice.checkOut,
      newCheckIn: reprice.checkIn,
      newCheckOut: reprice.checkOut,
      oldGuestCount: reprice.guestCount,
      newGuestCount: reprice.guestCount,
      oldFinalPriceCents: reprice.oldFinalPriceCents,
      newFinalPriceCents: reprice.newFinalPriceCents,
      changeFeeCents: 0,
      refundAmountCents: reprice.refundAmountCents,
      accountCreditAmountCents: reprice.accountCreditAmountCents,
      // The credit share is returned in full by the clamp and reported as
      // account credit above (D-3813-5); #3809's give-back never runs here.
      appliedCreditGivenBackCents: 0,
      promoCoverageNote: reprice.promoCoverageNote,
      // The re-price is applied only where its money is decided in full, and
      // a booking under an open financial review is never re-priced.
      financialReviewPending: false,
      // D-3813-6: an internet-banking refund is the club's to send.
      refundByBankTransfer: editRefundGoesBackByHand(reprice),
      refundReturnedToOrganiser: reprice.organiserChildRefund !== null,
      lodgeId: reprice.lodgeId,
      additionalAmountCents: reprice.additionalAsk.amountCents,
      unpaidAskCancelled: reprice.unpaidAskCancelled,
    },
    format,
  ).catch((err) =>
    logger.error({ err, bookingId }, "Failed to send the booking-modified email for a guest-acceptance re-price"),
  );
}
