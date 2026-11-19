import "server-only";

import { getAgeTierSettings } from "@/lib/age-tier";
import { readBookingAmountOwed } from "@/lib/booking-amount-owed";
import { buildBookingInvoiceData, type BookingInvoiceData } from "@/lib/booking-invoice";
import { renderBookingInvoicePdf } from "@/lib/booking-invoice-pdf";
import { bookingInvoiceSummary } from "@/lib/booking-invoice-summary";
import { bookingOwnerName } from "@/lib/booking-owner-name";
import { getClubFormat } from "@/lib/club-format-settings";
import { getClubInvoiceSupplier } from "@/lib/club-invoice-supplier";
import { formatClubDate } from "@/lib/club-time";
import { clubTime } from "@/lib/club-time/server";
import { prisma } from "@/lib/prisma";
import { loadRateMembershipLabelResolver } from "@/lib/rate-membership-label";
import type { BookingDetailRecord } from "./load-booking-detail";

const generatedDependencies = {
  supplier: getClubInvoiceSupplier,
  format: getClubFormat,
  clubTime,
  ageTierSettings: getAgeTierSettings,
  rateMembershipLabelResolver: () => loadRateMembershipLabelResolver(prisma),
  amountOwed: (booking: BookingDetailRecord) => readBookingAmountOwed(booking),
};

/**
 * The app's own booking invoice for a `GENERATED` offer (#5066, slice 2):
 * builds the document from the booking page's own read and renders the PDF.
 * Read-only: no provider call and no write (the caller audits the download).
 *
 * The figures are the page's: the lines from the booking row, the account rows
 * from `bookingInvoiceSummary` over the one amount-owed read
 * (`readBookingAmountOwed`), which is what the page's Invoice and credits card
 * shows. The date is the club's today in club time, never the server's.
 */
export async function renderGeneratedBookingInvoice(
  booking: BookingDetailRecord,
  offer: { notYetApproved: boolean },
  dependencies = generatedDependencies,
): Promise<{ body: Buffer; data: BookingInvoiceData; balanceCents: number }> {
  const [supplier, format, club, ageTierSettings, rateResolver, amountOwed] = await Promise.all([
    dependencies.supplier(),
    dependencies.format(),
    dependencies.clubTime(),
    dependencies.ageTierSettings(),
    dependencies.rateMembershipLabelResolver(),
    dependencies.amountOwed(booking),
  ]);
  const summary = bookingInvoiceSummary(booking, amountOwed);
  const data = buildBookingInvoiceData({
    bookingId: booking.id,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    finalPriceCents: booking.finalPriceCents,
    promoAdjustmentCents: booking.promoAdjustmentCents,
    guests: booking.guests,
    promoRedemptions: booking.promoRedemptions,
    billToName: bookingOwnerName(booking),
    supplier,
    lodgeName: booking.lodge.name,
    summary,
    notYetApproved: offer.notYetApproved,
    documentDate: formatClubDate(club.today(), format),
    format,
    ageTierLabels: new Map(ageTierSettings.map((setting) => [setting.tier, setting.label])),
    rateMembershipLabelResolver: rateResolver,
  });
  return { body: renderBookingInvoicePdf(data, format), data, balanceCents: summary.balanceCents };
}
