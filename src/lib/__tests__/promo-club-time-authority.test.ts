import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3123 — the two temporal kinds `promo.ts` was conflating, and the live money
 * defect that conflation shipped.
 *
 * `nzDateKey` projected its argument through `APP_TIME_ZONE`, and it was handed
 * two different kinds of value:
 *
 * - the booking-date window compared a projected BOOKING CHECK-IN
 *   (`Booking.checkIn`, `@db.Date`, `prisma/schema.prisma:1662`) against
 *   `PromoCode.bookingStartFrom` / `bookingStartUntil` (`@db.Date`, `:2957-2958`)
 *   read ZONE-FREE by `storedPromoDateKey`. Two sides of one comparison in two
 *   different frames — so for any club behind Greenwich the check-in key was a
 *   day early and a booking starting on the promotion's FIRST valid day was
 *   refused with "This promo code is not valid for your booking dates". That is
 *   live today on any deployment west of Greenwich, whatever its club timezone
 *   says, because one side of the comparison never consulted a zone at all;
 * - the validity window compares "now" — a real instant — against `validFrom` /
 *   `validUntil`. That one genuinely needs a zone, and the zone it needs is the
 *   club's PERSISTED one (`INV-CONFIG-002`), never the container's.
 *
 * DISCRIMINATION. `APP_TIME_ZONE` is pinned to `America/Denver`, behind
 * Greenwich, because that is the side on which both defects are visible. Where
 * the persisted club zone matters it is set to something the environment does
 * not claim, and moved between cases — a suite that persists the zone the
 * environment already holds cannot tell the persisted zone from the environment
 * zone (#3123 execution contract).
 */
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "America/Denver",
  APP_LOCALE: "en-NZ",
}));

const { mockPromoCodeAssignmentFindMany, mockClubTimeSettingsFindUnique } =
  vi.hoisted(() => ({
    mockPromoCodeAssignmentFindMany: vi.fn(),
    mockClubTimeSettingsFindUnique: vi.fn(),
  }));

/*
  THE `clubTimeSettings` DELEGATE IS NOT OPTIONAL ON THIS MOCK. The persisted
  reader is fail-soft on a missing delegate, on a throwing query and on a missing
  row, and every one of those degrades silently to the environment — so a prisma
  mock without it passes for exactly the reason this file exists to rule out.
*/
vi.mock("@/lib/prisma", () => ({
  prisma: {
    promoCodeAssignment: { findMany: mockPromoCodeAssignmentFindMany },
    clubTimeSettings: { findUnique: mockClubTimeSettingsFindUnique },
  },
}));

import { APP_TIME_ZONE } from "@/config/operational";
import { requireCalendarDate } from "@/lib/club-time";
import {
  getAssignedPromoCodeSummariesForMember,
  validatePromoCodeRules,
  type PromoRuleSubject,
} from "@/lib/promo";

const ENVIRONMENT_ZONE = "America/Denver";

function persistClubZone(timeZone: string) {
  mockClubTimeSettingsFindUnique.mockResolvedValue({ timeZone });
}

/** A `@db.Date` value as Prisma hands it back: the calendar day at UTC midnight. */
function storedDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}


/*
  #3123, second half: `validatePromoCodeRules` no longer takes an instant it
  projects through `APP_TIME_ZONE` — it takes the CLUB's already-resolved
  calendar day, so the `FROZEN_NOW` fixture this file used to pass is gone
  entirely rather than converted. At the frozen instant the club's day is 1 July
  for the persisted `Pacific/Auckland` and 30 June for the environment's
  `America/Denver`, so the two remain distinguishable; the booking-date cases
  below carry no validity window at all, so either day serves them.
*/
const CLUB_TODAY = requireCalendarDate("2026-07-01");

const BASE_PROMO: PromoRuleSubject = {
  id: "promo-1",
  active: true,
  validFrom: null,
  validUntil: null,
  bookingStartFrom: null,
  bookingStartUntil: null,
  membersOnly: false,
  maxRedemptionsTotal: null,
  maxUniqueMembersTotal: null,
  maxUsesPerMember: null,
  currentRedemptions: 0,
  type: "PERCENTAGE",
  lifetimeFreeNightsCap: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  persistClubZone("Pacific/Auckland");
});

describe("PREMISE: the environment is behind Greenwich, so a stored day projected through it moves", () => {
  it("is pinned to America/Denver, and a UTC-midnight @db.Date reads a day early there", () => {
    expect(APP_TIME_ZONE).toBe(ENVIRONMENT_ZONE);
    expect(
      new Intl.DateTimeFormat("en-CA", { timeZone: ENVIRONMENT_ZONE }).format(
        storedDay("2026-08-01"),
      ),
    ).toBe("2026-07-31");
    // Without this leg every assertion below would pass just as well with the
    // projection left in, which is the false green the contract names.
    expect(
      new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(
        storedDay("2026-08-01"),
      ),
    ).toBe("2026-08-01");
  });
});

