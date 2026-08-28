import { describe, expect, it } from "vitest";
import type { PromoCode, PromoRedemption } from "@prisma/client";
import { assignmentRequiresGuestSelection } from "@/lib/promo-guest-scope";
import {
  promoRequiresStoredGuestTargets,
  selectedIndexesForStoredGuestTargets,
  targetBookingGuestIdsForSelectedIndexes,
  type PromoRedemptionWithTargets,
} from "@/lib/promo-stored-guest-targets";

// #3131 — these three functions had five separate homes across the booking
// modification and guest-removal paths, and `booking-modify-plan.ts`'s copy had
// already diverged in shape. This file pins the behaviour the merge had to
// preserve, and in particular the ONE place it could have shifted silently: what
// `assignedMembersOnlyOwnNights` means when it is `null` or `undefined`.
//
// The four service/route copies typed the field `boolean | null | undefined` and
// compared it with `=== false`; the canonical module routes the read through
// `promo-guest-scope.ts`'s `assignedMembersOnlyOwnNights`, which treats an absent
// value as `true` because the column is `Boolean @default(true)`. The first
// describe block below proves those two spellings agree on every value, so
// unifying the copies cannot have changed any caller's answer.
//
// No source-scanning census guards against a sixth copy, deliberately: per
// `INV-SSOT-001` the remedy here is structural — one exported symbol, five local
// copies deleted — and a guard is for when the structural option is unavailable.
// It would also be actively unsafe in this repository: the canonical module's own
// docblock quotes the old `=== false` spelling to explain what replaced it, which
// a raw-source scanner would report as the very defect it was hunting.

/** The predicate exactly as the four identical copies spelled it, before #3131. */
function legacyPredicate(redemption: PromoRedemptionWithTargets) {
  return (
    redemption.promoCode.assignments.length > 0 &&
    redemption.promoCode.assignedMembersOnlyOwnNights === false
  );
}

function redemption(
  assignedMembersOnlyOwnNights: boolean | null | undefined,
  assignmentCount: number,
  guestTargets?: Array<{ bookingGuestId: string }>
): PromoRedemptionWithTargets {
  return {
    promoCode: {
      ...(assignedMembersOnlyOwnNights === undefined ? {} : { assignedMembersOnlyOwnNights }),
      assignments: Array.from({ length: assignmentCount }, (_, index) => ({
        memberId: `member-${index}`,
      })),
    },
    ...(guestTargets ? { guestTargets } : {}),
  };
}

const FIELD_VALUES: Array<[label: string, value: boolean | null | undefined]> = [
  ["true", true],
  ["false", false],
  ["null", null],
  ["undefined", undefined],
];

describe("promoRequiresStoredGuestTargets", () => {
  // The whole truth table, both dimensions. Only ONE of the eight cells is true,
  // and it is the one both spellings have always agreed on.
  const expected: Record<string, boolean> = {
    "true/no assignments": false,
    "true/with assignments": false,
    "false/no assignments": false,
    "false/with assignments": true,
    "null/no assignments": false,
    "null/with assignments": false,
    "undefined/no assignments": false,
    "undefined/with assignments": false,
  };

  for (const [label, value] of FIELD_VALUES) {
    for (const [countLabel, count] of [
      ["no assignments", 0],
      ["with assignments", 2],
    ] as Array<[string, number]>) {
      const key = `${label}/${countLabel}`;

      it(`is ${expected[key]} for assignedMembersOnlyOwnNights=${label} with ${countLabel}`, () => {
        expect(promoRequiresStoredGuestTargets(redemption(value, count))).toBe(expected[key]);
      });

      it(`agrees with the pre-#3131 \`=== false\` spelling for ${key}`, () => {
        const input = redemption(value, count);
        expect(promoRequiresStoredGuestTargets(input)).toBe(legacyPredicate(input));
      });
    }
  }

  it("treats a missing assignedMembersOnlyOwnNights as own-night scoping ON", () => {
    // The column is `Boolean @default(true)`. If an absent value ever read as
    // "off", an unassigned-intent code would start demanding stored guest
    // targets, and a reprice would scope the discount by rows that do not exist.
    expect(promoRequiresStoredGuestTargets(redemption(undefined, 3))).toBe(false);
    expect(promoRequiresStoredGuestTargets(redemption(null, 3))).toBe(false);
  });

  it("accepts a Prisma-shaped LoadedPromoRedemption, whose field is non-nullable", () => {
    // `booking-modify-plan.ts` passes `PromoRedemption & { promoCode: PromoCode & … }`,
    // where `assignedMembersOnlyOwnNights` is a required `boolean`. This pins that
    // the structural parameter still accepts it — the assignability the merge
    // depended on.
    const loaded = {
      id: "redemption-1",
      promoCode: {
        id: "promo-1",
        assignedMembersOnlyOwnNights: false,
        assignments: [{ memberId: "member-1" }],
        lodges: [{ lodgeId: "lodge-1" }],
      } as unknown as PromoCode & { assignments: Array<{ memberId: string }> },
      guestTargets: [{ bookingGuestId: "bg-1" }],
    } as unknown as PromoRedemption & {
      promoCode: PromoCode & { assignments: Array<{ memberId: string }> };
      guestTargets?: Array<{ bookingGuestId: string }>;
    };

    const asStructural: PromoRedemptionWithTargets = loaded;
    expect(promoRequiresStoredGuestTargets(asStructural)).toBe(true);
  });

  it("is NOT the same question as assignmentRequiresGuestSelection", () => {
    // A fixed-nightly GROUP code is assigned, own-night scoping off, and the
    // booker never picks guests — so it stores no targets. The two functions
    // therefore disagree by design, and the empty-targets branch below is what
    // makes the group case come out right.
    const groupPromo = {
      type: "FIXED_NIGHTLY_PRICE" as const,
      memberGuestsOnly: false,
      assignedMembersOnlyOwnNights: false,
      assignments: [{ memberId: "member-1" }],
    };

    expect(assignmentRequiresGuestSelection(groupPromo, ["member-1"])).toBe(false);
    expect(promoRequiresStoredGuestTargets({ promoCode: groupPromo })).toBe(true);
    expect(
      selectedIndexesForStoredGuestTargets({ promoCode: groupPromo }, [
        { bookingGuestId: "bg-1" },
        { bookingGuestId: "bg-2" },
      ])
    ).toEqual([0, 1]);
  });
});

