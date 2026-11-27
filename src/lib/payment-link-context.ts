/**
 * The public pay page's read model: what a `/pay/[token]` visitor is told and
 * what the link can still do. Extracted from `payment-link.ts` by
 * responsibility (#2956). Read-only apart from burning the link once the
 * booking is paid; token resolution stays in `payment-link.ts`, and the
 * wording comes from `booking-narrative.ts`, which this module only feeds.
 */
import { BookingStatus, PaymentSource } from "@prisma/client";
import { bookingOwner } from "@/lib/booking-owner";
import { buildInternetBankingPaymentReference } from "@/lib/booking-payment-methods";
import {
  resolveBookingNarrative,
  type BookingNarrative,
  type BookingNarrativeState,
  type NarrativeEvent,
  type ResolveBookingNarrativeInput,
} from "@/lib/booking-narrative";
import { readBookingAmountOwed } from "@/lib/booking-amount-owed";
import { readCancelledCardRefund, readCardShortfallTaskStatuses } from "@/lib/cancel-card-refund-shortfall-status";
import { bindClubTime } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import logger from "@/lib/logger";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { isPaidLikeStatus, loadPaymentLinkRecord } from "@/lib/payment-link";
import { prisma } from "@/lib/prisma";
import { clubFormatValues } from "@/lib/club-format-server";

/** The data the public page needs to actually take a payment. */
interface PaymentLinkPayable {
  checkIn: string;
  checkOut: string;
  guestCount: number;
  status: BookingStatus;
  amountCents: number;
  /**
   * The bank-transfer reference, present only when the optional Internet
   * Banking module is on. Omitted when the module is off so the public pay
   * page never offers a payment method the club hasn't enabled.
   */
  internetBankingReference?: string;
  /**
   * #3638 (`INV-PAY-102`): false when the booking has switched to Internet
   * Banking. The page then shows the bank-transfer details in place of the card
   * button, because the card door would refuse the payment anyway.
   */
  cardPaymentAvailable: boolean;
  /**
   * The link's hard expiry, ISO. The END OF THE CHECK-IN DAY in the club's
   * PERSISTED timezone (`payment-link-expiry.ts`, `INV-CONFIG-002`) — not the
   * container's, and not spelled as an abbreviation, which `INV-CONFIG-002`
   * forbids and which names one country's zone in a generic product
   * (`INV-CONFIG-001`). The pay page renders this value in that same zone.
   */
  expiresAt: string;
}

export interface PaymentLinkContext {
  state: BookingNarrativeState;
  /** Rich, plain-language wording shared with the admin booking history. */
  narrative: BookingNarrative;
  firstName: string;
  /** Present only when the booking can still be paid via this link. */
  payable: PaymentLinkPayable | null;
  /** True when the page should offer the "email me a fresh link" action. */
  canRequestFreshLink: boolean;
  /**
   * Name of the lodge THIS booking is at (#2919), so the public pay page's
   * confirmation copy names the right property in a multi-lodge club instead of
   * falling back to the club's default lodge. Single-lodge clubs see no change.
   */
  lodgeName: string;
}

/**
 * Build the public payment page context for a raw token. Resolves the booking's
 * narrative from its durable events so guests see the same wording as admins,
 * for every state — payable, expired-but-payable, paid, bumped, cancelled,
 * declined — never a generic error. Marks the link used (idempotently) once the
 * booking is paid/completed so it cannot be replayed.
 */