describe("the booking-date window compares two STORED calendar days, and takes no zone", () => {
  const promo: PromoRuleSubject = {
    ...BASE_PROMO,
    bookingStartFrom: storedDay("2026-08-01"),
    bookingStartUntil: storedDay("2026-08-10"),
  };

  it("accepts a booking starting on the promotion's FIRST valid day", () => {
    // THE LIVE DEFECT. Before #3123 the check-in was projected into
    // America/Denver and read "2026-07-31", which is lexically before the
    // zone-free "2026-08-01" the window itself was read as — so the member was
    // told their booking dates were outside a window they were exactly inside.
    expect(
      validatePromoCodeRules(
        promo,
        { memberId: "member-1", bookingCheckIn: storedDay("2026-08-01") },
        CLUB_TODAY,
      ),
    ).toBeNull();
  });

  it("still refuses the day before the window opens", () => {
    expect(
      validatePromoCodeRules(
        promo,
        { memberId: "member-1", bookingCheckIn: storedDay("2026-07-31") },
        CLUB_TODAY,
      ),
    ).toBe("This promo code is not valid for your booking dates");
  });

  it("accepts the last day inside the exclusive upper bound, and refuses the bound itself", () => {
    // The upper comparison is `>=`, so 2026-08-09 is in and 2026-08-10 is out.
    // Projected through Denver both slid a day earlier, which let a booking ON
    // the excluded bound through.
    expect(
      validatePromoCodeRules(
        promo,
        { memberId: "member-1", bookingCheckIn: storedDay("2026-08-09") },
        CLUB_TODAY,
      ),
    ).toBeNull();
    expect(
      validatePromoCodeRules(
        promo,
        { memberId: "member-1", bookingCheckIn: storedDay("2026-08-10") },
        CLUB_TODAY,
      ),
    ).toBe("This promo code is not valid for your booking dates");
  });
});

describe("an assigned promotion's validity window is judged in the club's PERSISTED zone", () => {
  function assignmentFor(overrides: Record<string, unknown>) {
    return [
      {
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        promoCode: {
          id: "promo-1",
          code: "WINDOW",
          description: null,
          type: "PERCENTAGE",
          percentOff: 10,
          valueCents: null,
          freeNightsPerIndividual: null,
          lifetimeFreeNightsCap: null,
          fixedNightlyPriceCents: null,
          fixedNightlyMode: null,
          active: true,
          archivedAt: null,
          validFrom: null,
          validUntil: null,
          bookingStartFrom: null,
          bookingStartUntil: null,
          assignedMembersOnlyOwnNights: true,
          maxRedemptionsTotal: null,
          currentRedemptions: 0,
          maxUsesPerMember: null,
          allocations: [],
          ...overrides,
        },
      },
    ];
  }

  it("a promotion opening today at the club is available, though the container is still on yesterday", async () => {
    // The frozen clock is 2026-07-01T00:00:00.000Z: 1 July in Auckland, 30 June
    // in Denver. A window opening on 1 July is therefore OPEN for the club and
    // not yet open for the container.
    persistClubZone("Pacific/Auckland");
    mockPromoCodeAssignmentFindMany.mockResolvedValue(
      assignmentFor({ validFrom: storedDay("2026-07-01") }),
    );

    const [summary] = await getAssignedPromoCodeSummariesForMember("member-1");

    expect(summary.statusReason).toBe("Available to member");
    expect(summary.visibleToMember).toBe(true);
  });

  it("follows the persisted zone when it MOVES — kills a hard-coded Pacific/Auckland", async () => {
    mockPromoCodeAssignmentFindMany.mockResolvedValue(
      assignmentFor({ validFrom: storedDay("2026-07-01") }),
    );

    // UTC+14: already 1 July, so the window is open.
    persistClubZone("Pacific/Kiritimati");
    const [ahead] = await getAssignedPromoCodeSummariesForMember("member-1");
    expect(ahead.statusReason).toBe("Available to member");

    // UTC-11: still 30 June, so the same promotion is not valid yet.
    persistClubZone("Pacific/Pago_Pago");
    const [behind] = await getAssignedPromoCodeSummariesForMember("member-1");
    expect(behind.statusReason).toBe("Not valid yet");
  });

  it("expires on the club's day, not the container's", async () => {
    mockPromoCodeAssignmentFindMany.mockResolvedValue(
      assignmentFor({ validUntil: storedDay("2026-06-30") }),
    );

    // Auckland is on 1 July, so a window that closed on 30 June has expired.
    persistClubZone("Pacific/Auckland");
    const [club] = await getAssignedPromoCodeSummariesForMember("member-1");
    expect(club.statusReason).toBe("Expired");

    // A club actually on the container's day is still inside it.
    persistClubZone("America/Denver");
    const [sameAsHost] =
      await getAssignedPromoCodeSummariesForMember("member-1");
    expect(sameAsHost.statusReason).toBe("Available to member");
  });
});
