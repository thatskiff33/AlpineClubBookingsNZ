import { describe, expect, it } from "vitest";

import {
  carriedCapRowScaler,
  scaleCappedCarriedRows,
  scaleCarriedRedemptions,
  type CarriedRedemption,
} from "@/lib/carried-promotion-cap";
import { apportionCents } from "@/lib/night-price-runs";

/**
 * #4317 review round 4 (epic #4302): AN IN-PROGRESS EDIT CARRIES ITS PROMOTION
 * AND CAPS IT. The planner caps the booking's figure at the new total; these
 * pin how the stored redemptions and allocations are scaled to that figure -
 * in proportion, in whole cents, leftover cents on the earliest entry - for
 * every kind of code, without re-deciding any of them.
 */

function redemption(
  id: string,
  priceAdjustmentCents: number,
  allocations: Array<[string | null, number, number?]>,
  extra: Partial<CarriedRedemption> = {},
): CarriedRedemption {
  return {
    id,
    promoCodeId: `code-${id}`,
    bookingId: "booking-1",
    memberId: "owner",
    discountCents: Math.max(0, -priceAdjustmentCents),
    priceAdjustmentCents,
    freeNightsUsed: null,
    eligibleGuestCount: 1,
    allocations: allocations.map(([memberId, cents, freeNights]) => ({
      memberId,
      priceAdjustmentCents: cents,
      discountCents: Math.max(0, -cents),
      freeNightsUsed: freeNights ?? 0,
    })),
    ...extra,
  };
}

const figures = (scaled: ReturnType<typeof scaleCarriedRedemptions>) =>
  scaled?.map((entry) => ({
    id: entry.redemption.id,
    priceAdjustmentCents: entry.priceAdjustmentCents,
    discountCents: entry.discountCents,
    allocations: entry.allocations.map((allocation) => [
      allocation.memberId,
      allocation.priceAdjustmentCents,
      allocation.discountCents,
      allocation.freeNightsUsed,
    ]),
  }));

