import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #2390 — a booking edit must never be refused, and never bill back, because a
// promotion ran out of uses.
//
// Owner decision (31 Jul 2026): the edit always succeeds; everyone already
// benefiting keeps their discount; newly-added people are priced normally and
// told so at the moment of the edit.
//
// Before this, all four reprice paths took the promotion's caps as a yes/no
// question. A member who added a guest to a booking on a nearly-full promotion
// got `application.error`, which each path turns into
// `deletePromoRedemptionAndAdjustCount` — the discount stripped from EVERYONE on
// the booking, including the people who already had it, and the difference
// billed straight back.

vi.mock("@/lib/prisma", () => ({
  prisma: {
    promoRedemptionAllocation: {
      aggregate: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
    },
    member: { findMany: vi.fn() },
  },
}));

import { applyPromoCodeChanges } from "../booking-modify-plan";
import { recalculateBookingPromo } from "../booking-guest-removal-service";
import { buildBookingHistoryItems } from "../booking-history";
import {
  bookingModificationSummaryRows,
} from "@/lib/booking-money-lines";
import {
  describePromoCapCoverage,
  joinNames,
  promoCapCoverageMessage,
} from "../promo-cap-coverage";
import {
  trimPromoBeneficiariesToCaps,
  validateAndCalculatePromoDiscount,
  validatePromoCodeRules,
  type PromoApplicationSubject,
} from "../promo";
import { requireCalendarDate } from "@/lib/club-time";

// #3123 — the transaction-bound promo and refund helpers take the CLUB's
// calendar day as a REQUIRED value now: the club timezone is one of the two
// reads that cannot happen under a lock (`INV-LOCK-004`), so it is resolved by
// the caller and threaded in. These call sites are not about a date boundary,
// so the frozen clock's own club day is used.
const CLUB_TODAY_FOR_TEST = requireCalendarDate("2026-07-01");

const ANN = "member-ann";
const BOB = "member-bob";
const CAL = "member-cal";

// --- The rule, as pure arithmetic --------------------------------------------

function trim(overrides: Partial<Parameters<typeof trimPromoBeneficiariesToCaps>[0]> = {}) {
  return trimPromoBeneficiariesToCaps({
    beneficiaryMemberIds: [ANN, BOB, CAL],
    protectedMemberIds: new Set([ANN]),
    exhaustedMemberIds: new Set(),
    existingUniqueBeneficiaryMemberIds: new Set(),
    redemptionsHeldElsewhere: 0,
    maxRedemptionsTotal: null,
    uniqueMembersUsed: 0,
    maxUniqueMembersTotal: null,
    ...overrides,
  });
}

describe("trimPromoBeneficiariesToCaps — who a capped promotion still covers", () => {
  it("covers everybody when no cap is set", () => {
    expect(trim()).toEqual({
      coveredMemberIds: [ANN, BOB, CAL],
      retainedMemberIds: [ANN],
      excludedMemberIds: [],
    });
  });

  it("keeps the people already benefiting and leaves out only the newcomers", () => {
    // Two slots; Ann already holds one. Bob fits, Cal does not.
    expect(trim({ maxRedemptionsTotal: 2 })).toEqual({
      coveredMemberIds: [ANN, BOB],
      retainedMemberIds: [ANN],
      excludedMemberIds: [CAL],
    });
  });

  it("keeps EXISTING beneficiaries even when they alone exceed the cap", () => {
    // Decision 5: an admin lowered the cap to one after two people were already
    // given the discount. Taking it back would bill a member for a promise the
    // club already made, so both are kept — and no newcomer is admitted while
    // the code is over its cap.
    expect(
      trim({
        protectedMemberIds: new Set([ANN, BOB]),
        maxRedemptionsTotal: 1,
      })
    ).toEqual({
      coveredMemberIds: [ANN, BOB],
      retainedMemberIds: [ANN, BOB],
      excludedMemberIds: [CAL],
    });
  });

  it("counts slots other bookings hold against the allowance", () => {
    expect(
      trim({ maxRedemptionsTotal: 3, redemptionsHeldElsewhere: 2 })
    ).toEqual({
      coveredMemberIds: [ANN],
      retainedMemberIds: [ANN],
      excludedMemberIds: [BOB, CAL],
    });
  });

  it("never lets a newcomer take a slot ahead of somebody who already holds one", () => {
    // Ann is listed LAST but is the one already benefiting. Processing in list
    // order would hand her slot to Bob and then keep her anyway, putting the
    // code two over its cap instead of one.
    expect(
      trim({
        beneficiaryMemberIds: [BOB, CAL, ANN],
        protectedMemberIds: new Set([ANN]),
        maxRedemptionsTotal: 1,
      })
    ).toEqual({
      coveredMemberIds: [ANN],
      retainedMemberIds: [ANN],
      excludedMemberIds: [BOB, CAL],
    });
  });

  it("admits candidates in the order the promotion applies to them", () => {
    // The caller hands the list over already ordered by
    // `selectPromoDiscountGuests` — most expensive stay first — and this
    // function spends the allowance straight down that list. Ordering is the
    // caller's job precisely so the trim and the pricing cannot disagree about
    // who comes first.
    expect(
      trim({
        beneficiaryMemberIds: [CAL, BOB],
        protectedMemberIds: new Set(),
        maxRedemptionsTotal: 1,
      })
    ).toEqual({
      coveredMemberIds: [CAL],
      retainedMemberIds: [],
      excludedMemberIds: [BOB],
    });
  });

  it("applies the unique-members cap only to members who are new to the code", () => {
    // The two unique-member slots are used, by Ann and Bob. Neither is new, so
    // neither is turned away; Cal would be a third distinct member and is.
    expect(
      trim({
        protectedMemberIds: new Set([ANN]),
        existingUniqueBeneficiaryMemberIds: new Set([ANN, BOB]),
        uniqueMembersUsed: 2,
        maxUniqueMembersTotal: 2,
      })
    ).toEqual({
      coveredMemberIds: [ANN, BOB],
      retainedMemberIds: [ANN],
      excludedMemberIds: [CAL],
    });
  });

  it("leaves out a newcomer who has personally used the code up", () => {
    expect(trim({ exhaustedMemberIds: new Set([BOB]) })).toEqual({
      coveredMemberIds: [ANN, CAL],
      retainedMemberIds: [ANN],
      excludedMemberIds: [BOB],
    });
  });

  it("still keeps a PROTECTED member who has used their own allowance up", () => {
    expect(
      trim({
        protectedMemberIds: new Set([ANN]),
        exhaustedMemberIds: new Set([ANN]),
      })
    ).toEqual({
      coveredMemberIds: [ANN, BOB, CAL],
      retainedMemberIds: [ANN],
      excludedMemberIds: [],
    });
  });

  it("returns nobody when nobody fits and nobody is protected", () => {
    expect(
      trim({
        protectedMemberIds: new Set(),
        maxRedemptionsTotal: 1,
        redemptionsHeldElsewhere: 1,
      })
    ).toEqual({
      coveredMemberIds: [],
      retainedMemberIds: [],
      excludedMemberIds: [ANN, BOB, CAL],
    });
  });
});

