export type BookingPaymentMode = "payment" | "setup";

export interface BookingPaymentFlowState {
  status: string;
  hasNonMembers?: boolean | null;
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

  if (requiresSavedPaymentMethod(state)) {
    return false;
  }

  return ["CONFIRMED", "DRAFT", "PENDING"].includes(state.status);
}

export function getBookingPaymentMode(
  booking: string | BookingPaymentFlowState
): BookingPaymentMode {
  return requiresSavedPaymentMethod(booking) ? "setup" : "payment";
}
