"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { apiErrorMessageFromResponse } from "@/lib/api-error-message";
import type { BookingInvoiceOffer } from "@/lib/booking-invoice-access";
import { saveResponseAsFile } from "@/lib/save-response-as-file";

/**
 * One booking document download (#5066): the invoice or one of its credit
 * notes. It fetches rather than linking straight to the route so that a
 * refusal — Xero unreachable, say — appears as a message on the page instead
 * of a raw JSON page. The route names the file (club-prefixed,
 * `bookingInvoiceFileName`); `fallbackName` is used only if it does not.
 *
 * The route answers every refusal with the same 404; by the time someone
 * clicks, the page they loaded may be stale (the booking changed, or Xero was
 * switched off), so a 404 says so rather than "booking not found".
 */
export function BookingDocumentDownloadButton({
  href,
  label,
  documentName,
  fallbackName,
}: {
  href: string;
  label: string;
  documentName: "invoice" | "credit note";
  fallbackName: string;
}) {
  const [downloading, setDownloading] = useState(false);
  const failed = `The ${documentName} could not be downloaded. Please try again.`;

  async function download() {
    setDownloading(true);
    try {
      const response = await fetch(href);
      if (!response.ok) {
        toast.error(
          response.status === 404
            ? `This ${documentName} is no longer available from this page; please refresh.`
            : await apiErrorMessageFromResponse(response, failed),
        );
        return;
      }
      await saveResponseAsFile(response, fallbackName);
    } catch {
      toast.error(failed);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Button variant="outline" onClick={download} disabled={downloading}>
      {downloading ? `Preparing ${documentName}…` : label}
    </Button>
  );
}

/**
 * The booking page's invoice control (#5066, slice 1), beside Edit Booking. It
 * renders the page's `BookingInvoiceOffer` and nothing else: a Download invoice
 * button for the booking's Xero invoice, a line saying where to get copies when
 * the booking may have more than one invoice, or nothing at all. The booking's
 * credit notes and account summary are `BookingInvoiceAccountCard`'s.
 *
 * The "more than one invoice" line knows its reader (#1289): an officer or admin
 * looking at someone else's booking is told to check the club's accounts (not
 * every admin has a Xero login), not addressed as the booker.
 */
export function BookingInvoiceControl({
  bookingId,
  offer,
}: {
  bookingId: string;
  offer: BookingInvoiceOffer;
}) {
  if (offer.kind === "NONE") return null;
  if (offer.kind === "ASK_CLUB") {
    return (
      <p className="text-sm text-muted-foreground">
        {offer.staffViewer
          ? "This booking may have more than one invoice. Check the club's accounts for copies."
          : "This booking may have more than one invoice. Please ask the club for copies."}
      </p>
    );
  }
  return (
    <BookingDocumentDownloadButton
      href={`/api/bookings/${bookingId}/invoice`}
      label={offer.invoiceNumber ? `Download invoice ${offer.invoiceNumber}` : "Download invoice"}
      documentName="invoice"
      fallbackName="invoice.pdf"
    />
  );
}
