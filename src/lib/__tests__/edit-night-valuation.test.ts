import { describe, expect, it, vi } from "vitest";

import {
  editedBookingTotalCents,
  NEGATIVE_STORED_GUEST_TOTAL_MESSAGE,
  NegativeEditedHeadlineError,
  NegativeStoredGuestTotalError,
  refuseNegativeStoredGuestTotals,
  valueEditStrand,
  valueHeldNights,
  valuedNightLocksForGuest,
  valuedStrandNightPrices,
  withUnattachedStrandMoney,
} from "@/lib/edit-night-valuation";

/**
 * #4317 (epic #4302, owner decisions D1 and D11): what an edit reads a guest's
 * held nights as being worth, in the shapes the edit doors price with.
 *
 * `valueStrandNights` owns the rule and has its own suite; this one pins the
 * adapter every door goes through — which nights are held, which provenance a
 * rewritten row records, the money a strand carries beyond its nights, and how
 * that money is put back into an engine breakdown — in dollar figures.
 */

const BOOKING = {
  checkIn: new Date("2026-08-01T00:00:00.000Z"),
  checkOut: new Date("2026-08-04T00:00:00.000Z"),
};

function night(
  date: string,
  priceCents: number | null,
  priceSource: "SOLD" | "EVEN_SPLIT" | "UNKNOWN" | "RATE_DERIVED" | "OFFICER_PRICED" = "SOLD",
) {
  return { stayDate: new Date(`${date}T00:00:00.000Z`), priceCents, priceSource };
}

describe("valueEditStrand: each held night's value and the row it rewrites to", () => {
  it("R1: rows that add up to the stored total are the values, keeping their provenance", () => {
    const valued = valueEditStrand(
      {
        priceCents: 9_000,
        nights: [night("2026-08-01", 4_000, "SOLD"), night("2026-08-02", 5_000, "EVEN_SPLIT")],
      },
      BOOKING,
    );
    expect(valued.nights).toEqual([
      { date: "2026-08-01", valueCents: 4_000, priceSource: "SOLD" },
      { date: "2026-08-02", valueCents: 5_000, priceSource: "EVEN_SPLIT" },
    ]);
    expect(valued.unattachedCents).toBe(0);
    expect(valued.flag).toBeNull();
  });

  it("R2: a usable row keeps its figure; the rest of $100 is split over the blanks", () => {
    const valued = valueEditStrand(
      {
        priceCents: 10_000,
        nights: [
          night("2026-08-01", 4_000, "SOLD"),
          night("2026-08-02", null, "UNKNOWN"),
          night("2026-08-03", null, "UNKNOWN"),
        ],
      },
      BOOKING,
    );
    expect(valued.nights.map((n) => [n.valueCents, n.priceSource])).toEqual([
      [4_000, "SOLD"],
      [3_000, "EVEN_SPLIT"],
      [3_000, "EVEN_SPLIT"],
    ]);
    expect(valued.unattachedCents).toBe(0);
  });

  it("R3: rows over the total are discarded and $100 is split, leftover cent first", () => {
    const valued = valueEditStrand(
      {
        priceCents: 10_000,
        nights: [
          night("2026-08-01", 6_000, "SOLD"),
          night("2026-08-02", null, "UNKNOWN"),
          night("2026-08-03", 6_000, "SOLD"),
        ],
      },
      BOOKING,
    );
    expect(valued.nights.map((n) => [n.valueCents, n.priceSource])).toEqual([
      [3_334, "EVEN_SPLIT"],
      [3_333, "EVEN_SPLIT"],
      [3_333, "EVEN_SPLIT"],
    ]);
    expect(valued.unattachedCents).toBe(0);
  });

  it("a guest with no rows is valued over its stay envelope (INV-DATE-020)", () => {
    const valued = valueEditStrand(
      {
        priceCents: 9_001,
        stayStart: new Date("2026-08-02T00:00:00.000Z"),
        stayEnd: new Date("2026-08-04T00:00:00.000Z"),
        nights: [],
      },
      BOOKING,
    );
    expect(valued.nights.map((n) => [n.date, n.valueCents])).toEqual([
      ["2026-08-02", 4_501],
      ["2026-08-03", 4_500],
    ]);
  });

  it("D11: a negative stored total values every night at $0 and flags it (pure; doors refuse it)", () => {
    const valued = valueEditStrand(
      {
        priceCents: -500,
        nights: [night("2026-08-01", 4_000), night("2026-08-02", 4_000)],
      },
      BOOKING,
    );
    expect(valued.nights.map((n) => [n.valueCents, n.priceSource])).toEqual([
      [0, "UNKNOWN"],
      [0, "UNKNOWN"],
    ]);
    expect(valued.unattachedCents).toBe(-500);
    expect(valued.flag).toBe("NEGATIVE_STORED_TOTAL");
  });
});

