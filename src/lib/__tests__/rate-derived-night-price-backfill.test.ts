/**
 * The rate-derived backfill (#3531 stage 3b, D-3531-2): a strand is rewritten
 * only when the rate table, over the party as sold, reproduces its stored total
 * to the cent; everything else is listed with a reason and never priced. Every
 * write is a compare-and-set on what the row was planned from.
 */
import { describe, expect, it, vi } from "vitest";
import type { SeasonRateData } from "@/lib/pricing";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  applyRateDerivedNightPrices,
  formatRateDerivedBackfillReport,
  isRateDerivationCandidate,
  planRateDerivedNightPrices,
  RateDerivedBackfillRacedError,
  rateDerivedBackfillAuditMetadata,
  type StoredStrand,
} from "@/lib/rate-derived-night-price-backfill";

const D = (value: string) => new Date(`${value}T00:00:00.000Z`);
const MEMBER_TYPE = "type-member";
const NON_MEMBER_TYPE = "type-non-member";

/** Two seasons meeting mid-stay, so a real derivation is NOT an even split. */
const SEASONS: SeasonRateData[] = [
  {
    seasonId: "s-early",
    startDate: D("2026-08-01"),
    endDate: D("2026-08-15"),
    rates: [
      { ageTier: "ADULT", membershipTypeId: MEMBER_TYPE, pricePerNightCents: 6000 },
      { ageTier: "ADULT", membershipTypeId: NON_MEMBER_TYPE, pricePerNightCents: 8000 },
    ],
  },
  {
    seasonId: "s-late",
    startDate: D("2026-08-16"),
    endDate: D("2026-08-31"),
    rates: [
      { ageTier: "ADULT", membershipTypeId: MEMBER_TYPE, pricePerNightCents: 7000 },
      { ageTier: "ADULT", membershipTypeId: NON_MEMBER_TYPE, pricePerNightCents: 9000 },
    ],
  },
];

/** A strand whose rows were split evenly across 15 and 16 Aug. */
function evenlySplit(id: string, overrides: Partial<StoredStrand> = {}): StoredStrand {
  return {
    id,
    ageTier: "ADULT",
    isMember: true,
    rateMembershipTypeId: MEMBER_TYPE,
    priceCents: 13000, // 6000 + 7000 as sold; split evenly at import as 6500 + 6500
    nights: [
      { id: `${id}-n1`, stayDate: D("2026-08-15"), priceCents: 6500, priceSource: "EVEN_SPLIT" },
      { id: `${id}-n2`, stayDate: D("2026-08-16"), priceCents: 6500, priceSource: "EVEN_SPLIT" },
    ],
    ...overrides,
  };
}

function booking(guests: StoredStrand[]) {
  return { id: "bk1", checkIn: D("2026-08-15"), checkOut: D("2026-08-17"), guests };
}

const plan = (guests: StoredStrand[]) =>
  planRateDerivedNightPrices({ booking: booking(guests), seasons: SEASONS, groupDiscount: undefined, nonMemberTypeId: NON_MEMBER_TYPE });

describe("isRateDerivationCandidate", () => {
  it("is a strand whose every row was split or is of unknown origin; a sold or officer-priced row disqualifies it", () => {
    expect(isRateDerivationCandidate(evenlySplit("a"))).toBe(true);
    expect(isRateDerivationCandidate(evenlySplit("a", { nights: [{ id: "x", stayDate: D("2026-08-15"), priceCents: 6500, priceSource: "UNKNOWN" }] }))).toBe(true);
    expect(isRateDerivationCandidate(evenlySplit("a", { nights: [{ id: "x", stayDate: D("2026-08-15"), priceCents: 6500, priceSource: "SOLD" }] }))).toBe(false);
    expect(isRateDerivationCandidate(evenlySplit("a", { nights: [{ id: "x", stayDate: D("2026-08-15"), priceCents: 6500, priceSource: "RATE_DERIVED" }] }))).toBe(false);
    expect(isRateDerivationCandidate(evenlySplit("a", { nights: [] }))).toBe(false);
  });
});

