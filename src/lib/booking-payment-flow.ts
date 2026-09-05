import { IMMEDIATE_PAYMENT_BOOKING_STATUSES } from "@/lib/booking-status";

export type BookingPaymentMode = "payment" | "setup";

export interface BookingPaymentFlowState {
  status: string;
  hasNonMembers?: boolean | null;
  // Group booking ORGANISER_PAYS: the organiser settles this booking, so the
  // joiner who owns it must never be offered a self-pay flow.
  organiserSettled?: boolean | null;
}

function normalizeBookingState(
  booking: string | BookingPaymentFlowState
): BookingPaymentFlowState {
  return typeof booking === "string" ? { status: booking } : booking;
}

export function requiresSavedPaymentMethod(
  booking: string | BookingPaymentFlowState
) {
  const state = normalizeBookingState(booking);
  return state.status === "PENDING" && state.hasNonMembers !== false;
}

export function canCreateImmediatePaymentIntent(
  booking: string | BookingPaymentFlowState
) {
  const state = normalizeBookingState(booking);

  // The organiser settles ORGANISER_PAYS bookings as one combined bill; the
  // joiner who owns the booking is never billed and cannot pay it here.
  if (state.organiserSettled) {
    return false;
  }

  if (requiresSavedPaymentMethod(state)) {
    return false;
  }

  return (IMMEDIATE_PAYMENT_BOOKING_STATUSES as readonly string[]).includes(state.status);
}

export function getBookingPaymentMode(
  booking: string | BookingPaymentFlowState
): BookingPaymentMode {
  return requiresSavedPaymentMethod(booking) ? "setup" : "payment";
}
