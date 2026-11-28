/**
 * A subscription invoice's status as this app reads it from Xero. Pure, and in
 * its own module so the membership sync and the age-up top-up sync
 * (`subscription-age-up-sync.ts`) judge an invoice by the one rule.
 */
import { Invoice } from "xero-node";
import { compareCalendarDates, type CalendarDate } from "@/lib/club-time";
import {
  xeroCalendarDate,
  xeroCalendarDateAsDateOnly,
  xeroInstant,
} from "@/lib/xero-provider-dates";

/**
 * Subscription status from a Xero invoice, judged against the CLUB's calendar
 * day rather than against the host's clock. Exported for testing.
 *
 * `clubToday` is passed in rather than read here so this stays a pure function
 * of the provider payload plus one explicit civil-time fact — which is what lets
 * the hostile-host-zone tests hold the club zone constant while moving `TZ`.
 */
export function determineSubscriptionStatus(
  invoice: Invoice,
  clubToday: CalendarDate,
): {
  status: "PAID" | "UNPAID" | "OVERDUE";
  paidAt?: Date;
} {
  const invoiceStatus = invoice.status;

  if (invoiceStatus === Invoice.StatusEnum.PAID) {
    // TWO DIFFERENT CONCEPTS, and the old code read both with `new Date(...)`.
    // `fullyPaidOnDate` is a CALENDAR DATE (Xero types it `string` and documents
    // it as a date); `updatedDateUTC` is an INSTANT the provider names as UTC. A
    // calendar day has no time of day, so the paid-at instant it implies is the
    // start of that day in UTC — the same date-only encoding every other calendar
    // value in this system carries (INV-DATE-010) — not host-local midnight,
    // which is what the previous parse produced for an offset-less payload.
    const paidAt =
      xeroCalendarDateAsDateOnly(invoice.fullyPaidOnDate) ??
      xeroInstant(invoice.updatedDateUTC) ??
      undefined;
    return { status: "PAID", paidAt };
  }

  if (
    invoiceStatus === Invoice.StatusEnum.AUTHORISED ||
    invoiceStatus === Invoice.StatusEnum.SUBMITTED
  ) {
    // Past due is a CALENDAR comparison: an invoice is overdue once the club's
    // today is past its due day, not once some instant derived from that day has
    // elapsed. The old `new Date(invoice.dueDate) < new Date()` compared a
    // midnight — UTC midnight for an SDK `Date`, host-local midnight for an
    // offset-less string — against the wall clock, so the flip happened partway
    // through the due date itself, at an hour that moved with the container's
    // zone: an invoice went OVERDUE on the afternoon of the day it was due in
    // New Zealand, and on the EVENING BEFORE on a host west of Greenwich.
    const dueDate = xeroCalendarDate(invoice.dueDate);
    if (dueDate && compareCalendarDates(clubToday, dueDate) > 0) {
      return { status: "OVERDUE" };
    }
    return { status: "UNPAID" };
  }

  // Draft invoices — treat as not yet properly invoiced. VOIDED/DELETED
  // invoices technically also fall here, but since #2147 the subscription write
  // path in checkMembershipStatus intercepts a VOIDED/DELETED invoice BEFORE
  // calling this (routing it to releaseVoidedSubscriptionInvoice, which sets
  // NOT_INVOICED — no longer locked out). This function still runs over voided
  // invoices only in collectSubscriptionInvoiceMatches' isPaid ranking, where a
  // voided invoice is correctly a non-paid (union-only loser) candidate.
  return { status: "UNPAID" };
}
