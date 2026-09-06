import { describe, expect, it, vi } from "vitest";

import {
  computeBookingRoundingDrift,
  computeGuestRoundingDrift,
  computeSettlementRoundingDrift,
  countStayNights,
  formatRoundingAuditReport,
  scanBookingInvoiceRoundingDrift,
  scanGroupSettlementRoundingDrift,
  scanXeroInvoiceRoundingDrift,
  type AuditGuest,
  type InvoiceRoundingDrift,
  type RoundingAuditBooking,
  type RoundingAuditChildBooking,
  type RoundingAuditPrismaClient,
  type RoundingAuditSettlement,
} from "@/lib/xero-invoice-rounding-audit";

// Date-only UTC-midnight helper so formatDate contiguity is stable.
const day = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

function guest(overrides: Partial<AuditGuest> = {}): AuditGuest {
  return {
    firstName: "Test",
    lastName: "Guest",
    ageTier: "ADULT",
    isMember: true,
    priceCents: 0,
    nights: null,
    ...overrides,
  };
}

describe("computeGuestRoundingDrift (pre-#1231 replay)", () => {
  it("flags a mixed-price contiguous run whose round(total/n) drifts (#1163)", () => {
    // [2500, 2500, 3000] over Jun 1-3 => one contiguous run, total 8000, n=3.
    // round(8000/3)=2667, emitted 3*2667=8001, drift +1. Exactly the #1163 bug.
    const result = computeGuestRoundingDrift(
      guest({
        priceCents: 8000,
        nights: [
          { stayDate: day(2026, 6, 1), priceCents: 2500 },
          { stayDate: day(2026, 6, 2), priceCents: 2500 },
          { stayDate: day(2026, 6, 3), priceCents: 3000 },
        ],
      }),
      3
    );

    expect(result.guestDriftCents).toBe(1);
    expect(result.driftedRuns).toHaveLength(1);
    expect(result.driftedRuns[0]).toMatchObject({
      nightCount: 3,
      totalCents: 8000,
      roundedPerNightCents: 2667,
      emittedTotalCents: 8001,
      driftCents: 1,
      mixedPrices: true,
    });
  });

  it("does NOT flag a clean single-price contiguous run", () => {
    const result = computeGuestRoundingDrift(
      guest({
        priceCents: 9000,
        nights: [
          { stayDate: day(2026, 6, 1), priceCents: 3000 },
          { stayDate: day(2026, 6, 2), priceCents: 3000 },
          { stayDate: day(2026, 6, 3), priceCents: 3000 },
        ],
      }),
      3
    );

    expect(result.guestDriftCents).toBe(0);
    expect(result.driftedRuns).toHaveLength(0);
  });

  it("does NOT flag a mixed-price run that divides evenly (keys on drift, not mixed prices)", () => {
    // [2000, 4000] over 2 nights => total 6000, round(3000)*2 = 6000, drift 0.
    const result = computeGuestRoundingDrift(
      guest({
        priceCents: 6000,
        nights: [
          { stayDate: day(2026, 6, 1), priceCents: 2000 },
          { stayDate: day(2026, 6, 2), priceCents: 4000 },
        ],
      }),
      2
    );

    expect(result.guestDriftCents).toBe(0);
    expect(result.driftedRuns).toHaveLength(0);
  });

  it("does NOT flag non-contiguous single-price runs (each run reconciles)", () => {
    const result = computeGuestRoundingDrift(
      guest({
        priceCents: 10000,
        nights: [
          { stayDate: day(2026, 6, 1), priceCents: 2500 },
          { stayDate: day(2026, 6, 2), priceCents: 2500 },
          // gap
          { stayDate: day(2026, 6, 5), priceCents: 2500 },
          { stayDate: day(2026, 6, 6), priceCents: 2500 },
        ],
      }),
      4
    );

    expect(result.guestDriftCents).toBe(0);
    expect(result.driftedRuns).toHaveLength(0);
  });

  it("flags the legacy flat-total path when priceCents is not divisible by nights", () => {
    // No per-night rows: old builder billed nights * round(priceCents/nights).
    // 8000 over 3 nights => 3 * round(2666.67)=3*2667=8001, drift +1.
    const result = computeGuestRoundingDrift(
      guest({ priceCents: 8000, nights: null }),
      3
    );

    expect(result.guestDriftCents).toBe(1);
    expect(result.driftedRuns).toHaveLength(1);
    expect(result.driftedRuns[0]).toMatchObject({
      nightCount: 3,
      totalCents: 8000,
      emittedTotalCents: 8001,
      driftCents: 1,
    });
  });

  it("does NOT flag a degenerate zero-night legacy stay (old and new emit identically)", () => {
    const result = computeGuestRoundingDrift(
      guest({ priceCents: 8000, nights: null }),
      0
    );
    expect(result.driftedRuns).toHaveLength(0);
  });
});

