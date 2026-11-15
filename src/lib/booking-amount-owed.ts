import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { bookingAmountOwedCents, type BookingAmountOwed } from "@/lib/booking-payment-state";
import { deriveBookingAppliedCreditCents } from "@/lib/member-credit";

/**
 * What a payable booking still owes, read for a booking row already in hand
 * (#4058, #3991, `INV-PAY-119`): its price plus a change fee recorded on its
 * payment, less the credit applied to it. The pure arithmetic stays in
 * `bookingAmountOwedCents`; this adds the two reads it needs.
 *
 * THE ONE READ (`INV-SSOT`) for every surface that quotes the amount owed to a
 * member or charges what is owed (the saved-card charge takes the booking's
 * full worth by design, #3864, and does not read this): the `/pay/<token>` page and its card intent, the pay-link and
 * exception-approved emails, the booking page (its narrative, pay card and
 * `{amountDue}` token, read once per page load), the member's card intent
 * (`create-payment-intent`, both reads, the second under its transaction) and
 * the member dashboard's Payment Owed card (`member-dashboard.ts`, #4944). So
 * a page, the email a member opens it from and the charge cannot disagree.
 *
 * The credit is the LEDGER's (`deriveBookingAppliedCreditCents`, the sum of the
 * booking's `BOOKING_APPLIED` rows), which every intent is minted against —
 * never `Payment.creditAppliedCents`, which only mirrors it and is absent before
 * a payment row exists.
 *
 * `owedCents` can go to or below zero (credit covers it all) and is what every
 * decision reads; `dueCents` is that figure floored at zero, for a line that
 * says what to pay (`BookingAmountOwed`).
 *
 * NOT YET EVERY READER. These still call `bookingAmountOwedCents` with credit
 * they read or are handed themselves, and are known (#3991, to be raised on
 * their own): `confirm-payment/route.ts`, `switch-to-internet-banking/route.ts`,
 * `stripe-webhook-service.ts`, `manual-booking-payment-state.ts`,
 * `payment-reconciliation.ts`, `booking-modify-settlement.ts`,
 * `booking-date-modification-service.ts`, `booking-credit-election.ts`,
 * `edit-financial-review-account-credit.ts` and
 * `policies/booking-route-decisions.ts`. `amount-owed-one-home.test.ts` pins
 * that list, so a new composer is a deliberate addition.
 *
 * No `server-only` import: `payment-link-context.ts` is reachable from
 * `src/instrumentation.node.ts`, where it throws.
 */
export async function readBookingAmountOwed(
  booking: {
    id: string;
    finalPriceCents: number;
    payment: { changeFeeCents: number | null } | null;
  },
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<BookingAmountOwed> {
  const appliedCreditCents = await deriveBookingAppliedCreditCents(booking.id, db);
  const owedCents = bookingAmountOwedCents({
    finalPriceCents: booking.finalPriceCents,
    changeFeeCents: booking.payment?.changeFeeCents ?? null,
    appliedCreditCents,
  });
  return { owedCents, dueCents: Math.max(0, owedCents), appliedCreditCents };
}
