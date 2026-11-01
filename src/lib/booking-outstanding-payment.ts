import { isAdditionalAmountUncollected, isAdditionalPaymentDoorOpenForBooking } from "@/lib/additional-payment-chase";
import type { AdditionalAskCause } from "@/lib/additional-ask-cause";
import type { InvoicePayableObservation } from "@/lib/xero-invoice-payable-observation";

export type BookingOutstandingPaymentView =
  | { kind: "hidden" }
  | {
      kind: "ready";
      audience: "owner" | "officer";
      bookingStatus: string;
      revision: string;
      cardDueCents: number;
      /** Opaque identity of the current card ask; remounts a replaced pay door. */
      cardRevision: string;
      /** Why the current card ask exists (#4253); absent reads as a booking change. */
      askCause?: AdditionalAskCause;
      observations: InvoicePayableObservation[];
      incomplete: boolean;
      nextCursor: string | null;
    };

/** Member card authority; the deliberately narrower admin/chase predicate stays separate. */
export function bookingOutstandingCardCents(booking: {
  status: string;
  deletedAt: Date | null;
  payment: { additionalAmountCents: number; additionalPaymentStatus: string | null } | null;
}): number {
  return isAdditionalPaymentDoorOpenForBooking({ bookingStatus: booking.status, bookingDeletedAt: booking.deletedAt }) && isAdditionalAmountUncollected(booking.payment)
    ? booking.payment.additionalAmountCents : 0;
}

export function hasOutstandingCollectionEvidence(view: BookingOutstandingPaymentView): boolean {
  return view.kind === "ready" && (view.cardDueCents > 0 || view.incomplete || view.nextCursor !== null ||
    view.observations.some((row) => row.kind !== "settled"));
}