describe("validatePromoCodeRules stops refusing once the set has been trimmed", () => {
  const SUBJECT = {
    id: "promo-1",
    active: true,
    validFrom: null,
    validUntil: null,
    maxRedemptionsTotal: 1,
    currentRedemptions: 5,
    membersOnly: false,
    maxUsesPerMember: 1,
    maxUniqueMembersTotal: 1,
  };
  const booking = { memberId: ANN };

  it("still refuses a fresh application on a full code", () => {
    expect(
      validatePromoCodeRules(SUBJECT, booking, CLUB_TODAY_FOR_TEST, {
        requestedRedemptionCount: 1,
        requestedNewUniqueMemberCount: 1,
        uniqueMembersUsed: 1,
        memberRedemptionCount: 1,
      })
    ).toBe("This promo code has reached its maximum number of uses");
  });

  it("refuses none of the three set-size caps on a reprice", () => {
    // Each of these numbers would have refused on its own. The trim has already
    // decided who is covered, so refusing here could only take the discount off
    // somebody who already had it.
    expect(
      validatePromoCodeRules(SUBJECT, booking, CLUB_TODAY_FOR_TEST, {
        requestedRedemptionCount: 1,
        requestedNewUniqueMemberCount: 1,
        uniqueMembersUsed: 1,
        memberRedemptionCount: 1,
        capsResolvedByBeneficiaryTrim: true,
      })
    ).toBeNull();
  });

  it("does not suppress anything else — an expired code still fails", () => {
    expect(
      validatePromoCodeRules(
        { ...SUBJECT, active: false },
        booking,
        CLUB_TODAY_FOR_TEST,
        { capsResolvedByBeneficiaryTrim: true }
      )
    ).toBe("This promo code is no longer active");
  });
});

// --- The choke point all four reprice paths share ----------------------------

function promoSubject(
  overrides: Partial<PromoApplicationSubject> = {}
): PromoApplicationSubject {
  return {
    id: "promo-1",
    active: true,
    validFrom: null,
    validUntil: null,
    maxRedemptionsTotal: 2,
    currentRedemptions: 1,
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
    assignedMembersOnlyOwnNights: true,
    lodges: [],
    ...overrides,
  };
}

const THREE_MEMBER_GUESTS = [ANN, BOB, CAL].map((memberId) => ({
  memberId,
  isMember: true,
  perNightRates: [5000, 5000],
}));

const BOOKING_DETAILS = {
  memberId: ANN,
  totalPriceCents: 30000,
  guests: THREE_MEMBER_GUESTS,
};

/**
 * A usage client for the promo module.
 *
 * `bookingBeneficiaries` is who already holds a benefit ON the booking being
 * repriced — the people #2390 protects. `otherBeneficiaries` is who holds one
 * on some OTHER booking, which is what the unique-members cap counts.
 */
function usageDb(
  options: {
    bookingBeneficiaries?: string[];
    otherBeneficiaries?: string[];
    ownAllocationRows?: number;
    memberRedemptionCounts?: Record<string, number>;
    /** Free nights this member holds on OTHER bookings. */
    memberFreeNightsUsed?: Record<string, number>;
    /** Free nights this booking's own allocation rows already granted. */
    bookingFreeNights?: Record<string, number>;
  } = {}
) {
  const findManyWheres: Record<string, unknown>[] = [];
  return {
    findManyWheres,
    db: {
      promoRedemptionAllocation: {
        count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          if (typeof where.bookingId === "string") {
            return options.ownAllocationRows ?? options.bookingBeneficiaries?.length ?? 0;
          }
          const memberId = where.memberId;
          return typeof memberId === "string"
            ? options.memberRedemptionCounts?.[memberId] ?? 0
            : 0;
        }),
        aggregate: vi.fn(async ({ where }: { where: Record<string, unknown> }) => ({
          _sum: {
            freeNightsUsed:
              typeof where.memberId === "string"
                ? options.memberFreeNightsUsed?.[where.memberId] ?? 0
                : 0,
          },
        })),
        findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          findManyWheres.push(where);
          const ids =
            typeof where.bookingId === "string"
              ? options.bookingBeneficiaries ?? []
              : options.otherBeneficiaries ?? [];
          return ids.map((memberId) => ({
            memberId,
            freeNightsUsed: options.bookingFreeNights?.[memberId] ?? 0,
          }));
        }),
      },
      member: {
        findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.map((id) => ({
            id,
            firstName: id === ANN ? "Ann" : id === BOB ? "Bob" : "Cal",
            lastName: "Hughes",
          }))
        ),
      },
    },
  };
}

const ASSIGNED = [ANN, BOB, CAL];