describe("computeBookingRoundingDrift", () => {
  it("returns null for a clean booking", () => {
    const result = computeBookingRoundingDrift({
      bookingId: "b-clean",
      xeroInvoiceId: "inv-1",
      xeroInvoiceNumber: "INV-1",
      issuedAtProxy: day(2026, 6, 1),
      bookingNights: 2,
      guests: [
        guest({
          priceCents: 6000,
          nights: [
            { stayDate: day(2026, 6, 1), priceCents: 3000 },
            { stayDate: day(2026, 6, 2), priceCents: 3000 },
          ],
        }),
      ],
    });
    expect(result).toBeNull();
  });

  it("returns the aggregated drift for an affected booking", () => {
    const result = computeBookingRoundingDrift({
      bookingId: "b-drift",
      xeroInvoiceId: "inv-2",
      xeroInvoiceNumber: "INV-2",
      issuedAtProxy: day(2026, 6, 1),
      bookingNights: 3,
      guests: [
        guest({
          firstName: "Mixed",
          lastName: "Rates",
          priceCents: 8000,
          nights: [
            { stayDate: day(2026, 6, 1), priceCents: 2500 },
            { stayDate: day(2026, 6, 2), priceCents: 2500 },
            { stayDate: day(2026, 6, 3), priceCents: 3000 },
          ],
        }),
        guest({ firstName: "Clean", lastName: "Guest", priceCents: 9000, nights: null }),
      ],
    });

    expect(result).not.toBeNull();
    expect(result?.totalDriftCents).toBe(1);
    expect(result?.guests).toHaveLength(1); // only the drifting guest is kept
    expect(result?.guests[0].guestName).toBe("Mixed Rates");
  });
});

describe("countStayNights", () => {
  it("counts whole date-only nights", () => {
    expect(countStayNights(day(2026, 6, 1), day(2026, 6, 4))).toBe(3);
    expect(countStayNights(day(2026, 6, 1), day(2026, 6, 1))).toBe(0);
  });
});

describe("computeSettlementRoundingDrift", () => {
  it("sums each child's drift and labels the source GROUP_SETTLEMENT", () => {
    const result = computeSettlementRoundingDrift({
      settlementId: "s1",
      groupBookingId: "g1",
      xeroInvoiceId: "inv-s1",
      xeroInvoiceNumber: "INV-S1",
      issuedAtProxy: day(2026, 6, 1),
      children: [
        {
          bookingNights: 3,
          guests: [
            guest({
              firstName: "Mixed",
              lastName: "Child",
              priceCents: 8000,
              nights: [
                { stayDate: day(2026, 6, 1), priceCents: 2500 },
                { stayDate: day(2026, 6, 2), priceCents: 2500 },
                { stayDate: day(2026, 6, 3), priceCents: 3000 },
              ],
            }),
          ],
        },
        {
          bookingNights: 2,
          guests: [
            guest({
              firstName: "Clean",
              lastName: "Child",
              priceCents: 6000,
              nights: [
                { stayDate: day(2026, 6, 1), priceCents: 3000 },
                { stayDate: day(2026, 6, 2), priceCents: 3000 },
              ],
            }),
          ],
        },
      ],
    });

    expect(result).not.toBeNull();
    expect(result?.source).toBe("GROUP_SETTLEMENT");
    expect(result?.sourceId).toBe("s1");
    expect(result?.groupBookingId).toBe("g1");
    expect(result?.totalDriftCents).toBe(1); // only the mixed child drifts
    expect(result?.guests).toHaveLength(1);
    expect(result?.guests[0].guestName).toBe("Mixed Child");
  });

  it("returns null when every child reconciles", () => {
    const result = computeSettlementRoundingDrift({
      settlementId: "s2",
      groupBookingId: "g2",
      xeroInvoiceId: "inv-s2",
      xeroInvoiceNumber: "INV-S2",
      issuedAtProxy: day(2026, 6, 1),
      children: [
        {
          bookingNights: 2,
          guests: [
            guest({
              priceCents: 6000,
              nights: [
                { stayDate: day(2026, 6, 1), priceCents: 3000 },
                { stayDate: day(2026, 6, 2), priceCents: 3000 },
              ],
            }),
          ],
        },
      ],
    });
    expect(result).toBeNull();
  });
});

