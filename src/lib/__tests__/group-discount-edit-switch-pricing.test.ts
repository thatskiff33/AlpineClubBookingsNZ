import { describe, expect, it, vi } from "vitest";
import type { AgeTier, BookingGuestNightPriceSource } from "@prisma/client";
import type { SeasonRateData } from "@/lib/policies/pricing";

/**
 * #2770 (INV-MOD-026): what the club's `applyToEdits` switch actually does to
 * money, driven through the REAL planner and the REAL pricing engine, in both
 * positions, at both planner branches.
 *
 * ## Why this suite is built the way it is
 *
 * The trap here is a vacuous pass, and #2756 walked into it: its first build
 * plumbed a group-discount config through an edit path that could never apply
 * it, and every one of its eleven new tests went green while the defect
 * survived. A switch is even easier to fake — "off" and "the plumbing does not
 * work" produce the same number.
 *
 * So every case here asserts the ON price is **strictly cheaper** than the OFF
 * price on the nights an edit buys. An inert gate makes those two numbers equal
 * and fails the case; there is no way for this suite to be green while the
 * switch is decorative. `priceBookingGuestsWithMembershipTypePolicy` is
 * therefore a thin delegation to the real `calculateBookingPrice` rather than a
 * canned answer, so the config genuinely has to arrive for the cents to move.
 *
 * ## The two season shapes, and why both are run
 *
 * The edit paths used to hand-roll their `SeasonRateData` without the season's
 * `type`, so at a club on the schema default (`summerOnly: true`) the group
 * discount could not reach an edit at all. #2756 (PR #2772, now merged) routes
 * every mapping through `toSeasonRateData` and restored it, which is what makes
 * this switch matter to a default-configured club rather than only to one that
 * had turned `summerOnly` off. Each case therefore runs twice:
 *
 *  - `summerOnly: true` with a `SUMMER` season — the schema default, and the
 *    configuration a real club is most likely in;
 *  - `summerOnly: false` with a typeless season — the same behaviour where the
 *    season's type is irrelevant, so a future regression in `type` plumbing
 *    cannot make the whole suite vacuous at once.
 *
 * Both must behave identically, because the switch is about *whether an edit is
 * discounted*, never about which season it is in.
 */