describe("apportionCents", () => {
  it("splits in proportion and adds up exactly, leftover cents on the earliest entries", () => {
    expect(apportionCents(-1_001, [-3_333, -6_667])).toEqual([-334, -667]);
    expect(apportionCents(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(apportionCents(-10_000, [-35_000])).toEqual([-10_000]);
  });

  it("gives an entry with no weight nothing, not even a leftover cent", () => {
    expect(apportionCents(101, [0, 1, 1])).toEqual([0, 51, 50]);
  });

  it("refuses weights that sum to zero: there is no proportion to keep", () => {
    expect(() => apportionCents(100, [0, 0])).toThrow(/sum to zero/);
  });
});

describe("scaleCarriedRedemptions", () => {
  it("a fixed $350 code on a stay cut to $100 is scaled to -$100, its holder's allocation with it", () => {
    expect(figures(scaleCarriedRedemptions([redemption("r1", -35_000, [["owner", -35_000]])], -35_000, -10_000))).toEqual([
      { id: "r1", priceAdjustmentCents: -10_000, discountCents: 10_000, allocations: [["owner", -10_000, 10_000, 0]] },
    ]);
  });

  it("a 100% code is scaled to whatever is left", () => {
    expect(figures(scaleCarriedRedemptions([redemption("r1", -40_000, [["owner", -40_000]])], -40_000, -10_000))).toEqual([
      { id: "r1", priceAdjustmentCents: -10_000, discountCents: 10_000, allocations: [["owner", -10_000, 10_000, 0]] },
    ]);
  });

  it("stacked codes share the cap in proportion to what each took, in their application order", () => {
    const scaled = scaleCarriedRedemptions(
      [redemption("first", -3_333, [["owner", -3_333]]), redemption("second", -6_667, [["owner", -6_667]])],
      -10_000,
      -1_001,
    );
    expect(figures(scaled)).toEqual([
      { id: "first", priceAdjustmentCents: -334, discountCents: 334, allocations: [["owner", -334, 334, 0]] },
      { id: "second", priceAdjustmentCents: -667, discountCents: 667, allocations: [["owner", -667, 667, 0]] },
    ]);
  });

  it("a free-nights code keeps the nights it recorded as used; only its money is scaled", () => {
    const scaled = scaleCarriedRedemptions(
      [redemption("r1", -20_000, [["owner", -12_000, 2], ["partner", -8_000, 1]], { freeNightsUsed: 3 })],
      -20_000,
      -5_001,
    );
    expect(figures(scaled)).toEqual([
      {
        id: "r1",
        priceAdjustmentCents: -5_001,
        discountCents: 5_001,
        // -5001 x 0.6 = -3000.6 and -5001 x 0.4 = -2000.4: the leftover cent
        // goes to the earliest allocation.
        allocations: [
          ["owner", -3_001, 3_001, 2],
          ["partner", -2_000, 2_000, 1],
        ],
      },
    ]);
    expect(scaled?.[0]?.redemption.freeNightsUsed).toBe(3);
  });

  it("leaves the records as they were where an allocation names no member: the writer would delete that row (round 6)", () => {
    // A school's booker slot. The shared writer does not rewrite it, so scaling
    // would drop the row and lower the code's currentRedemptions.
    expect(scaleCarriedRedemptions([redemption("r1", -1_000, [["owner", -600], [null, -400]])], -1_000, -400)).toBeNull();
  });

  it("leaves the records as they were where the cap would scale an allocation to nothing (round 6)", () => {
    // -$0.01 of a -$10.00 code, scaled to -$0.05: the small share truncates to
    // $0, the writer would drop that allocation, and its counter would fall.
    expect(
      scaleCarriedRedemptions([redemption("r1", -1_000, [["owner", -999], ["partner", -1]])], -1_000, -5),
    ).toBeNull();
    // CONTROL: a free-nights share at $0 still records the nights it used, so it stays.
    expect(
      scaleCarriedRedemptions([redemption("r1", -1_000, [["owner", -999], ["partner", -1, 1]])], -1_000, -5),
    ).not.toBeNull();
  });

  it("scales nothing where the records do not add up to the stored figure, or there are none", () => {
    expect(scaleCarriedRedemptions([redemption("r1", -3_000, [["owner", -3_000]])], -5_000, -1_000)).toBeNull();
    expect(scaleCarriedRedemptions([], -5_000, -1_000)).toBeNull();
  });
});

describe("scaleCappedCarriedRows: the one rule-derived amount (#4317, owner decision 24 Oct 2026 on #4302)", () => {
  const N1 = new Date("2026-08-01T00:00:00.000Z");
  const N2 = new Date("2026-08-02T00:00:00.000Z");
  const N3 = new Date("2026-08-03T00:00:00.000Z");
  const row = (
    stayDate: Date | null,
    amountCents: number | null,
    extra: Partial<{
      bookingGuestId: string;
      beneficiaryMemberId: string;
      promoRedemptionId: string;
      heldPriceCents: number | null;
      guestHeldCents: number;
    }> = {},
  ) => ({
    kind: "PROMO" as const,
    amountCents,
    promoRedemptionId: "redemption-1",
    promoCodeId: "promo-1",
    beneficiaryMemberId: "booker",
    bookingGuestId: "guest-a",
    stayDate,
    heldPriceCents: 10_000,
    guestHeldCents: 100_000,
    ...extra,
  });
  const recorded = (priceAdjustmentCents: number, allocations: Array<[string | null, number]>, id = "redemption-1") => ({
    id,
    priceAdjustmentCents,
    allocations: allocations.map(([memberId, cents]) => ({ memberId, priceAdjustmentCents: cents })),
  });

  it("scales a fixed code's guest row to its capped figure: -$350 becomes -$300", () => {
    expect(
      scaleCappedCarriedRows([row(null, -35_000, { heldPriceCents: 30_000 })], [recorded(-30_000, [["booker", -30_000]])]),
    ).toEqual([-30_000]);
  });

  it("keeps rows that already add up byte for byte: a 100% code cut to the nights left", () => {
    expect(
      scaleCappedCarriedRows([row(N1, -5_000), row(N2, -5_000)], [recorded(-10_000, [["booker", -10_000]])]),
    ).toEqual([-5_000, -5_000]);
  });

  it("scales in proportion to the stored rows, leftover cents on the earliest night", () => {
    // -$25.00 / -$25.00 / -$50.00 scaled to -$100.01: -25.0025, -25.0025, -50.005.
    expect(
      scaleCappedCarriedRows(
        [row(N3, -5_000), row(N2, -2_500), row(N1, -2_500)],
        [recorded(-10_001, [["booker", -10_001]])],
      ),
    ).toEqual([-5_000, -2_500, -2_501]);
  });

  it("puts a night before a guest-scope row when the leftover cent goes", () => {
    expect(
      scaleCappedCarriedRows([row(null, -1_000), row(N2, -1_000)], [recorded(-1_001, [["booker", -1_001]])]),
    ).toEqual([-500, -501]);
  });

  it("scales each beneficiary to their own allocation, and each code on its own", () => {
    const scaled = scaleCappedCarriedRows(
      [
        row(N1, -4_000),
        row(N2, -4_000, { beneficiaryMemberId: "partner", bookingGuestId: "guest-b" }),
        row(N1, -2_000, { promoRedemptionId: "redemption-2", bookingGuestId: "guest-b" }),
      ],
      [
        recorded(-5_000, [["booker", -2_000], ["partner", -3_000]]),
        recorded(-1_000, [["booker", -1_000]], "redemption-2"),
      ],
    );
    expect(scaled).toEqual([-2_000, -3_000, -1_000]);
  });

  it("scales a beneficiary the cap left with nothing to zero", () => {
    expect(
      scaleCappedCarriedRows(
        [row(N1, -4_000), row(N2, -1_000, { beneficiaryMemberId: "partner" })],
        [recorded(-2_000, [["booker", -2_000]])],
      ),
    ).toEqual([-2_000, 0]);
  });

  describe("writes no row for a code it cannot scale honestly (round 6), and leaves the other codes", () => {
    it("LENS 1, a 50% code across two members: scaling the booker up would take $150 off a $100 night", () => {
      // The booker kept one $100 night (-$50 stored), the partner two; the cap
      // left each member -$150. The partner's rows could carry theirs; the
      // booker's one night cannot carry -$150, so the code writes none.
      const scaled = scaleCappedCarriedRows(
        [
          row(N1, -5_000),
          row(N1, -5_000, { beneficiaryMemberId: "partner", bookingGuestId: "guest-b" }),
          row(N2, -5_000, { beneficiaryMemberId: "partner", bookingGuestId: "guest-b" }),
        ],
        [recorded(-30_000, [["booker", -15_000], ["partner", -15_000]])],
      );
      expect(scaled).toEqual([null, null, null]);
    });

    it("LENS 2, an assigned fixed code: a guest row may not take more than the guest's own total", () => {
      // The engine's rule is min(value, guest total): guest A, now $100, cannot
      // carry the -$200 the cap left the booker once guest B's row went.
      expect(
        scaleCappedCarriedRows(
          [row(null, -30_000, { heldPriceCents: 10_000 })],
          [recorded(-20_000, [["booker", -20_000]])],
        ),
      ).toEqual([null]);
    });

    it("LENS 3, a SET_PRICE code that raised one night and discounted another: no proportion is meaningful", () => {
      expect(
        scaleCappedCarriedRows([row(N1, 2_000), row(N2, -5_000)], [recorded(-2_100, [["booker", -2_100]])]),
      ).toEqual([null, null]);
    });

    it("a raise is never scaled further up", () => {
      expect(scaleCappedCarriedRows([row(N1, 2_000)], [recorded(3_000, [["booker", 3_000]])])).toEqual([null]);
    });

    it("a NOT KNOWN amount, or an allocation with no row left, writes none for that code only", () => {
      const rows = [row(N1, null), row(N1, -2_000, { promoRedemptionId: "redemption-2", bookingGuestId: "guest-b" })];
      const codes = [recorded(-3_000, [["booker", -3_000]]), recorded(-1_000, [["booker", -1_000]], "redemption-2")];
      // The second code keeps KNOWN rows. (The booking's Xero promotion lines
      // still fall back to the aggregate while the first reads not known.)
      expect(scaleCappedCarriedRows(rows, codes)).toEqual([null, -1_000]);
      expect(scaleCappedCarriedRows([], [recorded(-3_000, [["booker", -3_000]])])).toEqual([]);
    });

    describe("ACROSS CODES, no guest may end with more off than the guest's held total (round 7)", () => {
      // Three guests at $200 each ($100 a night). A fixed code's guest rows on
      // G1 and G2, and a 50% code's night rows on G1 and G3, each scaled within
      // its own bounds - but G1 ends -$128.57 + -$85.72 = -$214.29 against $200.
      const G = (id: string) => ({ bookingGuestId: id, guestHeldCents: 20_000 });
      const lensRows = (g1HeldCents: number) => [
        row(null, -15_000, { ...G("g1"), guestHeldCents: g1HeldCents, heldPriceCents: g1HeldCents }),
        row(null, -15_000, { ...G("g2"), heldPriceCents: 20_000 }),
        row(N1, -5_000, { ...G("g1"), guestHeldCents: g1HeldCents, promoRedemptionId: "redemption-2" }),
        row(N2, -5_000, { ...G("g1"), guestHeldCents: g1HeldCents, promoRedemptionId: "redemption-2" }),
        row(N1, -5_000, { ...G("g3"), promoRedemptionId: "redemption-2" }),
        row(N2, -5_000, { ...G("g3"), promoRedemptionId: "redemption-2" }),
      ];
      const lensCodes = [
        recorded(-25_714, [["booker", -25_714]]),
        recorded(-17_143, [["booker", -17_143]], "redemption-2"),
      ];

      it("LENS: G1 would end at -$214.29 against $200, so both codes on G1 write none", () => {
        expect(scaleCappedCarriedRows(lensRows(20_000), lensCodes)).toEqual([null, null, null, null, null, null]);
      });

      it("CONTROL: with G1 held at $250, every code stands, scaled", () => {
        expect(scaleCappedCarriedRows(lensRows(25_000), lensCodes)).toEqual([
          -12_857, -12_857, -4_286, -4_286, -4_286, -4_285,
        ]);
      });

      it("a code on no over-total guest is left standing", () => {
        // G3's own code is the 50% code, which also sits on G1: it goes. A third
        // code only on G2 stays.
        const rows = [
          ...lensRows(20_000),
          row(N1, -1_000, { ...G("g2"), promoRedemptionId: "redemption-3" }),
        ];
        const codes = [...lensCodes, recorded(-1_000, [["booker", -1_000]], "redemption-3")];
        expect(scaleCappedCarriedRows(rows, codes)).toEqual([null, null, null, null, null, null, -1_000]);
      });
    });

    describe("ACROSS CODES, per night, in any order, and always ending (round 8)", () => {
      const at = (night: Date, cents: number, code: string, extra: Partial<{ heldPriceCents: number; guestHeldCents: number; bookingGuestId: string }> = {}) =>
        row(night, cents, { promoRedemptionId: code, ...extra });

      it("LENS F1: two codes on one $100 night take -$133.34 while the guest stays at its $200, so both write none", () => {
        // B (50%, first) on N1 and N2, A (a free night, on the remainder) on N1;
        // the cap left B -$133.33 and A -$66.67. Each row is within its night,
        // and the guest's -$200 is exactly its held total - but N1 would go
        // -$33.34 below nothing.
        const rows = [
          at(N1, -5_000, "b", { heldPriceCents: 10_000, guestHeldCents: 20_000 }),
          at(N2, -5_000, "b", { heldPriceCents: 10_000, guestHeldCents: 20_000 }),
          at(N1, -5_000, "a", { heldPriceCents: 10_000, guestHeldCents: 20_000 }),
        ];
        const codes = [recorded(-13_333, [["booker", -13_333]], "b"), recorded(-6_667, [["booker", -6_667]], "a")];
        expect(scaleCappedCarriedRows(rows, codes)).toEqual([null, null, null]);
      });

      it("CONTROL F1: at $150 a night the same rows stand", () => {
        const rows = [
          at(N1, -5_000, "b", { heldPriceCents: 15_000, guestHeldCents: 30_000 }),
          at(N2, -5_000, "b", { heldPriceCents: 15_000, guestHeldCents: 30_000 }),
          at(N1, -5_000, "a", { heldPriceCents: 15_000, guestHeldCents: 30_000 }),
        ];
        const codes = [recorded(-13_333, [["booker", -13_333]], "b"), recorded(-6_667, [["booker", -6_667]], "a")];
        expect(scaleCappedCarriedRows(rows, codes)).toEqual([-6_667, -6_666, -6_667]);
      });

      it("F4: a guest taking exactly its held total, and a night exactly its price, stand", () => {
        const rows = [
          at(N1, -10_000, "a", { heldPriceCents: 10_000, guestHeldCents: 20_000 }),
          at(N2, -10_000, "b", { heldPriceCents: 10_000, guestHeldCents: 20_000 }),
        ];
        const codes = [recorded(-10_000, [["booker", -10_000]], "a"), recorded(-10_000, [["booker", -10_000]], "b")];
        expect(scaleCappedCarriedRows(rows, codes)).toEqual([-10_000, -10_000]);
      });

      it("F2: two guests over at once clear every code on either, whatever order the rows come in", () => {
        // G1: X's guest row -$150 and Y's night -$80 = -$230 against $200.
        // G2: Y's night -$30 and Z's guest row -$190 = -$220 against $200.
        // Clearing G1 first would have spared Z; clearing G2 first, X.
        const rows = [
          row(null, -15_000, { promoRedemptionId: "x", bookingGuestId: "g1", guestHeldCents: 20_000, heldPriceCents: 20_000 }),
          at(N1, -8_000, "y", { bookingGuestId: "g1", guestHeldCents: 20_000 }),
          at(N1, -3_000, "y", { bookingGuestId: "g2", guestHeldCents: 20_000 }),
          row(null, -19_000, { promoRedemptionId: "z", bookingGuestId: "g2", guestHeldCents: 20_000, heldPriceCents: 20_000 }),
        ];
        const codes = [
          recorded(-15_000, [["booker", -15_000]], "x"),
          recorded(-11_000, [["booker", -11_000]], "y"),
          recorded(-19_000, [["booker", -19_000]], "z"),
        ];
        for (const order of [[0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]]) {
          expect(scaleCappedCarriedRows(order.map((index) => rows[index]!), codes)).toEqual([null, null, null, null]);
        }
      });

      it("ROUND 9 CASCADE: clearing a raise on one pass tips a night over on the next", () => {
        // N1 ($100) for G1 holds A's raise +$50 beside B -$70 and C -$70: a net
        // -$90, in bounds. A also sits on G2, which is over with D (+$10 and
        // -$120 against $100). Pass 1 clears A and D, which leaves N1 at -$140;
        // pass 2 must then clear B and C.
        const rows = [
          at(N1, 5_000, "a", { bookingGuestId: "g1", guestHeldCents: 30_000 }),
          at(N1, -7_000, "b", { bookingGuestId: "g1", guestHeldCents: 30_000 }),
          at(N1, -7_000, "c", { bookingGuestId: "g1", guestHeldCents: 30_000 }),
          at(N2, 1_000, "a", { bookingGuestId: "g2", guestHeldCents: 10_000 }),
          row(null, -12_000, { promoRedemptionId: "d", bookingGuestId: "g2", guestHeldCents: 10_000, heldPriceCents: 10_000 }),
        ];
        const codes = [
          recorded(6_000, [["booker", 6_000]], "a"),
          recorded(-7_000, [["booker", -7_000]], "b"),
          recorded(-7_000, [["booker", -7_000]], "c"),
          recorded(-12_000, [["booker", -12_000]], "d"),
        ];
        expect(scaleCappedCarriedRows(rows, codes)).toEqual([null, null, null, null, null]);
      });

      it("ROUND 9: one night of two guests is two nights - each -$60 on its own $100 stands", () => {
        const rows = [
          at(N1, -6_000, "x", { bookingGuestId: "g1", guestHeldCents: 20_000 }),
          at(N1, -6_000, "y", { bookingGuestId: "g2", guestHeldCents: 20_000 }),
        ];
        const codes = [recorded(-6_000, [["booker", -6_000]], "x"), recorded(-6_000, [["booker", -6_000]], "y")];
        expect(scaleCappedCarriedRows(rows, codes)).toEqual([-6_000, -6_000]);
      });

      it("ROUND 9: a row kept as it was on a night whose price is NOT KNOWN is not measured against it", () => {
        const rows = [row(N1, -5_000, { heldPriceCents: null, guestHeldCents: 20_000 })];
        expect(scaleCappedCarriedRows(rows, [recorded(-5_000, [["booker", -5_000]])])).toEqual([-5_000]);
      });

      it("F3: a guest held below zero ends the pass instead of looping, and leaves other codes standing", () => {
        const rows = [
          // A NOT KNOWN amount: this code writes none, so G1 has no row left.
          row(N1, null, { promoRedemptionId: "x", bookingGuestId: "g1", guestHeldCents: -100 }),
          // G3, also held below zero, with a row: that code goes.
          at(N1, -1_000, "y", { bookingGuestId: "g3", guestHeldCents: -100 }),
          at(N1, -1_000, "z", { bookingGuestId: "g2", guestHeldCents: 20_000 }),
        ];
        const codes = [
          recorded(-1_000, [["booker", -1_000]], "x"),
          recorded(-1_000, [["booker", -1_000]], "y"),
          recorded(-1_000, [["booker", -1_000]], "z"),
        ];
        expect(scaleCappedCarriedRows(rows, codes)).toEqual([null, null, -1_000]);
      });
    });

    it("a row naming no code the booking carries is not written", () => {
      expect(scaleCappedCarriedRows([row(N1, -5_000, { promoRedemptionId: "gone" })], [])).toEqual([null]);
    });
  });
});

describe("carriedCapRowScaler: the scaler the save hands the writer (round 6)", () => {
  it("none where the plan capped nothing, the scale where the records were scaled, and a clear where not", () => {
    expect(carriedCapRowScaler(undefined)).toBeUndefined();
    expect(carriedCapRowScaler(true)).toBe(scaleCappedCarriedRows);
    // Records left unscaled: rows that already reconcile to them are still
    // cleared, because the booking's own figure was capped beneath them.
    const clear = carriedCapRowScaler(false)!;
    const row = { kind: "PROMO" as const, amountCents: -5_000, promoRedemptionId: "r", promoCodeId: "c", beneficiaryMemberId: "m", bookingGuestId: "g", stayDate: null, heldPriceCents: 9_000, guestHeldCents: 9_000 };
    const recorded = [{ id: "r", priceAdjustmentCents: -5_000, allocations: [{ memberId: "m", priceAdjustmentCents: -5_000 }] }];
    expect(clear([row], recorded)).toEqual([null]);
    expect(carriedCapRowScaler(true)!([row], recorded)).toEqual([-5_000]);
  });
});
