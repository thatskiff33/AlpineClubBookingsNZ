import type { Prisma } from "@prisma/client";

/**
 * Whether a booking's sale was settled outside this app, so Xero must never
 * receive a new invoice for it. Cash provenance is `manuallyMarkedPaidAt`; an
 * imported free stay has no manual payment to carry it, so its zero-amount
 * import row is the equivalent fence (#5005). A paid import keeps the manual
 * provenance its settle wrote, so once that is reversed it is invoiceable like
 * any reversed cash booking.
 */
export function bookingHasExternalSettlement(booking: {
  payment?: { manuallyMarkedPaidAt: Date | null } | null;
  importRow?: { amountCents: number } | null;
}): boolean {
  return Boolean(booking.payment?.manuallyMarkedPaidAt) || booking.importRow?.amountCents === 0;
}

/**
 * The same rule as a Prisma booking filter, for a query that must leave these
 * bookings out (`NOT: BOOKING_EXTERNAL_SETTLEMENT_WHERE`): the admin
 * missing-invoice list (#2262, #5005). One arm per condition of
 * `bookingHasExternalSettlement`; `booking-external-settlement.test.ts` checks
 * the two agree, so a list never offers a mint the enqueue fence refuses.
 */
export const BOOKING_EXTERNAL_SETTLEMENT_WHERE = {
  OR: [
    { payment: { manuallyMarkedPaidAt: { not: null } } },
    { importRow: { is: { amountCents: 0 } } },
  ],
} satisfies Prisma.BookingWhereInput;

/** How a booking the fence holds came to be settled outside the app: one decision for every message below. */
type ExternalSettlementKind = "manual" | "imported";

function externalSettlementKind(payment: { manuallyMarkedPaidAt: Date | null }): ExternalSettlementKind {
  return payment.manuallyMarkedPaidAt ? "manual" : "imported";
}

const CAUSE: Record<ExternalSettlementKind, string> = {
  manual: "manually marked paid (cash / off-Xero)",
  imported: "imported as settled outside the app",
};

const SKIP_REASON: Record<ExternalSettlementKind, string> = {
  manual:
    "Booking was manually marked paid (cash / off-Xero) after this invoice operation was queued — no Xero invoice is expected, so none was created and nothing was emailed (#2262).",
  imported:
    "Booking was imported as settled outside the app — no Xero invoice is expected, so none was created and nothing was emailed (#5005).",
};

/**
 * How a booking settled outside the app was settled, for the "no Xero invoice
 * is expected" messages: the manual stamp, or else the imported free stay
 * `bookingHasExternalSettlement` fences (#2262, #5005).
 */
export function externalSettlementCause(payment: { manuallyMarkedPaidAt: Date | null }): string {
  return CAUSE[externalSettlementKind(payment)];
}

/** Why an invoice operation on a booking settled outside the app created nothing (#2262, #5005). */
export function externalSettlementSkipReason(payment: { manuallyMarkedPaidAt: Date | null }): string {
  return SKIP_REASON[externalSettlementKind(payment)];
}
