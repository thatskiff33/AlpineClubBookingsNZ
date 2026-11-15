"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { apiErrorMessageFromResponse } from "@/lib/api-error-message";
import type { BookingInvoiceOffer } from "@/lib/booking-invoice-access";
import { saveResponseAsFile } from "@/lib/save-response-as-file";

const DOWNLOAD_FAILED = "The invoice could not be downloaded. Please try again.";
// The route answers every refusal with the same 404; by the time someone
// clicks, the page they loaded may be stale (the booking changed, or Xero was
// switched off), so say so rather than "booking not found".
const NO_LONGER_AVAILABLE = "This invoice is no longer available from this page; please refresh.";

/**
 * The booking page's invoice control (#5066, slice 1), beside Edit Booking. It
 * renders the page's `BookingInvoiceOffer` and nothing else: a Download invoice
 * button for the booking's Xero invoice, a line saying where to get copies when
 * the booking may have more than one invoice, or nothing at all.
 *
 * The "more than one invoice" line knows its reader (#1289): an officer or admin
 * looking at someone else's booking is told to open Xero, not addressed as the
 * booker.
 *
 * It fetches rather than linking straight to the route so that a refusal —
 * Xero unreachable, say — appears as a message on the page instead of a raw
 * JSON page.
 */
export function BookingInvoiceControl({
  bookingId,
  offer,
}: {
  bookingId: string;
  offer: BookingInvoiceOffer;
}) {
  const [downloading, setDownloading] = useState(false);
  if (offer.kind === "NONE") return null;
  if (offer.kind === "ASK_CLUB") {
    return (
      <p className="text-sm text-muted-foreground">
        {offer.staffViewer
          ? "This booking may have more than one invoice in Xero; open Xero for copies."
          : "This booking may have more than one invoice. Please ask the club for copies."}
      </p>
    );
  }

  async function download() {
    setDownloading(true);
    try {
      const response = await fetch(`/api/bookings/${bookingId}/invoice`);
      if (!response.ok) {
        toast.error(
          response.status === 404
            ? NO_LONGER_AVAILABLE
            : await apiErrorMessageFromResponse(response, DOWNLOAD_FAILED),
        );
        return;
      }
      await saveResponseAsFile(response, "Invoice.pdf");
    } catch {
      toast.error(DOWNLOAD_FAILED);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Button variant="outline" onClick={download} disabled={downloading}>
      {downloading
        ? "Preparing invoice…"
        : offer.invoiceNumber
          ? `Download invoice ${offer.invoiceNumber}`
          : "Download invoice"}
    </Button>
  );
}
