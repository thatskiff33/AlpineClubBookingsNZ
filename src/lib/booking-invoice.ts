/**
 * The generated booking invoice (fork #115), as plain data.
 *
 * Used when a booking has no Xero invoice: a club that does not use Xero, or an
 * organisation that needs an invoice while its group booking is not approved
 * yet. When Xero has an invoice for the booking, the download is Xero's own
 * PDF instead and nothing here runs.
 *
 * Pure: the booking, lodge, tax and payment facts in, everything the PDF
 * prints out, in integer cents and formatted dates. No database, no provider
 * and no PDF code, so the totals can be tested without rendering a page.
 *
 * The totals are the booking's own: the guest lines come from the shared
 * per-guest builder the Xero invoice uses (`buildGuestInvoiceLines`), and any
 * difference between them and the booking's final price is printed as its own
 * discount line, so the invoice always adds up to what the booking is worth
 * (`bookingWorthCents`) and never to a figure re-derived here.
 */
import { formatAgeTierName } from "@/lib/age-tier-name";
import {
  buildGuestInvoiceLines,
  guestInvoiceLineAmountCents,
} from "@/lib/booking-guest-invoice-lines";
import { buildInternetBankingPaymentReference } from "@/lib/booking-payment-methods";
import { bookingWorthCents, isSettledBookingStatus } from "@/lib/booking-payment-state";
import { formatBookingReference } from "@/lib/booking-reference";
import { isPaymentOwedBookingStatus } from "@/lib/booking-status";
import {
  calendarDateOfDateOnlyInstant,
  formatClubLongWeekdayDate,
  type ClubDateFormat,
} from "@/lib/club-time";
import { getStayNights } from "@/lib/policies/pricing";
import {
  describeGuestRateMembershipLabel,
  type RateMembershipLabelResolver,
} from "@/lib/rate-membership-label";
import { CHANGE_FEE_LINE_DESCRIPTION } from "@/lib/xero-modification-line-items";
import { promoAdjustmentLineDescription } from "@/lib/xero-promo-adjustment-lines";

/** The issuer line where a person or role is named (owner decision 7). */
export const BOOKING_INVOICE_CONTACT_LINE = "Booking Officer";

export interface BookingInvoiceGuest {
  firstName: string;
  lastName: string;
  ageTier: string;
  isMember: boolean;
  rateMembershipTypeId?: string | null;
  priceCents: number;
  nights?: Array<{ stayDate: Date; priceCents: number | null }> | null;
}

export interface BookingInvoicePromoRedemption {
  promoCode: {
    code: string;
    internal?: boolean | null;
    workPartyEvent?: { name: string } | null;
  } | null;
}

export interface BookingInvoiceLodge {
  name: string;
  address: string | null;
  postalAddress: string | null;
  bankAccountName: string | null;
  bankAccountDetails: string | null;
  gstNumber: string | null;
}

export interface BookingInvoiceInput {
  bookingId: string;
  checkIn: Date;
  checkOut: Date;
  finalPriceCents: number;
  /** The change fee recorded on the payment (`recordedChangeFeeCents`). */
  changeFeeCents: number;
  guests: readonly BookingInvoiceGuest[];
  promoRedemptions: readonly BookingInvoicePromoRedemption[];
  /** The organisation's name when there is one, otherwise the booker's (owner decision 6). */
  billToName: string;
  lodge: BookingInvoiceLodge;
  gstRegistered: boolean;
  /** Cash still held plus account credit applied, in cents. */
  amountPaidCents: number;
  /**
   * The invoice date, already formatted: the club's today through
   * `formatClubDate`, by the caller. Kept out of this module so it never pairs
   * a stay-date decoder with `formatClubDate` (`INV-SSOT-001`).
   */
  invoiceDate: string;
  format: ClubDateFormat;
  ageTierLabels: ReadonlyMap<string, string>;
  rateMembershipLabelResolver: RateMembershipLabelResolver | null;
}

export type BookingInvoiceLine =
  | {
      kind: "GUEST";
      guest: string;
      category: string;
      nights: number;
      ratePerNightCents: number;
      amountCents: number;
    }
  | { kind: "ADJUSTMENT" | "FEE"; description: string; amountCents: number };

export interface BookingInvoiceData {
  issuer: {
    lodgeName: string;
    addressLines: string[];
    contactLine: string;
    gstNumber: string | null;
  };
  /** Always null here: a generated invoice carries no number (owner decision 4). */
  invoiceNumber: null;
  invoiceDate: string;
  billTo: string;
  stay: { checkIn: string; checkOut: string; nights: number; guests: number };
  lines: BookingInvoiceLine[];
  subtotalCents: number;
  totalCents: number;
  includesGst: boolean;
  /** Present once any payment has arrived (owner decision 5). */
  payments: { amountPaidCents: number; balanceDueCents: number } | null;
  /** Present only when the lodge has bank details. */
  paymentDetails: {
    accountName: string | null;
    accountDetails: string | null;
    reference: string;
  } | null;
}

/**
 * The statuses a generated invoice may be made for: a booking that owes its
 * price or has paid it, and one awaiting the club's approval — the group
 * booking an organisation needs an invoice for before approval (owner decision
 * 9). A cancelled, draft or waitlisted booking owes nothing, so an invoice for
 * it would ask for money that is not due.
 */
