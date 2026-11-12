import "server-only";

import type { auth } from "@/lib/auth";
import { getAgeTierSettings } from "@/lib/age-tier";
import { readBookingAmountOwed } from "@/lib/booking-amount-owed";
import {
  bookingInvoiceFileName,
  buildBookingInvoiceData,
  canGenerateBookingInvoiceForStatus,
} from "@/lib/booking-invoice";
import { canDownloadBookingInvoice } from "@/lib/booking-invoice-access";
import { renderBookingInvoicePdf } from "@/lib/booking-invoice-pdf";
import { bookingOwner } from "@/lib/booking-owner";
import { recordedChangeFeeCents } from "@/lib/booking-payment-state";
import { getClubFormat } from "@/lib/club-format-settings";
import { loadClubTaxSettings } from "@/lib/club-tax-settings";
import { formatClubDate } from "@/lib/club-time";
import { clubTime } from "@/lib/club-time/server";
import { getNetCollectedCashParts } from "@/lib/payment-net-collected";
import { prisma } from "@/lib/prisma";
import { loadRateMembershipLabelResolver } from "@/lib/rate-membership-label";
import { LODGE_INVOICE_DETAIL_FIELDS } from "@/lib/lodges";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { isXeroConnected } from "@/lib/xero-token-store";
import { resolveBookingDetailViewer } from "./booking-detail-viewer";
import { loadBookingDetail } from "./load-booking-detail";

type BookingInvoiceSession = NonNullable<Awaited<ReturnType<typeof auth>>>;

/**
 * The booking invoice download (fork #115), behind `GET
 * /api/bookings/[id]/invoice`.
 *
 * - Access is the booking page's own viewer answer through
 *   `canDownloadBookingInvoice`; anything else is "not found", so the answer
 *   does not reveal that the booking exists.
 * - A booking with a Xero invoice gets Xero's PDF of it (owner decision 3). If
 *   Xero cannot be reached the download fails: it never falls back to a
 *   generated invoice, which would be a second document for the same debt
 *   without the number bank payments are matched on.
 * - Otherwise the invoice is generated from the booking (owner decision 4).
 *
 * Read-only: no database write, and the one provider call runs outside any
 * transaction.
 */
export type BookingInvoiceDownload =
  | { kind: "PDF"; body: Buffer; fileName: string; source: "XERO" | "GENERATED" }
  | { kind: "NOT_FOUND" }
  | { kind: "XERO_UNAVAILABLE" }
  | { kind: "XERO_NOT_CONNECTED" }
  | { kind: "CANNOT_GENERATE"; message: string };

const ORGANISER_PAID_MESSAGE =
  "This booking is paid through your group's invoice, so it has no invoice of its own. Please ask your group organiser for the group's invoice.";
const NOT_DUE_MESSAGE =
  "This booking has nothing to pay, so there is no invoice to download.";

const defaultDependencies = {
  xeroReachable: async (): Promise<boolean> =>
    (await loadEffectiveModuleFlags()).xeroIntegration && (await isXeroConnected()),
  fetchXeroInvoicePdf: async (invoiceId: string): Promise<Buffer> => {
    const { xero, tenantId } = await getAuthenticatedXeroClient();
    // Through the metered wrapper like every Xero call (usage row, daily-limit
    // memory, outage breaker). A failed download is inconsequential, so it
    // neither retries nor arms the process-wide breaker (#2394's rule for a
    // read behind a person's button).
    const result = await callXeroApi(
      () => xero.accountingApi.getInvoiceAsPdf(tenantId, invoiceId),
      {
        operation: "getInvoiceAsPdf",
        resourceType: "INVOICE",
        workflow: "bookingInvoiceDownload",
        maxRetries: 0,
        maxTransientRetries: 0,
        maxWaitSec: 0,
        armTransientBreaker: false,
      },
    );
    return Buffer.from(result.body);
  },
};