describe("formatRoundingAuditReport", () => {
  const emptyResult = {
    scannedInvoices: 5,
    scannedBookingInvoices: 4,
    scannedSettlementInvoices: 1,
    affected: [] as InvoiceRoundingDrift[],
    affectedCount: 0,
    totalDriftCents: 0,
    issuedBefore: null,
  };

  it("states both sources are covered and reports per-source counts", () => {
    const report = formatRoundingAuditReport(emptyResult);
    expect(report).toContain("scans BOTH per-booking invoices");
    expect(report).toContain("group-booking settlement invoices");
    expect(report).toContain("booking 4, settlement 1");
    expect(report).toContain(
      "both per-booking and group-settlement invoices are clean"
    );
  });

  it("labels a group-settlement candidate distinctly", () => {
    const settlementDrift = computeSettlementRoundingDrift({
      settlementId: "s9",
      groupBookingId: "g9",
      xeroInvoiceId: "inv-s9",
      xeroInvoiceNumber: "INV-S9",
      issuedAtProxy: day(2026, 6, 1),
      children: [
        {
          bookingNights: 3,
          guests: [
            guest({
              priceCents: 8000,
              nights: [
                { stayDate: day(2026, 6, 1), priceCents: 2500 },
                { stayDate: day(2026, 6, 2), priceCents: 2500 },
                { stayDate: day(2026, 6, 3), priceCents: 3000 },
              ],
            }),
          ],
        },
      ],
    })!;
    const report = formatRoundingAuditReport({
      ...emptyResult,
      affected: [settlementDrift],
      affectedCount: 1,
      totalDriftCents: 1,
    });
    expect(report).toContain("[GROUP SETTLEMENT]");
    expect(report).toContain("Settlement: s9 (group g9)");
  });

  // #3302: this report deliberately shows the dollar amount AND the raw
  // signed cent delta in parens — useful for a rounding audit where the exact
  // cent matters. Nothing previously pinned the compound string; this locks
  // it so the shared `formatCents` composition can never silently drop the
  // "(+/-Nc)" suffix or the sign.
  it("shows the net drift as both a dollar amount and the raw signed cent delta", () => {
    const report = formatRoundingAuditReport({
      ...emptyResult,
      affected: [],
      affectedCount: 0,
      totalDriftCents: 1,
    });
    expect(report).toContain("Net drift across candidates: $0.01 (+1c)");
  });
});

// Nights that drift under the old builder: [2500,2500,3000] total 8000 / 3 =>
// 3*round(2666.67)=8001 (+1c). Clean: uniform 3000/night reconciles exactly.
const driftNights = [
  { stayDate: day(2026, 6, 1), priceCents: 2500 },
  { stayDate: day(2026, 6, 2), priceCents: 2500 },
  { stayDate: day(2026, 6, 3), priceCents: 3000 },
];
const cleanNights = [
  { stayDate: day(2026, 6, 1), priceCents: 3000 },
  { stayDate: day(2026, 6, 2), priceCents: 3000 },
  { stayDate: day(2026, 6, 3), priceCents: 3000 },
];