describe("valueHeldNights: a strand holding no night", () => {
  it("keeps a $70 total unattached on the strand", () => {
    expect(valueHeldNights([], new Map(), 7_000)).toEqual({
      nights: [],
      unattachedCents: 7_000,
      flag: null,
    });
  });

  it("keeps a negative total unattached and flags it (pure; doors refuse it)", () => {
    const valued = valueHeldNights([], new Map(), -300);
    expect(valued.nights).toEqual([]);
    expect(valued.unattachedCents).toBe(-300);
    expect(valued.flag).toBe("NEGATIVE_STORED_TOTAL");
  });
});

describe("editedBookingTotalCents: the headline moves only by the edit's own change (review H1)", () => {
  it("is the sum of the edited guests on a booking whose headline is its guests", () => {
    // $200 + $200 stored, both extended by a $50 night: $500.
    expect(
      editedBookingTotalCents(
        { totalPriceCents: 40_000, guests: [{ priceCents: 20_000 }, { priceCents: 20_000 }] },
        50_000,
      ),
    ).toBe(50_000);
  });

  it("carries a frozen headline's gap forward instead of settling it", () => {
    // The coordinator's probe: $200 (no rows) + $200 under a frozen $600
    // headline. Extending both by a $50 night buys $100 of nights; read as the
    // bare sum the total would drop to $500 and refund $100. Carried, it is $700.
    expect(
      editedBookingTotalCents(
        { totalPriceCents: 60_000, guests: [{ priceCents: 20_000 }, { priceCents: 20_000 }] },
        50_000,
      ),
    ).toBe(70_000);
  });

  it("refuses an edit that would carry a headline below its guests under zero (review round 2)", () => {
    // $100 headline over $100 + $300 of guests (a parked add's review settled
    // while its re-base declined). Removing the $300 guest carries -$200.
    expect(() =>
      editedBookingTotalCents(
        { id: "b1", totalPriceCents: 10_000, guests: [{ priceCents: 10_000 }, { priceCents: 30_000 }] },
        10_000,
      ),
    ).toThrow(NegativeEditedHeadlineError);
    // Exactly zero is a price, not a refusal.
    expect(
      editedBookingTotalCents(
        { totalPriceCents: 30_000, guests: [{ priceCents: 10_000 }, { priceCents: 30_000 }] },
        10_000,
      ),
    ).toBe(0);
  });

  it("counts a removed guest among the stored guests, so a removal moves the headline by its stored total", () => {
    // Removing a $120 guest from $120 + $120 under a frozen $360: $240, not $120.
    expect(
      editedBookingTotalCents(
        { totalPriceCents: 36_000, guests: [{ priceCents: 12_000 }, { priceCents: 12_000 }] },
        12_000,
      ),
    ).toBe(24_000);
  });
});

describe("valuedNightLocksForGuest: every held night is locked at its value", () => {
  it("locks the blank night too, so no held night reaches a season rate", () => {
    const locks = valuedNightLocksForGuest(
      {
        priceCents: 9_000,
        nights: [night("2026-08-01", 4_000), night("2026-08-02", null, "UNKNOWN")],
      },
      BOOKING,
    );
    expect(locks).toEqual({
      lockedNightPrices: [
        {
          stayDate: new Date("2026-08-01T00:00:00.000Z"),
          priceCents: 4_000,
          priceSource: "SOLD",
        },
        {
          stayDate: new Date("2026-08-02T00:00:00.000Z"),
          priceCents: 5_000,
          priceSource: "EVEN_SPLIT",
        },
      ],
      unattachedCents: 0,
    });
  });
});

