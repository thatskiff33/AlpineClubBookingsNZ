import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * CT-4 (#2870): a season's first and last nights are the days the column stores.
 *
 * `Season.startDate` and `Season.endDate` are `@db.Date` — a calendar day encoded
 * as UTC midnight and never a moment (INV-DATE-010), read back in UTC under
 * INV-DATE-019's first exact boundary with INV-DATE-026, which are the citation
 * for a decode rather than INV-DATE-010 (#3080).
 *
 * The availability grid used to decode them with `formatDateOnlyForTimeZone`,
 * which projects the stored instant into
 * `APP_TIME_ZONE`. For a club ahead of Greenwich that is the identity, which is
 * why New Zealand never saw it. For a club BEHIND Greenwich every season window
 * slid one night earlier: the grid labelled the night before the season opened
 * as in-season, and dropped the season's own last night.
 *
 * That is not cosmetic. A member reads the season badge to know which nightly
 * rate applies before they book.
 *
 * ## What this file proves
 *
 * Zone-INDEPENDENCE, not zone-authority — and the difference is worth being
 * plain about. A calendar date takes no zone, ever, so after the change this
 * route consults none on this path: mocking a persisted `ClubTimeSettings` row
 * would prove nothing, because the code never reads one here and the old
 * projection would sail past such a test. `APP_TIME_ZONE` — the only zone the
 * replaced helper ever read — is instead pinned BEHIND UTC, and the first case
 * measures what that helper answers so the premise cannot go quiet.
 *
 * Independent of the host's `TZ`, which the mock overrides.
 */

// Inlined: `vi.mock` factories hoist above every const in this file.
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "America/Denver",
  APP_LOCALE: "en-NZ",
}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  applyRateLimit: vi.fn(),
  getMonthAvailability: vi.fn(),
  isMemberEligibleToBookLodge: vi.fn(),
  getDefaultLodgeId: vi.fn(),
  seasonFindMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...a: unknown[]) => mocks.requireActiveSessionUser(...a),
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: (...a: unknown[]) => mocks.applyRateLimit(...a),
  rateLimiters: { bookingQuery: { id: "bq", limit: 60, windowSeconds: 60 } },
}));
vi.mock("@/lib/capacity", () => ({
  getMonthAvailability: (...a: unknown[]) => mocks.getMonthAvailability(...a),
}));
vi.mock("@/lib/lodge-access", () => ({
  isMemberEligibleToBookLodge: (...a: unknown[]) => mocks.isMemberEligibleToBookLodge(...a),
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: (...a: unknown[]) => mocks.getDefaultLodgeId(...a),
  lodgeNullTolerantScope: () => ({}),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodge: { findUnique: vi.fn() },
    season: { findMany: (...a: unknown[]) => mocks.seasonFindMany(...a) },
  },
}));

import { APP_TIME_ZONE } from "@/config/operational";
import { formatDateOnlyForTimeZone } from "@/lib/date-only";
import { GET } from "@/app/api/availability/route";

/**
 * The zone the `@/config/operational` factory above pins, named rather than left
 * to the helper's `APP_TIME_ZONE` default, which #3123 deletes. The premise case
 * asserts the two are still the same zone, so this constant cannot drift out of
 * step with the factory and leave the cases below measuring nothing.
 */
const CLUB_ZONE_BEHIND_UTC = "America/Denver";

/** A season stored exactly as a `@db.Date` pair round-trips. */
const SEASON = {
  name: "Peak",
  type: "PEAK",
  startDate: new Date("2026-08-01T00:00:00.000Z"),
  endDate: new Date("2026-08-31T00:00:00.000Z"),
};

async function seasonsForAugust(): Promise<Record<string, { name: string; type: string }>> {
  const response = await GET(
    new NextRequest("http://localhost/api/availability?year=2026&month=7"),
  );
  expect(response.status).toBe(200);
  return (await response.json()).seasons;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "m1" } });
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.applyRateLimit.mockResolvedValue(null);
  mocks.getDefaultLodgeId.mockResolvedValue("lodge-a");
  mocks.isMemberEligibleToBookLodge.mockResolvedValue(true);
  mocks.getMonthAvailability.mockResolvedValue(new Map<string, number>());
  mocks.seasonFindMany.mockResolvedValue([SEASON]);
});

describe("season windows on the availability grid take no zone (CT-4, #2870)", () => {
  it("PREMISE: the replaced helper really moves both endpoints in this zone", () => {
    // The legacy ANSWER, measured rather than assumed. If these ever equalled
    // the stored days the zone would have stopped discriminating and the case
    // below would pass against the defect.
    //
    // The zone the replaced helper would have read is `APP_TIME_ZONE`, so the
    // constant below has to keep naming it for this premise to be about the
    // right zone at all.
    expect(APP_TIME_ZONE).toBe(CLUB_ZONE_BEHIND_UTC);
    expect(formatDateOnlyForTimeZone(SEASON.startDate, CLUB_ZONE_BEHIND_UTC)).toBe(
      "2026-07-31",
    );
    expect(formatDateOnlyForTimeZone(SEASON.endDate, CLUB_ZONE_BEHIND_UTC)).toBe(
      "2026-08-30",
    );
  });

  it("labels exactly the nights the season stores — first and last included", async () => {
    // MUTANT KILLED: decoding `@db.Date` through a zone. Under the projection
    // the window becomes 31 July - 30 August, so 1 August is still labelled
    // (from the wrong side) but 31 August loses its badge entirely, and the
    // member sees no season on the last night of the season.
    const seasons = await seasonsForAugust();

    expect(seasons["2026-08-01"]).toEqual({ name: "Peak", type: "PEAK" });
    expect(seasons["2026-08-31"]).toEqual({ name: "Peak", type: "PEAK" });
    expect(Object.keys(seasons)).toHaveLength(31);
  });

  it("does not spill the season onto the night before it opens", async () => {
    // The complement, on the July grid: with the projection, 31 July reads as
    // in-season because the window has slid a day earlier.
    const response = await GET(
      new NextRequest("http://localhost/api/availability?year=2026&month=6"),
    );
    const { seasons } = await response.json();

    expect(seasons["2026-07-31"]).toBeUndefined();
    expect(Object.keys(seasons)).toHaveLength(0);
  });
});