describe("validateAndCalculatePromoDiscount — partial coverage on a reprice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("without the option, a reprice that outgrows the cap still refuses (unchanged)", async () => {
    const { db } = usageDb({ bookingBeneficiaries: [ANN] });

    const application = await validateAndCalculatePromoDiscount(
      promoSubject(),
      BOOKING_DETAILS,
      ASSIGNED,
      {
      todayAtClub: CLUB_TODAY_FOR_TEST, excludeBookingId: "booking-1", db: db as never }
    );

    // Two slots, one held by this booking: 1 - 1 + 3 = 3 > 2.
    expect(application.error).toBe(
      "This promo code has reached its maximum number of uses"
    );
  });

  it("covers the people who already had it, prices the newcomer normally", async () => {
    const { db } = usageDb({ bookingBeneficiaries: [ANN] });

    const application = await validateAndCalculatePromoDiscount(
      promoSubject(),
      BOOKING_DETAILS,
      ASSIGNED,
      {
      todayAtClub: CLUB_TODAY_FOR_TEST,
        excludeBookingId: "booking-1",
        db: db as never,
        capOverflow: "coverExisting",
      }
    );

    expect(application.error).toBeUndefined();
    expect(application.capCoverage).toEqual({
      coveredMemberIds: [ANN, BOB],
      retainedMemberIds: [ANN],
      excludedMemberIds: [CAL],
    });
    // 20% of Ann's and Bob's $100 each — NOT Cal's.
    expect(application.discount?.discountCents).toBe(4000);
    expect(application.discount?.allocations.map((a) => a.memberId).sort()).toEqual(
      [ANN, BOB]
    );
    expect(application.beneficiaryMemberIds).toEqual([ANN, BOB]);
  });

  it("leaves capCoverage unset when the promotion still reaches everybody", async () => {
    const { db } = usageDb({ bookingBeneficiaries: [ANN] });

    const application = await validateAndCalculatePromoDiscount(
      promoSubject({ maxRedemptionsTotal: null }),
      BOOKING_DETAILS,
      ASSIGNED,
      {
      todayAtClub: CLUB_TODAY_FOR_TEST,
        excludeBookingId: "booking-1",
        db: db as never,
        capOverflow: "coverExisting",
      }
    );

    expect(application.capCoverage).toBeUndefined();
    expect(application.discount?.discountCents).toBe(6000);
  });

  it("keeps a discount the club already gave when an admin lowers the cap", async () => {
    // Decision 5. Ann and Bob both already benefit on this booking; the cap is
    // now one. Both keep it, Cal does not get it, and nobody is billed back.
    const { db } = usageDb({ bookingBeneficiaries: [ANN, BOB], ownAllocationRows: 2 });

    const application = await validateAndCalculatePromoDiscount(
      promoSubject({ maxRedemptionsTotal: 1, currentRedemptions: 2 }),
      BOOKING_DETAILS,
      ASSIGNED,
      {
      todayAtClub: CLUB_TODAY_FOR_TEST,
        excludeBookingId: "booking-1",
        db: db as never,
        capOverflow: "coverExisting",
      }
    );

    expect(application.error).toBeUndefined();
    expect(application.capCoverage?.coveredMemberIds).toEqual([ANN, BOB]);
    expect(application.discount?.discountCents).toBe(4000);
  });

  it("keeps a benefiting member whose own per-member cap was lowered under them", async () => {
    // Decision 5 again, but through the per-member cap rather than the total.
    // Ann has one use elsewhere and the cap is now one, so the exhausted-member
    // filter that runs BEFORE the trim would drop her — and she is one of the
    // people already benefiting on this booking. Dropping her would bill her
    // back for a discount the club already gave.
    const { db } = usageDb({
      bookingBeneficiaries: [ANN],
      memberRedemptionCounts: { [ANN]: 1 },
    });

    const application = await validateAndCalculatePromoDiscount(
      promoSubject({ maxRedemptionsTotal: null, maxUsesPerMember: 1 }),
      BOOKING_DETAILS,
      ASSIGNED,
      {
      todayAtClub: CLUB_TODAY_FOR_TEST,
        excludeBookingId: "booking-1",
        db: db as never,
        capOverflow: "coverExisting",
      }
    );

    expect(application.error).toBeUndefined();
    expect(application.beneficiaryMemberIds).toEqual([ANN, BOB, CAL]);
    expect(application.discount?.discountCents).toBe(6000);
    expect(application.capCoverage).toBeUndefined();
  });

  it("refuses cleanly — not silently for everybody — when nobody can be covered", async () => {
    // Nobody on this booking holds a benefit and the code is exhausted
    // elsewhere. An empty beneficiary list reads as "unassigned promo"
    // downstream, so without the explicit guard the code would be priced for
    // every guest on the booking, cap and all.
    const { db } = usageDb({ bookingBeneficiaries: [], ownAllocationRows: 0 });

    const application = await validateAndCalculatePromoDiscount(
      promoSubject({ maxRedemptionsTotal: 1, currentRedemptions: 1 }),
      BOOKING_DETAILS,
      ASSIGNED,
      {
      todayAtClub: CLUB_TODAY_FOR_TEST,
        excludeBookingId: "booking-1",
        db: db as never,
        capOverflow: "coverExisting",
      }
    );

    expect(application.error).toBe(
      "This promo code has reached its maximum number of uses"
    );
    expect(application.discount).toBeUndefined();
  });

  it("reads the protected set from THIS booking's beneficial rows", async () => {
    const { db, findManyWheres } = usageDb({ bookingBeneficiaries: [ANN] });

    await validateAndCalculatePromoDiscount(
      promoSubject(),
      BOOKING_DETAILS,
      ASSIGNED,
      {
      todayAtClub: CLUB_TODAY_FOR_TEST,
        excludeBookingId: "booking-1",
        db: db as never,
        capOverflow: "coverExisting",
      }
    );

    // Benefit-filtered, so a legacy all-zero row cannot buy protection.
    expect(findManyWheres).toContainEqual({
      promoCodeId: "promo-1",
      bookingId: "booking-1",
      OR: [
        { discountCents: { gt: 0 } },
        { priceAdjustmentCents: { not: 0 } },
        { freeNightsUsed: { gt: 0 } },
      ],
    });
  });

  it("does not go looking for a protected set on a NEW booking", async () => {
    const { db, findManyWheres } = usageDb();

    await validateAndCalculatePromoDiscount(
      promoSubject({ maxRedemptionsTotal: null }),
      BOOKING_DETAILS,
      ASSIGNED,
      {
      todayAtClub: CLUB_TODAY_FOR_TEST, db: db as never, capOverflow: "coverExisting" }
    );

    expect(
      findManyWheres.filter((where) => typeof where.bookingId === "string")
    ).toEqual([]);
  });

  it("splits on the unique-members cap too", async () => {
    const { db } = usageDb({
      bookingBeneficiaries: [ANN],
      otherBeneficiaries: [ANN, BOB],
    });

    const application = await validateAndCalculatePromoDiscount(
      promoSubject({ maxRedemptionsTotal: null, maxUniqueMembersTotal: 2 }),
      BOOKING_DETAILS,
      ASSIGNED,
      {
      todayAtClub: CLUB_TODAY_FOR_TEST,
        excludeBookingId: "booking-1",
        db: db as never,
        capOverflow: "coverExisting",
      }
    );

    // Ann and Bob already count among the two unique members; Cal would be a
    // third, so he is priced normally.
    expect(application.capCoverage).toEqual({
      coveredMemberIds: [ANN, BOB],
      retainedMemberIds: [ANN],
      excludedMemberIds: [CAL],
    });
    expect(application.discount?.discountCents).toBe(4000);
  });
});

