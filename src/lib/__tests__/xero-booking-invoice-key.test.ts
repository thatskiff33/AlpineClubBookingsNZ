import { describe, expect, it } from "vitest";

import { buildXeroBookingInvoiceCorrelationKey } from "@/lib/xero-booking-invoice-key";

/**
 * The booking-invoice correlation key, pinned (#3001, MAD epic #2725).
 *
 * This is a STORED string. Every `XeroSyncOperation` ever written for a booking
 * invoice carries the spelling below, and three live behaviours find their row
 * by matching it: the enqueue dedup that stops a second invoice being raised,
 * the Xero create-invoice idempotency key, and #3001's warning on the booking
 * itself. Change a segment and all three go QUIET rather than loud — no
 * duplicate-invoice fence, and a booking whose invoice is sitting failed
 * reporting all-clear.
 *
 * So this file exists to make that change a failing test that names the
 * consequence, rather than a silent one. If it fails, the question is not "what
 * is the new expected string" — it is whether the stored rows are being
 * migrated to match.
 */
describe("buildXeroBookingInvoiceCorrelationKey", () => {
  it("produces the exact stored spelling every existing operation row carries", () => {
    expect(buildXeroBookingInvoiceCorrelationKey("bkg_123")).toBe(
      "booking:bkg_123:invoice:v1",
    );
  });

  it("is scoped to the booking, so it is the same key across that booking's life", () => {
    // The operation row is stored against the PAYMENT, but keyed on the
    // BOOKING. That is what lets #3001 find a booking's invoice operation
    // without joining through a payment row that may not have been created
    // yet. (That is the real case, and the only one: the payment is one-to-one
    // with the booking and nothing deletes it.)
    expect(buildXeroBookingInvoiceCorrelationKey("bkg_abc")).toBe(
      buildXeroBookingInvoiceCorrelationKey("bkg_abc"),
    );
    expect(buildXeroBookingInvoiceCorrelationKey("bkg_abc")).not.toBe(
      buildXeroBookingInvoiceCorrelationKey("bkg_abd"),
    );
  });
});
