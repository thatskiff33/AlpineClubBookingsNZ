/**
 * The two 3c summaries the money census reports (#3531): what the stored night
 * prices are made of, and every edit financial review by cause - both per
 * month, so before/after a deploy is one line against another.
 */
import type { BookingGuestNightPriceSource } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  classifyStrandProvenance,
  monthOf,
  summarizeEditFinancialReviews,
  summarizeNightPriceProvenance,
} from "@/lib/night-price-provenance-census";
import { requireClubTimeZone } from "@/lib/club-time";

const ZONE = requireClubTimeZone("Pacific/Auckland");
const D = (value: string) => new Date(`${value}T00:00:00.000Z`);
let stayDay = 0;
const night = (priceCents: number | null, priceSource: BookingGuestNightPriceSource) => ({
  // Distinct, real stay dates: the classifier keys evidence by calendar day.
  stayDate: new Date(Date.UTC(2026, 7, 1 + (stayDay++ % 20))),
  priceCents,
  priceSource,
});
/** A strand whose stored total is the sum of its rows, unless `total` says otherwise. */
const strand = (nights: ReturnType<typeof night>[], total?: number) => ({
  priceCents: total ?? nights.reduce((sum, n) => sum + (n.priceCents ?? 0), 0),
  nights,
});
const CLASSES = {
  EXACT: 0,
  NO_STORED_NIGHT_PRICES: 0,
  PARTIAL_STORED_NIGHT_PRICES: 0,
  STORED_TOTAL_MISMATCH: 0,
  INEXACT_STORED_NIGHT_PRICES: 0,
  COUNTERPART_STRAND_UNREADABLE: 0,
};

describe("classifyStrandProvenance", () => {
  it("is INV-MOD-028's own verdict at individual-night grain: EXACT, or the cause the gate would park with", () => {
    expect(classifyStrandProvenance(strand([night(5000, "SOLD"), night(5000, "OFFICER_PRICED")]))).toBe("EXACT");
    // A comped night is a real sold price, not a blank; no rows and no money is exact too.
    expect(classifyStrandProvenance(strand([night(0, "SOLD")]))).toBe("EXACT");
    expect(classifyStrandProvenance(strand([]))).toBe("EXACT");
    expect(classifyStrandProvenance(strand([], 5000))).toBe("NO_STORED_NIGHT_PRICES");
    expect(classifyStrandProvenance(strand([night(null, "UNKNOWN")], 5000))).toBe("NO_STORED_NIGHT_PRICES");
    expect(classifyStrandProvenance(strand([night(5000, "SOLD"), night(null, "UNKNOWN")], 10000))).toBe(
      "PARTIAL_STORED_NIGHT_PRICES",
    );
    expect(classifyStrandProvenance(strand([night(5000, "SOLD"), night(5000, "EVEN_SPLIT")]))).toBe(
      "INEXACT_STORED_NIGHT_PRICES",
    );
    expect(classifyStrandProvenance(strand([night(5000, "UNKNOWN")]))).toBe("INEXACT_STORED_NIGHT_PRICES");
  });

  it("counts an exact-looking strand whose rows do not sum, or which holds a negative row, where the gate parks it", () => {
    // Both were invisible to a provenance-only reading (review lens B on #3576).
    expect(classifyStrandProvenance(strand([night(5000, "SOLD"), night(5000, "SOLD")], 9999))).toBe(
      "STORED_TOTAL_MISMATCH",
    );
    expect(classifyStrandProvenance(strand([night(-100, "SOLD"), night(5100, "SOLD")], 5000))).toBe(
      "PARTIAL_STORED_NIGHT_PRICES",
    );
  });
});