// --- The guest cap runs BEFORE protection could be consulted -----------------
//
// `maxGuestsPerBooking` is spent while the beneficiary list is being built:
// eligible guests are ordered most-expensive-stay first and cut to the cap.
// Every protection check downstream reads that list — so a protected member the
// cut removed is invisible to all of them, and the edit reads as "they are not
// a beneficiary any more" rather than "they must be kept". The fix is to let
// protection win a slot inside the cut itself.

describe("a protected member cannot be cut by maxGuestsPerBooking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Ann is on the booking and already has the discount; the guest she adds has
  // the more expensive stay. One slot only.
  const ANN_CHEAP_CAL_EXPENSIVE = {
    memberId: ANN,
    totalPriceCents: 24000,
    guests: [
      { memberId: ANN, isMember: true, perNightRates: [3000, 3000] },
      { memberId: CAL, isMember: true, perNightRates: [9000, 9000] },
    ],
  };

  it("bills nobody back when the newcomer has used the code up (the money bug)", async () => {
    // The precise failure #2390 exists to prevent, with no over-cap
    // precondition at all. Cut to one guest by stay cost, Ann disappears and
    // Cal is then dropped as exhausted, leaving nobody — which every reprice
    // path turns into `deletePromoRedemptionAndAdjustCount`: Ann is billed back
    // a discount she already had, and the panel tells her the code is no longer
    // valid.
    const { db } = usageDb({
      bookingBeneficiaries: [ANN],
      memberRedemptionCounts: { [CAL]: 1 },
    });

    const application = await validateAndCalculatePromoDiscount(
      promoSubject({
        maxRedemptionsTotal: null,
        maxUsesPerMember: 1,
        maxGuestsPerBooking: 1,
      }),
      ANN_CHEAP_CAL_EXPENSIVE,
      [ANN, CAL],
      {
      todayAtClub: CLUB_TODAY_FOR_TEST,
        excludeBookingId: "booking-1",
        db: db as never,
        capOverflow: "coverExisting",
      }
    );

    expect(application.error).toBeUndefined();
    // 20% of Ann's $60 stay. Exactly what she had before the edit.
    expect(application.discount?.discountCents).toBe(1200);
    expect(application.beneficiaryMemberIds).toEqual([ANN]);
    expect(application.capCoverage).toEqual({
      coveredMemberIds: [ANN],
      retainedMemberIds: [ANN],
      excludedMemberIds: [CAL],
    });
  });

  it("does not hand the slot to the newcomer just because their stay costs more", async () => {
    // The milder variant, live on any code with a guest cap and no per-member
    // cap: the newcomer simply takes the slot, which inverts the rule — the
    // person who already had the discount loses it to the person who did not.
    const { db } = usageDb({ bookingBeneficiaries: [ANN] });

    const application = await validateAndCalculatePromoDiscount(
      promoSubject({ maxRedemptionsTotal: null, maxGuestsPerBooking: 1 }),
      ANN_CHEAP_CAL_EXPENSIVE,
      [ANN, CAL],
      {
      todayAtClub: CLUB_TODAY_FOR_TEST,
        excludeBookingId: "booking-1",
        db: db as never,
        capOverflow: "coverExisting",
      }
    );

    expect(application.beneficiaryMemberIds).toEqual([ANN]);
    expect(application.discount?.allocations.map((a) => a.memberId)).toEqual([ANN]);
    // And Cal is NAMED, not silently priced at the normal rate: he is the
    // person the protection kept out, so the sentence has to account for him.
    expect(application.capCoverage?.excludedMemberIds).toEqual([CAL]);
  });

  it("still spends a guest cap on the most expensive stay when nobody is protected", async () => {
    // The ordering rule itself is unchanged — protection is the only thing that
    // outranks cost, and on a booking with no protected member the cap goes
    // where it is worth the most, exactly as it does at booking creation.
    const { db } = usageDb({ bookingBeneficiaries: [] });

    const application = await validateAndCalculatePromoDiscount(
      promoSubject({ maxRedemptionsTotal: null, maxGuestsPerBooking: 1 }),
      ANN_CHEAP_CAL_EXPENSIVE,
      [ANN, CAL],
      {
      todayAtClub: CLUB_TODAY_FOR_TEST,
        excludeBookingId: "booking-1",
        db: db as never,
        capOverflow: "coverExisting",
      }
    );

    expect(application.beneficiaryMemberIds).toEqual([CAL]);
    // 20% of Cal's $180 stay.
    expect(application.discount?.discountCents).toBe(3600);
    expect(application.capCoverage).toBeUndefined();
  });
});

// --- Nobody is left out without being told -----------------------------------

