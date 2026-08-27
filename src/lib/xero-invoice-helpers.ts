/**
 * Shared helpers for the Xero booking-invoice flows.
 *
 * Tiny utilities used across `xero-booking-invoices`, `xero-credit-notes`,
 * `xero-invoice-payments`, `xero-supplementary-invoices`,
 * `xero-modification-credit-notes`, and `xero-entrance-fee-invoices`.
 * Kept in their own module so the consumers do not have to import each
 * other just for date / allocation helpers.
 */

import type { ClubTimeZone } from "@/lib/club-time";
import {
  xeroDocumentDateFromDateOnlyColumn,
  xeroDocumentDateFromInstant,
} from "@/lib/xero-provider-dates";
import { buildXeroIdempotencyKey } from "@/lib/xero-sync";

/**
 * This module used to export a `formatDate` wrapper that spelled out
 * `date.toISOString().split("T")[0]` a second time. #2834 documented it as
 * correct for a `@db.Date` receiver, which it was — but a second copy of the
 * truncation, under a name no date census recognises, is exactly what let a
 * whole class of instant defects hide: eleven modules imported it, so twenty
 * Xero document dates reached the forbidden pattern one indirection away from
 * the spelling anyone was searching for, and neither #2682's sweep nor the
 * regex census in `nz-today-date-only.test.tsx` could see them.
 *
 * The encoding now lives once, in `formatDateOnly` (INV-DATE-010), and the
 * callers name it directly. Nothing about the dates changed: `formatDate` was a
 * character-for-character duplicate of that helper.
 */

/**
 * The invoice's issue date is the booking's check-in, which is a `@db.Date`
 * lodge night — an abstract calendar day already pinned to UTC midnight, not an
 * instant (INV-DATE-010). Reading it back as a date-only value yields the day it
 * encodes: INV-DATE-019's first exact boundary, with INV-DATE-026, which are the
 * citation for that decode and INV-DATE-010 is not (#3080).
 */
export function getBookingInvoiceIssueDate(booking: {
  checkIn: Date | string;
}): string {
  return xeroDocumentDateFromDateOnlyColumn(new Date(booking.checkIn));
}

/**
 * The invoice's due date is the club-local calendar day the booking was made.
 *
 * `Booking.createdAt` is a `DateTime` — a real instant — so its UTC calendar day
 * is the PREVIOUS day for roughly the first half of every New Zealand day. Xero
 * received a due date one day early for every booking made in the NZ morning,
 * which also shifted downstream overdue comparisons (#2697). The club timezone
 * is the only correct calendar for this value, so it is derived through the
 * canonical zone-aware helper rather than by truncating the instant
 * (INV-DATE-019).
 */
export function getBookingInvoiceDueDate(
  booking: { createdAt: Date | string },
  zone: ClubTimeZone,
): string {
  return xeroDocumentDateFromInstant(new Date(booking.createdAt), zone);
}

/**
 * Construct a stable allocation identifier for a Xero credit-note
 * allocation. Xero does not return per-allocation IDs, so the local code
 * derives one from the credit note, invoice, and amount.
 */
export function buildSyntheticAllocationId(
  creditNoteId: string,
  invoiceId: string,
  amountCents: number
): string {
  return buildXeroIdempotencyKey(
    "allocation",
    creditNoteId,
    invoiceId,
    amountCents,
    "v1"
  );
}