describe("selectedIndexesForStoredGuestTargets", () => {
  const guests = [
    { bookingGuestId: "bg-1" },
    { bookingGuestId: "bg-2" },
    { bookingGuestId: "bg-3" },
  ];

  it("returns undefined when the promotion is not guest-scoped", () => {
    // undefined means "no per-guest scoping applies", not "nobody" — every
    // caller passes it straight through to the pricing call, where a missing
    // selection covers every eligible guest.
    expect(selectedIndexesForStoredGuestTargets(redemption(true, 2), guests)).toBeUndefined();
    expect(selectedIndexesForStoredGuestTargets(redemption(null, 2), guests)).toBeUndefined();
    expect(selectedIndexesForStoredGuestTargets(redemption(undefined, 2), guests)).toBeUndefined();
    expect(selectedIndexesForStoredGuestTargets(redemption(false, 0), guests)).toBeUndefined();
  });

  it("selects every guest when guest-scoped with no stored targets", () => {
    expect(selectedIndexesForStoredGuestTargets(redemption(false, 1, []), guests)).toEqual([
      0, 1, 2,
    ]);
    // Absent `guestTargets` (a narrower select, or a redemption written before
    // targets were recorded) takes the same branch.
    expect(selectedIndexesForStoredGuestTargets(redemption(false, 1), guests)).toEqual([0, 1, 2]);
  });

  it("selects only the guests named by the stored targets, in list order", () => {
    const input = redemption(false, 1, [{ bookingGuestId: "bg-3" }, { bookingGuestId: "bg-1" }]);
    expect(selectedIndexesForStoredGuestTargets(input, guests)).toEqual([0, 2]);
  });

  it("drops a stored target that is no longer on the repriced guest list", () => {
    const input = redemption(false, 1, [
      { bookingGuestId: "bg-2" },
      { bookingGuestId: "bg-gone" },
    ]);
    expect(selectedIndexesForStoredGuestTargets(input, guests)).toEqual([1]);
  });

  it("never matches a guest row that has no bookingGuestId", () => {
    const withPending = [
      { bookingGuestId: null },
      { bookingGuestId: "bg-2" },
      { bookingGuestId: undefined },
      {},
    ];
    const input = redemption(false, 1, [{ bookingGuestId: "bg-2" }]);
    expect(selectedIndexesForStoredGuestTargets(input, withPending)).toEqual([1]);
  });

  it("returns an empty selection when no stored target resolves", () => {
    const input = redemption(false, 1, [{ bookingGuestId: "bg-gone" }]);
    expect(selectedIndexesForStoredGuestTargets(input, guests)).toEqual([]);
  });
});

describe("targetBookingGuestIdsForSelectedIndexes", () => {
  const guests = [
    { bookingGuestId: "bg-1" },
    { bookingGuestId: null },
    { bookingGuestId: "bg-3" },
  ];

  it("passes undefined through, so no guest-target rows are written", () => {
    expect(targetBookingGuestIdsForSelectedIndexes(guests, undefined)).toBeUndefined();
  });

  it("returns an empty array for an empty selection", () => {
    expect(targetBookingGuestIdsForSelectedIndexes(guests, [])).toEqual([]);
  });

  it("maps selected indexes to their bookingGuestIds", () => {
    expect(targetBookingGuestIdsForSelectedIndexes(guests, [0, 2])).toEqual(["bg-1", "bg-3"]);
  });

  it("drops an index whose guest has no bookingGuestId yet", () => {
    expect(targetBookingGuestIdsForSelectedIndexes(guests, [0, 1, 2])).toEqual(["bg-1", "bg-3"]);
  });

  it("drops an out-of-range index rather than throwing", () => {
    expect(targetBookingGuestIdsForSelectedIndexes(guests, [0, 99, -1])).toEqual(["bg-1"]);
  });

  it("round-trips a stored selection through both functions", () => {
    const input = redemption(false, 1, [{ bookingGuestId: "bg-3" }]);
    const nightRates = [{ bookingGuestId: "bg-1" }, { bookingGuestId: "bg-3" }];
    const indexes = selectedIndexesForStoredGuestTargets(input, nightRates);
    expect(indexes).toEqual([1]);
    expect(targetBookingGuestIdsForSelectedIndexes(nightRates, indexes)).toEqual(["bg-3"]);
  });
});
