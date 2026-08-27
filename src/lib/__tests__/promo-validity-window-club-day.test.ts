import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3123 — THE PROMOTION'S VALIDITY WINDOW IS JUDGED ON THE CLUB'S DAY, AND THE
 * CLUB'S DAY NEVER REACHES THIS FUNCTION FROM INSIDE A LOCK.
 *
 * Two claims, and they are separate failures.
 *
 * ## 1. The money claim
 *
 * `validatePromoCodeRules` decided whether a promotion was live by projecting a
 * real instant through `APP_TIME_ZONE` — the CONTAINER's zone — and comparing
 * the result against `PromoCode.validFrom` / `validUntil`, which are `@db.Date`
 * columns read zone-free. For any deployment whose configured club zone differs
 * from its container's that judged the window in the wrong calendar, by up to a
 * day at each edge: a member could be refused a discount their club's own
 * promotion was already offering, or handed one it had already withdrawn.
 * `INV-CONFIG-002` says the persisted `ClubTimeSettings.timeZone` is the
 * authority.
 *
 * ## 2. The lock claim, which is why the fix is a parameter
 *
 * The fix is NOT "read the club's zone here". `validatePromoCodeRules` is
 * synchronous and pure; its async boundary is
 * `validateAndCalculatePromoDiscount`, and four of that function's ten call
 * sites invoke it with `{ db: tx }` from inside an open interactive transaction
 * holding `pg_advisory_xact_lock(1)`, the per-lodge capacity key and a
 * `FOR UPDATE` lock on the promo row — `booking-create-promo.ts`,
 * `booking-date-modification-service.ts`, `booking-guest-removal-service.ts`
 * and `api/bookings/[id]/guests/route.ts`. `INV-LOCK-004` names the club
 * timezone as one of only two reads that cannot take a transaction client, so a
 * `clubTimeSettings.findUnique` in here would take a second pooled connection
 * under those locks AND escape the transaction's own client — the four-way
 * mistake `diagnostics/tools/packs/booking-evidence.ts` records, and the reason
 * `booking-create.ts` says in as many words "Read outside every transaction."
 *
 * So the second block below asserts a NEGATIVE: driven exactly as a locked
 * caller drives it, this function touches the global client zero times.
 *
 * ## What makes this file discriminating
 *
 * `APP_TIME_ZONE` is pinned to `Pacific/Auckland` — both the answer the replaced
 * default gave AND this codebase's own fallback, so it is the one value a wrong
 * fix could still pass under. Every club day below is stated explicitly, which
 * is the point: the day is the caller's answer now, not this module's.
 */

// Inlined literals: `vi.mock` factories hoist above every const in this file.
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "Pacific/Auckland",
  APP_LOCALE: "en-NZ",
}));