describe("a newcomer who has personally used the code up is NAMED, not just dropped", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("names the exhausted newcomer in the sentence the member reads", async () => {
    // The most commonly configured cap of the lot: one use per member. Bob
    // redeemed the code last winter, so he is priced at the normal rate — and
    // before this he was removed from the beneficiary list BEFORE the trim ran,
    // so he never reached the excluded list and the panel, the email and the
    // history all said nothing about him.
    const { db } = usageDb({
      bookingBeneficiaries: [ANN],
      memberRedemptionCounts: { [BOB]: 1 },
    });

    const application = await validateAndCalculatePromoDiscount(
      promoSubject({ maxRedemptionsTotal: null, maxUsesPerMember: 1 }),
      BOOKING_DETAILS,
      ASSIGNED,
      {
      todayAtClub: CLUB_TODAY_FOR_TEST,
        excludeBookingId: "booking-1",
        db: db as never,
        capOverflow: "coverExisting",
      }
    );

    expect(application.error).toBeUndefined();
    expect(application.capCoverage).toEqual({
      coveredMemberIds: [ANN, CAL],
      retainedMemberIds: [ANN],
      excludedMemberIds: [BOB],
    });
    // Ann and Cal only: 20% of $100 each.
    expect(application.discount?.discountCents).toBe(4000);
    expect(application.discount?.allocations.map((a) => a.memberId).sort()).toEqual(
      [ANN, CAL]
    );

    const notice = await describePromoCapCoverage(db as never, {
      promoCode: "SUMMER25",
      capCoverage: application.capCoverage,
    });
    expect(notice?.message).toContain("does not extend to Bob Hughes");
  });

  it("says so plainly when every linked member has used it up", async () => {
    // Nobody is protected and everybody is exhausted, so there is no discount
    // to keep. The refusal keeps its own words rather than borrowing the
    // total-uses message, because that is not what happened.
    const { db } = usageDb({
      bookingBeneficiaries: [],
      memberRedemptionCounts: { [ANN]: 1, [BOB]: 1, [CAL]: 1 },
    });

    const application = await validateAndCalculatePromoDiscount(
      promoSubject({ maxRedemptionsTotal: null, maxUsesPerMember: 1 }),
      BOOKING_DETAILS,
      ASSIGNED,
      {
      todayAtClub: CLUB_TODAY_FOR_TEST,
        excludeBookingId: "booking-1",
        db: db as never,
        capOverflow: "coverExisting",
      }
    );

    expect(application.error).toBe("All linked member guests have used this promo code");
    expect(application.discount).toBeUndefined();
  });
});

// --- A lowered lifetime cap is a budget, not a slot ---------------------------

describe("a protected member's free nights survive a lowered lifetime cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const FREE_NIGHTS_SUBJECT = promoSubject({
    type: "FREE_NIGHTS",
    percentOff: null,
    freeNightsPerIndividual: 2,
    lifetimeFreeNightsCap: 2,
    maxRedemptionsTotal: null,
  });

  const ANN_ONLY = {
    memberId: ANN,
    totalPriceCents: 10000,
    guests: [{ memberId: ANN, isMember: true, perNightRates: [5000, 5000] }],
  };

  it("keeps the nights this booking already gave her", async () => {
    // The cap was 4 and is now 2. Ann holds two nights on this booking and two
    // on another. Protecting her place in the beneficiary list is not enough:
    // the remaining-nights budget reads 2 - 2 = 0, she is awarded nothing, and
    // because she counts as COVERED there is no notice anywhere — roughly $100
    // simply disappears from her discount.
    const { db } = usageDb({
      bookingBeneficiaries: [ANN],
      bookingFreeNights: { [ANN]: 2 },
      memberFreeNightsUsed: { [ANN]: 2 },
    });

    const application = await validateAndCalculatePromoDiscount(
      FREE_NIGHTS_SUBJECT,
      ANN_ONLY,
      [ANN],
      {
      todayAtClub: CLUB_TODAY_FOR_TEST,
        excludeBookingId: "booking-1",
        db: db as never,
        capOverflow: "coverExisting",
      }
    );

    expect(application.error).toBeUndefined();
    expect(application.remainingFreeNightsByMemberId).toEqual({ [ANN]: 2 });
    expect(application.discount?.freeNightsUsed).toBe(2);
    expect(application.discount?.discountCents).toBe(10000);
  });

  it("gives a member nothing extra just because they were protected", async () => {
    // The floor can only hold somebody level with what they already had. Ann
    // holds ONE night here and has used one elsewhere against a cap of two, so
    // her budget stays at one — not two, and not one-plus-one.
    const { db } = usageDb({
      bookingBeneficiaries: [ANN],
      bookingFreeNights: { [ANN]: 1 },
      memberFreeNightsUsed: { [ANN]: 1 },
    });

    const application = await validateAndCalculatePromoDiscount(
      FREE_NIGHTS_SUBJECT,
      ANN_ONLY,
      [ANN],
      {
      todayAtClub: CLUB_TODAY_FOR_TEST,
        excludeBookingId: "booking-1",
        db: db as never,
        capOverflow: "coverExisting",
      }
    );

    expect(application.remainingFreeNightsByMemberId).toEqual({ [ANN]: 1 });
    expect(application.discount?.freeNightsUsed).toBe(1);
  });

  it("leaves a member who never had free nights here at the cap's answer", async () => {
    // Bob is on the booking but holds no allocation of his own, so nothing is
    // floored for him: an exhausted newcomer is still excluded and named.
    const { db } = usageDb({
      bookingBeneficiaries: [ANN],
      bookingFreeNights: { [ANN]: 2 },
      memberFreeNightsUsed: { [ANN]: 2, [BOB]: 2 },
    });

    const application = await validateAndCalculatePromoDiscount(
      FREE_NIGHTS_SUBJECT,
      {
        memberId: ANN,
        totalPriceCents: 20000,
        guests: [
          { memberId: ANN, isMember: true, perNightRates: [5000, 5000] },
          { memberId: BOB, isMember: true, perNightRates: [5000, 5000] },
        ],
      },
      [ANN, BOB],
      {
      todayAtClub: CLUB_TODAY_FOR_TEST,
        excludeBookingId: "booking-1",
        db: db as never,
        capOverflow: "coverExisting",
      }
    );

    expect(application.capCoverage?.excludedMemberIds).toEqual([BOB]);
    expect(application.remainingFreeNightsByMemberId).toEqual({ [ANN]: 2 });
    expect(application.discount?.freeNightsUsed).toBe(2);
  });
});

// --- The sentence every surface shows ----------------------------------------

