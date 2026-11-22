import { NextRequest, NextResponse } from "next/server";

import { prepareBookingInvoiceDownload } from "@/app/(authenticated)/bookings/[id]/_lib/booking-invoice-download";
import { bookingInvoicePdfResponse } from "@/app/(authenticated)/bookings/[id]/_lib/booking-invoice-pdf-response";
import { auth } from "@/lib/auth";
import { BOOKING_INVOICE_DOWNLOAD_BOOKING_LIMIT, BOOKING_INVOICE_DOWNLOAD_MEMBER_LIMIT } from "@/lib/booking-invoice-rate-limits";
import { checkRateLimit, getClientIp, rateLimitedResponse } from "@/lib/rate-limit";
import { requireActiveSessionUser } from "@/lib/session-guards";

/**
 * GET /api/bookings/[id]/invoice (#5066)
 *
 * Downloads the booking's invoice for exactly the viewers and bookings the
 * booking page offers it to (`resolveBookingInvoiceOffer`); anything else is
 * `404`. With the club's Xero module on that is the primary Xero invoice as
 * Xero's own PDF; with it off, the app's generated document (slice 2). Takes no
 * invoice id from the caller. Writes one audit row per successful download.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id, {
    sessionUser: session.user,
  });
  if (inactiveResponse) return inactiveResponse;

  // A download is a live Xero read, or a PDF the app renders (Xero off). The
  // per-member budget comes first; the per-booking one (shared with the
  // booking's credit notes, so several officers on one booking cannot multiply
  // the reads) is charged only once the caller is authorised and the invoice
  // is on offer.
  const memberLimit = await checkRateLimit(BOOKING_INVOICE_DOWNLOAD_MEMBER_LIMIT, session.user.id);
  if (!memberLimit.success) return rateLimitedResponse(memberLimit);

  const download = await prepareBookingInvoiceDownload(id, session, { kind: "INVOICE" }, {
    ipAddress: getClientIp(request),
    chargeBookingLimit: () => checkRateLimit(BOOKING_INVOICE_DOWNLOAD_BOOKING_LIMIT, id),
  });
  return bookingInvoicePdfResponse(download, "invoice");
}
