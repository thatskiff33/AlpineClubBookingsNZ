export const BOOKING_PAYMENT_METHOD_VALUES = [
  "stripe",
  "internet_banking",
] as const;

export type BookingPaymentMethod =
  (typeof BOOKING_PAYMENT_METHOD_VALUES)[number];

export const DEFAULT_BOOKING_PAYMENT_METHOD: BookingPaymentMethod = "stripe";

export function buildInternetBankingPaymentReference(bookingId: string) {
  return `BOOKING-${bookingId.slice(0, 8).toUpperCase()}`;
}