describe("summarizeNightPriceProvenance", () => {
  it("counts rows by provenance and strands by class, overall and per creation month", () => {
    const result = summarizeNightPriceProvenance([
      { createdAt: D("2026-05-03"), guests: [strand([night(5000, "EVEN_SPLIT"), night(5000, "EVEN_SPLIT")])] },
      { createdAt: D("2026-05-20"), guests: [strand([night(5000, "SOLD")]), strand([], 700)] },
      { createdAt: D("2026-07-01"), guests: [strand([night(null, "UNKNOWN"), night(5000, "SOLD")], 10000)] },
    ], ZONE);
    expect(result.nightRowsBySource).toEqual({ EVEN_SPLIT: 2, SOLD: 2, UNKNOWN: 1 });
    expect(result.strandsByClass).toEqual({
      ...CLASSES,
      EXACT: 1,
      INEXACT_STORED_NIGHT_PRICES: 1,
      PARTIAL_STORED_NIGHT_PRICES: 1,
      NO_STORED_NIGHT_PRICES: 1,
    });
    expect(result.byMonth).toEqual([
      {
        month: "2026-05",
        bookings: 2,
        nightRowsBySource: { EVEN_SPLIT: 2, SOLD: 1 },
        strandsByClass: { ...CLASSES, EXACT: 1, INEXACT_STORED_NIGHT_PRICES: 1, NO_STORED_NIGHT_PRICES: 1 },
      },
      {
        month: "2026-07",
        bookings: 1,
        nightRowsBySource: { UNKNOWN: 1, SOLD: 1 },
        strandsByClass: { ...CLASSES, PARTIAL_STORED_NIGHT_PRICES: 1 },
      },
    ]);
  });

  it("classes a rate-derived night (#3531 3b) as exact, through INV-MOD-028's own classifier", () => {
    const result = summarizeNightPriceProvenance([
      { createdAt: D("2026-05-03"), guests: [strand([night(5000, "RATE_DERIVED")])] },
    ], ZONE);
    expect(result.nightRowsBySource).toEqual({ RATE_DERIVED: 1 });
    expect(result.strandsByClass.EXACT).toBe(1);
  });

  it("months are the club's calendar month of the stored instant, oldest first", () => {
    // 23:30 UTC on 31 Dec is already 12:30 on 1 Jan at the club (INV-DATE-019):
    // a UTC truncation would file this booking one month early.
    expect(monthOf(new Date("2026-12-31T23:30:00.000Z"), ZONE)).toBe("2027-01");
    expect(monthOf(new Date("2026-12-31T10:00:00.000Z"), ZONE)).toBe("2026-12");
    const result = summarizeNightPriceProvenance([
      { createdAt: D("2026-09-01"), guests: [] },
      { createdAt: D("2026-03-01"), guests: [] },
    ], ZONE);
    expect(result.byMonth.map((m) => m.month)).toEqual(["2026-03", "2026-09"]);
  });
});

describe("summarizeEditFinancialReviews", () => {
  const context = (cause: string) => ({
    version: 1,
    occurrence: {
      bookingId: "bk1",
      bookingGuestId: "guest-1",
      cause,
      surrenderedNightDates: ["2026-08-14"],
      addedNightDates: [],
      storedEvidence: { guestTotalCents: null, nightPrices: [] },
    },
    guestMemberId: "member-1",
    bookingCheckIn: "2026-08-14",
    bookingCheckOut: "2026-08-16",
    bookingModificationId: "mod-1",
  });

  it("counts tasks by status and by the cause the raise recorded, per month, through the one parser", () => {
    const result = summarizeEditFinancialReviews([
      { createdAt: D("2026-09-17"), status: "COMPLETED", reviewContext: context("INEXACT_STORED_NIGHT_PRICES") },
      { createdAt: D("2026-09-18"), status: "OPEN", reviewContext: context("INEXACT_STORED_NIGHT_PRICES") },
      { createdAt: D("2026-10-02"), status: "OPEN", reviewContext: context("NO_STORED_NIGHT_PRICES") },
      { createdAt: D("2026-10-03"), status: "DISMISSED", reviewContext: { not: "a context" } },
    ], ZONE);
    expect(result.total).toBe(4);
    expect(result.byStatus).toEqual({ COMPLETED: 1, OPEN: 2, DISMISSED: 1 });
    expect(result.byCause).toMatchObject({
      INEXACT_STORED_NIGHT_PRICES: 2,
      NO_STORED_NIGHT_PRICES: 1,
      UNREADABLE_CONTEXT: 1,
    });
    expect(result.byMonth.map((m) => [m.month, m.total, m.byCause.INEXACT_STORED_NIGHT_PRICES])).toEqual([
      ["2026-09", 2, 2],
      ["2026-10", 2, 0],
    ]);
  });
});
