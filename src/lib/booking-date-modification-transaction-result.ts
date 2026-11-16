// The date edit's transaction result, moved verbatim from
// `booking-date-modification-service.ts` to keep that file under its size
// ceiling (#5145). Types only.
import type { Booking, BookingGuest, Payment, PaymentSource, PaymentStatus } from "@prisma/client";

import type { BookingModificationPaymentContext } from "@/lib/booking-modification-settlement";
import type { BookingModificationSettlementMethod } from "@/lib/booking-modify";
import type { PromoCoverageNotice } from "@/lib/promo-cap-coverage";

export type ModifiedBooking = Booking & {
  guests: BookingGuest[];
  payment: Payment | null;
};

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
