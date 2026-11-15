import "server-only";

import type { auth } from "@/lib/auth";
import type { FeatureFlags } from "@/config/schema";
import { createAuditLog } from "@/lib/audit";
import { bookingOwner } from "@/lib/booking-owner";
import { formatBookingReference } from "@/lib/booking-reference";
import { primaryXeroInvoiceOnOffer, type BookingInvoiceOffer } from "@/lib/booking-invoice-access";
import { bookingHasAnySupplementaryInvoiceEvidence } from "@/lib/booking-supplementary-invoice-identities";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { isXeroConnected } from "@/lib/xero-token-store";
import { resolveBookingDetailViewer, type BookingDetailViewer } from "./booking-detail-viewer";
import { loadBookingDetail, type BookingDetailRecord } from "./load-booking-detail";

type BookingInvoiceSession = NonNullable<Awaited<ReturnType<typeof auth>>>;

/**
 * The booking invoice download (#5066, slice 1), behind the booking page's
 * Download invoice button and `GET /api/bookings/[id]/invoice`.
 *
 * WHICH INVOICE. Only the booking's primary Xero invoice (`Payment.xeroInvoiceId`),
 * and only when nothing says the booking has another invoice the member is
 * billed by. Two checks say so, and either is enough for a "please ask the
 * club" line instead of an incomplete record:
 *
 * - any ADDITIONAL ledger row on the payment (an extra charge, asked or
 *   withdrawn), as loaded by the page's own read; and
 * - any supplementary invoice evidence on the booking's supplementary anchors
 *   (`bookingHasAnySupplementaryInvoiceEvidence`): bank demand, card receipt,
 *   unsent or failed create, inactive link, unclassifiable second ask.
 *
 * Those anchors (Booking, BookingModification, edit-review ManualRefundTask) are
 * where every supplementary invoice writer anchors. The booking's other Xero
 * invoices bill no one on this page: a card-refund reversal invoice bills the
 * Stripe clearing account (`INV-PAY-151`), and a kept late capture's invoice
 * exists only on a cancelled booking, which is never offered. The route takes
 * no invoice id from the client at all.
 *
 * Read-only apart from the audit row: the one provider call runs outside any
 * transaction, through the metered `callXeroApi` with no retries, and never arms
 * the process-wide outage breaker (#2394's rule for a read behind a person's
 * button). Each successful download writes one audit row AFTER the Xero read; if
 * that row cannot be written the PDF is not handed over (owner decision 5 on
 * #5066: each download writes an audit row).
 */
export type BookingInvoiceDownload =
  | { kind: "PDF"; body: Buffer; fileName: string }
  | { kind: "NOT_FOUND" }
  | { kind: "XERO_NOT_CONNECTED" }
  | { kind: "XERO_UNAVAILABLE" }
  | { kind: "AUDIT_FAILED" };

const offerDependencies = {
  hasAnySupplementaryInvoice: bookingHasAnySupplementaryInvoiceEvidence,
};

/**
 * The page's and the route's one answer to "what invoice does this viewer get"
 * (`BookingInvoiceOffer`). The supplementary read runs only once the cheap gates
 * (audience, module, lifecycle, primary invoice, ledger rows) have said yes.
 */
export async function resolveBookingInvoiceOffer(
  input: {
    booking: BookingDetailRecord;
    viewer: Pick<BookingDetailViewer, "canSeeOwnerCredit">;
    modules: Pick<FeatureFlags, "xeroIntegration">;
  },
  dependencies = offerDependencies,
): Promise<BookingInvoiceOffer> {
  const primary = primaryXeroInvoiceOnOffer({
    viewer: input.viewer,
    booking: input.booking,
    xeroModuleOn: input.modules.xeroIntegration,
  });
  if (!primary) return { kind: "NONE" };
  // The page's read loads the payment's ADDITIONAL rows (any status, withdrawn
  // included); one is enough to say a further invoice may exist.
  if ((input.booking.payment?.transactions.length ?? 0) > 0) return { kind: "ASK_CLUB" };
  if (await dependencies.hasAnySupplementaryInvoice(input.booking.id)) return { kind: "ASK_CLUB" };
  return { kind: "XERO_INVOICE", invoiceNumber: primary.invoiceNumber };
}

/** `Invoice-<Xero number>.pdf`, else the booking reference; header-safe characters only. */
export function bookingInvoiceFileName(bookingId: string, invoiceNumber: string | null): string {
  const label = (invoiceNumber?.trim() || formatBookingReference(bookingId)).replace(/[^A-Za-z0-9._-]/g, "-");
  return `Invoice-${label}.pdf`;
}

const downloadDependencies = {
  loadBooking: loadBookingDetail,
  modules: loadEffectiveModuleFlags,
  offer: resolveBookingInvoiceOffer,
  xeroConnected: isXeroConnected,
  fetchXeroInvoicePdf: async (invoiceId: string): Promise<Buffer> => {
    const { xero, tenantId } = await getAuthenticatedXeroClient();
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
  writeAudit: createAuditLog,
};

export async function prepareBookingInvoiceDownload(
  bookingId: string,
  session: BookingInvoiceSession,
  request: { ipAddress: string | null },
  dependencies = downloadDependencies,
): Promise<BookingInvoiceDownload> {
  const booking = await dependencies.loadBooking(bookingId);
  if (!booking) return { kind: "NOT_FOUND" };
  const viewer = resolveBookingDetailViewer({ session, booking });
  const modules = await dependencies.modules();
  const offer = await dependencies.offer({ booking, viewer, modules });
  // Every refusal — audience, module, lifecycle, no invoice, a further invoice —
  // is the same "not found", so the answer reveals nothing about the booking.
  if (offer.kind !== "XERO_INVOICE") return { kind: "NOT_FOUND" };
  const invoiceId = booking.payment?.xeroInvoiceId;
  if (!invoiceId) return { kind: "NOT_FOUND" };

  let body: Buffer;
  try {
    if (!(await dependencies.xeroConnected())) return { kind: "XERO_NOT_CONNECTED" };
    body = await dependencies.fetchXeroInvoicePdf(invoiceId);
  } catch {
    return { kind: "XERO_UNAVAILABLE" };
  }
  if (body.length === 0) return { kind: "XERO_UNAVAILABLE" };

  const owner = bookingOwner(booking);
  try {
    await dependencies.writeAudit({
      action: "booking.invoice.downloaded",
      memberId: session.user.id,
      actorMemberId: session.user.id,
      targetId: booking.id,
      // INV-PRIV-019: an organisation-owned booking records no subject member.
      subjectMemberId: owner.memberId,
      entityType: "Booking",
      entityId: booking.id,
      category: "booking",
      outcome: "success",
      summary: "Booking invoice downloaded",
      metadata: {
        bookingId: booking.id,
        source: "XERO",
        xeroInvoiceNumber: offer.invoiceNumber,
        onBehalf: !viewer.isBookingOwner,
      },
      ipAddress: request.ipAddress,
    });
  } catch {
    return { kind: "AUDIT_FAILED" };
  }
  return { kind: "PDF", body, fileName: bookingInvoiceFileName(booking.id, offer.invoiceNumber) };
}
