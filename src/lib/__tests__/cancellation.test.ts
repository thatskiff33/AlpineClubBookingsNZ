import { describe, it, expect, vi } from "vitest";

/*
  THE PINNED ZONE IS THE DISCRIMINATOR, AND IT IS `Atlantic/Azores` (#3123).

  `daysUntilDate` reads no timezone at all any more, so nothing in this file can
  be moved by this pin while the function is correct — which is the point. The
  regression it guards is the PROJECTION it used to perform: both operands went
  through `normalizeDateOnlyForTimeZone`, so a stored `@db.Date` night was pushed
  into `APP_TIME_ZONE` before being counted. Under this repo's own fallback zone,
  `Pacific/Auckland`, that projection is the identity for a UTC-midnight value, so
  reintroducing it would not move a single number here. Pinned to a zone BEHIND
  Greenwich it does.

  `Atlantic/Azores` rather than any other such zone because it is the only IANA
  zone that changes the SIGN of its offset across DST — UTC-1 in standard time,
  UTC+0 in summer (swept across all 418 zones for 2026, #3107). Every other
  behind-Greenwich zone shifts every night by the same day, so a projection stays
  a translation there and differences between two counts still cancel. Here they
  do not, which is what lets the DST case below compare two ranges of equal
  length and see the projection appear in one of them and not the other.
*/
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "Atlantic/Azores",
  APP_LOCALE: "en-NZ",
}));

// getRefundTier / calculateRefundAmount are re-implemented below to avoid
// importing "../cancellation", which pulls in prisma. daysUntilDate is imported
// straight from the prisma-free policy module so these tests exercise the real
// lodge-day boundary logic (issue #1166) rather than a stale copy.
import { APP_TIME_ZONE } from "@/config/operational";
import { daysUntilDate } from "../policies/cancellation";
import { requireCalendarDate } from "@/lib/club-time";
import type { CancellationRule } from "../cancellation";

/** A stored `@db.Date` lodge night: the calendar day encoded at UTC midnight. */
const storedNight = (day: string) => new Date(`${day}T00:00:00.000Z`);

/** What the removed projection would have made of that stored night. */
const projected = (day: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: APP_TIME_ZONE }).format(
    storedNight(day),
  );

function getRefundTier(
  daysUntilCheckIn: number,
  policyRules: CancellationRule[]
): { refundPercentage: number; creditRefundPercentage: number; daysBeforeStay: number } {
  if (policyRules.length === 0) {
    return { refundPercentage: 0, creditRefundPercentage: 0, daysBeforeStay: 0 };
  }

  const sortedRules = [...policyRules].sort(
    (a, b) => b.daysBeforeStay - a.daysBeforeStay
  );

  for (const rule of sortedRules) {
    if (daysUntilCheckIn >= rule.daysBeforeStay) {
      return {
        refundPercentage: rule.refundPercentage,
        creditRefundPercentage: rule.creditRefundPercentage ?? rule.refundPercentage,
        daysBeforeStay: rule.daysBeforeStay,
      };
    }
  }

  return { refundPercentage: 0, creditRefundPercentage: 0, daysBeforeStay: 0 };
}

function calculateRefundAmount(
  paidAmountCents: number,
  daysUntilCheckIn: number,
  policyRules: CancellationRule[]
): { refundAmountCents: number; refundPercentage: number } {
  const { refundPercentage } = getRefundTier(daysUntilCheckIn, policyRules);
  const refundAmountCents = Math.round(
    (paidAmountCents * refundPercentage) / 100
  );
  return { refundAmountCents, refundPercentage };
}

