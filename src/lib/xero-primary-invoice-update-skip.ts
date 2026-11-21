import { asRecord } from "@/lib/xero-json";

/**
 * WHETHER A PRIMARY-INVOICE UPDATE ROW WAS SKIPPED rather than applied (#5066,
 * PR #5201 review F1). One answer for every reader, covering both writers:
 *
 * - the edit's policy declined it before queueing
 *   (`recordSkippedXeroBookingInvoiceUpdateOperation`, `xero-operation-outbox.ts`:
 *   `requestPayload.skippedByPolicy`);
 * - the worker declined it on reading the live invoice — payment or credit
 *   already applied, or the invoice voided or deleted
 *   (`updateXeroBookingInvoiceForBooking`, `xero-booking-invoices.ts`: the row
 *   completes SUCCEEDED with `responsePayload.skipped`).
 *
 * Either way the invoice in Xero kept its old lines. Its own module because
 * both writers' files are past their size budget (#4926) and may not grow.
 */
export function isSkippedPrimaryInvoiceUpdate(row: { requestPayload: unknown; responsePayload: unknown }): boolean {
  return asRecord(row.requestPayload)?.skippedByPolicy === true || asRecord(row.responsePayload)?.skipped === true;
}