describe("planRateDerivedNightPrices", () => {
  it("rewrites a strand the rate table reproduces, with the real per-night split rather than the even one", () => {
    const result = plan([evenlySplit("a")]);
    expect(result.residue).toEqual([]);
    expect(result.rewrite).toEqual([
      {
        bookingGuestId: "a",
        guestTotalCents: 13000,
        nights: [
          { id: "a-n1", date: "2026-08-15", fromPriceCents: 6500, fromSource: "EVEN_SPLIT", toPriceCents: 6000 },
          { id: "a-n2", date: "2026-08-16", fromPriceCents: 6500, fromSource: "EVEN_SPLIT", toPriceCents: 7000 },
        ],
      },
    ]);
  });

  it("lists a strand the rate table does not reproduce, with the figure it derived (mutation probe: one cent)", () => {
    const result = plan([evenlySplit("a", { priceCents: 13001, nights: [
      { id: "a-n1", stayDate: D("2026-08-15"), priceCents: 6501, priceSource: "EVEN_SPLIT" },
      { id: "a-n2", stayDate: D("2026-08-16"), priceCents: 6500, priceSource: "EVEN_SPLIT" },
    ] })]);
    expect(result.rewrite).toEqual([]);
    expect(result.residue).toEqual([
      { bookingGuestId: "a", guestTotalCents: 13001, reason: "RATE_TABLE_DOES_NOT_REPRODUCE_TOTAL", derivedTotalCents: 13000 },
    ]);
  });

  it("lists a strand with no rate snapshot, and one holding a blank night, without running the engine on them", () => {
    const result = plan([
      evenlySplit("no-snapshot", { rateMembershipTypeId: null }),
      evenlySplit("blank", { nights: [
        { id: "b-n1", stayDate: D("2026-08-15"), priceCents: 6500, priceSource: "EVEN_SPLIT" },
        { id: "b-n2", stayDate: D("2026-08-16"), priceCents: null, priceSource: "UNKNOWN" },
      ] }),
    ]);
    expect(result.rewrite).toEqual([]);
    expect(result.residue.map((r) => [r.bookingGuestId, r.reason])).toEqual([
      ["no-snapshot", "NO_RATE_SNAPSHOT"],
      ["blank", "UNVALUED_NIGHT"],
    ]);
  });

  it("lists every candidate as NO_SEASON_RATE when the engine cannot price a night", () => {
    const result = planRateDerivedNightPrices({
      booking: booking([evenlySplit("a")]),
      seasons: [],
      groupDiscount: undefined,
      nonMemberTypeId: NON_MEMBER_TYPE,
    });
    expect(result.rewrite).toEqual([]);
    expect(result.residue).toEqual([{ bookingGuestId: "a", guestTotalCents: 13000, reason: "NO_SEASON_RATE" }]);
  });

  it("never rewrites a sold strand, but prices it as part of the party", () => {
    const sold = evenlySplit("sold", {
      nights: [
        { id: "s-n1", stayDate: D("2026-08-15"), priceCents: 6000, priceSource: "SOLD" },
        { id: "s-n2", stayDate: D("2026-08-16"), priceCents: 7000, priceSource: "SOLD" },
      ],
    });
    const result = plan([sold, evenlySplit("a")]);
    expect(result.rewrite.map((r) => r.bookingGuestId)).toEqual(["a"]);
    expect(result.residue).toEqual([]);
  });

  it("a non-member strand is derived from the non-member rows", () => {
    const result = plan([
      evenlySplit("nm", { isMember: false, rateMembershipTypeId: NON_MEMBER_TYPE, priceCents: 17000, nights: [
        { id: "nm-n1", stayDate: D("2026-08-15"), priceCents: 8500, priceSource: "EVEN_SPLIT" },
        { id: "nm-n2", stayDate: D("2026-08-16"), priceCents: 8500, priceSource: "EVEN_SPLIT" },
      ] }),
    ]);
    expect(result.rewrite[0]?.nights.map((n) => n.toPriceCents)).toEqual([8000, 9000]);
  });

  it("does nothing for a booking with no candidate", () => {
    const sold = evenlySplit("sold", {
      nights: [{ id: "s-n1", stayDate: D("2026-08-15"), priceCents: 6000, priceSource: "SOLD" }],
      priceCents: 6000,
    });
    expect(plan([sold])).toEqual({ bookingId: "bk1", rewrite: [], residue: [] });
  });
});

describe("applyRateDerivedNightPrices", () => {
  const planned = plan([evenlySplit("a")]);

  it("writes every planned row as a compare-and-set on the price and provenance it was planned from", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const rows = await applyRateDerivedNightPrices(planned, { bookingGuestNight: { updateMany } } as never);
    expect(rows).toBe(2);
    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "a-n1", bookingGuestId: "a", priceCents: 6500, priceSource: "EVEN_SPLIT" },
      data: { priceCents: 6000, priceSource: "RATE_DERIVED" },
    });
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "a-n2", bookingGuestId: "a", priceCents: 6500, priceSource: "EVEN_SPLIT" },
      data: { priceCents: 7000, priceSource: "RATE_DERIVED" },
    });
  });

  it("refuses the booking when a row no longer holds what it was planned from", async () => {
    const updateMany = vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await expect(
      applyRateDerivedNightPrices(planned, { bookingGuestNight: { updateMany } } as never),
    ).rejects.toBeInstanceOf(RateDerivedBackfillRacedError);
  });
});

