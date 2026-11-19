// #1507, #4992: THE ONE HOME of a booking edit's card refund door - its Stripe
// idempotency-key prefix and the Stripe metadata `reason` it maps to
// (`INV-MOD-061`, #4101). The edit's transaction writes the prefix on its
// pre-persisted row (`stripeKeyPrefix`, #1152), the inline attempt
// (`executeBookingModificationRefund`) stamps the reason for it, and the
// recovery replay rebuilds that reason from the stored prefix, so all three
// send one request. A new door adds its row here; a caller of
// `reserveModificationRefundDebts` naming no door here is refused by
// `modification-refund-replay-reason.test.ts`. Legacy rows enqueued before
// #1152 carry no stored prefix; they keep the historical recovery reason and
// their operation-scoped key. Split out of `payment-recovery-keys.ts`, which
// re-exports it, to keep that file within its size budget.
export const BOOKING_MODIFICATION_REFUND_DOORS = {
  dateChange: { prefix: "mod_dates_refund_", reason: "date_change_price_decrease" },
  batchModify: { prefix: "mod_batch_refund_", reason: "batch_modification" },
  guestRemoval: { prefix: "guest_remove_refund_", reason: "guest_removed_price_decrease" },
  guestAcceptanceReprice: { prefix: "guest_accept_refund_", reason: "guest_accepted_promo_reprice" },
} as const;

export type BookingModificationRefundDoor = keyof typeof BOOKING_MODIFICATION_REFUND_DOORS;

export function buildBookingModificationRefundKeyPrefix(door: BookingModificationRefundDoor, bookingId: string): string {
  return `${BOOKING_MODIFICATION_REFUND_DOORS[door].prefix}${bookingId}`;
}

/**
 * #4992 (`INV-SSOT`): THE ONE spelling of one edit's Stripe idempotency-key
 * prefix. The edit's reserve stores it on the row the runner replays and the
 * inline attempt sends under it, so both send one request and Stripe makes the
 * refund once.
 */
export function buildBookingModificationRefundStripeKeyPrefix(
  door: BookingModificationRefundDoor,
  bookingId: string,
  bookingModificationId: string,
): string {
  return `${buildBookingModificationRefundKeyPrefix(door, bookingId)}_${bookingModificationId}`;
}