function childRow(id: string, driftGuest: boolean): RoundingAuditChildBooking {
  return {
    id,
    checkIn: day(2026, 6, 1),
    checkOut: day(2026, 6, 4),
    guests: [
      {
        firstName: "Guest",
        lastName: id,
        ageTier: "ADULT",
        isMember: true,
        priceCents: driftGuest ? 8000 : 9000,
        nights: driftGuest ? driftNights : cleanNights,
      },
    ],
  };
}

function bookingRow(id: string, driftGuest: boolean): RoundingAuditBooking {
  return {
    ...childRow(id, driftGuest),
    payment: {
      xeroInvoiceId: `${id}-inv`,
      xeroInvoiceNumber: `INV-${id}`,
      createdAt: day(2026, 6, 1),
    },
  };
}

function settlementRow(id: string): RoundingAuditSettlement {
  return {
    id,
    xeroInvoiceId: `${id}-inv`,
    xeroInvoiceNumber: `INV-${id}`,
    createdAt: day(2026, 6, 1),
    groupBooking: { id: `${id}-group`, organiserBookingId: `${id}-organiser` },
  };
}

describe("scanBookingInvoiceRoundingDrift (read-only)", () => {
  it("scans issued invoices and flags only the drifting ones", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([bookingRow("a", true), bookingRow("c", false)]);
    const client = {
      booking: { findMany },
      groupBookingSettlement: { findMany: vi.fn() },
    } as unknown as RoundingAuditPrismaClient;

    const result = await scanBookingInvoiceRoundingDrift(client, { batchSize: 200 });

    expect(result.scannedInvoices).toBe(2);
    expect(result.scannedBookingInvoices).toBe(2);
    expect(result.scannedSettlementInvoices).toBe(0);
    expect(result.affectedCount).toBe(1);
    expect(result.totalDriftCents).toBe(1);
    expect(result.affected[0].source).toBe("BOOKING");
    expect(result.affected[0].sourceId).toBe("a");
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("passes an issued-before cutoff into the query and never mutates", async () => {
    const findMany = vi.fn().mockResolvedValueOnce([]);
    const client = {
      booking: { findMany },
      groupBookingSettlement: { findMany: vi.fn() },
    } as unknown as RoundingAuditPrismaClient;
    const cutoff = day(2026, 7, 4);

    const result = await scanBookingInvoiceRoundingDrift(client, {
      issuedBefore: cutoff,
    });

    expect(result.affectedCount).toBe(0);
    expect(result.issuedBefore).toBe(cutoff.toISOString());
    const call = findMany.mock.calls[0][0];
    expect(call.where.payment.is.xeroInvoiceId).toEqual({ not: null });
    expect(call.where.payment.is.createdAt).toEqual({ lt: cutoff });
    // read-only: the booking read surface is findMany only.
    expect(Object.keys(client.booking)).toEqual(["findMany"]);
  });

  it("values an unknown night the way the builder does, not at zero (#3170)", async () => {
    /*
      #3170 made `BookingGuestNight.priceCents` nullable: a night a parked edit
      committed without valuing. Two things went wrong here if the scanner just
      passed those rows through.

      One, the ARITHMETIC. `totalCents += night.priceCents` adds a null as 0 and
      `Math.min(minPrice, null)` collapses to 0, so a $30 night valued at nothing
      produces a drift figure that is not the drift - in a report a person acts
      on.

      Two, the BRANCH. This module's promise is that it replays the builder, and
      since #3170 the builder sends a guest with ANY unknown night down the
      whole-stay legacy branch. Staying on the per-night branch replays a builder
      that no longer exists, for exactly the population #3170 creates.
    */
    const blankNightRow: RoundingAuditBooking = {
      ...bookingRow("blank", false),
      guests: [
        {
          firstName: "Guest",
          lastName: "blank",
          ageTier: "ADULT",
          isMember: true,
          // $80 stored for the guest, over the booking's three nights.
          priceCents: 8000,
          nights: [
            { stayDate: day(2026, 6, 1), priceCents: 2500 },
            { stayDate: day(2026, 6, 2), priceCents: 2500 },
            { stayDate: day(2026, 6, 3), priceCents: null },
          ],
        },
      ],
    };
    const findMany = vi.fn().mockResolvedValueOnce([blankNightRow]);
    const client = {
      booking: { findMany },
      groupBookingSettlement: { findMany: vi.fn() },
    } as unknown as RoundingAuditPrismaClient;

    const result = await scanBookingInvoiceRoundingDrift(client, {});

    expect(result.scannedInvoices).toBe(1);
    // The legacy branch: round(8000 / 3) = 2667, 3 * 2667 = 8001, so +1c of real
    // drift on the line the builder actually emits.
    expect(result.totalDriftCents).toBe(1);
    const runs = result.affected[0].guests[0].driftedRuns;
    expect(runs).toHaveLength(1);
    // The legacy branch emits no date boundaries - it bills the booking's own
    // range as one line - which is itself the proof of which branch ran.
    expect(runs[0].startDate).toBe("");
    expect(runs[0].nightCount).toBe(3);
    expect(runs[0].totalCents).toBe(8000);
    // A CONTROL on the null-as-zero half: had the unknown night been added as 0,
    // the per-night branch would have totalled 5000 over three nights, which is
    // 3 * round(1666.67) = 5001 - a +1c drift too, but on $50 of a guest who was
    // charged $80. Asserting the TOTAL, not just the drift, is what tells the two
    // apart.
    expect(runs[0].totalCents).not.toBe(5000);
    expect(runs[0].mixedPrices).toBe(false);
  });

  it("paginates across batches with a cursor", async () => {
    const batch1 = [bookingRow("p0", false), bookingRow("p1", false)];
    const batch2 = [bookingRow("p2", false), bookingRow("last", true)];
    const findMany = vi
      .fn()
      .mockResolvedValueOnce(batch1)
      .mockResolvedValueOnce(batch2)
      .mockResolvedValueOnce([]);
    const client = {
      booking: { findMany },
      groupBookingSettlement: { findMany: vi.fn() },
    } as unknown as RoundingAuditPrismaClient;

    const result = await scanBookingInvoiceRoundingDrift(client, { batchSize: 2 });

    expect(findMany).toHaveBeenCalledTimes(3);
    expect(result.scannedInvoices).toBe(4);
    expect(result.affectedCount).toBe(1);
    expect(findMany.mock.calls[0][0].cursor).toBeUndefined();
    expect(findMany.mock.calls[1][0].cursor).toEqual({ id: "p1" });
    expect(findMany.mock.calls[1][0].skip).toBe(1);
    expect(findMany.mock.calls[2][0].cursor).toEqual({ id: "last" });
  });
});

describe("scanGroupSettlementRoundingDrift (read-only)", () => {
  it("re-runs the builder's child query and flags a drifting settlement", async () => {
    const settlementFindMany = vi
      .fn()
      .mockResolvedValueOnce([settlementRow("s1")]);
    // Children of s1: one drifting child + one clean child.
    const bookingFindMany = vi
      .fn()
      .mockResolvedValueOnce([childRow("kid-drift", true), childRow("kid-clean", false)]);
    const client = {
      booking: { findMany: bookingFindMany },
      groupBookingSettlement: { findMany: settlementFindMany },
    } as unknown as RoundingAuditPrismaClient;

    const result = await scanGroupSettlementRoundingDrift(client);

    expect(result.scannedInvoices).toBe(1);
    expect(result.scannedSettlementInvoices).toBe(1);
    expect(result.affectedCount).toBe(1);
    expect(result.totalDriftCents).toBe(1);
    expect(result.affected[0].source).toBe("GROUP_SETTLEMENT");
    expect(result.affected[0].sourceId).toBe("s1");
    expect(result.affected[0].groupBookingId).toBe("s1-group");

    // Fidelity: the child query mirrors xero-group-settlement-invoices.ts.
    const childArgs = bookingFindMany.mock.calls[0][0];
    expect(childArgs.where.parentBookingId).toBe("s1-organiser");
    expect(childArgs.where.organiserSettled).toBe(true);
    expect(childArgs.where.deletedAt).toBeNull();
    expect(childArgs.where.status).toEqual({ in: ["CONFIRMED", "PAID"] });
  });

  it("does not flag a settlement whose children all reconcile", async () => {
    const settlementFindMany = vi
      .fn()
      .mockResolvedValueOnce([settlementRow("s2")]);
    const bookingFindMany = vi
      .fn()
      .mockResolvedValueOnce([childRow("kid-a", false), childRow("kid-b", false)]);
    const client = {
      booking: { findMany: bookingFindMany },
      groupBookingSettlement: { findMany: settlementFindMany },
    } as unknown as RoundingAuditPrismaClient;

    const result = await scanGroupSettlementRoundingDrift(client);

    expect(result.scannedInvoices).toBe(1);
    expect(result.affectedCount).toBe(0);
    expect(result.totalDriftCents).toBe(0);
  });

  it("passes the settlement issued-before cutoff on createdAt", async () => {
    const settlementFindMany = vi.fn().mockResolvedValueOnce([]);
    const client = {
      booking: { findMany: vi.fn() },
      groupBookingSettlement: { findMany: settlementFindMany },
    } as unknown as RoundingAuditPrismaClient;
    const cutoff = day(2026, 7, 4);

    await scanGroupSettlementRoundingDrift(client, { issuedBefore: cutoff });

    const call = settlementFindMany.mock.calls[0][0];
    expect(call.where.xeroInvoiceId).toEqual({ not: null });
    expect(call.where.createdAt).toEqual({ lt: cutoff });
  });
});

describe("scanXeroInvoiceRoundingDrift (combined, read-only)", () => {
  it("scans both sources and returns candidates from each, labelled", async () => {
    // Call order: booking scan (1x booking.findMany) then settlement scan
    // (1x groupBookingSettlement.findMany + 1x booking.findMany for children).
    const bookingFindMany = vi
      .fn()
      .mockResolvedValueOnce([bookingRow("a", true)]) // booking scan
      .mockResolvedValueOnce([childRow("kid-drift", true), childRow("kid-clean", false)]); // children
    const settlementFindMany = vi
      .fn()
      .mockResolvedValueOnce([settlementRow("s1")]);
    const client = {
      booking: { findMany: bookingFindMany },
      groupBookingSettlement: { findMany: settlementFindMany },
    } as unknown as RoundingAuditPrismaClient;

    const result = await scanXeroInvoiceRoundingDrift(client, { batchSize: 200 });

    expect(result.scannedBookingInvoices).toBe(1);
    expect(result.scannedSettlementInvoices).toBe(1);
    expect(result.scannedInvoices).toBe(2);
    expect(result.affectedCount).toBe(2);
    expect(result.totalDriftCents).toBe(2);
    const sources = result.affected.map((a) => a.source).sort();
    expect(sources).toEqual(["BOOKING", "GROUP_SETTLEMENT"]);
  });

  it("reports clean only when BOTH scans are clean", async () => {
    const bookingFindMany = vi
      .fn()
      .mockResolvedValueOnce([bookingRow("clean", false)]) // booking scan: clean
      .mockResolvedValueOnce([childRow("kid", false)]); // settlement children: clean
    const settlementFindMany = vi
      .fn()
      .mockResolvedValueOnce([settlementRow("s1")]);
    const client = {
      booking: { findMany: bookingFindMany },
      groupBookingSettlement: { findMany: settlementFindMany },
    } as unknown as RoundingAuditPrismaClient;

    const result = await scanXeroInvoiceRoundingDrift(client);

    expect(result.scannedInvoices).toBe(2);
    expect(result.affectedCount).toBe(0);
    expect(formatRoundingAuditReport(result)).toContain(
      "both per-booking and group-settlement invoices are clean"
    );
  });
});
