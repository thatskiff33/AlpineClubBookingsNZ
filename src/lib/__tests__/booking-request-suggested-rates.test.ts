import { describe, expect, it } from "vitest";
import { resolveSuggestedGuestNightRatesForRequests } from "@/lib/booking-request-suggested-rates";

// A fake Prisma slice: the two built-in membership types, a default lodge, and
// one active season covering the fixtures' check-in with per-tier rate rows.
function fakeDb(
  overrides: {
    types?: Array<{ id: string; key: string }>;
    seasons?: unknown[];
  } = {},
) {
  const types = overrides.types ?? [
    { id: "full-id", key: "FULL" },
    { id: "nm-id", key: "NON_MEMBER" },
  ];
  const seasons = overrides.seasons ?? [
    {
      id: "season-winter",
      startDate: new Date("2026-07-01"),
      endDate: new Date("2026-09-30"),
      type: "WINTER",
      membershipTypeRates: [
        { membershipTypeId: "full-id", ageTier: "ADULT", pricePerNightCents: 5000 },
        { membershipTypeId: "nm-id", ageTier: "ADULT", pricePerNightCents: 8000 },
        { membershipTypeId: "full-id", ageTier: "CHILD", pricePerNightCents: 2500 },
        { membershipTypeId: "nm-id", ageTier: "CHILD", pricePerNightCents: 4000 },
      ],
    },
  ];
  return {
    membershipType: { findMany: async () => types },
    lodge: { findFirst: async () => ({ id: "lodge-1" }) },
    season: { findMany: async () => seasons },
  } as never;
}

const request = {
  id: "r1",
  lodgeId: "lodge-1",
  checkIn: new Date("2026-08-02"),
  guests: [{ ageTier: "ADULT" }, { ageTier: "CHILD" }, { ageTier: "ADULT" }],
};

describe("resolveSuggestedGuestNightRatesForRequests (#2749)", () => {
  it("returns an empty map for no requests", async () => {
    const result = await resolveSuggestedGuestNightRatesForRequests([], fakeDb());
    expect(result.size).toBe(0);
  });

  it("resolves non-member and Full-member nightly rates per distinct tier", async () => {
    const result = await resolveSuggestedGuestNightRatesForRequests(
      [request],
      fakeDb(),
    );
    const rates = result.get("r1");
    expect(rates).toEqual({
      ADULT: { nonMemberCents: 8000, memberCents: 5000 },
      CHILD: { nonMemberCents: 4000, memberCents: 2500 },
    });
    // INFANT was not among the guests, so it is not resolved.
    expect(rates?.INFANT).toBeUndefined();
  });

  it("yields null cents for a tier with no rate row", async () => {
    const result = await resolveSuggestedGuestNightRatesForRequests(
      [{ ...request, guests: [{ ageTier: "YOUTH" }] }],
      fakeDb(),
    );
    expect(result.get("r1")).toEqual({
      YOUTH: { nonMemberCents: null, memberCents: null },
    });
  });

  it("yields null cents when no season covers the check-in", async () => {
    const result = await resolveSuggestedGuestNightRatesForRequests(
      [{ ...request, checkIn: new Date("2026-12-25") }],
      fakeDb(),
    );
    expect(result.get("r1")).toEqual({
      ADULT: { nonMemberCents: null, memberCents: null },
      CHILD: { nonMemberCents: null, memberCents: null },
    });
  });
});
