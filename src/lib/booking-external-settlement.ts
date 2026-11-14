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
