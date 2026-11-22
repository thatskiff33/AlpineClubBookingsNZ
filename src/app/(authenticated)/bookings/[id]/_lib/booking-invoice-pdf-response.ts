import { NextResponse } from "next/server";

import type { BookingInvoiceDownload } from "./booking-invoice-download";
import { rateLimitedResponse } from "@/lib/rate-limit";

/**
 * The HTTP answer for one booking invoice or credit-note download (#5066), so
 * `GET /api/bookings/[id]/invoice` and its credit-note route answer alike: the
 * same refusals, the same `private, no-store` PDF headers.
 */
export function bookingInvoicePdfResponse(download: BookingInvoiceDownload, documentName: "invoice" | "credit note"): Response {
  switch (download.kind) {
    case "NOT_FOUND":
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    case "RATE_LIMITED":
      return rateLimitedResponse(download.limit);
    case "XERO_NOT_CONNECTED":
      return NextResponse.json(
        { error: `The club's accounts are not connected right now, so the ${documentName} cannot be downloaded. Please try again later or ask the club for a copy.` },
        { status: 503 },
      );
    case "XERO_UNAVAILABLE":
      return NextResponse.json(
        { error: `The ${documentName} could not be fetched from the club's accounts; please try again.` },
        { status: 502 },
      );
    case "AUDIT_FAILED":
    case "SETTINGS_UNAVAILABLE":
      return NextResponse.json({ error: `The ${documentName} could not be downloaded; please try again.` }, { status: 503 });
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