describe("the wording a member reads", () => {
  it("names who keeps it, who does not, and says the total already includes it", () => {
    expect(
      promoCapCoverageMessage({
        promoCode: "SUMMER25",
        keptNames: ["Ann Hughes"],
        addedNames: [],
        excludedNames: ["Cal Hughes"],
      })
    ).toBe(
      "Promo code SUMMER25 has reached its limit, so it stays with Ann Hughes, " +
        "who already had it, and does not extend to Cal Hughes " +
        "— Cal Hughes is priced at the normal rate. The total shown already " +
        "includes this."
    );
  });

  it("does not tell somebody this edit just added that they 'already had it'", () => {
    // The owner's own headline case: two slots free, Ann already covered, the
    // member adds Bob and Cal. Bob IS covered — but by this edit, not before
    // it, and a member who reads "Ann and Bob, who already had it" about a
    // guest they added a moment ago stops believing the rest of the sentence.
    expect(
      promoCapCoverageMessage({
        promoCode: "SUMMER25",
        keptNames: ["Ann Hughes"],
        addedNames: ["Bob Hughes"],
        excludedNames: ["Cal Hughes"],
      })
    ).toBe(
      "Promo code SUMMER25 has reached its limit, so it stays with Ann Hughes, " +
        "who already had it, and it also covers Bob Hughes, and does not extend " +
        "to Cal Hughes — Cal Hughes is priced at the normal rate. The total " +
        "shown already includes this."
    );
  });

  it("claims nothing about the past when everybody covered is new", () => {
    const message = promoCapCoverageMessage({
      promoCode: "SUMMER25",
      keptNames: [],
      addedNames: ["Bob Hughes"],
      excludedNames: ["Cal Hughes"],
    });
    expect(message).toContain("so it covers Bob Hughes, and does not extend to Cal Hughes");
    expect(message).not.toContain("already had it");
  });

  it("reads naturally with more than one person left out", () => {
    const message = promoCapCoverageMessage({
      promoCode: "SUMMER25",
      keptNames: ["Ann Hughes"],
      addedNames: [],
      excludedNames: ["Bob Hughes", "Cal Hughes"],
    });
    expect(message).toContain("Bob Hughes and Cal Hughes are priced at the normal rate");
  });

  it("joins names the way a person would say them", () => {
    expect(joinNames([])).toBe("");
    expect(joinNames(["Ann"])).toBe("Ann");
    expect(joinNames(["Ann", "Bob"])).toBe("Ann and Bob");
    expect(joinNames(["Ann", "Bob", "Cal"])).toBe("Ann, Bob and Cal");
  });

  it("says nothing at all when the promotion still covers everybody", async () => {
    const { db } = usageDb();
    expect(
      await describePromoCapCoverage(db as never, {
        promoCode: "SUMMER25",
        capCoverage: undefined,
      })
    ).toBeNull();
  });

  it("turns member ids into the sentence", async () => {
    const { db } = usageDb();
    const notice = await describePromoCapCoverage(db as never, {
      promoCode: "SUMMER25",
      capCoverage: {
        coveredMemberIds: [ANN],
        retainedMemberIds: [ANN],
        excludedMemberIds: [CAL],
      },
    });

    expect(notice?.coveredNames).toEqual(["Ann Hughes"]);
    expect(notice?.retainedNames).toEqual(["Ann Hughes"]);
    expect(notice?.excludedNames).toEqual(["Cal Hughes"]);
    expect(notice?.message).toContain("does not extend to Cal Hughes");
  });

  it("splits the covered into who kept it and who this edit brought in", async () => {
    const { db } = usageDb();
    const notice = await describePromoCapCoverage(db as never, {
      promoCode: "SUMMER25",
      capCoverage: {
        coveredMemberIds: [ANN, BOB],
        retainedMemberIds: [ANN],
        excludedMemberIds: [CAL],
      },
    });

    expect(notice?.retainedNames).toEqual(["Ann Hughes"]);
    expect(notice?.message).toContain(
      "it stays with Ann Hughes, who already had it, and it also covers Bob Hughes"
    );
  });
});

// --- The reprice paths, driven end to end ------------------------------------

const PROMO_ROW = {
  id: "promo-1",
  code: "SUMMER25",
  internal: false,
  active: true,
  validFrom: null,
  validUntil: null,
  bookingStartFrom: null,
  bookingStartUntil: null,
  // Two slots. Ann holds one, on this very booking.
  maxRedemptionsTotal: 2,
  currentRedemptions: 1,
  maxUniqueMembersTotal: null,
  maxUsesPerMember: null,
  membersOnly: false,
  memberGuestsOnly: false,
  type: "PERCENTAGE",
  valueCents: null,
  percentOff: 20,
  freeNightsPerIndividual: null,
  lifetimeFreeNightsCap: null,
  fixedNightlyPriceCents: null,
  fixedNightlyMode: null,
  maxGuestsPerBooking: null,
  maxNightlyValueCents: null,
  assignedMembersOnlyOwnNights: true,
  assignments: ASSIGNED.map((memberId) => ({ memberId })),
  lodges: [],
};

function makeRepriceTx(
  options: {
    bookingBeneficiaries?: string[];
    refreshedRedemptions?: number;
  } = {}
) {
  const bookingBeneficiaries = options.bookingBeneficiaries ?? [ANN];
  const calls: string[] = [];
  const createdAllocations: Array<{ memberId: string; discountCents: number }> = [];
  const counterUpdates: unknown[] = [];

  const tx = {
    $executeRaw: vi.fn(async () => {
      calls.push("lock");
      // $executeRaw returns an affected-row count, never rows (#2289).
      return 1;
    }),
    promoCode: {
      findUnique: vi.fn(async () => {
        calls.push("promoCode.findUnique");
        return options.refreshedRedemptions === undefined
          ? PROMO_ROW
          : { ...PROMO_ROW, currentRedemptions: options.refreshedRedemptions };
      }),
      update: vi.fn(async ({ data }: { data: unknown }) => {
        counterUpdates.push(data);
        return {};
      }),
    },
    promoCodeLodge: { findMany: vi.fn(async () => []) },
    promoRedemption: {
      update: vi.fn(async () => {
        calls.push("promoRedemption.update");
        return {};
      }),
      delete: vi.fn(async () => {
        calls.push("promoRedemption.delete");
        return {};
      }),
    },
    promoRedemptionAllocation: {
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.promoRedemptionId) return bookingBeneficiaries.length;
        if (typeof where.bookingId === "string") return bookingBeneficiaries.length;
        return 0;
      }),
      aggregate: vi.fn(async () => ({ _sum: { freeNightsUsed: 0 } })),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        calls.push("allocation.findMany");
        return typeof where.bookingId === "string"
          ? bookingBeneficiaries.map((memberId) => ({ memberId }))
          : [];
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async ({ data }: { data: typeof createdAllocations }) => {
        calls.push("allocation.createMany");
        createdAllocations.push(...data);
        return { count: data.length };
      }),
    },
    promoRedemptionGuestTarget: {
      createMany: vi.fn(async () => ({ count: 0 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    member: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        calls.push("member.findMany");
        return where.id.in.map((id) => ({
          id,
          firstName: id === ANN ? "Ann" : id === BOB ? "Bob" : "Cal",
          lastName: "Hughes",
        }));
      }),
    },
  };

  return { tx, calls, createdAllocations, counterUpdates };
}

