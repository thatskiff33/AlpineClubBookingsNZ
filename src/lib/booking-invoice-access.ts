import { isAdditionalAskRetiredBookingStatus } from "@/lib/additional-payment-chase";
import { BookingStatus } from "@prisma/client";
import { planBookingInvoiceLines, type BookingInvoiceLineSource } from "@/lib/booking-invoice";
import type { BookingInvoiceSummary } from "@/lib/booking-invoice-summary";
import { PAID_LIKE_BOOKING_STATUSES, PAYMENT_OWED_BOOKING_STATUSES } from "@/lib/booking-status";
import { paidByOrganiserInternetBanking } from "@/lib/group-organiser-paid";

/** One Xero credit note raised against the booking (`readBookingCreditNotes`). */
export type BookingCreditNoteKind = "CHANGE" | "REFUND" | "ACCOUNT_CREDIT" | "CREDIT_USED";
export type BookingCreditNote = {
  creditNoteId: string;
  creditNoteNumber: string | null;
  kind: BookingCreditNoteKind;
};

/**
 * WHAT THE BOOKING PAGE OFFERS AS THE BOOKING'S INVOICE (#5066).
 *
 * Owner decisions on #5066 (15 Nov 2026): with the club's Xero module on, the
 * booking page offers Xero's own invoice PDF, so there is one invoice of record;
 * only with Xero off does the app generate its own document (slice 2). Only the
 * booking's owner, admins and booking officers may download either; a
 * cancelled booking's invoice is not offered.
 *
 * - `NONE`: no control at all.
 * - `XERO_INVOICE`: the Download invoice button, for the booking's primary Xero
 *   invoice (`Payment.xeroInvoiceId`), and one download per Xero credit note
 *   raised against the booking (`readBookingCreditNotes`; owner decision on
 *   PR #5201, 17 Nov 2026), each under the same audience, limits and audit.
 * - `ASK_CLUB`: the booking has, or may have, a further Xero invoice for a
 *   change to it (a supplementary invoice). Offering the primary alone would
 *   hand over an incomplete record, so the page says where to get copies:
 *   `staffViewer` (an officer or admin on someone else's booking,
 *   `nonOwnerAdminViewer`) is told to check the club's accounts; anyone else
 *   to ask the club. With Xero off it carries a `reason` (absent, the Xero
 *   case above): `XERO_DOCUMENTS` when the booking already has Xero documents
 *   from when the module was on, so no generated "Invoice" is made beside
 *   them; `EXTRA_CHARGE` when an extra charge was raised (asked or since
 *   withdrawn), which the generated document's figures do not cover;
 *   `REGISTERED_TAX_PERIOD` when the booking falls in a GST-registered period
 *   the club recorded (`generatedInvoiceWaitsOnTaxPeriod`).
 * - `GENERATED` (Xero off only): the Download invoice button, for the app's own
 *   document (`buildBookingInvoiceData`), marked "Not yet approved" on a
 *   booking awaiting review (`notYetApproved`). Its account lines ride beside
 *   it as for `XERO_INVOICE`, with no credit notes.
 *
 * THE ONE RULE for the buttons, `GET /api/bookings/[id]/invoice` and
 * `GET /api/bookings/[id]/invoice/credit-notes/[creditNoteId]` (`INV-SSOT`):
 * the page renders this answer and the routes serve only `XERO_INVOICE` or
 * `GENERATED` and, for a credit note, only an id in a `XERO_INVOICE` offer's
 * `creditNotes`, so neither can disagree with the other.
 */
export type BookingInvoiceOffer =
  | { kind: "NONE" }
  | { kind: "XERO_INVOICE"; invoiceNumber: string | null; creditNotes: BookingCreditNote[] }
  | { kind: "ASK_CLUB"; staffViewer: boolean; reason?: BookingInvoiceAskClubReason }
  | { kind: "GENERATED"; notYetApproved: boolean };

/** Why a Xero-off booking is pointed at the club instead of a generated document. */
export type BookingInvoiceAskClubReason = "XERO_DOCUMENTS" | "EXTRA_CHARGE" | "REGISTERED_TAX_PERIOD";

/**
 * The page-only account lines beside a `XERO_INVOICE` or `GENERATED` offer: the summary from
 * the app's own records and, when the app knows the invoice in Xero does not
 * show the latest change, a plain-words line saying so
 * (`primaryInvoiceUpdateNotice`). The routes never read it.
 */
export type BookingInvoiceAccount = {
  summary: BookingInvoiceSummary;
  invoiceUpdateNotice: string | null;
};

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

