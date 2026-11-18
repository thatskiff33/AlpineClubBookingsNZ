// The date edit's transaction result, moved verbatim from
// `booking-date-modification-service.ts` to keep that file under its size
// ceiling (#5145). Types only. `DateModificationResponse` followed for the
// same reason when the lock(1) budget follow-up grew the service by a line.
// `ModifiedBooking` has one home for both edit services,
// `booking-modification-modified-booking.ts` (#4516 merge, `INV-SSOT`); it is
// re-exported here so each service keeps one import line.
import type { PaymentSource, PaymentStatus } from "@prisma/client";

import type { ModifiedBooking } from "@/lib/booking-modification-modified-booking";
import type { BookingModificationPaymentContext } from "@/lib/booking-modification-settlement";
import type { BookingModificationSettlementMethod } from "@/lib/booking-modify";
import type { PromoCoverageNotice } from "@/lib/promo-cap-coverage";

export type { ModifiedBooking };

export type DateModificationTransactionResult =
  BookingModificationPaymentContext & {
    /** #3954: the reduction cancelled the unpaid ask outright, for the member's email. */
    unpaidAskCancelled: boolean;
    /**
     * The plain figure the emails, the response body and the Xero leg read.
     * Inherited from `BookingModificationPaymentContext` until #3371 replaced
     * that field with `additionalAsk`; it is restated here because those
     * consumers want a number and the minter must not be handed one.
     */
    additionalAmountCents: number;
    billedToOrganiserCents: number; // #4299: invoiced to the group organiser, not asked of this member
    booking: ModifiedBooking;
    priceDiffCents: number;
    changeFeeCents: number;
    refundAmountCents: number;
    accountCreditAmountCents: number;
    settlementMethod: BookingModificationSettlementMethod | null;
    policyRetainedAmountCents: number;
    promoRemoved: boolean;
    // #2390: set only when a usage cap stopped the promotion reaching somebody
    // on the repriced booking; null means everyone it applies to is covered.
    promoCoverage: PromoCoverageNotice | null;
    choreWarnings: string[];
    datesChanged: boolean;
    adminOverride: boolean;
    notifyMember: boolean;
    capacityOverridden: boolean;
    oldCheckIn: Date;
    oldCheckOut: Date;
    hasIssuedXeroInvoice: boolean;
    paymentStatus: PaymentStatus | null;
    paymentSource: PaymentSource | null;
    paymentReference: string | null;
    xeroInvoiceNumber: string | null;
    xeroRefundAmountCents: number;
    appliedCreditGivenBackCents: number;
    xeroAdditionalAmountCents: number;
    // F20 (#1887): the reprice landed the booking fully credit-covered and it
    // was auto-confirmed at $0, so the primary Xero invoice must be created.
    zeroDollarAutoPaid: boolean;
  };

export type DateModificationResponse = {
  booking: ModifiedBooking;
  priceDiffCents: number;
  changeFeeCents: number;
  refundAmountCents: number;
  accountCreditAmountCents: number;
  /** #3809: applied credit the reduction gave back, as account credit. */
  appliedCreditGivenBackCents: number;
  settlementMethod: BookingModificationSettlementMethod | null;
  policyRetainedAmountCents: number;
  additionalAmountCents: number;
  /** #4299 (`INV-PAY-148`): the increase invoiced to the group organiser instead of this member. */
  billedToOrganiserCents: number;
  additionalPaymentClientSecret: string | null;
  stripeRefundId: string | null;
  promoRemoved: boolean;
  promoCoverage: PromoCoverageNotice | null;
  choreWarnings: string[];
  // Admin override (issue #1668): true when an over-capacity target was
  // explicitly confirmed. Always false on the standard (hard-blocked) path.
  capacityOverridden: boolean;
};
