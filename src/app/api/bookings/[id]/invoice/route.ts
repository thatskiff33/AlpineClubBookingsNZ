import { NextRequest, NextResponse } from "next/server";

import { prepareBookingInvoiceDownload } from "@/app/(authenticated)/bookings/[id]/_lib/booking-invoice-download";
import { auth } from "@/lib/auth";
import { checkRateLimit, rateLimitedResponse, rateLimiters } from "@/lib/rate-limit";
import { requireActiveSessionUser } from "@/lib/session-guards";

/**
 * GET /api/bookings/[id]/invoice (fork #115)
 *
 * Downloads the booking's invoice as a PDF: Xero's own invoice when the booking
 * has one, otherwise one generated from the booking. Open to everyone who can
 * view the booking page except a guest linked to someone else's booking
 * (`canDownloadBookingInvoice`); anyone else gets 404. Read-only.
 */
export async function GET(
  _request: NextRequest,
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

  const download = await prepareBookingInvoiceDownload(id, session);
  switch (download.kind) {
    case "NOT_FOUND":
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    case "XERO_UNAVAILABLE":
      return NextResponse.json(
        { error: "The invoice could not be fetched from Xero; please try again." },
        { status: 502 },
      );
    case "XERO_NOT_CONNECTED":
      return NextResponse.json(
        { error: "Xero is not connected right now, so this booking's Xero invoice cannot be downloaded. Please ask the club for a copy." },
        { status: 503 },
      );
    case "CANNOT_GENERATE":
      return NextResponse.json({ error: download.message }, { status: 409 });
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