export function canGenerateBookingInvoiceForStatus(status: string): boolean {
  return (
    isPaymentOwedBookingStatus(status) ||
    isSettledBookingStatus(status) ||
    status === "AWAITING_REVIEW"
  );
}

/** A guest night whose price is not known yet blocks the generated invoice. */
export class BookingInvoiceUnpricedNightError extends Error {
  constructor() {
    super(
      "This booking has a night whose price is still being reviewed, so an invoice cannot be generated yet.",
    );
    this.name = "BookingInvoiceUnpricedNightError";
  }
}

function textLines(value: string | null): string[] {
  return (value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function guestCategory(
  guest: BookingInvoiceGuest,
  input: Pick<BookingInvoiceInput, "ageTierLabels" | "rateMembershipLabelResolver">,
): string {
  const tier = input.ageTierLabels.get(guest.ageTier) ?? formatAgeTierName(guest.ageTier);
  return `${tier} · ${describeGuestRateMembershipLabel(input.rateMembershipLabelResolver, guest)}`;
}

/**
 * The words for the line that carries the difference between the guest lines
 * and the booking's final price. A work party's internal code is never printed
 * (it is the club's, not the booker's): its line names the work party.
 */
function adjustmentDescription(
  redemptions: readonly BookingInvoicePromoRedemption[],
): string {
  const promos = redemptions.flatMap((redemption) =>
    redemption.promoCode ? [redemption.promoCode] : [],
  );
  if (promos.length === 0) return "Price adjustment";
  if (promos.length > 1) return "Discounts and promotions";
  const [promo] = promos;
  if (promo!.internal) {
    // The booking page's own words for a work party's discount.
    return promo!.workPartyEvent?.name
      ? `Working bee discount (${promo!.workPartyEvent.name})`
      : "Working bee discount";
  }
  return promoAdjustmentLineDescription(promo!.code);
}

export function buildBookingInvoiceData(input: BookingInvoiceInput): BookingInvoiceData {
  const stayNights = getStayNights(input.checkIn, input.checkOut).length;
  const guestLines = buildGuestInvoiceLines(
    input.guests,
    input.checkIn,
    input.checkOut,
    stayNights,
  );
  if (guestLines.some((line) => line.hasUnpricedNight)) {
    throw new BookingInvoiceUnpricedNightError();
  }

  const lines: BookingInvoiceLine[] = guestLines.map((line) => ({
    kind: "GUEST",
    guest: `${line.guest.firstName} ${line.guest.lastName}`.trim(),
    category: guestCategory(line.guest, input),
    nights: line.run.nightCount,
    ratePerNightCents: line.run.perNightCents,
    amountCents: guestInvoiceLineAmountCents(line),
  }));

  const guestTotalCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
  const adjustmentCents = input.finalPriceCents - guestTotalCents;
  if (adjustmentCents !== 0) {
    lines.push({
      kind: "ADJUSTMENT",
      description: adjustmentDescription(input.promoRedemptions),
      amountCents: adjustmentCents,
    });
  }
  if (input.changeFeeCents > 0) {
    lines.push({
      kind: "FEE",
      description: CHANGE_FEE_LINE_DESCRIPTION,
      amountCents: input.changeFeeCents,
    });
  }

  const totalCents = bookingWorthCents({
    finalPriceCents: input.finalPriceCents,
    changeFeeCents: input.changeFeeCents,
  });
  const subtotalCents = lines.reduce((sum, line) => sum + line.amountCents, 0);

  const addressLines = textLines(input.lodge.postalAddress);
  const hasBankDetails = Boolean(
    input.lodge.bankAccountName?.trim() || input.lodge.bankAccountDetails?.trim(),
  );

  return {
    issuer: {
      lodgeName: input.lodge.name,
      addressLines: addressLines.length > 0 ? addressLines : textLines(input.lodge.address),
      contactLine: BOOKING_INVOICE_CONTACT_LINE,
      gstNumber: input.lodge.gstNumber?.trim() || null,
    },
    invoiceNumber: null,
    invoiceDate: input.invoiceDate,
    billTo: input.billToName,
    stay: {
      checkIn: formatClubLongWeekdayDate(calendarDateOfDateOnlyInstant(input.checkIn), input.format),
      checkOut: formatClubLongWeekdayDate(calendarDateOfDateOnlyInstant(input.checkOut), input.format),
      nights: stayNights,
      guests: input.guests.length,
    },
    lines,
    subtotalCents,
    totalCents,
    includesGst: input.gstRegistered,
    payments:
      input.amountPaidCents > 0
        ? {
            amountPaidCents: input.amountPaidCents,
            balanceDueCents: Math.max(0, totalCents - input.amountPaidCents),
          }
        : null,
    paymentDetails: hasBankDetails
      ? {
          accountName: input.lodge.bankAccountName?.trim() || null,
          accountDetails: input.lodge.bankAccountDetails?.trim() || null,
          reference: buildInternetBankingPaymentReference(input.bookingId),
        }
      : null,
  };
}

/** The download's file name: Xero's invoice number when there is one, else the booking's short reference. */
export function bookingInvoiceFileName(
  bookingId: string,
  xeroInvoiceNumber: string | null | undefined,
): string {
  const label = (xeroInvoiceNumber?.trim() || formatBookingReference(bookingId)).replace(
    /[^A-Za-z0-9._-]/g,
    "-",
  );
  return `Invoice-${label}.pdf`;
}
