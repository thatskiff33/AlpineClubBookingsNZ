import { storedShortBookingId } from "@/lib/booking-reference";

export const BOOKING_PAYMENT_METHOD_VALUES = [
  "stripe",
  "internet_banking",
] as const;

export type BookingPaymentMethod =
  (typeof BOOKING_PAYMENT_METHOD_VALUES)[number];

export const DEFAULT_BOOKING_PAYMENT_METHOD: BookingPaymentMethod = "stripe";

/** Stored on the payment and typed by the member into their bank: never change its output. */
export function buildInternetBankingPaymentReference(bookingId: string) {
  return `BOOKING-${storedShortBookingId(bookingId).toUpperCase()}`;
}

/** Stored on the group settlement and typed by the organiser into their bank: never change its output. */
export function buildGroupSettlementPaymentReference(groupBookingId: string) {
  return `GROUP-${storedShortBookingId(groupBookingId).toUpperCase()}`;
}
