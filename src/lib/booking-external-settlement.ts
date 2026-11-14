/**
 * Whether a booking's sale was settled outside this app, so Xero must never
 * receive a new invoice for it. Import rows also cover free carried-over
 * stays: they have no manual payment to carry cash provenance (#5005).
 */
export function bookingHasExternalSettlement(booking: {
  payment?: { manuallyMarkedPaidAt: Date | null } | null;
  importRow?: { id: string } | null;
}): boolean {
  return Boolean(booking.payment?.manuallyMarkedPaidAt || booking.importRow);
}