/**
 * The statuses the app's own document is made for: a booking that owes its
 * price or has paid it, and one awaiting the club's review (owner decision 5:
 * marked "Not yet approved"). Draft, pending, waitlisted and offered bookings
 * owe nothing yet; cancelled and bumped ones are ended.
 */
const GENERATED_INVOICE_STATUSES: ReadonlySet<string> = new Set<string>([
  ...PAYMENT_OWED_BOOKING_STATUSES,
  ...PAID_LIKE_BOOKING_STATUSES,
  BookingStatus.AWAITING_REVIEW,
]);

type GeneratedOfferBooking = BookingInvoiceLineSource & {
  status: string;
  organiserSettled: boolean;
  payment: { transactions: readonly unknown[]; xeroInvoiceId?: string | null } | null;
};

/**
 * Whether the page may offer the app's GENERATED invoice (#5066, slice 2), and
 * marked how. Pure: the same answer for the button and the route, so the page
 * never shows a control the route refuses (review finding 12).
 *
 * - Audience: `canSeeOwnerCredit`, as for the Xero invoice.
 * - Only while the Xero module is OFF (owner decision 1): a Xero club's
 *   invoice of record is Xero's, so no second document is ever made for it.
 * - Status: `GENERATED_INVOICE_STATUSES`; `AWAITING_REVIEW` is marked "Not yet
 *   approved".
 * - Not a group place the organiser pays for (`organiserSettled`, before or
 *   after the organiser pays): the organiser's settlement carries that money,
 *   so a document from the place would bill the joiner for it. The organiser's
 *   own booking is offered: its figures are its own guests only, and the
 *   group's settlement covers only the places (`groupSettlementTotalCents`).
 * - Its lines must be printable (`planBookingInvoiceLines`): no night whose
 *   price is not known (#3170), and lines that add up to the booking's price.
 * - Otherwise printable, a booking is pointed at the club (`ASK_CLUB`, never a
 *   silent nothing) when it already has a primary Xero invoice from when the
 *   module was on (`XERO_DOCUMENTS`), or an extra charge asked (any ADDITIONAL
 *   ledger row, `EXTRA_CHARGE`): the summary does not cover additional asks,
 *   which have their own pay link. The download refuses both. Other Xero
 *   documents (supplementary invoices, credit notes) and the booking's tax
 *   period need a read, so `resolveBookingInvoiceOffer` asks after this says
 *   GENERATED (`generatedInvoiceWaitsOnTaxPeriod`).
 */
export function generatedBookingInvoiceOnOffer(input: {
  viewer: { canSeeOwnerCredit: boolean; nonOwnerAdminViewer: boolean };
  booking: GeneratedOfferBooking;
  xeroModuleOn: boolean;
}): Extract<BookingInvoiceOffer, { kind: "GENERATED" | "ASK_CLUB" }> | null {
  const { viewer, booking } = input;
  if (!viewer.canSeeOwnerCredit) return null;
  if (input.xeroModuleOn) return null;
  if (!GENERATED_INVOICE_STATUSES.has(booking.status)) return null;
  if (booking.organiserSettled) return null;
  if (planBookingInvoiceLines(booking).kind !== "LINES") return null;
  const askClub = (reason: BookingInvoiceAskClubReason) =>
    ({ kind: "ASK_CLUB", staffViewer: viewer.nonOwnerAdminViewer, reason }) as const;
  if (booking.payment?.xeroInvoiceId) return askClub("XERO_DOCUMENTS");
  if ((booking.payment?.transactions.length ?? 0) > 0) return askClub("EXTRA_CHARGE");
  return { kind: "GENERATED", notYetApproved: booking.status === BookingStatus.AWAITING_REVIEW };
}

/**
 * The tax period in force at a booking's tax anchor (`readBookingTaxAnchorInstant`:
 * when the booking was made, or for a group place its organiser's booking), as
 * the generated document's offer needs it: whether the club recorded that period
 * (`clubTaxPeriodIsRecorded`) and whether it is a GST-registered one.
 */
export type GeneratedInvoiceTaxPeriod = { recorded: boolean; registered: boolean };

/**
 * Owner decision of 20 Nov 2026 on #5066: the generated document is titled
 * "Invoice" and carries no tax wording, so it is not made for a booking whose
 * period the club recorded as GST-registered; that booking gets the
 * ask-the-club line until the "Tax invoice" form and the club GST number
 * setting exist (#5291). A club that never recorded a status, and a period it
 * recorded as not registered, get the document.
 */
export function generatedInvoiceWaitsOnTaxPeriod(tax: GeneratedInvoiceTaxPeriod): boolean {
  return tax.recorded && tax.registered;
}