const h = vi.hoisted(() => ({
  /**
   * Rate membership types. The group discount substitutes `MEMBER_TYPE`'s rows
   * for a true non-member (`NON_MEMBER_DEFAULT`) when a night qualifies, which
   * is the only thing the discount does since #1930 E4 — so the whole money
   * effect of the switch is visible as the spread between these two rates.
   */
  MEMBER_TYPE: "type-full",
  NON_MEMBER_TYPE: "type-non-member",
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/membership-type-policy", async () => {
  const { calculateBookingPrice } = await import("@/lib/policies/pricing");
  return {
    assertMembershipTypeBookingAllowed: vi.fn().mockResolvedValue(undefined),
    MembershipTypeBookingPolicyError: class extends Error {},
    // The real resolver reads the database. Here it does what #1930 E4 says it
    // does and nothing else: a member prices on their own type's rows, a true
    // non-member on the NON_MEMBER rows and is the only guest a group discount
    // can move.
    resolveGuestRateMembershipTypes: vi.fn(
      async (
        _tx: unknown,
        { guests }: { guests: Array<{ isMember: boolean }> },
      ) =>
        guests.map((guest) => ({
          ...guest,
          rateMembershipTypeId: guest.isMember
            ? h.MEMBER_TYPE
            : h.NON_MEMBER_TYPE,
          rateSource: guest.isMember ? "OWN_TYPE" : "NON_MEMBER_DEFAULT",
        })),
    ),
    // Delegation, not a stub: the group-discount config has to genuinely reach
    // the engine for any assertion below to pass.
    priceBookingGuestsWithMembershipTypePolicy: vi.fn(
      async (
        _tx: unknown,
        input: Parameters<typeof calculateBookingPrice> extends never
          ? never
          : {
              checkIn: Date;
              checkOut: Date;
              guests: Parameters<typeof calculateBookingPrice>[2];
              seasons: SeasonRateData[];
              groupDiscount?: Parameters<typeof calculateBookingPrice>[4];
            },
      ) =>
        calculateBookingPrice(
          input.checkIn,
          input.checkOut,
          input.guests,
          input.seasons,
          input.groupDiscount,
        ),
    ),
  };
});

import { calculateModifiedPricing } from "@/lib/booking-modify-plan";

const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const MEMBER_RATE_CENTS = 8000;
const NON_MEMBER_RATE_CENTS = 12000;
/** What one discounted non-member night saves. Integer cents throughout. */
const DISCOUNT_PER_NIGHT_CENTS = NON_MEMBER_RATE_CENTS - MEMBER_RATE_CENTS;

/**
 * The two season shapes described in the file header. One flat season covering
 * every date any case uses, carrying both rate rows.
 */
const SEASON_SHAPES = [
  {
    name: "typeless season, summerOnly off (the shape main can reach today)",
    summerOnly: false,
    seasonType: undefined,
  },
  {
    name: "SUMMER season, summerOnly on (the shape #2772 restores)",
    summerOnly: true,
    seasonType: "SUMMER" as const,
  },
] as const;

function seasons(seasonType: "SUMMER" | undefined): SeasonRateData[] {
  return [
    {
      seasonId: "s1",
      startDate: D("2026-01-01"),
      endDate: D("2027-12-31"),
      ...(seasonType ? { type: seasonType } : {}),
      rates: [
        {
          membershipTypeId: h.MEMBER_TYPE,
          ageTier: null,
          pricePerNightCents: MEMBER_RATE_CENTS,
        },
        {
          membershipTypeId: h.NON_MEMBER_TYPE,
          ageTier: null,
          pricePerNightCents: NON_MEMBER_RATE_CENTS,
        },
      ],
    },
  ];
}

/**
 * The club's stored policy row, in one of the three states that matter:
 * discount off entirely (the baseline nothing may move from), discount on with
 * the switch on, discount on with the switch off.
 */
function groupDiscountRow(
  state: "disabled" | "on" | "off",
  summerOnly: boolean,
) {
  return {
    id: "default",
    minGroupSize: 5,
    summerOnly,
    enabled: state !== "disabled",
    rateMembershipTypeId: h.MEMBER_TYPE,
    applyToEdits: state !== "off",
  };
}

function txFor(state: "disabled" | "on" | "off", summerOnly: boolean) {
  return {
    groupDiscountSetting: {
      findUnique: vi.fn().mockResolvedValue(groupDiscountRow(state, summerOnly)),
    },
  } as never;
}

interface PartyGuest {
  id: string;
  isMember: boolean;
  stayStart: Date;
  stayEnd: Date;
  /** Stored per-night prices — the locks that make a bought night immovable. */
  nights?: Array<{
    stayDate: Date;
    priceCents: number;
    priceSource: BookingGuestNightPriceSource;
  }>;
}

/** What a guest's stored night rows say they have paid so far. */
/**
 * The pricing result, insisting it priced (#3031).
 *
 * `calculateModifiedPricing` answers with a discriminated result now, so a
 * fixture whose stored rows stop reconciling fails HERE, naming the causes,
 * rather than later on an expectation about a number that was never produced.
 */
async function pricedPricing(
  ...args: Parameters<typeof calculateModifiedPricing>
) {
  const result = await calculateModifiedPricing(...args);
  if (result.kind !== "priced") {
    throw new Error(
      `Expected a priced modification, got financial review: ${result.occurrences
        .map((occurrence) => occurrence.cause)
        .join(", ")}`,
    );
  }
  return result;
}

function storedPriceOf(guest: PartyGuest): number {
  return (guest.nights ?? []).reduce((sum, night) => sum + night.priceCents, 0);
}

/**
 * A guest's stored total is the SUM of their stored night rows, never a
 * hard-coded zero, and that matters more than it looks (#2744, INV-MOD-025).
 *
 * `composeProposedNightPrices` writes the real per-night rates only when the
 * stored past nights account exactly for the part of the total the edit does not
 * touch; a guest whose total has drifted from their rows falls back to an EVEN
 * SPLIT of the whole total across every night. Under that fallback a cheaper
 * edit makes every night look cheaper — held nights included — so a fixture with
 * three stored 12000-cent nights and a stored total of zero would report the
 * switch re-rating history when it had done nothing of the kind, and would hide
 * the real per-night effect behind an average. The fixtures must therefore be
 * the coherent booking, because that is the one the assertions are about.
 */
function bookingOf(
  party: PartyGuest[],
  checkIn: Date,
  checkOut: Date,
  totalPriceCents = party.reduce((sum, guest) => sum + storedPriceOf(guest), 0),
) {
  return {
    id: "b1",
    memberId: "m-owner",
    lodgeId: "lodge-1",
    checkIn,
    checkOut,
    totalPriceCents,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: totalPriceCents,
    guests: party.map((guest) => ({
      id: guest.id,
      ageTier: "ADULT" as AgeTier,
      isMember: guest.isMember,
      memberId: guest.isMember ? `m-${guest.id}` : null,
      stayStart: guest.stayStart,
      stayEnd: guest.stayEnd,
      priceCents: storedPriceOf(guest),
      nights: guest.nights ?? [],
    })),
  } as never;
}

function guestsForPricing(party: PartyGuest[]) {
  return party.map((guest) => ({
    bookingGuestId: guest.id,
    ageTier: "ADULT" as AgeTier,
    isMember: guest.isMember,
    memberId: guest.isMember ? `m-${guest.id}` : null,
    stayStart: guest.stayStart,
    stayEnd: guest.stayEnd,
    lockedNightPrices: guest.nights ?? null,
  }));
}

/**
 * A party of five non-members: one over the minimum group size, so every night
 * the edit buys either qualifies for the discount or is refused it by the
 * switch, and nothing else can explain the difference.
 */
const FIVE_NON_MEMBERS: PartyGuest[] = [1, 2, 3, 4, 5].map((n) => ({
  id: `g${n}`,
  isMember: false,
  stayStart: D("2026-09-10"),
  stayEnd: D("2026-09-12"),
  // #3166: the two nights they already hold, each carrying what it was sold
  // for, so the strand's rows reconcile with the total `storedPriceOf` derives
  // from them. Without stored rows this party has no readable sold-price
  // history and every ordinary-planner case below now parks for financial
  // review rather than pricing — which is the gate working, not a discount
  // question. These are the nights the edit KEEPS, so they lock at their stored
  // price in both switch states and the only night either state can move is the
  // one the extension buys, which is exactly what the assertions measure.
  nights: [D("2026-09-10"), D("2026-09-11")].map((stayDate) => ({
    stayDate,
    priceCents: NON_MEMBER_RATE_CENTS,
    priceSource: "SOLD" as const,
  })),
}));

describe.each(SEASON_SHAPES)(
  "edit-time group discount switch — $name (#2770, INV-MOD-026)",
  ({ summerOnly, seasonType }) => {
    const seasonRateData = seasons(seasonType);

    /**
     * The ORDINARY planner branch: a booking whose stay has not started, extended
     * by one night. This is `calculateModifiedPricing`'s non-in-progress branch —
     * the branch that has always passed a group-discount config.
     */
    async function extendByOneNight(state: "disabled" | "on" | "off") {
      const party = FIVE_NON_MEMBERS;
      const result = await pricedPricing(txFor(state, summerOnly), {
        booking: bookingOf(party, D("2026-09-10"), D("2026-09-12"), 0),
        bookingId: "b1",
        isInProgressEdit: false,
        editableFrom: null,
        newCheckIn: D("2026-09-10"),
        newCheckOut: D("2026-09-13"),
        normalizedAddGuests: undefined,
        removeGuestIds: undefined,
        guestsForPricing: guestsForPricing(
          party.map((guest) => ({ ...guest, stayEnd: D("2026-09-13") })),
        ),
        skipBookingLifecycleRules: true,
        seasonRateData,
      });
      return result;
    }

    it("ordinary planner: ON discounts the nights the edit buys, OFF does not, and OFF is the same price as a club with no discount at all", async () => {
      const [disabled, on, off] = await Promise.all([
        extendByOneNight("disabled"),
        extendByOneNight("on"),
        extendByOneNight("off"),
      ]);

      // Three nights × five non-members, undiscounted. Two of the three were
      // already bought at the non-member rate and keep it (#3166 gave this
      // party the stored rows it needs to be priceable at all), so the figure is
      // unchanged even though its composition is not.
      expect(disabled.newTotalPriceCents).toBe(
        3 * 5 * NON_MEMBER_RATE_CENTS,
      );

      // The load-bearing assertion, and the one an inert gate cannot pass: the
      // switch is worth real money on the night this edit BUYS. It reaches that
      // night only — the two already bought keep their stored price in every
      // state (INV-MOD-005), which is the neighbouring case's subject.
      expect(on.newTotalPriceCents).toBeLessThan(off.newTotalPriceCents);
      expect(on.newTotalPriceCents).toBe(
        2 * 5 * NON_MEMBER_RATE_CENTS + 5 * MEMBER_RATE_CENTS,
      );
      expect(off.newTotalPriceCents - on.newTotalPriceCents).toBe(
        5 * DISCOUNT_PER_NIGHT_CENTS,
      );

      // Off is the ABSENCE of a discount, not a second discount rule: byte-for-byte
      // the club-with-no-discount answer, which is what makes turning the switch
      // off safe to ship.
      expect(off.newTotalPriceCents).toBe(disabled.newTotalPriceCents);
      expect(off.priceBreakdown.guests.map((g) => g.perNightCents)).toEqual(
        disabled.priceBreakdown.guests.map((g) => g.perNightCents),
      );

      // Integer cents, per night, in both states (INV-MONEY-001).
      for (const quote of [on, off, disabled]) {
        for (const guest of quote.priceBreakdown.guests) {
          for (const cents of guest.perNightCents) {
            expect(Number.isInteger(cents)).toBe(true);
          }
          expect(
            guest.perNightCents.reduce<number>(
              // #3170: NaN, never 0 — an unknown night must FAIL this sum, not
              // satisfy it. A `?? 0` here would let a null pass as a comped night.
              (sum, cents) => sum + (cents ?? Number.NaN),
              0,
            ),
          ).toBe(guest.priceCents);
        }
      }
    });

    it("ordinary planner: a night the party already BOUGHT keeps its price in both states (INV-MOD-005)", async () => {
      // Every guest carries stored night rows for the two nights they hold, at
      // the undiscounted rate they were sold. The edit adds a third night.
      const held = [D("2026-09-10"), D("2026-09-11")];
      const party: PartyGuest[] = FIVE_NON_MEMBERS.map((guest) => ({
        ...guest,
        stayEnd: D("2026-09-13"),
        nights: held.map((stayDate) => ({
          stayDate,
          priceCents: NON_MEMBER_RATE_CENTS,
          priceSource: "SOLD" as const,
        })),
      }));

      const run = (state: "disabled" | "on" | "off") =>
        pricedPricing(txFor(state, summerOnly), {
          booking: bookingOf(party, D("2026-09-10"), D("2026-09-12"), 0),
          bookingId: "b1",
          isInProgressEdit: false,
          editableFrom: null,
          newCheckIn: D("2026-09-10"),
          newCheckOut: D("2026-09-13"),
          normalizedAddGuests: undefined,
          removeGuestIds: undefined,
          guestsForPricing: guestsForPricing(party),
          skipBookingLifecycleRules: true,
          seasonRateData,
        });

      const [on, off] = await Promise.all([run("on"), run("off")]);

      // The two bought nights are identical in both states; only the third moves.
      for (const quote of [on, off]) {
        for (const guest of quote.priceBreakdown.guests) {
          expect(guest.perNightCents.slice(0, 2)).toEqual([
            NON_MEMBER_RATE_CENTS,
            NON_MEMBER_RATE_CENTS,
          ]);
        }
      }
      expect(
        on.priceBreakdown.guests.map((g) => g.perNightCents[2]),
      ).toEqual(FIVE_NON_MEMBERS.map(() => MEMBER_RATE_CENTS));
      expect(
        off.priceBreakdown.guests.map((g) => g.perNightCents[2]),
      ).toEqual(FIVE_NON_MEMBERS.map(() => NON_MEMBER_RATE_CENTS));
      expect(off.newTotalPriceCents - on.newTotalPriceCents).toBe(
        5 * DISCOUNT_PER_NIGHT_CENTS,
      );
    });

    it("ordinary planner: a party below the minimum is undiscounted in BOTH states, so the switch adds no discount of its own", async () => {
      const party = FIVE_NON_MEMBERS.slice(0, 4).map((guest) => ({
        ...guest,
        stayEnd: D("2026-09-13"),
      }));
      const run = (state: "disabled" | "on" | "off") =>
        pricedPricing(txFor(state, summerOnly), {
          booking: bookingOf(party, D("2026-09-10"), D("2026-09-12"), 0),
          bookingId: "b1",
          isInProgressEdit: false,
          editableFrom: null,
          newCheckIn: D("2026-09-10"),
          newCheckOut: D("2026-09-13"),
          normalizedAddGuests: undefined,
          removeGuestIds: undefined,
          guestsForPricing: guestsForPricing(party),
          skipBookingLifecycleRules: true,
          seasonRateData,
        });

      const [disabled, on, off] = await Promise.all([
        run("disabled"),
        run("on"),
        run("off"),
      ]);
      expect(on.newTotalPriceCents).toBe(3 * 4 * NON_MEMBER_RATE_CENTS);
      expect(off.newTotalPriceCents).toBe(on.newTotalPriceCents);
      expect(disabled.newTotalPriceCents).toBe(on.newTotalPriceCents);
    });

    /**
     * The IN-PROGRESS planner branch. The stay has started (the frozen clock puts
     * "today" at 2026-07-01 NZ, so a stay from 2026-06-28 is under way and
     * `editableFrom` is NZ tomorrow), and the check-out moves out by one night —
     * so the edit buys exactly ONE night per guest, on 2026-07-03.
     *
     * Since #2756 (PR #2772) this branch takes a group-discount config, and after
     * the merge it takes the SAME hoisted, gated value the ordinary pass takes.
     * So the assertions here are the same strict shape as the ordinary planner's:
     * ON is cheaper than OFF by exactly the discount on the night the edit buys,
     * OFF is byte-identical to a club with no discount at all, and the three
     * nights each guest already holds carry their stored price untouched in both
     * states. An inert gate on this branch makes the ON and OFF numbers equal and
     * fails the case, which is what acceptance criterion 4 asks for — both states
     * at both planner branches, provably.
     */
    const HELD_NIGHTS = [D("2026-06-28"), D("2026-06-29"), D("2026-06-30")];

    async function extendInProgress(state: "disabled" | "on" | "off") {
      const party: PartyGuest[] = [1, 2, 3, 4, 5].map((n) => ({
        id: `g${n}`,
        isMember: false,
        stayStart: D("2026-06-28"),
        stayEnd: D("2026-07-03"),
        nights: HELD_NIGHTS.map((stayDate) => ({
          stayDate,
          priceCents: NON_MEMBER_RATE_CENTS,
          priceSource: "SOLD" as const,
        })),
      }));
      return pricedPricing(txFor(state, summerOnly), {
        booking: bookingOf(party, D("2026-06-28"), D("2026-07-03")),
        bookingId: "b1",
        isInProgressEdit: true,
        editableFrom: D("2026-07-02"),
        newCheckIn: D("2026-06-28"),
        newCheckOut: D("2026-07-04"),
        normalizedAddGuests: undefined,
        removeGuestIds: undefined,
        guestsForPricing: guestsForPricing(party),
        skipBookingLifecycleRules: true,
        seasonRateData,
      });
    }

    it("in-progress planner: OFF prices byte-identically to a club with no group discount", async () => {
      const [disabled, off] = await Promise.all([
        extendInProgress("disabled"),
        extendInProgress("off"),
      ]);

      expect(off.inProgressPlan).not.toBeNull();
      expect(disabled.inProgressPlan).not.toBeNull();
      expect(off.newTotalPriceCents).toBe(disabled.newTotalPriceCents);
      expect(off.priceBreakdown.guests.map((g) => g.perNightCents)).toEqual(
        disabled.priceBreakdown.guests.map((g) => g.perNightCents),
      );
      // And it really went through the in-progress plan, not the ordinary pass.
      expect(off.guestNightRates).toEqual([]);
    });

    it("in-progress planner: ON discounts the night the edit buys and OFF does not, while every night already bought keeps its stored price (INV-MOD-005)", async () => {
      const [on, off] = await Promise.all([
        extendInProgress("on"),
        extendInProgress("off"),
      ]);

      // The load-bearing assertion, and the one an inert gate on THIS branch
      // cannot pass: one newly bought night per guest, five guests, one discount
      // each.
      expect(on.newTotalPriceCents).toBeLessThan(off.newTotalPriceCents);
      expect(off.newTotalPriceCents - on.newTotalPriceCents).toBe(
        5 * DISCOUNT_PER_NIGHT_CENTS,
      );

      for (const [state, quote] of [
        ["on", on],
        ["off", off],
      ] as const) {
        const expectedNewNightCents =
          state === "on" ? MEMBER_RATE_CENTS : NON_MEMBER_RATE_CENTS;
        for (const guest of quote.priceBreakdown.guests) {
          // Four nights: the three held, then the one this edit bought.
          expect(guest.perNightCents).toEqual([
            NON_MEMBER_RATE_CENTS,
            NON_MEMBER_RATE_CENTS,
            NON_MEMBER_RATE_CENTS,
            expectedNewNightCents,
          ]);
          // Integer cents per night, summing back to the guest's own total.
          for (const cents of guest.perNightCents) {
            expect(Number.isInteger(cents)).toBe(true);
          }
          expect(
            guest.perNightCents.reduce<number>(
              // #3170: NaN, never 0 — an unknown night must FAIL this sum, not
              // satisfy it. A `?? 0` here would let a null pass as a comped night.
              (sum, cents) => sum + (cents ?? Number.NaN),
              0,
            ),
          ).toBe(guest.priceCents);
        }
      }

      // Stated once more as the property rather than as numbers: the switch
      // cannot re-rate a bought night in either direction.
      const heldOf = (quote: Awaited<ReturnType<typeof extendInProgress>>) =>
        quote.priceBreakdown.guests.map((g) =>
          g.perNightCents.slice(0, HELD_NIGHTS.length),
        );
      expect(heldOf(on)).toEqual(heldOf(off));
    });
  },
);