describe("the report and the audit metadata", () => {
  it("carry every strand's before and after, and count the residue by reason", () => {
    const plans = [
      plan([evenlySplit("a"), evenlySplit("no-snapshot", { rateMembershipTypeId: null })]),
    ];
    const report = formatRateDerivedBackfillReport(plans);
    expect(report).toContain("Strands to rewrite: 1 (2 night rows)");
    expect(report).toContain("NO_RATE_SNAPSHOT: 1");
    expect(report).toContain("rewrite guest a (total 13000c): 2026-08-15 6500->6000, 2026-08-16 6500->7000");
    expect(rateDerivedBackfillAuditMetadata(plans[0]!)).toEqual({
      bookingId: "bk1",
      rewrittenStrands: [
        {
          bookingGuestId: "a",
          guestTotalCents: 13000,
          nightPrices: [
            { date: "2026-08-15", fromPriceCents: 6500, fromSource: "EVEN_SPLIT", toPriceCents: 6000 },
            { date: "2026-08-16", fromPriceCents: 6500, fromSource: "EVEN_SPLIT", toPriceCents: 7000 },
          ],
        },
      ],
      residue: [{ bookingGuestId: "no-snapshot", guestTotalCents: 13000, reason: "NO_RATE_SNAPSHOT" }],
    });
  });
});

describe("runRateDerivedNightPriceBackfill (store-facing)", () => {
  function storeDouble(args: { raceOnSecondRow?: boolean } = {}) {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: args.raceOnSecondRow ? 0 : 1 });
    const auditCreate = vi.fn().mockResolvedValue({});
    const tx = {
      bookingGuestNight: { updateMany },
      booking: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          memberId: "m1",
          organisationId: null,
          member: { id: "m1" },
          organisation: null,
        }),
      },
      auditLog: { create: auditCreate },
    };
    const store = {
      groupDiscountSetting: { findUnique: vi.fn().mockResolvedValue(null) },
      membershipType: { findFirst: vi.fn().mockResolvedValue({ id: NON_MEMBER_TYPE }) },
      bookingGuestNight: {
        findMany: vi.fn().mockResolvedValue([
          { bookingGuest: { bookingId: "bk1", booking: { createdAt: D("2026-06-01") } } },
        ]),
      },
      booking: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "bk1",
          lodgeId: "lodge-1",
          checkIn: D("2026-08-15"),
          checkOut: D("2026-08-17"),
          guests: [evenlySplit("a")],
        }),
      },
      season: {
        findMany: vi.fn().mockResolvedValue(
          SEASONS.map((season) => ({
            id: season.seasonId,
            startDate: season.startDate,
            endDate: season.endDate,
            type: "WINTER",
            membershipTypeRates: season.rates,
          })),
        ),
      },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    return { store, tx, updateMany, auditCreate };
  }

  it("dry run plans and writes nothing", async () => {
    const { store, updateMany, auditCreate } = storeDouble();
    const { runRateDerivedNightPriceBackfill } = await import("@/lib/rate-derived-night-price-backfill");
    const result = await runRateDerivedNightPriceBackfill({ store: store as never, apply: false });
    expect(result.mode).toBe("dry-run");
    expect(result.plans[0]?.rewrite).toHaveLength(1);
    expect(updateMany).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
    expect(store.$transaction).not.toHaveBeenCalled();
  });

  it("apply writes each booking in its own transaction with one audit row carrying before and after", async () => {
    const { store, updateMany, auditCreate } = storeDouble();
    const { runRateDerivedNightPriceBackfill } = await import("@/lib/rate-derived-night-price-backfill");
    const result = await runRateDerivedNightPriceBackfill({ store: store as never, apply: true });
    expect(result.applied).toEqual([{ bookingId: "bk1", rows: 2 }]);
    expect(result.raced).toEqual([]);
    expect(updateMany).toHaveBeenCalledTimes(2);
    const audit = auditCreate.mock.calls[0]?.[0]?.data;
    expect(audit).toMatchObject({
      action: "booking-payment.stored-night-price.rate-derived",
      category: "payment",
      severity: "important",
      outcome: "success",
      targetId: "bk1",
      entityType: "Booking",
      subjectMemberId: "m1",
    });
    const metadata = JSON.parse(typeof audit.metadata === "string" ? audit.metadata : JSON.stringify(audit.metadata));
    expect(metadata.rewrittenStrands[0].nightPrices).toEqual([
      { date: "2026-08-15", fromPriceCents: 6500, fromSource: "EVEN_SPLIT", toPriceCents: 6000 },
      { date: "2026-08-16", fromPriceCents: 6500, fromSource: "EVEN_SPLIT", toPriceCents: 7000 },
    ]);
  });

  it("a raced row rolls the booking back and names it, and the run continues", async () => {
    const { store, auditCreate } = storeDouble({ raceOnSecondRow: true });
    const { runRateDerivedNightPriceBackfill } = await import("@/lib/rate-derived-night-price-backfill");
    const result = await runRateDerivedNightPriceBackfill({ store: store as never, apply: true });
    expect(result.applied).toEqual([]);
    expect(result.raced).toEqual(["bk1"]);
    expect(auditCreate).not.toHaveBeenCalled();
  });
});
