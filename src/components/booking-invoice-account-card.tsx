"use client";

import { useClubFormat } from "@/components/club-format-provider";
import { BookingDocumentDownloadButton } from "@/components/download-invoice-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { BookingCreditNote, BookingCreditNoteKind, BookingInvoiceAccount } from "@/lib/booking-invoice-access";
import { bookingInvoiceAccountRows, bookingInvoiceChargeRows } from "@/lib/booking-invoice-summary-rows";
import { formatCents } from "@/lib/utils";

const CREDIT_NOTE_KIND_LABEL: Readonly<Record<BookingCreditNoteKind, string>> = {
  CHANGE: "For a change to the booking",
  REFUND: "For a refund",
  ACCOUNT_CREDIT: "Moved to account credit",
  CREDIT_USED: "Account credit used on this booking",
};

/**
 * The booking's invoice account (#5066; owner decision on PR #5201, 17 Nov
 * 2026), after the Payment card whenever the page offers an invoice — Xero's,
 * or with Xero off the app's own: a line when the app knows the invoice in Xero
 * does not show the latest change, a short summary from the app's own records
 * (the rows the generated invoice prints too, `bookingInvoiceAccountRows`), and
 * one download per Xero credit note raised against the booking (none with Xero
 * off). Renders the server's answer only; the routes re-check everything.
 */
export function BookingInvoiceAccountCard({
  bookingId,
  creditNotes,
  account,
}: {
  bookingId: string;
  creditNotes: readonly BookingCreditNote[];
  account: BookingInvoiceAccount;
}) {
  const format = useClubFormat();
  const { summary } = account;
  const rows = [...bookingInvoiceChargeRows(summary), ...bookingInvoiceAccountRows(summary)];
  return (
    <Card>
      <CardHeader>
        <CardTitle headingLevel={2}>Invoice and credits</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {account.invoiceUpdateNotice && (
          <p role="status" className="rounded-md bg-warning-3 p-3 text-sm text-warning-11">
            {account.invoiceUpdateNotice}
          </p>
        )}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm" aria-label="Booking account summary">
          {rows.map(({ label, cents }) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="text-right font-medium">{formatCents(cents, format)}</dd>
            </div>
          ))}
        </dl>
        {creditNotes.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Credit notes</h3>
            <ul className="space-y-2">
              {creditNotes.map((note) => (
                <li key={note.creditNoteId} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm text-muted-foreground">{CREDIT_NOTE_KIND_LABEL[note.kind]}</span>
                  <BookingDocumentDownloadButton
                    href={`/api/bookings/${bookingId}/invoice/credit-notes/${encodeURIComponent(note.creditNoteId)}`}
                    label={note.creditNoteNumber ? `Download credit note ${note.creditNoteNumber}` : "Download credit note"}
                    documentName="credit note"
                    fallbackName="credit-note.pdf"
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
