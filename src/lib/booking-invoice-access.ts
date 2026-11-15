import { isAdditionalAskRetiredBookingStatus } from "@/lib/additional-payment-chase";
import { paidByOrganiserInternetBanking } from "@/lib/group-organiser-paid";

/**
 * WHAT THE BOOKING PAGE OFFERS AS THE BOOKING'S INVOICE (#5066, slice 1).
 *
 * Owner decisions on #5066 (15 Nov 2026): with the club's Xero module on, the
 * booking page offers Xero's own invoice PDF, so there is one invoice of record;
 * only the booking's owner, admins and booking officers may download it; a
 * cancelled booking's invoice is not offered. With Xero off nothing is offered
 * yet — the app's own generated document is a later slice.
 *
 * - `NONE`: no control at all.
 * - `XERO_INVOICE`: the Download invoice button, for the booking's primary Xero
 *   invoice (`Payment.xeroInvoiceId`).
 * - `ASK_CLUB`: the booking has, or may have, a further Xero invoice for a
 *   change to it (a supplementary invoice). Offering the primary alone would
 *   hand over an incomplete record, so the page says where to get copies:
 *   `staffViewer` (an officer or admin on someone else's booking,
 *   `nonOwnerAdminViewer`) is told to open Xero; anyone else to ask the club.
 *
 * THE ONE RULE for the button and `GET /api/bookings/[id]/invoice`
 * (`INV-SSOT`): the page renders this answer and the route serves only
 * `XERO_INVOICE`, so neither can disagree with the other.
 */
export type BookingInvoiceOffer =
  | { kind: "NONE" }
  | { kind: "XERO_INVOICE"; invoiceNumber: string | null }
  | { kind: "ASK_CLUB"; staffViewer: boolean };

type InvoiceOfferBooking = {
  status: string;
  organiserSettled: boolean;
  parentBookingId: string | null;
  payment: {
    source: string;
    xeroInvoiceId: string | null;
    xeroInvoiceNumber: string | null;
  } | null;
};

/**
 * The booking's primary Xero invoice when the page may offer it, else null.
 * Pure: the further-invoice question is asked only after this says yes.
 *
 * - Audience: the booking page's own `canSeeOwnerCredit` (#3991) — the owner,
 *   anyone who can manage the booking, and admin-type viewers; never a linked
 *   guest.
 * - The Xero module must be on (`modules.xeroIntegration`).
 * - An ended booking (CANCELLED, or BUMPED — the system's cancellation of a
 *   pending one) is not offered: its asks are retired (`INV-ADDPAY-044`) and
 *   its invoice is not a debt the member still owes. This also covers a deleted
 *   booking: `softDeleteCancelledBooking` deletes only CANCELLED bookings.
 * - A place the group organiser paid by internet banking never has an invoice
 *   of its own (`INV-PAY-148`); any invoice id it carries is the organiser's
 *   combined invoice, which names the whole group.
 */
export function primaryXeroInvoiceOnOffer(input: {
  viewer: { canSeeOwnerCredit: boolean };
  booking: InvoiceOfferBooking;
  xeroModuleOn: boolean;
}): { invoiceId: string; invoiceNumber: string | null } | null {
  const { viewer, booking } = input;
  if (!viewer.canSeeOwnerCredit) return null;
  if (!input.xeroModuleOn) return null;
  // The asks' ended-booking list doubles as "no invoice offered": both ask whether the booking still owes anything.
  if (isAdditionalAskRetiredBookingStatus(booking.status)) return null;
  if (paidByOrganiserInternetBanking(booking)) return null;
  const invoiceId = booking.payment?.xeroInvoiceId ?? null;
  if (!invoiceId) return null;
  return { invoiceId, invoiceNumber: booking.payment?.xeroInvoiceNumber ?? null };
}
