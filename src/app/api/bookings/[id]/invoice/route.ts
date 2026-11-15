import { NextRequest, NextResponse } from "next/server";

import { prepareBookingInvoiceDownload } from "@/app/(authenticated)/bookings/[id]/_lib/booking-invoice-download";
import { auth } from "@/lib/auth";
import { checkRateLimit, getClientIp, rateLimitedResponse, rateLimiters } from "@/lib/rate-limit";
import { requireActiveSessionUser } from "@/lib/session-guards";

/**
 * GET /api/bookings/[id]/invoice (#5066, slice 1)
 *
 * Downloads the booking's primary Xero invoice as Xero's own PDF, for exactly
 * the viewers and bookings the booking page offers it to
 * (`resolveBookingInvoiceOffer`); anything else is `404`. Takes no invoice id
 * from the caller. Writes one audit row per successful download.
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

  const limited = await checkRateLimit(
    rateLimiters.bookingQuery,
    `booking-invoice:${session.user.id}`,
  );
  if (!limited.success) return rateLimitedResponse(limited);

  const download = await prepareBookingInvoiceDownload(id, session, {
    ipAddress: getClientIp(request),
  });
  switch (download.kind) {
    case "NOT_FOUND":
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    case "XERO_NOT_CONNECTED":
      return NextResponse.json(
        { error: "The club's accounts are not connected right now, so the invoice cannot be downloaded. Please try again later or ask the club for a copy." },
        { status: 503 },
      );
    case "XERO_UNAVAILABLE":
      return NextResponse.json(
        { error: "The invoice could not be fetched from the club's accounts; please try again." },
        { status: 502 },
      );
    case "AUDIT_FAILED":
      return NextResponse.json(
        { error: "The invoice could not be downloaded; please try again." },
        { status: 503 },
      );
    case "PDF":
      return new NextResponse(new Uint8Array(download.body), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${download.fileName}"`,
          "Cache-Control": "private, no-store",
        },
      });
  }
}
