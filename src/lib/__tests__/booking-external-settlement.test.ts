import { describe, expect, it } from "vitest";

import { bookingHasExternalSettlement, externalSettlementCause } from "@/lib/booking-external-settlement";

// #5005: the one "settled outside the app" fence the Xero enqueuer, invoice
// creator, repair classifier and missing-invoice health check all read.
describe("bookingHasExternalSettlement", () => {
  const stamped = { manuallyMarkedPaidAt: new Date("2026-06-30T00:00:00.000Z") };
  const unstamped = { manuallyMarkedPaidAt: null };

  it("fences a manually marked-paid booking (#2262)", () => {
    expect(bookingHasExternalSettlement({ payment: stamped, importRow: null })).toBe(true);
  });

  it("fences an imported free stay, which has no manual stamp to carry it", () => {
    expect(bookingHasExternalSettlement({ payment: unstamped, importRow: { amountCents: 0 } })).toBe(true);
  });

  it("does not fence a paid import whose manual settlement was reversed", () => {
    expect(bookingHasExternalSettlement({ payment: unstamped, importRow: { amountCents: 45_000 } })).toBe(false);
  });

  it("does not fence an ordinary unstamped booking", () => {
    expect(bookingHasExternalSettlement({ payment: unstamped })).toBe(false);
    expect(bookingHasExternalSettlement({ payment: null, importRow: null })).toBe(false);
  });
});

describe("externalSettlementCause", () => {
  it("names the manual stamp when there is one, and the import otherwise", () => {
    expect(externalSettlementCause({ manuallyMarkedPaidAt: new Date("2026-06-30T00:00:00.000Z") })).toBe(
      "manually marked paid (cash / off-Xero)",
    );
    expect(externalSettlementCause({ manuallyMarkedPaidAt: null })).toBe("imported as settled outside the app");
  });
});