const globalPrisma = vi.hoisted(() => ({
  promoRedemptionAllocation: {
    aggregate: vi.fn(),
    count: vi.fn(),
    findMany: vi.fn(),
  },
  promoCodeAssignment: { findMany: vi.fn() },
  promoCodeLodge: { findMany: vi.fn() },
  // Present, and deliberately so: `getClubTimeZone` is fail-soft on a MISSING
  // delegate, so leaving it off would make "nobody read the zone" true for the
  // wrong reason. It is here, it works, and the assertion is that nothing calls
  // it.
  clubTimeSettings: { findUnique: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: globalPrisma }));

import { APP_TIME_ZONE } from "@/config/operational";
import { requireCalendarDate } from "@/lib/club-time";
import {
  validateAndCalculatePromoDiscount,
  validatePromoCodeRules,
  type PromoApplicationSubject,
  type PromoRuleSubject,
} from "@/lib/promo";

/** A `@db.Date` value as Prisma hands it back: the calendar day at UTC midnight. */
function storedDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

const BASE_RULE_SUBJECT: PromoRuleSubject = {
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

const APPLICATION_SUBJECT: PromoApplicationSubject = {
  id: "promo-1",
  active: true,
  validFrom: storedDay("2026-07-01"),
  validUntil: storedDay("2026-07-31"),
  maxRedemptionsTotal: null,
  currentRedemptions: 0,
  membersOnly: false,
  maxUsesPerMember: null,
  maxUniqueMembersTotal: null,
  type: "PERCENTAGE",
  valueCents: null,
  percentOff: 20,
  freeNightsPerIndividual: null,
  lifetimeFreeNightsCap: null,
  fixedNightlyPriceCents: null,
  fixedNightlyMode: null,
  maxGuestsPerBooking: null,
  maxNightlyValueCents: null,
  memberGuestsOnly: false,
};

const BOOKING_DETAILS = {
  memberId: "member-1",
  bookingCheckIn: storedDay("2026-09-01"),
  totalPriceCents: 10_000,
  guests: [
    { memberId: "member-1", isMember: true, perNightRates: [5_000, 5_000] },
  ],
};

/**
 * A transaction client shaped exactly as the four locked callers hand one in:
 * `{ db: tx }`, where `tx` answers every usage read this function makes.
 */
function makeTx() {
  return {
    promoRedemptionAllocation: {
      aggregate: vi.fn(async () => ({ _sum: { freeNightsUsed: 0 } })),
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
    },
    promoCodeAssignment: { findMany: vi.fn(async () => []) },
    promoCodeLodge: { findMany: vi.fn(async () => []) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  globalPrisma.clubTimeSettings.findUnique.mockResolvedValue({
    timeZone: "America/Denver",
    updatedByMemberId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
});

describe("the validity window is judged on the day the caller supplies (#3123)", () => {
  it("PREMISE: the container's zone is the one a wrong fix would fall back to", () => {
    // Named so a later reader can see that this file's negative result is not
    // an accident of the two zones agreeing.
    expect(APP_TIME_ZONE).toBe("Pacific/Auckland");
  });

  it("the promotion's FIRST valid day is in, and the day before it is out", () => {
    const promo: PromoRuleSubject = {
      ...BASE_RULE_SUBJECT,
      validFrom: storedDay("2026-07-01"),
    };
    expect(
      validatePromoCodeRules(
        promo,
        { memberId: "member-1" },
        requireCalendarDate("2026-07-01"),
      ),
    ).toBeNull();
    expect(
      validatePromoCodeRules(
        promo,
        { memberId: "member-1" },
        requireCalendarDate("2026-06-30"),
      ),
    ).toBe("This promo code is not yet valid");
  });

  it("`validUntil` is inclusive: its own day is in, the next day is expired", () => {
    const promo: PromoRuleSubject = {
      ...BASE_RULE_SUBJECT,
      validUntil: storedDay("2026-07-31"),
    };
    expect(
      validatePromoCodeRules(
        promo,
        { memberId: "member-1" },
        requireCalendarDate("2026-07-31"),
      ),
    ).toBeNull();
    expect(
      validatePromoCodeRules(
        promo,
        { memberId: "member-1" },
        requireCalendarDate("2026-08-01"),
      ),
    ).toBe("This promo code has expired");
  });

  it("MONEY: the same booking is discounted or not, purely on which club day it is", async () => {
    // The two clubs' days at the frozen instant. On 30 June the promotion has
    // not opened; on 1 July it has, and the member's $100 booking is $20
    // cheaper. Both calls are identical apart from the day.
    const refused = await validateAndCalculatePromoDiscount(
      APPLICATION_SUBJECT,
      BOOKING_DETAILS,
      null,
      { db: makeTx() as never, todayAtClub: requireCalendarDate("2026-06-30") },
    );
    expect(refused.error).toBe("This promo code is not yet valid");
    expect(refused.discount).toBeUndefined();

    const allowed = await validateAndCalculatePromoDiscount(
      APPLICATION_SUBJECT,
      BOOKING_DETAILS,
      null,
      { db: makeTx() as never, todayAtClub: requireCalendarDate("2026-07-01") },
    );
    expect(allowed.error).toBeUndefined();
    expect(allowed.discount?.discountCents).toBe(2_000);
  });
});

describe("INV-LOCK-004: nothing here reads the club's timezone (#3123)", () => {
  it("performs ZERO clubTimeSettings reads when driven as a locked caller drives it", async () => {
    // The four transactional callers reach this line holding
    // `pg_advisory_xact_lock(1)`, the per-lodge capacity key and a `FOR UPDATE`
    // lock on the promo row. A settings read here would take a SECOND pooled
    // connection under all three, and would read outside the transaction's own
    // snapshot. The day arrives as a value instead, so there is nothing to read.
    const tx = makeTx();
    const result = await validateAndCalculatePromoDiscount(
      APPLICATION_SUBJECT,
      BOOKING_DETAILS,
      null,
      { db: tx as never, todayAtClub: requireCalendarDate("2026-07-15") },
    );

    expect(result.discount?.discountCents).toBe(2_000);
    expect(globalPrisma.clubTimeSettings.findUnique).not.toHaveBeenCalled();
  });

  it("NOT VACUOUS: the usage reads really did go through the transaction client", async () => {
    // Without this, a function that had stopped reading anything at all — or a
    // mock that silently answered nothing — would satisfy the assertion above
    // perfectly.
    const tx = makeTx();
    await validateAndCalculatePromoDiscount(
      APPLICATION_SUBJECT,
      BOOKING_DETAILS,
      null,
      { db: tx as never, todayAtClub: requireCalendarDate("2026-07-15") },
    );

    expect(tx.promoRedemptionAllocation.count).toHaveBeenCalled();
    expect(globalPrisma.promoRedemptionAllocation.count).not.toHaveBeenCalled();
  });

  it("takes no default: the day cannot be omitted at a call site", () => {
    // A TYPE-level assertion, never executed. If `todayAtClub` regains a default
    // — or the options object goes back to being optional — this stops being an
    // error and `tsc` fails the build, which is the whole mechanism that stopped
    // ten call sites from quietly keeping the container's answer.
    const omitted = () => validateAndCalculatePromoDiscount(
      APPLICATION_SUBJECT,
      BOOKING_DETAILS,
      null,
      // @ts-expect-error `todayAtClub` is REQUIRED (#3123, INV-LOCK-004).
      { db: makeTx() as never },
    );
    expect(typeof omitted).toBe("function");
  });
});
