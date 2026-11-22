/**
 * THE APP'S GENERATED BOOKING INVOICE (#5066, slice 2), as plain data.
 *
 * Owner decisions of 15 Nov 2026 on #5066:
 *
 * 1. Made ONLY while the club's Xero module is off. With Xero on, the booking
 *    page offers Xero's own invoice (slice 1, `primaryXeroInvoiceOnOffer`) and
 *    nothing here runs, so a Xero club never gets a second document for the
 *    same debt.
 * 2. Titled "Invoice", with NO GST wording at all: no GST number, no "includes
 *    GST", no tax line. Owner decision of 20 Nov 2026: that form is made only
 *    for a booking whose tax anchor falls in no recorded period (the code
 *    baseline) or in a period the club recorded as not registered. A booking
 *    in a GST-registered period the club recorded (#5153's schedule,
 *    `INV-CONFIG-007`) is pointed at the club instead
 *    (`generatedInvoiceWaitsOnTaxPeriod`, read by the offer before this runs),
 *    until the "Tax invoice" form and the club GST number setting are built
 *    (#5291). Nothing here reads the schedule: the offer does, through
 *    `resolveAnchoredClubTax`.
 * 4. The supplier is the club's legal name and postal address
 *    (`getClubInvoiceSupplier`), with the lodge named as the place of stay. No
 *    issuer contact line.
 * 5. A booking awaiting review gets a document marked "Not yet approved"; a
 *    cancelled booking gets none; account credit is its own line, with the
 *    balance from the shared amount-owed figure.
 *
 * No payment box and no bank details: the club's bank details are #4526's
 * setting, not built yet. No invoice number: the document carries the date it
 * was downloaded, in club time, and each download is audited instead.
 *
 * Pure: the booking and its figures in, everything the PDF prints out, in
 * integer cents. Each figure has one home (`INV-SSOT`, `INV-MONEY`):
 *
 * - guest lines: the runs `buildGuestInvoiceLines` cuts, the builder the Xero
 *   invoice's guest lines are made from;
 * - promotions: one line per code with the booking page's own amounts and
 *   fallback (`perCodePromoAdjustmentRows`, `INV-MONEY-040`), never a remainder;
 * - the change fee: the fee recorded on the payment (`recordedChangeFeeCents`,
 *   through the summary);
 * - the total, credit, paid and balance: `bookingInvoiceSummary`, the figures
 *   the booking page's Invoice and credits card shows, in its words
 *   (`bookingInvoiceAccountRows`).
 *
 * The lines must add up to the booking's price. When they do not (a stored-side
 * defect the booking's money reconciliation reports), or a guest holds a night
 * whose price is not known (#3170), no document is made: the offer is withheld
 * (`planBookingInvoiceLines`), rather than printing an invented split or a
 * balancing line.
 */
import { ageTierLabel } from "@/lib/age-tier-name";
import {
  buildGuestInvoiceLines,
  guestInvoiceLineAmountCents,
  type GuestInvoiceLine,
  type GuestInvoiceLineGuest,
} from "@/lib/booking-guest-invoice-lines";
import type { BookingInvoiceSummary } from "@/lib/booking-invoice-summary";
import { bookingInvoiceAccountRows, type BookingInvoiceSummaryRow } from "@/lib/booking-invoice-summary-rows";
import {
  bookingPromoCodeAdjustments,
  bookingPromoRedemptions,
  perCodePromoAdjustmentRows,
} from "@/lib/booking-promo-redemptions";
import { formatBookingReference } from "@/lib/booking-reference";
import type { ClubInvoiceSupplier } from "@/lib/club-invoice-supplier";
import { calendarDateOfDateOnlyInstant, formatClubLongWeekdayDate, type ClubDateFormat } from "@/lib/club-time";
import { getStayNights } from "@/lib/policies/pricing";
import { describeGuestRateMembershipLabel, type RateMembershipLabelResolver } from "@/lib/rate-membership-label";
import { CHANGE_FEE_LINE_DESCRIPTION } from "@/lib/xero-modification-line-items";
import { workingBeeDiscountLabel } from "@/lib/working-bee-discount-label";
import { promoAdjustmentLineDescription } from "@/lib/xero-promo-adjustment-lines";

/**
 * The document's title. The "Tax invoice" form follows #5291; a booking in a
 * recorded GST-registered period is never offered this document.
 */
