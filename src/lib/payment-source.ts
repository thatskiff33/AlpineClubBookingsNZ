import type { PaymentSource } from "@prisma/client";

/**
 * The two `Payment.source` values the money rules branch on, each spelled once
 * (`INV-SSOT`) and checked against the Prisma enum by the compiler. A leaf with
 * a type-only import, so the client-safe `group-organiser-paid.ts` and the pure
 * `booking-payment-state.ts` (which imports that module) can both read it.
 */

/** The source a card ask is minted against. */
export const CARD_PAYMENT_SOURCE = "STRIPE" satisfies PaymentSource;

/** The source Xero bills: an invoice paid by bank transfer, reconciled in Xero. */
export const INTERNET_BANKING_PAYMENT_SOURCE = "INTERNET_BANKING" satisfies PaymentSource;