export async function prepareBookingInvoiceDownload(
  bookingId: string,
  session: BookingInvoiceSession,
  dependencies = defaultDependencies,
): Promise<BookingInvoiceDownload> {
  const booking = await loadBookingDetail(bookingId);
  if (!booking) return { kind: "NOT_FOUND" };
  const viewer = resolveBookingDetailViewer({ session, booking });
  if (!canDownloadBookingInvoice(viewer, booking)) {
    return { kind: "NOT_FOUND" };
  }

  const xeroInvoiceId = booking.payment?.xeroInvoiceId ?? null;
  if (xeroInvoiceId) {
    // With Xero switched off or disconnected the call cannot succeed, and a
    // generated copy is still not offered in its place (owner decision 3).
    try {
      if (!(await dependencies.xeroReachable())) return { kind: "XERO_NOT_CONNECTED" };
      const body = await dependencies.fetchXeroInvoicePdf(xeroInvoiceId);
      if (body.length === 0) return { kind: "XERO_UNAVAILABLE" };
      return {
        kind: "PDF",
        body,
        fileName: bookingInvoiceFileName(booking.id, booking.payment?.xeroInvoiceNumber),
        source: "XERO",
      };
    } catch {
      return { kind: "XERO_UNAVAILABLE" };
    }
  }

  // A group child the organiser pays for is billed on the group's settlement
  // invoice, never to the joiner; an invoice from this booking would ask the
  // joiner for money the organiser is paying.
  if (booking.organiserSettled) return { kind: "CANNOT_GENERATE", message: ORGANISER_PAID_MESSAGE };
  if (!canGenerateBookingInvoiceForStatus(booking.status)) {
    return { kind: "CANNOT_GENERATE", message: NOT_DUE_MESSAGE };
  }

  const [lodge, format, club, taxSettings, ageTierSettings, rateResolver, amountOwed] =
    await Promise.all([
      prisma.lodge.findUnique({
        where: { id: booking.lodgeId },
        select: {
          name: true,
          address: true,
          ...Object.fromEntries(LODGE_INVOICE_DETAIL_FIELDS.map((field) => [field, true])),
        } as { name: true; address: true } & Record<(typeof LODGE_INVOICE_DETAIL_FIELDS)[number], true>,
      }),
      getClubFormat(),
      clubTime(),
      loadClubTaxSettings(prisma),
      getAgeTierSettings(),
      loadRateMembershipLabelResolver(prisma),
      readBookingAmountOwed(booking),
    ]);
  if (!lodge) return { kind: "NOT_FOUND" };

  // Paid so far: the cash this booking took and still holds — the same
  // Net Collected figure the booking page reads (`getNetCollectedCashParts`) —
  // plus any account credit applied to it.
  const heldCashCents = booking.payment
    ? getNetCollectedCashParts({ ...booking.payment, booking }).heldCashCents
    : 0;
  const owner = bookingOwner(booking).member;

  try {
    const data = buildBookingInvoiceData({
      bookingId: booking.id,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      finalPriceCents: booking.finalPriceCents,
      changeFeeCents: recordedChangeFeeCents(booking.payment),
      guests: booking.guests,
      promoRedemptions: booking.promoRedemptions,
      billToName:
        booking.organisation?.name ??
        `${owner?.firstName ?? ""} ${owner?.lastName ?? ""}`.trim(),
      lodge,
      gstRegistered: taxSettings.gstRegistered,
      amountPaidCents: heldCashCents + amountOwed.appliedCreditCents,
      invoiceDate: formatClubDate(club.today(), format),
      format,
      ageTierLabels: new Map(ageTierSettings.map((setting) => [setting.tier, setting.label])),
      rateMembershipLabelResolver: rateResolver,
    });
    return {
      kind: "PDF",
      body: renderBookingInvoicePdf(data, format),
      fileName: bookingInvoiceFileName(booking.id, null),
      source: "GENERATED",
    };
  } catch (error) {
    if (error instanceof Error && error.name === "BookingInvoiceUnpricedNightError") {
      return { kind: "CANNOT_GENERATE", message: error.message };
    }
    throw error;
  }
}
