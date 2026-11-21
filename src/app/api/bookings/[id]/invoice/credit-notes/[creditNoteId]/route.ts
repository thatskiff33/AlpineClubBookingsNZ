import { NextRequest, NextResponse } from "next/server";

import { prepareBookingInvoiceDownload } from "@/app/(authenticated)/bookings/[id]/_lib/booking-invoice-download";
import { bookingInvoicePdfResponse } from "@/app/(authenticated)/bookings/[id]/_lib/booking-invoice-pdf-response";
import { auth } from "@/lib/auth";
import { BOOKING_INVOICE_DOWNLOAD_BOOKING_LIMIT, BOOKING_INVOICE_DOWNLOAD_MEMBER_LIMIT } from "@/lib/booking-invoice-rate-limits";
import { checkRateLimit, getClientIp, rateLimitedResponse } from "@/lib/rate-limit";
import { requireActiveSessionUser } from "@/lib/session-guards";

/**
 * GET /api/bookings/[id]/invoice/credit-notes/[creditNoteId] (#5066)
 *
 * Downloads one Xero credit note raised against the booking as Xero's own PDF
 * (owner decision on PR #5201, 17 Nov 2026), under the invoice's own rule:
 * the same audience and offer (`resolveBookingInvoiceOffer`), the same two
 * budgets, one audit row per successful download. The id must be one the
 * booking's offer lists (`readBookingCreditNotes`); any other id, like any
 * other refusal, is `404`, so the route cannot fetch an arbitrary credit note.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; creditNoteId: string }> },
) {
  const { id, creditNoteId } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id, {
    sessionUser: session.user,
  });
  if (inactiveResponse) return inactiveResponse;

  // As the invoice route: per member first, per booking only once on offer.
  const memberLimit = await checkRateLimit(BOOKING_INVOICE_DOWNLOAD_MEMBER_LIMIT, session.user.id);
  if (!memberLimit.success) return rateLimitedResponse(memberLimit);

  const download = await prepareBookingInvoiceDownload(id, session, { kind: "CREDIT_NOTE", creditNoteId }, {
    ipAddress: getClientIp(request),
    chargeBookingLimit: () => checkRateLimit(BOOKING_INVOICE_DOWNLOAD_BOOKING_LIMIT, id),
  });
  return bookingInvoicePdfResponse(download, "credit note");
}
