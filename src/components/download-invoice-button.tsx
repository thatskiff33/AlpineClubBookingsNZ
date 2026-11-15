"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { BookingInvoiceOffer } from "@/lib/booking-invoice-access";

const DOWNLOAD_FAILED = "The invoice could not be downloaded. Please try again.";

/**
 * The booking page's invoice control (#5066, slice 1), beside Edit Booking. It
 * renders the page's `BookingInvoiceOffer` and nothing else: a Download invoice
 * button for the booking's Xero invoice, a line asking the member to contact the
 * club when the booking has more than one invoice, or nothing at all.
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
        This booking has more than one invoice in the club&apos;s accounts. Please ask the club for copies of your invoices.
      </p>
    );
  }

  async function download() {
    setDownloading(true);
    try {
      const response = await fetch(`/api/bookings/${bookingId}/invoice`);
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        toast.error(body?.error ?? DOWNLOAD_FAILED);
        return;
      }
      const blob = await response.blob();
      const fileName =
        /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ??
        "Invoice.pdf";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
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