const STORED_REDEMPTION = {
  id: "redemption-1",
  promoCodeId: "promo-1",
  bookingId: "booking-1",
  memberId: ANN,
  guestTargets: [],
  promoCode: PROMO_ROW,
};

const GUEST_NIGHT_RATES = [ANN, BOB, CAL].map((memberId, index) => ({
  bookingGuestId: `bg-${index}`,
  memberId,
  isMember: true,
  perNightRates: [5000, 5000],
}));

describe("path 1 — batch modification reprice (booking-modify-plan)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  type ApplyArgs = Parameters<typeof applyPromoCodeChanges>;

  function run(
    tx: ReturnType<typeof makeRepriceTx>["tx"],
    promoRedemption: typeof STORED_REDEMPTION = STORED_REDEMPTION
  ) {
    return applyPromoCodeChanges(tx as unknown as ApplyArgs[0], {
      todayAtClub: CLUB_TODAY_FOR_TEST,
      booking: {
        memberId: ANN,
        lodgeId: "lodge-1",
        promoRedemption,
      } as unknown as ApplyArgs[1]["booking"],
      bookingId: "booking-1",
      input: {} as unknown as ApplyArgs[1]["input"],
      inProgressPlan: null,
      newCheckIn: new Date("2026-08-01T00:00:00Z"),
      newTotalPriceCents: 30000,
      guestNightRates: GUEST_NIGHT_RATES,
    });
  }

  it("saves the edit, keeps Ann's discount and prices Cal normally", async () => {
    const { tx, calls, createdAllocations } = makeRepriceTx();

    const result = await run(tx);

    expect(result.promoRemoved).toBe(false);
    expect(result.newDiscountCents).toBe(4000);
    expect(result.newPromoAdjustmentCents).toBe(-4000);
    expect(calls).not.toContain("promoRedemption.delete");
    expect(createdAllocations.map((a) => a.memberId).sort()).toEqual([ANN, BOB]);
    expect(result.promoCoverage?.message).toContain(
      "does not extend to Cal Hughes"
    );
  });

  it("divides up the counter it read UNDER the lock, not the stale snapshot", async () => {
    // The race: this transaction's snapshot was loaded with the booking and
    // still shows one slot free; under the lock another booking has taken it.
    // Trimming against the snapshot would hand Bob a slot that no longer
    // exists. Ann, who already holds hers, keeps it either way.
    const staleSnapshot = {
      ...STORED_REDEMPTION,
      promoCode: { ...PROMO_ROW, currentRedemptions: 1 },
    };
    const { tx, createdAllocations } = makeRepriceTx({ refreshedRedemptions: 2 });

    const result = await run(tx, staleSnapshot);

    expect(result.promoRemoved).toBe(false);
    expect(createdAllocations.map((a) => a.memberId)).toEqual([ANN]);
    expect(result.newDiscountCents).toBe(2000);
    expect(result.promoCoverage?.excludedNames).toEqual(["Bob Hughes", "Cal Hughes"]);
  });

  it("reads who is protected BEFORE the redemption write the triggers fire on", async () => {
    // `PromoRedemption_sync_allocation_update` upserts a booker allocation row
    // on every redemption write. Reading the protected set afterwards would let
    // that transient row grant protection nobody earned.
    const { tx, calls } = makeRepriceTx();

    await run(tx);

    expect(calls.indexOf("allocation.findMany")).toBeGreaterThan(
      calls.indexOf("lock")
    );
    expect(calls.indexOf("allocation.findMany")).toBeLessThan(
      calls.indexOf("promoRedemption.update")
    );
  });
});

describe("path 4 — guest removal reprice (booking-guest-removal-service)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  type RemovalArgs = Parameters<typeof recalculateBookingPromo>[0];

  function run(tx: ReturnType<typeof makeRepriceTx>["tx"]) {
    return recalculateBookingPromo({
      todayAtClub: CLUB_TODAY_FOR_TEST,
      tx: tx as unknown as RemovalArgs["tx"],
      bookingId: "booking-1",
      booking: {
        memberId: ANN,
        lodgeId: "lodge-1",
        checkIn: new Date("2026-08-01T00:00:00Z"),
        promoRedemption: STORED_REDEMPTION,
      } as unknown as RemovalArgs["booking"],
      newTotalPriceCents: 30000,
      guestNightRates: GUEST_NIGHT_RATES,
    });
  }

  it("keeps the discount for whoever already had it", async () => {
    const { tx, calls } = makeRepriceTx();

    const result = await run(tx);

    expect(result.promoRemoved).toBe(false);
    expect(result.newDiscountCents).toBe(4000);
    expect(calls).not.toContain("promoRedemption.delete");
    expect(result.promoCoverage?.excludedNames).toEqual(["Cal Hughes"]);
  });

  it("says nothing when the promotion covers everybody it applies to", async () => {
    const { tx } = makeRepriceTx({ bookingBeneficiaries: [ANN, BOB, CAL] });

    const result = await run(tx);

    expect(result.promoCoverage).toBeNull();
    expect(result.newDiscountCents).toBe(6000);
  });
});

// --- One price, told the same way everywhere ---------------------------------