export const BOOKING_INVOICE_TITLE = "Invoice";
/** The mark on a booking the club has not approved yet (owner decision 5). */
export const BOOKING_INVOICE_NOT_YET_APPROVED = "Not yet approved";
export const BOOKING_INVOICE_NOT_YET_APPROVED_NOTE =
  "The club has not approved this booking yet, so nothing is payable until it does.";

export interface BookingInvoiceGuest extends GuestInvoiceLineGuest {
  firstName: string;
  lastName: string;
  ageTier: string;
  isMember: boolean;
  rateMembershipTypeId?: string | null;
}

export interface BookingInvoicePromoRedemption {
  id?: string | null;
  applicationOrder?: number | null;
  priceAdjustmentCents: number;
  promoCode: {
    code: string;
    internal?: boolean | null;
    workPartyEvent?: { name: string } | null;
  } | null;
}

/** What the lines are made from: the booking's own stored figures. */
export interface BookingInvoiceLineSource {
  checkIn: Date;
  checkOut: Date;
  finalPriceCents: number;
  promoAdjustmentCents: number;
  guests: readonly BookingInvoiceGuest[];
  promoRedemptions?: readonly BookingInvoicePromoRedemption[] | null;
}

export type BookingInvoiceLinePlan =
  | {
      kind: "LINES";
      stayNights: number;
      guestRuns: Array<GuestInvoiceLine<BookingInvoiceGuest>>;
      promoLines: Array<{ description: string; amountCents: number }>;
    }
  /** A guest holds a night whose price is not known yet (#3170). */
  | { kind: "UNPRICED_NIGHT" }
  /** The guest and promotion lines do not come to the booking's price. */
  | { kind: "LINES_DO_NOT_ADD_UP" };

type InvoicePromoCode = NonNullable<BookingInvoicePromoRedemption["promoCode"]>;

/**
 * A code's words: the booking page's own for a work party's internal code
 * (which is the club's, never printed), else the Xero invoice's
 * `Promo adjustment - CODE`.
 */
function promoName(promo: InvoicePromoCode): string {
  if (!promo.internal) return promoAdjustmentLineDescription(promo.code);
  return workingBeeDiscountLabel(promo.workPartyEvent?.name);
}

/**
 * One line per code with its own adjustment, exactly when the booking page and
 * the confirmation email show one row per code (`perCodePromoAdjustmentRows`);
 * otherwise their one combined row, naming the code (or every code), at the
 * booking's `promoAdjustmentCents`.
 */
function promoLines(source: BookingInvoiceLineSource): Array<{ description: string; amountCents: number }> {
  const redemptions = bookingPromoRedemptions({ promoRedemptions: source.promoRedemptions ?? [] });
  const promos = redemptions.flatMap((redemption) => (redemption.promoCode ? [redemption.promoCode] : []));
  const byCode = new Map(promos.map((promo) => [promo.code, promo] as const));
  const perCode = perCodePromoAdjustmentRows(
    bookingPromoCodeAdjustments({ promoRedemptions: redemptions }),
    source.promoAdjustmentCents,
  );
  if (perCode) {
    return perCode.map((row) => ({ description: promoName(byCode.get(row.code)!), amountCents: row.amountCents }));
  }
  if (source.promoAdjustmentCents === 0) return [];
  const names = promos.map((promo) => (promo.internal ? "working bee" : promo.code));
  const description = promos.length === 1 ? promoName(promos[0]!) : promoAdjustmentLineDescription(names.join(", ") || null);
  return [{ description, amountCents: source.promoAdjustmentCents }];
}

/**
 * The document's stay lines, or why there can be none. Pure: the one check
 * both the offer (so the page never shows a dead button) and the download make.
 */
export function planBookingInvoiceLines(source: BookingInvoiceLineSource): BookingInvoiceLinePlan {
  const stayNights = getStayNights(source.checkIn, source.checkOut).length;
  const guestRuns = buildGuestInvoiceLines(source.guests, source.checkIn, source.checkOut, stayNights);
  if (guestRuns.some((line) => line.hasUnpricedNight)) return { kind: "UNPRICED_NIGHT" };
  const promo = promoLines(source);
  const lineTotal =
    guestRuns.reduce((sum, line) => sum + guestInvoiceLineAmountCents(line), 0) +
    promo.reduce((sum, line) => sum + line.amountCents, 0);
  if (lineTotal !== source.finalPriceCents) return { kind: "LINES_DO_NOT_ADD_UP" };
  return { kind: "LINES", stayNights, guestRuns, promoLines: promo };
}

