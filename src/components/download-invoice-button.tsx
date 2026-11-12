"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

/**
 * The booking page's Download invoice button (fork #115). Shown only when
 * `canDownloadBookingInvoice` allows, beside Edit Booking.
 *
 * It fetches rather than linking straight to the route so that a refusal —
 * Xero unreachable, or a night still awaiting a price — appears as a message on
 * the page instead of a raw JSON page.
 */
export function DownloadInvoiceButton({ bookingId }: { bookingId: string }) {
  const [downloading, setDownloading] = useState(false);

  async function download() {
    setDownloading(true);
    try {
      const response = await fetch(`/api/bookings/${bookingId}/invoice`);
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        toast.error(body?.error ?? "The invoice could not be downloaded. Please try again.");
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
      toast.error("The invoice could not be downloaded. Please try again.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Button variant="outline" onClick={download} disabled={downloading}>
      {downloading ? "Preparing invoice…" : "Download invoice"}
    </Button>
  );
}