describe("withUnattachedStrandMoney: the engine's breakdown plus each strand's unattached money", () => {
  it("returns the engine's breakdown itself when no strand carries any", () => {
    const breakdown = { totalPriceCents: 9_000, guests: [{ priceCents: 9_000 }] };
    // Even with a misaligned input: nothing to add means nothing to check.
    expect(withUnattachedStrandMoney(breakdown, [])).toBe(breakdown);
  });

  it("keeps a night-less strand's $70 on it, beside a guest the edit adds at $60", () => {
    const result = withUnattachedStrandMoney(
      {
        totalPriceCents: 6_000,
        guests: [{ priceCents: 0, id: "nightless" }, { priceCents: 6_000, id: "added" }],
      },
      [{ unattachedCents: 7_000 }, {}],
    );
    expect(result.totalPriceCents).toBe(13_000);
    expect(result.guests).toEqual([
      { priceCents: 7_000, id: "nightless" },
      { priceCents: 6_000, id: "added" },
    ]);
  });

  it("refuses to add money to a breakdown it cannot align", () => {
    expect(() =>
      withUnattachedStrandMoney(
        { totalPriceCents: 0, guests: [{ priceCents: 0 }, { priceCents: 0 }] },
        [{ unattachedCents: 7_000 }],
      ),
    ).toThrow(/1 pricing inputs for 2 priced guests/);
  });
});

describe("valuedStrandNightPrices: an acceptance re-price reads the same values", () => {
  it("returns each guest's nights in stay order, valued, with parallel dates", () => {
    const [strand] = valuedStrandNightPrices(
      [
        {
          id: "guest-1",
          memberId: "member-1",
          isMember: true,
          consentStatus: null,
          priceCents: 10_000,
          nights: [
            night("2026-08-03", null, "UNKNOWN"),
            night("2026-08-01", 4_000),
            night("2026-08-02", null, "UNKNOWN"),
          ],
        },
      ],
      BOOKING,
    );
    expect(strand).toEqual({
      bookingGuestId: "guest-1",
      memberId: "member-1",
      isMember: true,
      consentStatus: null,
      perNightRates: [4_000, 3_000, 3_000],
      nightDates: [
        new Date("2026-08-01T00:00:00.000Z"),
        new Date("2026-08-02T00:00:00.000Z"),
        new Date("2026-08-03T00:00:00.000Z"),
      ],
    });
  });
});

describe("refuseNegativeStoredGuestTotals (D11, review M2)", () => {
  it("refuses with a 409, logging at error level once, naming every negative guest and #2745", () => {
    const error = vi.fn();
    expect(() =>
      refuseNegativeStoredGuestTotals({ error }, { bookingId: "b1", site: "test" }, [
        { id: "g1", priceCents: -1 },
        { id: "g2", priceCents: 0 },
        { id: "g3", priceCents: -900 },
      ]),
    ).toThrow(NegativeStoredGuestTotalError);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toEqual({
      bookingId: "b1",
      site: "test",
      bookingGuestIds: ["g1", "g3"],
      flag: "NEGATIVE_STORED_TOTAL",
    });
    expect(error.mock.calls[0]?.[1]).toContain("#2745");
    try {
      refuseNegativeStoredGuestTotals({ error }, { bookingId: "b1", site: "test" }, [
        { id: "g1", priceCents: -1 },
      ]);
    } catch (thrown) {
      expect(thrown).toMatchObject({ status: 409, message: NEGATIVE_STORED_GUEST_TOTAL_MESSAGE });
    }
  });

  it("lets a booking whose every stored total is zero or more through, silently", () => {
    const error = vi.fn();
    refuseNegativeStoredGuestTotals({ error }, { bookingId: "b1", site: "test" }, [
      { id: "g1", priceCents: 0 },
      { id: "g2", priceCents: 12_000 },
    ]);
    expect(error).not.toHaveBeenCalled();
  });
});
