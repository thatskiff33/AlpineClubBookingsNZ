import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression coverage for the production-readiness review §1.2: six
// modification/cancellation call sites now thread the BOOKING'S lodgeId into
// loadCancellationPolicy / getNonMemberHoldDays instead of silently resolving
// the default lodge. Those two shared functions are the choke point for change
// fees, settlement tiers, and non-member holds on the modify / date-change /
// guests-add paths. These tests pin that:
//   1. when a lodgeId is passed, the lodge's OWN override rows are used and
//      REPLACE the club-wide rows (never merged — ADR-001 resolved question 3),
//      and the default-lodge lookup is NOT consulted; and
//   2. when the caller passes null, the club's default lodge is resolved (the
//      bridging behaviour for a caller with no lodge context); and
//   3. the lodge cannot be left out at all: it is a required parameter
//      (#4946), pinned by the @ts-expect-error below, which `pnpm typecheck`
//      fails the moment the parameter becomes optional again.

const mocks = vi.hoisted(() => ({
  cancellationFindMany: vi.fn(),
  bookingPeriodFindMany: vi.fn(),
  bookingDefaultsFindUnique: vi.fn(),
  lodgeFindFirst: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    cancellationPolicy: { findMany: mocks.cancellationFindMany },
    bookingPeriod: { findMany: mocks.bookingPeriodFindMany },
    bookingDefaults: { findUnique: mocks.bookingDefaultsFindUnique },
    lodge: { findFirst: mocks.lodgeFindFirst },
  },
}));

import { getNonMemberHoldDays, loadCancellationPolicy } from "../cancellation";

const checkIn = new Date("2026-07-15");

// Club-wide (null) rows plus a distinct lodge-B override set for the SAME date
// window. If policy resolution ever merged or picked the wrong partition, the
// resolved rules would carry the wrong refund percentages / fees.
const CLUB_WIDE_RULES = [
  { lodgeId: null, daysBeforeStay: 14, refundPercentage: 100 },
  { lodgeId: null, daysBeforeStay: 7, refundPercentage: 50 },
];
const LODGE_B_RULES = [
  { lodgeId: "lodge-b", daysBeforeStay: 30, refundPercentage: 90 },
  { lodgeId: "lodge-b", daysBeforeStay: 3, refundPercentage: 25 },
];

describe("loadCancellationPolicy resolves the booking's lodge policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No BookingPeriod covers the date, so resolution falls to the
    // CancellationPolicy table (the branch the six call sites exercise).
    mocks.bookingPeriodFindMany.mockResolvedValue([]);
    mocks.lodgeFindFirst.mockResolvedValue({ id: "lodge-default" });
  });

  it("uses the lodge's override rows and REPLACES the club-wide rows", async () => {
    mocks.cancellationFindMany.mockResolvedValue([
      ...CLUB_WIDE_RULES,
      ...LODGE_B_RULES,
    ]);

    const rules = await loadCancellationPolicy(checkIn, "lodge-b");

    // Only lodge-B's rules survive — the club-wide rows are not merged in.
    expect(rules.map((r) => r.daysBeforeStay).sort((a, b) => a - b)).toEqual([
      3, 30,
    ]);
    expect(rules.map((r) => r.refundPercentage).sort((a, b) => a - b)).toEqual([
      25, 90,
    ]);
    // The booking's lodge was used directly; the default-lodge fallback was
    // never consulted.
    expect(mocks.lodgeFindFirst).not.toHaveBeenCalled();
  });

  it("falls back to the club-wide rows when the lodge has no override", async () => {
    // Lodge-C has no rows of its own, so the null (club-wide) partition applies.
    mocks.cancellationFindMany.mockResolvedValue([...CLUB_WIDE_RULES]);

    const rules = await loadCancellationPolicy(checkIn, "lodge-c");

    expect(rules.map((r) => r.daysBeforeStay).sort((a, b) => a - b)).toEqual([
      7, 14,
    ]);
    expect(mocks.lodgeFindFirst).not.toHaveBeenCalled();
  });

  it("resolves the club default lodge only when the caller passes null", async () => {
    mocks.cancellationFindMany.mockResolvedValue([...CLUB_WIDE_RULES]);

    await loadCancellationPolicy(checkIn, null);

    // The bridging behaviour: call sites without lodge context resolve the
    // default lodge (oldest active) rather than crashing.
    expect(mocks.lodgeFindFirst).toHaveBeenCalled();
  });

  it("refuses, at compile time, a call that leaves the lodge out (#4946)", async () => {
    mocks.cancellationFindMany.mockResolvedValue([...CLUB_WIDE_RULES]);

    // @ts-expect-error -- the lodge is required; a caller with a booking in hand
    // passes the booking's lodge, never nothing.
    await loadCancellationPolicy(checkIn);
  });

  it("prefers a matching BookingPeriod's rules over the policy table, scoped to the lodge", async () => {
    mocks.bookingPeriodFindMany.mockResolvedValue([
      {
        lodgeId: "lodge-b",
        startDate: new Date("2026-07-01"),
        endDate: new Date("2026-07-31"),
        cancellationRules: [{ daysBeforeStay: 10, refundPercentage: 40 }],
      },
      {
        lodgeId: null,
        startDate: new Date("2026-07-01"),
        endDate: new Date("2026-07-31"),
        cancellationRules: [{ daysBeforeStay: 99, refundPercentage: 100 }],
      },
    ]);

    const rules = await loadCancellationPolicy(checkIn, "lodge-b");

    // The lodge-B period rules win and replace the club-wide period entirely.
    expect(rules).toHaveLength(1);
    expect(rules[0].daysBeforeStay).toBe(10);
    expect(rules[0].refundPercentage).toBe(40);
    // The CancellationPolicy table is not consulted once a period matches.
    expect(mocks.cancellationFindMany).not.toHaveBeenCalled();
  });
});

describe("getNonMemberHoldDays resolves the booking's lodge hold", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lodgeFindFirst.mockResolvedValue({ id: "lodge-default" });
    mocks.bookingDefaultsFindUnique.mockResolvedValue({ nonMemberHoldDays: 7 });
  });

  it("uses the lodge's own BookingPeriod hold days for the check-in date", async () => {
    mocks.bookingPeriodFindMany.mockResolvedValue([
      {
        lodgeId: "lodge-b",
        startDate: new Date("2026-07-01"),
        endDate: new Date("2026-07-31"),
        nonMemberHoldDays: 14,
        cancellationRules: [],
      },
      {
        lodgeId: null,
        startDate: new Date("2026-07-01"),
        endDate: new Date("2026-07-31"),
        nonMemberHoldDays: 3,
        cancellationRules: [],
      },
    ]);

    const holdDays = await getNonMemberHoldDays(checkIn, "lodge-b");

    // Lodge-B's 14, not the club-wide period's 3, and not the default fallback.
    expect(holdDays).toBe(14);
    expect(mocks.lodgeFindFirst).not.toHaveBeenCalled();
  });

  it("falls back to booking defaults when no period covers the lodge's date", async () => {
    mocks.bookingPeriodFindMany.mockResolvedValue([]);

    const holdDays = await getNonMemberHoldDays(checkIn, "lodge-b");

    expect(holdDays).toBe(7);
  });
});
