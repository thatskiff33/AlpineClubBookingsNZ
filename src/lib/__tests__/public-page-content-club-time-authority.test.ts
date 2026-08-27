import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3123 — the four public content loaders ask "what day is it at the club", and
 * must answer from the PERSISTED `ClubTimeSettings.timeZone`, never from the
 * container's zone.
 *
 * Two of the four decide a PRICE. `loadPublicJoiningFees` and
 * `loadPublicAnnualFees` bound a fee schedule's effective window on `today`
 * (`effectiveFrom <= today <= effectiveTo`), so a day out at a schedule
 * boundary publishes yesterday's price on a public page (`INV-PUB`,
 * `INV-MONEY`). The other two filter booking and cancellation policy periods to
 * the ones still in force, so a day out shows a visitor a period the club has
 * finished with — or hides the one it is in.
 *
 * DISCRIMINATION. `APP_TIME_ZONE` — the container's zone, and the only thing
 * `getTodayDateOnly()` ever read — is pinned to `Pacific/Auckland`, which is the
 * answer the replaced helper would have given AND the value this codebase falls
 * back to, so it is the one zone a wrong fix could still pass under. The
 * persisted club zone is `America/Denver`, behind Greenwich, which is the side
 * the defect shows on. Under the frozen clock (`2026-07-01T00:00:00.000Z`) it is
 * 1 July in Auckland and 30 June in Denver, so the two never agree and no
 * assertion below can pass by coincidence (#3123 execution contract: "a test
 * that persists `Pacific/Auckland` cannot tell the persisted zone from the
 * environment zone").
 *
 * The bound is asserted at the exact millisecond rather than through the
 * loaders' answers alone, because `ClubJoiningFee.effectiveFrom` and
 * `BookingPeriod.endDate` are `@db.Date`: a club-LOCAL midnight bound is
 * `2026-06-30T06:00:00Z`, which the Prisma adapter narrows to 29 June
 * (`INV-DATE-026`). Only "the club's day, encoded at UTC midnight" gives
 * `2026-06-30T00:00:00.000Z`.
 */

// Inlined literals: `vi.mock` factories hoist above every const in this file.
vi.mock("server-only", () => ({}));
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "Pacific/Auckland",
  APP_LOCALE: "en-NZ",
}));

const ENVIRONMENT_ZONE = "Pacific/Auckland";
const PERSISTED_ZONE = "America/Denver";

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  membershipTypes: vi.fn(),
  ageTiers: vi.fn(),
  defaults: vi.fn(),
  periods: vi.fn(),
  minimumStays: vi.fn(),
  discount: vi.fn(),
  hostingPolicies: vi.fn(),
  cancellation: vi.fn(),
  clubTimeSettings: vi.fn(),
}));

/*
  THE `clubTimeSettings` DELEGATE IS NOT OPTIONAL ON THIS MOCK. `getClubTimeZone`
  is fail-soft in three places — a missing delegate, a throwing query and an
  absent row — and every one of them degrades silently to the environment. A
  prisma mock without it therefore passes for exactly the reason this file
  exists to rule out.
*/
vi.mock("@/lib/prisma", () => ({
  prisma: {
    publicContentSettings: { findUnique: mocks.settings },
    membershipType: { findMany: mocks.membershipTypes },
    ageTierSetting: { findMany: mocks.ageTiers },
    bookingDefaults: { findUnique: mocks.defaults },
    bookingPeriod: { findMany: mocks.periods },
    minimumStayPolicy: { findMany: mocks.minimumStays },
    groupDiscountSetting: { findUnique: mocks.discount },
    adultMemberHostingPolicy: { findMany: mocks.hostingPolicies },
    cancellationPolicy: { findMany: mocks.cancellation },
    clubTimeSettings: { findUnique: mocks.clubTimeSettings },
  },
}));

import { APP_TIME_ZONE } from "@/config/operational";
import { clubToday, requireClubTimeZone } from "@/lib/club-time";
import {
  loadPublicAnnualFees,
  loadPublicBookingPolicy,
  loadPublicCancellationPolicy,
  loadPublicJoiningFees,
} from "@/lib/public-page-content-tokens";

const CLUB_DAY_UTC_MIDNIGHT = "2026-06-30T00:00:00.000Z";
const ENVIRONMENT_DAY_UTC_MIDNIGHT = "2026-07-01T00:00:00.000Z";