const standardPolicy: CancellationRule[] = [
  { daysBeforeStay: 14, refundPercentage: 100, creditRefundPercentage: 100 },
  { daysBeforeStay: 7, refundPercentage: 50, creditRefundPercentage: 50 },
  { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
];

describe("getRefundTier", () => {
  it("returns 100% for 15 days before (above highest tier)", () => {
    expect(getRefundTier(15, standardPolicy)).toEqual({
      refundPercentage: 100,
      creditRefundPercentage: 100,
      daysBeforeStay: 14,
    });
  });

  it("returns 100% for exactly 14 days (exact boundary)", () => {
    expect(getRefundTier(14, standardPolicy)).toEqual({
      refundPercentage: 100,
      creditRefundPercentage: 100,
      daysBeforeStay: 14,
    });
  });

  it("returns 50% for 10 days (between tiers)", () => {
    expect(getRefundTier(10, standardPolicy)).toEqual({
      refundPercentage: 50,
      creditRefundPercentage: 50,
      daysBeforeStay: 7,
    });
  });

  it("returns 50% for exactly 7 days (exact boundary)", () => {
    expect(getRefundTier(7, standardPolicy)).toEqual({
      refundPercentage: 50,
      creditRefundPercentage: 50,
      daysBeforeStay: 7,
    });
  });

  it("returns 0% for 5 days (below 7-day tier)", () => {
    expect(getRefundTier(5, standardPolicy)).toEqual({
      refundPercentage: 0,
      creditRefundPercentage: 0,
      daysBeforeStay: 0,
    });
  });

  it("returns 0% for 0 days (exact lowest boundary)", () => {
    expect(getRefundTier(0, standardPolicy)).toEqual({
      refundPercentage: 0,
      creditRefundPercentage: 0,
      daysBeforeStay: 0,
    });
  });

  it("returns 0% for empty policy", () => {
    expect(getRefundTier(15, [])).toEqual({
      refundPercentage: 0,
      creditRefundPercentage: 0,
      daysBeforeStay: 0,
    });
  });

  it("handles single-rule policy", () => {
    expect(
      getRefundTier(5, [{ daysBeforeStay: 3, refundPercentage: 75, creditRefundPercentage: 75 }])
    ).toEqual({ refundPercentage: 75, creditRefundPercentage: 75, daysBeforeStay: 3 });
  });

  it("returns 0% when below single-rule threshold", () => {
    expect(
      getRefundTier(2, [{ daysBeforeStay: 3, refundPercentage: 75, creditRefundPercentage: 75 }])
    ).toEqual({ refundPercentage: 0, creditRefundPercentage: 0, daysBeforeStay: 0 });
  });

  it("handles unsorted policy rules", () => {
    const unsorted: CancellationRule[] = [
      { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
      { daysBeforeStay: 14, refundPercentage: 100, creditRefundPercentage: 100 },
      { daysBeforeStay: 7, refundPercentage: 50, creditRefundPercentage: 50 },
    ];
    expect(getRefundTier(10, unsorted)).toEqual({
      refundPercentage: 50,
      creditRefundPercentage: 50,
      daysBeforeStay: 7,
    });
  });

  it("returns 0% for negative days", () => {
    expect(getRefundTier(-1, standardPolicy)).toEqual({
      refundPercentage: 0,
      creditRefundPercentage: 0,
      daysBeforeStay: 0,
    });
  });

  it("returns highest tier for very large days", () => {
    expect(getRefundTier(365, standardPolicy)).toEqual({
      refundPercentage: 100,
      creditRefundPercentage: 100,
      daysBeforeStay: 14,
    });
  });
});

describe("calculateRefundAmount", () => {
  it("returns 100% refund when cancelling 14+ days before", () => {
    const result = calculateRefundAmount(10000, 14, standardPolicy);
    expect(result.refundAmountCents).toBe(10000);
    expect(result.refundPercentage).toBe(100);
  });

  it("returns 100% refund when cancelling 20 days before", () => {
    const result = calculateRefundAmount(10000, 20, standardPolicy);
    expect(result.refundAmountCents).toBe(10000);
    expect(result.refundPercentage).toBe(100);
  });

  it("returns 50% refund when cancelling 7-13 days before", () => {
    const result = calculateRefundAmount(10000, 7, standardPolicy);
    expect(result.refundAmountCents).toBe(5000);
    expect(result.refundPercentage).toBe(50);
  });

  it("returns 50% refund when cancelling 10 days before", () => {
    const result = calculateRefundAmount(10000, 10, standardPolicy);
    expect(result.refundAmountCents).toBe(5000);
    expect(result.refundPercentage).toBe(50);
  });

  it("returns 0% refund when cancelling less than 7 days before", () => {
    const result = calculateRefundAmount(10000, 6, standardPolicy);
    expect(result.refundAmountCents).toBe(0);
    expect(result.refundPercentage).toBe(0);
  });

  it("returns 0% refund when cancelling on the day", () => {
    const result = calculateRefundAmount(10000, 0, standardPolicy);
    expect(result.refundAmountCents).toBe(0);
    expect(result.refundPercentage).toBe(0);
  });

  it("returns 0% refund when cancelling after check-in (negative days)", () => {
    const result = calculateRefundAmount(10000, -1, standardPolicy);
    expect(result.refundAmountCents).toBe(0);
    expect(result.refundPercentage).toBe(0);
  });

  it("handles empty policy (no refund)", () => {
    const result = calculateRefundAmount(10000, 30, []);
    expect(result.refundAmountCents).toBe(0);
    expect(result.refundPercentage).toBe(0);
  });

  it("handles single rule policy", () => {
    const policy: CancellationRule[] = [
      { daysBeforeStay: 0, refundPercentage: 50, creditRefundPercentage: 50 },
    ];
    const result = calculateRefundAmount(10000, 5, policy);
    expect(result.refundAmountCents).toBe(5000);
    expect(result.refundPercentage).toBe(50);
  });

  it("correctly rounds refund amounts for odd percentages", () => {
    const policy: CancellationRule[] = [
      { daysBeforeStay: 0, refundPercentage: 33, creditRefundPercentage: 33 },
    ];
    const result = calculateRefundAmount(10000, 5, policy);
    expect(result.refundAmountCents).toBe(3300);
    expect(result.refundPercentage).toBe(33);
  });

  it("correctly rounds fractional cents", () => {
    const policy: CancellationRule[] = [
      { daysBeforeStay: 0, refundPercentage: 33, creditRefundPercentage: 33 },
    ];
    // 333 * 33 / 100 = 109.89 -> rounds to 110
    const result = calculateRefundAmount(333, 5, policy);
    expect(result.refundAmountCents).toBe(110);
  });

  it("handles unsorted policy rules correctly", () => {
    const unsortedPolicy: CancellationRule[] = [
      { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
      { daysBeforeStay: 14, refundPercentage: 100, creditRefundPercentage: 100 },
      { daysBeforeStay: 7, refundPercentage: 50, creditRefundPercentage: 50 },
    ];
    const result = calculateRefundAmount(10000, 10, unsortedPolicy);
    expect(result.refundAmountCents).toBe(5000);
    expect(result.refundPercentage).toBe(50);
  });

  it("handles generous policy (always 100%)", () => {
    const policy: CancellationRule[] = [
      { daysBeforeStay: 0, refundPercentage: 100, creditRefundPercentage: 100 },
    ];
    const result = calculateRefundAmount(5000, 1, policy);
    expect(result.refundAmountCents).toBe(5000);
    expect(result.refundPercentage).toBe(100);
  });

  it("refunds based on paid amount after partial refunds", () => {
    const result = calculateRefundAmount(7000, 10, standardPolicy);
    expect(result.refundAmountCents).toBe(3500);
    expect(result.refundPercentage).toBe(50);
  });

  it("handles zero amount gracefully", () => {
    const result = calculateRefundAmount(0, 14, standardPolicy);
    expect(result.refundAmountCents).toBe(0);
    expect(result.refundPercentage).toBe(100);
  });
});

// #3123: EVERY `checkIn` fixture below is a stored `@db.Date` lodge night, i.e.
// UTC midnight, because that is the only value `Booking.checkIn` can ever hold
// (`prisma/schema.prisma:1662`). Five of these cases used to pass a real
// timestamp and so pinned a contract the schema forbids: that a check-in with a
// time of day is projected through a zone. `daysUntilDate` DECODES the stored
// day instead, so those fixtures were the wrong half of the pair and have been
// corrected rather than the behaviour.
//
// AND THE SECOND OPERAND IS NOW A CALENDAR DAY, NOT AN INSTANT. Every case
// below used to hand in a `Date` and rely on this function projecting it through
// `APP_TIME_ZONE` to reach a New Zealand day — which is exactly the environment
// authority #3123 removes. The club's day is resolved by the caller now and
// arrives as a `CalendarDate`, so these cases STATE the day instead of encoding
// it as an instant plus an assumed zone.
describe("daysUntilDate", () => {
  it("calculates days correctly for future date", () => {
    expect(
      daysUntilDate(
        new Date("2025-07-15T00:00:00.000Z"),
        requireCalendarDate("2025-07-01"),
      ),
    ).toBe(14);
  });

  it("returns 0 for same day", () => {
    expect(
      daysUntilDate(
        new Date("2025-07-02T00:00:00.000Z"),
        requireCalendarDate("2025-07-02"),
      ),
    ).toBe(0);
  });

  it("returns negative for past date", () => {
    expect(
      daysUntilDate(
        new Date("2025-07-11T00:00:00.000Z"),
        requireCalendarDate("2025-07-16"),
      ),
    ).toBe(-5);
  });

  it("handles exact day boundary", () => {
    expect(
      daysUntilDate(
        new Date("2025-07-08T00:00:00.000Z"),
        requireCalendarDate("2025-07-01"),
      ),
    ).toBe(7);
  });

  it("keeps the 7-day tier for the whole club boundary day", () => {
    // Seven lodge days from the club's 1 July to the stored night of 8 July, so
    // the 7-day tier (50%) applies for the WHOLE of that club day — there is no
    // time of day left in either operand that could split it.
    const days = daysUntilDate(
      new Date("2025-07-08T00:00:00.000Z"),
      requireCalendarDate("2025-07-01"),
    );
    expect(days).toBe(7);
    expect(getRefundTier(days, standardPolicy)).toEqual(
      expect.objectContaining({ refundPercentage: 50, daysBeforeStay: 7 })
    );
  });

  it("drops to the lower tier once the day count falls below the threshold", () => {
    const days = daysUntilDate(
      new Date("2025-07-08T00:00:00.000Z"),
      requireCalendarDate("2025-07-02"),
    );
    expect(days).toBe(6);
    expect(getRefundTier(days, standardPolicy)).toEqual(
      expect.objectContaining({ refundPercentage: 0, daysBeforeStay: 0 })
    );
  });

  it("takes the check-in day off the UTC clock face, not out of a zone (#3123)", () => {
    // The stored night is DECODED — its UTC day is read — so the count does not
    // move with a time of day the value happens to carry, and no zone can shift
    // it. Projecting instead is what moved the night a day back for every club
    // behind Greenwich.
    const clubDay = requireCalendarDate("2025-07-01");
    expect(daysUntilDate(new Date("2025-07-15T00:00:00.000Z"), clubDay)).toBe(14);
    expect(daysUntilDate(new Date("2025-07-15T12:00:00.000Z"), clubDay)).toBe(14);
    expect(daysUntilDate(new Date("2025-07-15T23:59:00.000Z"), clubDay)).toBe(14);
  });

  it("THE MONEY CASE: a club behind Greenwich counts one day more, and it is right (#3123)", () => {
    // The regression this replaced. Projecting the UTC-midnight encoding of the
    // stored night through a zone BEHIND Greenwich moved the night back a day
    // while leaving `now` where it was, so the two errors SUBTRACTED instead of
    // cancelling: measured on `America/Denver`, 31 where the answer is 32.
    //
    // At the frozen instant `2026-07-01T00:00:00.000Z` the club's own day is
    // 1 July for Pacific/Auckland and 30 June for America/Denver
    // (`src/lib/club-time/clock.ts` records that measurement), so the two clubs
    // legitimately get 31 and 32 — and 32 is the answer the old code could not
    // produce for any deployment at all.
    const augustFirst = new Date("2026-08-01T00:00:00.000Z");
    expect(daysUntilDate(augustFirst, requireCalendarDate("2026-07-01"))).toBe(31);
    expect(daysUntilDate(augustFirst, requireCalendarDate("2026-06-30"))).toBe(32);
  });
});

// Issue #1166: the refund-tier boundary is counted in whole lodge days, so it
// falls at the CLUB's midnight rather than at UTC-midnight-of-check-in minus
// N*24h.
//
// WHERE HALF OF THIS BLOCK'S CLAIM WENT (#3123). It used to prove two things at
// once: that the boundary is a whole-day count, and that the day either side of
// it is derived in New Zealand's zone. The second half was only ever true
// because `APP_TIME_ZONE` happened to be `Pacific/Auckland` — the environment
// deciding a club-facing answer, which is the defect this issue removes.
// Deriving a club calendar day from an instant is now `clubCalendarDateOf` /
// `clubToday`, tested against the PERSISTED zone in
// `src/lib/club-time/__tests__/`, and asserted as money on the paths that use
// it in `cancel-preview-club-time-authority.test.ts`. What is left here is the
// first half, which is this function's own contract.
describe("daysUntilDate — whole-lodge-day boundary (issue #1166)", () => {
  it("the boundary day keeps the 7-day tier, summer or winter", () => {
    // 13 Jan -> 20 Jan and 13 Jul -> 20 Jul are both 7 nights, and "summer or
    // winter" is load-bearing under the pin above: January is Azores STANDARD
    // time, where the removed projection moves the stored night back a day and
    // this count becomes 6 — a whole refund tier — while July is Azores summer,
    // where it moves nothing. One fixture proves the arithmetic and the pair
    // proves it is not being reached through a zone.
    for (const [clubDay, checkIn] of [
      ["2026-01-13", "2026-01-20T00:00:00.000Z"],
      ["2025-07-13", "2025-07-20T00:00:00.000Z"],
    ] as const) {
      const days = daysUntilDate(new Date(checkIn), requireCalendarDate(clubDay));
      expect(days).toBe(7);
      expect(getRefundTier(days, standardPolicy)).toEqual(
        expect.objectContaining({ refundPercentage: 50, daysBeforeStay: 7 })
      );
    }
  });

  it("the next club day drops to six, and the tier drops with it", () => {
    const days = daysUntilDate(
      new Date("2026-01-20T00:00:00.000Z"),
      requireCalendarDate("2026-01-14"),
    );
    expect(days).toBe(6);
    expect(getRefundTier(days, standardPolicy)).toEqual(
      expect.objectContaining({ refundPercentage: 0, daysBeforeStay: 0 })
    );
  });

  it("crossing a DST transition inside the range does not change the count", () => {
    /*
      TWO RANGES OF FOURTEEN NIGHTS, each straddling one of `Atlantic/Azores`'s
      2026 transitions: 22 Mar -> 5 Apr crosses the 29 March spring-forward, and
      18 Oct -> 1 Nov crosses the 25 October fall-back.

      Under exact calendar arithmetic both are 14 and both hold the 100% tier.
      Under the projection this function used to perform they are 14 and 13,
      because the sign change means the stored night is pushed back a day on the
      WINTER side of a transition and left alone on the SUMMER side. So the
      count depends on which side of a DST change the stay falls — which is
      exactly what this case's name says must not happen, and which no
      uniformly-shifting zone could have shown.

      The earlier spelling of this case asserted a single New Zealand range and
      blamed millisecond division. That could not fail: the old implementation
      normalised BOTH operands to UTC midnight before dividing, so the interval
      was always an exact multiple of 86_400_000 whatever DST did inside it.
    */
    const acrossSpringForward = daysUntilDate(
      storedNight("2026-04-05"),
      requireCalendarDate("2026-03-22"),
    );
    const acrossFallBack = daysUntilDate(
      storedNight("2026-11-01"),
      requireCalendarDate("2026-10-18"),
    );
    expect(acrossSpringForward).toBe(14);
    expect(acrossFallBack).toBe(14);
    // Stated as money as well as as a number, because the tier is what the
    // member is actually refunded and 14 -> 13 crosses a published boundary.
    expect(getRefundTier(acrossFallBack, standardPolicy)).toEqual(
      getRefundTier(acrossSpringForward, standardPolicy),
    );
    expect(getRefundTier(acrossFallBack, standardPolicy)).toEqual(
      expect.objectContaining({ refundPercentage: 100, daysBeforeStay: 14 }),
    );
  });
});

describe("PREMISE: the pinned zone's projection is not a uniform shift", () => {
  it("moves a stored night on one side of a DST change and not the other", () => {
    expect(APP_TIME_ZONE).toBe("Atlantic/Azores");
    // Asserted from raw `Intl`, never from a helper, so the premise cannot drift
    // with the code under test. Standard time is UTC-1: a `@db.Date` UTC
    // midnight lands on the previous evening.
    expect(projected("2026-01-20")).toBe("2026-01-19");
    expect(projected("2026-11-01")).toBe("2026-10-31");
    // Summer time is UTC+0: the same encoding lands on its own day.
    expect(projected("2025-07-20")).toBe("2025-07-20");
    expect(projected("2026-04-05")).toBe("2026-04-05");
    // If either behaviour ever disappears from the IANA data this file has
    // stopped discriminating, so both are asserted rather than assumed.
  });
});
