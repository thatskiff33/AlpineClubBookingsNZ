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

/**
 * Does the member still have to enter a card for this saved-card booking?
 *
 * Keyed on the card alone (#3266): `stripePaymentMethodId` is the one column
 * every charge path reads, so a row without it has nothing that can be
 * charged, whatever else it carries. That is deliberately NOT "does the row
 * carry a SetupIntent" — a SetupIntent id survives an abandoned replacement
 * (the member started re-saving and never finished) and a retirement (Stripe
 * refused the card and the charge path cleared it), and in both states the
 * member needs the form back. Nor is it the charge paths' own "reusable saved
 * card" question, which also needs the customer and the intent; that is a
 * different question with a different owner, and this one asks only whether
 * the member has something left to do. (Epic #3270 re-keys the page onto
 * #3269's `reusableSavedPaymentMethodOnRow` once both lanes share a base, so a
 * legacy row carrying an unusable pm shows the form too.)
 */
export function needsSavedCardEntry(
  payment: { stripePaymentMethodId: string | null } | null | undefined
): boolean {
  return !payment?.stripePaymentMethodId;
}

export function getBookingPaymentMode(
  booking: string | BookingPaymentFlowState
): BookingPaymentMode {
  return requiresSavedPaymentMethod(booking) ? "setup" : "payment";
}