function persistClubZone(timeZone: string) {
  mocks.clubTimeSettings.mockResolvedValue({
    timeZone,
    updatedByMemberId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
}

/** The `effectiveFrom` bound the loader handed Prisma for its fee window. */
function feeWindowBound(select: "joiningFees" | "annualFees"): Date {
  const call = mocks.membershipTypes.mock.calls.at(-1)?.[0] as {
    select: Record<string, { where: { effectiveFrom: { lte: Date } } }>;
  };
  return call.select[select].where.effectiveFrom.lte;
}

/** A booking period that ends on the club's day and NOT on the container's. */
function periodEndingOnTheClubDay() {
  return {
    name: "Winter",
    startDate: new Date("2026-06-01T00:00:00.000Z"),
    endDate: new Date(CLUB_DAY_UTC_MIDNIGHT),
    nonMemberHoldEnabled: false,
    nonMemberHoldDays: null,
    cancellationRules: [],
    lodgeId: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  persistClubZone(PERSISTED_ZONE);
  mocks.settings.mockImplementation(
    ({ select }: { select: Record<string, boolean> }) =>
      Object.fromEntries(Object.keys(select).map((key) => [key, true])),
  );
  mocks.membershipTypes.mockResolvedValue([]);
  mocks.ageTiers.mockResolvedValue([]);
  mocks.defaults.mockResolvedValue(null);
  mocks.periods.mockResolvedValue([]);
  mocks.minimumStays.mockResolvedValue([]);
  mocks.discount.mockResolvedValue(null);
  mocks.hostingPolicies.mockResolvedValue([]);
  mocks.cancellation.mockResolvedValue([]);
});

describe("public content loaders take today from the club, not the container (#3123)", () => {
  it("PREMISE: the persisted zone and the environment's give different days", () => {
    // The ANSWERS have to differ, not merely the identifiers — two zones with
    // different names and the same offset would make every case below vacuous.
    expect(APP_TIME_ZONE).toBe(ENVIRONMENT_ZONE);
    expect(clubToday(requireClubTimeZone(ENVIRONMENT_ZONE))).toBe("2026-07-01");
    expect(clubToday(requireClubTimeZone(PERSISTED_ZONE))).toBe("2026-06-30");
  });

  it("bounds the public joining-fee window on the club's day, at UTC midnight", async () => {
    await loadPublicJoiningFees();

    expect(feeWindowBound("joiningFees").toISOString()).toBe(
      CLUB_DAY_UTC_MIDNIGHT,
    );
  });

  it("bounds the public annual-fee window on the club's day, at UTC midnight", async () => {
    await loadPublicAnnualFees();

    expect(feeWindowBound("annualFees").toISOString()).toBe(
      CLUB_DAY_UTC_MIDNIGHT,
    );
  });

  it("keeps a booking period that is still in force on the club's day", async () => {
    // The period ends 30 June. On the club's day it is current and shown; on
    // the container's day it has expired and the visitor sees nothing.
    mocks.periods.mockResolvedValue([periodEndingOnTheClubDay()]);

    const policy = await loadPublicBookingPolicy();

    expect(policy?.periods.map((period) => period.name)).toEqual(["Winter"]);
  });

  it("keeps a cancellation-policy period that is still in force on the club's day", async () => {
    mocks.periods.mockResolvedValue([periodEndingOnTheClubDay()]);

    const policy = await loadPublicCancellationPolicy();

    expect(policy?.periods.map((period) => period.name)).toEqual(["Winter"]);
  });

  it("moves every answer when the persisted zone moves, and nothing else changes", async () => {
    // Kills "ignore the persisted row" in every form — a hard-coded default, an
    // environment read, a value cached across calls. Same clock, same mocks;
    // only the stored zone differs.
    persistClubZone("Pacific/Kiritimati"); // UTC+14 — 1 July, ahead of Auckland
    await loadPublicJoiningFees();
    expect(feeWindowBound("joiningFees").toISOString()).toBe(
      ENVIRONMENT_DAY_UTC_MIDNIGHT,
    );

    persistClubZone("Pacific/Pago_Pago"); // UTC-11 — still 30 June
    await loadPublicAnnualFees();
    expect(feeWindowBound("annualFees").toISOString()).toBe(
      CLUB_DAY_UTC_MIDNIGHT,
    );
  });

  it("really asks the ClubTimeSettings row for the zone", async () => {
    await loadPublicJoiningFees();

    expect(mocks.clubTimeSettings).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "default" } }),
    );
  });
});