export async function getPaymentLinkContext(
  token: string,
): Promise<PaymentLinkContext> {
  // The club's format (#3565), resolved once, before any transaction or
  // lock below — never per amount and never inside a transaction.
  const format = await clubFormatValues();
  const link = await loadPaymentLinkRecord(token);
  const booking = link.booking;
  const now = new Date();

  const events = await prisma.bookingEvent.findMany({
    where: { bookingId: booking.id },
    orderBy: { occurredAt: "asc" },
    select: {
      type: true,
      occurredAt: true,
      amountCents: true,
      reason: true,
      snapshot: true,
    },
  });

  // The narrative names the day a payment, cancellation or settlement landed
  // AT THE CLUB, so it is read in the club's persisted zone rather than the
  // container's (#3123). The runtime reader, not `clubTime()`: this module is
  // reachable from `src/instrumentation.node.ts`, where `server-only` throws at
  // import. Its stay dates are @db.Date lodge nights and take no zone.
  const club = bindClubTime(await readClubTimeZoneOutsideRequest(), format);

  // #3955 round 3 (`INV-PAY-119`): the amount this page quotes is what the
  // link's card intent charges — the booking's price plus a change fee
  // recorded on its payment, less applied credit — read from the one home.
  // At or below zero the narrative says there is nothing to pay, and the page
  // offers neither a payment nor a fresh link.
  // #3991: the narrative takes the whole reading (it decides on `owedCents`
  // and quotes `dueCents`); the payable figure below is the unfloored `owedCents`.
  const amountOwed = await readBookingAmountOwed(booking);
  const { owedCents } = amountOwed;

  const narrativeInput = {
    club,
    // #4097: a card cancel's shortfall parts, so the page says which are done.
    cardShortfallStatuses: booking.status === BookingStatus.CANCELLED ? await readCardShortfallTaskStatuses(booking.id) : {},
    // #4125: a card cancel's refund with no REFUNDED event - still being sent, made, or stalled;
    // #4145: closed "Paid another way", what the officer paid back.
    ...(booking.status === BookingStatus.CANCELLED ? await readCancelledCardRefund(booking.id) : {}),
    booking: {
      status: booking.status,
      finalPriceCents: booking.finalPriceCents,
      amountOwed,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      firstName: bookingOwner(booking).member.firstName,
      adminReviewStatus: booking.adminReviewStatus,
      adminReviewNotes: booking.adminReviewNotes,
      adminReviewReason: booking.adminReviewReason,
    },
    events: events.map(
      (event): NarrativeEvent => ({
        type: event.type,
        occurredAt: event.occurredAt,
        amountCents: event.amountCents,
        reason: event.reason,
        snapshot: event.snapshot,
      })
    ),
    link: {
      expiresAt: link.expiresAt,
      usedAt: link.usedAt,
      revokedAt: link.revokedAt,
    },
    now,
  } satisfies ResolveBookingNarrativeInput;

  const narrative = resolveBookingNarrative(narrativeInput, format);
  const paymentState = narrative.state;

  // A paid/completed booking burns the link so it cannot be replayed.
  if (isPaidLikeStatus(booking.status) && !link.usedAt) {
    await prisma.paymentLink
      .update({ where: { id: link.id }, data: { usedAt: now } })
      .catch((err) =>
        logger.error({ err, paymentLinkId: link.id }, "Failed to mark payment link used")
      );
  }

  // Internet Banking is an optional module; only surface the bank-transfer
  // reference on the public pay page when the club has it enabled.
  const ibModules =
    paymentState === "payable" ? await loadEffectiveModuleFlags() : null;
  const internetBankingEnabled = Boolean(
    ibModules?.xeroIntegration && ibModules?.internetBankingPayments
  );
  // A switched booking already has its invoice: its bank-transfer details are
  // shown even if the module has since been turned off.
  const payingByInternetBanking =
    booking.payment?.source === PaymentSource.INTERNET_BANKING;

  const payable: PaymentLinkPayable | null =
    paymentState === "payable"
      ? {
          checkIn: booking.checkIn.toISOString(),
          checkOut: booking.checkOut.toISOString(),
          guestCount: booking.guests.length,
          status: booking.status,
          amountCents: owedCents,
          cardPaymentAvailable: !payingByInternetBanking,
          ...(internetBankingEnabled || payingByInternetBanking
            ? {
                internetBankingReference: buildInternetBankingPaymentReference(
                  booking.id
                ),
              }
            : {}),
          expiresAt: link.expiresAt.toISOString(),
        }
      : null;

  return {
    state: narrative.state,
    narrative,
    firstName: bookingOwner(booking).member.firstName,
    payable,
    canRequestFreshLink: paymentState === "expired_payable",
    lodgeName: booking.lodge.name,
  };
}