describe("the price a partial promotion produces reaches every surface unchanged", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("booking summary, confirmation email and Xero invoice all read the one number", async () => {
    const { tx } = makeRepriceTx();
    const promo = await applyPromoCodeChanges(
      tx as unknown as Parameters<typeof applyPromoCodeChanges>[0],
      {
      todayAtClub: CLUB_TODAY_FOR_TEST,
        booking: {
          memberId: ANN,
          lodgeId: "lodge-1",
          promoRedemption: STORED_REDEMPTION,
        } as unknown as Parameters<typeof applyPromoCodeChanges>[1]["booking"],
        bookingId: "booking-1",
        input: {} as unknown as Parameters<typeof applyPromoCodeChanges>[1]["input"],
        inProgressPlan: null,
        newCheckIn: new Date("2026-08-01T00:00:00Z"),
        newTotalPriceCents: 30000,
        guestNightRates: GUEST_NIGHT_RATES,
      }
    );

    // What the reprice stores on the booking.
    const newTotalPriceCents = 30000;
    const storedPromoAdjustmentCents = promo.newPromoAdjustmentCents;
    const newFinalPriceCents = newTotalPriceCents + storedPromoAdjustmentCents;
    expect(storedPromoAdjustmentCents).toBe(-4000);
    expect(newFinalPriceCents).toBe(26000);

    // The confirmation/modification email's own rows.
    const rows = bookingModificationSummaryRows({
      oldCheckIn: new Date("2026-08-01T00:00:00Z"),
      oldCheckOut: new Date("2026-08-03T00:00:00Z"),
      newCheckIn: new Date("2026-08-01T00:00:00Z"),
      newCheckOut: new Date("2026-08-03T00:00:00Z"),
      oldGuestCount: 2,
      newGuestCount: 3,
      oldFinalPriceCents: 20000,
      newFinalPriceCents,
      changeFeeCents: 0,
      promoCoverageNote: promo.promoCoverage?.message ?? null,
    });
    expect(rows).toContainEqual({ label: "New Total", value: "$260.00" });
    // The same words as the panel and the history, not a second rendering.
    expect(rows).toContainEqual({
      label: "Promo coverage",
      value: promo.promoCoverage!.message,
    });

    // The Xero invoice line is the stored adjustment, unit for unit — the
    // description is deliberately untouched, because the reconciliation matcher
    // in xero-booking-invoices keys off the "Promo adjustment - " prefix.
    const invoiceLineAmount = storedPromoAdjustmentCents / 100;
    expect(invoiceLineAmount).toBe(newFinalPriceCents / 100 - newTotalPriceCents / 100);

    // And the booking's own history replays the identical sentence.
    const items = buildBookingHistoryItems({
      createdAt: new Date("2026-07-01T00:00:00Z"),
      payment: null,
      modifications: [
        {
          id: "mod-1",
          modificationType: "BATCH_MODIFY",
          previousData: { checkIn: "2026-08-01", checkOut: "2026-08-03", guestCount: 2 },
          newData: {
            checkIn: "2026-08-01",
            checkOut: "2026-08-03",
            guestCount: 3,
            promoCoverageNote: promo.promoCoverage?.message ?? null,
          },
          priceDiffCents: 6000,
          changeFeeCents: 0,
          createdAt: new Date("2026-07-30T00:00:00Z"),
        },
      ] as never,
      refundRequests: [],
      auditLogs: [],
    });
    const modificationItem = items.find((item) => item.id === "modification-mod-1");
    expect(modificationItem?.detail).toContain(promo.promoCoverage!.message);
  });

  it("leaves the history detail alone when nothing was left out", () => {
    const items = buildBookingHistoryItems({
      createdAt: new Date("2026-07-01T00:00:00Z"),
      payment: null,
      modifications: [
        {
          id: "mod-2",
          modificationType: "GUEST_ADD",
          previousData: { guestCount: 2 },
          newData: { guestCount: 3 },
          priceDiffCents: 6000,
          changeFeeCents: 0,
          createdAt: new Date("2026-07-30T00:00:00Z"),
        },
      ] as never,
      refundRequests: [],
      auditLogs: [],
    });
    expect(items.find((item) => item.id === "modification-mod-2")?.detail).toBe(
      "2 to 3 guests."
    );
  });

  it("adds no promo row to a modification email that left nobody out", () => {
    const rows = bookingModificationSummaryRows({
      oldCheckIn: new Date("2026-08-01T00:00:00Z"),
      oldCheckOut: new Date("2026-08-03T00:00:00Z"),
      newCheckIn: new Date("2026-08-01T00:00:00Z"),
      newCheckOut: new Date("2026-08-03T00:00:00Z"),
      oldGuestCount: 3,
      newGuestCount: 3,
      oldFinalPriceCents: 26000,
      newFinalPriceCents: 26000,
      changeFeeCents: 0,
    });
    expect(rows.some((row) => row.label === "Promo coverage")).toBe(false);
  });
});

// --- The wiring, pinned by source --------------------------------------------

function readSource(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

const REPRICE_CALL_SITES: Array<[string, string]> = [
  ["adding guests", "src/app/api/bookings/[id]/guests/route.ts"],
  ["changing dates", "src/lib/booking-date-modification-service.ts"],
  ["removing guests", "src/lib/booking-guest-removal-service.ts"],
  ["batch modification", "src/lib/booking-modify-plan.ts"],
  ["the edit preview", "src/app/api/bookings/[id]/modify-quote/route.ts"],
];

describe("every reprice path — and the preview — asks for partial coverage", () => {
  it.each(REPRICE_CALL_SITES)(
    "%s passes capOverflow: coverExisting",
    (_name, path) => {
      // Without it the path falls back to refusing, which each one turns into
      // deleting the redemption — the whole booking's discount stripped and
      // billed back because one added guest did not fit.
      expect(readSource(path)).toContain('capOverflow: "coverExisting"');
    }
  );

  it("the preview and the save both ask for it, so they cannot disagree", () => {
    const quote = readSource("src/app/api/bookings/[id]/modify-quote/route.ts");
    const save = readSource("src/lib/booking-modify-plan.ts");
    const occurrences = (source: string) =>
      source.split('capOverflow: "coverExisting"').length - 1;
    // Exactly one reprice branch each: the quote's keep-existing branch and the
    // plan's no-swap branch. A second would mean the "apply a new code" branch
    // had quietly acquired it.
    expect(occurrences(quote)).toBe(1);
    expect(occurrences(save)).toBe(1);
  });

  it("applying a NEW code still refuses a full promotion", () => {
    const source = readSource("src/lib/booking-modify-plan.ts");
    const applyStart = source.indexOf(
      "if (input.promoCode && !input.removePromoCode) {"
    );
    const applyBranch = source.slice(
      applyStart,
      source.indexOf("} else if (", applyStart)
    );
    expect(applyBranch).not.toContain("capOverflow");
    expect(applyBranch).toContain(
      'throw new ApiError(application.error ?? "Promo code could not be applied", 400)'
    );
  });

  it("booking creation is untouched", () => {
    const source = readSource("src/lib/booking-create-promo.ts");
    expect(source).not.toContain("capOverflow");
  });
});
