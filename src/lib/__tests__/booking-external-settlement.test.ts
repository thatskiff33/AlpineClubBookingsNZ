import { describe, expect, it } from "vitest";

import {
  BOOKING_EXTERNAL_SETTLEMENT_WHERE,
  bookingHasExternalSettlement,
  externalSettlementCause,
  externalSettlementSkipReason,
} from "@/lib/booking-external-settlement";

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

describe("externalSettlementSkipReason", () => {
  it("decides manual or imported by the same rule as the cause (#5167 review)", () => {
    const stamped = { manuallyMarkedPaidAt: new Date("2026-06-30T00:00:00.000Z") };
    const unstamped = { manuallyMarkedPaidAt: null };
    expect(externalSettlementSkipReason(stamped)).toContain(`Booking was ${externalSettlementCause(stamped)} after this invoice operation was queued`);
    expect(externalSettlementSkipReason(stamped)).toMatch(/\(#2262\)\.$/);
    expect(externalSettlementSkipReason(unstamped)).toContain(`Booking was ${externalSettlementCause(unstamped)} — no Xero invoice is expected`);
    expect(externalSettlementSkipReason(unstamped)).toMatch(/\(#5005\)\.$/);
  });
});

/**
 * The query form agrees with the predicate (#5167 review): the missing-invoice
 * list filters with `NOT: BOOKING_EXTERNAL_SETTLEMENT_WHERE`. This evaluates
 * the fragment's own arms against each booking shape and fails closed on any
 * filter shape it does not know, so a new arm must be read here before it
 * passes. The real query is proved in `booking-import.realdb.test.ts`.
 */
type Shape = { payment: { manuallyMarkedPaidAt: Date | null } | null; importRow: { amountCents: number } | null };

function armMatches(arm: Record<string, unknown>, booking: Shape): boolean {
  const keys = Object.keys(arm);
  if (keys.length !== 1) throw new Error(`unread arm: ${JSON.stringify(arm)}`);
  if (JSON.stringify(arm) === JSON.stringify({ payment: { manuallyMarkedPaidAt: { not: null } } })) {
    return booking.payment !== null && booking.payment.manuallyMarkedPaidAt !== null;
  }
  const importRow = (arm as { importRow?: { is?: { amountCents?: unknown } } }).importRow;
  if (keys[0] === "importRow" && importRow?.is && Object.keys(importRow).length === 1 && Object.keys(importRow.is).length === 1 && typeof importRow.is.amountCents === "number") {
    return booking.importRow !== null && booking.importRow.amountCents === importRow.is.amountCents;
  }
  throw new Error(`unread arm: ${JSON.stringify(arm)}`);
}

describe("BOOKING_EXTERNAL_SETTLEMENT_WHERE", () => {
  const stamp = new Date("2026-06-30T00:00:00.000Z");
  const shapes: Shape[] = [
    { payment: { manuallyMarkedPaidAt: stamp }, importRow: null },
    { payment: { manuallyMarkedPaidAt: stamp }, importRow: { amountCents: 45_000 } },
    { payment: { manuallyMarkedPaidAt: stamp }, importRow: { amountCents: 0 } },
    { payment: { manuallyMarkedPaidAt: null }, importRow: { amountCents: 0 } },
    { payment: { manuallyMarkedPaidAt: null }, importRow: { amountCents: 45_000 } },
    { payment: { manuallyMarkedPaidAt: null }, importRow: null },
    { payment: null, importRow: { amountCents: 0 } },
    { payment: null, importRow: null },
  ];

  it("is exactly an OR of arms", () => {
    expect(Object.keys(BOOKING_EXTERNAL_SETTLEMENT_WHERE)).toEqual(["OR"]);
  });

  it.each(shapes)("matches the bookings the predicate fences, and only those: %o", (booking) => {
    const matched = BOOKING_EXTERNAL_SETTLEMENT_WHERE.OR.some((arm) => armMatches(arm, booking));
    expect(matched).toBe(bookingHasExternalSettlement(booking));
  });
});