export type BookingInvoiceLine =
  | { kind: "GUEST"; guest: string; category: string; nights: number; ratePerNightCents: number; amountCents: number }
  | { kind: "PROMO" | "FEE"; description: string; amountCents: number };

export interface BookingInvoiceInput extends BookingInvoiceLineSource {
  bookingId: string;
  /** `bookingOwnerName`: the organisation, else the member. */
  billToName: string;
  supplier: ClubInvoiceSupplier;
  /** The lodge, named as the place of stay (owner decision 4). */
  lodgeName: string;
  /** `bookingInvoiceSummary` for the booking: the booking page's own figures. */
  summary: BookingInvoiceSummary;
  notYetApproved: boolean;
  /**
   * The download date, already formatted: the club's today through
   * `formatClubDate`, by the caller. Kept out of this module so it never pairs
   * a stay-date decoder with `formatClubDate` (`INV-SSOT-001`).
   */
  documentDate: string;
  format: ClubDateFormat;
  ageTierLabels: ReadonlyMap<string, string>;
  rateMembershipLabelResolver: RateMembershipLabelResolver | null;
}

export interface BookingInvoiceData {
  title: typeof BOOKING_INVOICE_TITLE;
  supplier: ClubInvoiceSupplier;
  placeOfStay: string;
  documentDate: string;
  bookingReference: string;
  notYetApproved: boolean;
  billTo: string;
  stay: { checkIn: string; checkOut: string; nights: number; guests: number };
  lines: BookingInvoiceLine[];
  /** The booking's worth: its price plus its recorded change fee. */
  totalCents: number;
  accountRows: BookingInvoiceSummaryRow[];
}

/** Why a document could not be built. The offer withholds the button first, so this is a race only. */
export class BookingInvoiceNotAvailableError extends Error {
  constructor(readonly reason: Exclude<BookingInvoiceLinePlan["kind"], "LINES"> | "TOTAL_DIFFERS") {
    super(`A booking invoice cannot be generated for this booking (${reason}).`);
    this.name = "BookingInvoiceNotAvailableError";
  }
}

function guestCategory(
  guest: BookingInvoiceGuest,
  input: Pick<BookingInvoiceInput, "ageTierLabels" | "rateMembershipLabelResolver">,
): string {
  const tier = ageTierLabel(guest.ageTier, (key) => input.ageTierLabels.get(key));
  return `${tier} · ${describeGuestRateMembershipLabel(input.rateMembershipLabelResolver, guest)}`;
}

export function buildBookingInvoiceData(input: BookingInvoiceInput): BookingInvoiceData {
  const plan = planBookingInvoiceLines(input);
  if (plan.kind !== "LINES") throw new BookingInvoiceNotAvailableError(plan.kind);
  const { summary } = input;
  // The summary is read from the same booking row, so this holds unless a
  // caller hands over a summary for another price: refuse rather than print a
  // total the lines do not reach.
  if (summary.totalCents !== input.finalPriceCents) throw new BookingInvoiceNotAvailableError("TOTAL_DIFFERS");
  const lines: BookingInvoiceLine[] = [
    ...plan.guestRuns.map((line) => ({
      kind: "GUEST" as const,
      guest: `${line.guest.firstName} ${line.guest.lastName}`.trim(),
      category: guestCategory(line.guest, input),
      nights: line.run.nightCount,
      ratePerNightCents: line.run.perNightCents,
      amountCents: guestInvoiceLineAmountCents(line),
    })),
    ...plan.promoLines.map((line) => ({ kind: "PROMO" as const, ...line })),
    ...(summary.changeFeeCents > 0
      ? [{ kind: "FEE" as const, description: CHANGE_FEE_LINE_DESCRIPTION, amountCents: summary.changeFeeCents }]
      : []),
  ];

  return {
    title: BOOKING_INVOICE_TITLE,
    supplier: input.supplier,
    placeOfStay: input.lodgeName,
    documentDate: input.documentDate,
    bookingReference: formatBookingReference(input.bookingId),
    notYetApproved: input.notYetApproved,
    billTo: input.billToName,
    stay: {
      checkIn: formatClubLongWeekdayDate(calendarDateOfDateOnlyInstant(input.checkIn), input.format),
      checkOut: formatClubLongWeekdayDate(calendarDateOfDateOnlyInstant(input.checkOut), input.format),
      nights: plan.stayNights,
      guests: input.guests.length,
    },
    lines,
    totalCents: summary.totalCents + summary.changeFeeCents,
    accountRows: bookingInvoiceAccountRows(summary),
  };
}
