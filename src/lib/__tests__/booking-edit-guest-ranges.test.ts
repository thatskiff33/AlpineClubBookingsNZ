/**
 * #2029 pricing invariant: an in-progress extension's charge must equal the
 * price of EXACTLY the added nights [originalStayEnd, newCheckOut) per guest,
 * regardless of when the edit happens. The #2029 edit-policy change opened
 * check-out-day extensions, whose genuinely-new nights fall in the
 * [stayEnd, editableFrom) slice — a window the old math dropped, handing those
 * nights out free (and, on a longer extension, under-charging by that slice).
 *
 * These run through the shared `buildInProgressGuestRangePlan` core that BOTH
 * the modify-quote and the modify-charge paths use, so a passing quote and a
 * passing charge are proven identical.
 */
import { describe, expect, it } from "vitest";
import {
  buildInProgressGuestRangePlan,
  type BuildInProgressGuestRangePlanInput,
} from "@/lib/booking-edit-guest-ranges";
import type { SeasonRateData } from "@/lib/pricing";
import { eachDateOnlyInRange } from "@/lib/date-only";

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

const MEMBER_TYPE = "type-member";
const RATE = 5000; // per adult member night

const SEASONS: SeasonRateData[] = [
  {
    seasonId: "s1",
    startDate: D("2026-08-01"),
    endDate: D("2026-08-31"),
    rates: [{ ageTier: "ADULT", membershipTypeId: MEMBER_TYPE, pricePerNightCents: RATE }],
  },
];

function guest(stayStart: string, stayEnd: string, priceCents: number, id = "g1") {
  return {
    id,
    firstName: "Guest",
    lastName: id,
    ageTier: "ADULT" as const,
    isMember: true,
    memberId: `m-${id}`,
    rateMembershipTypeId: MEMBER_TYPE,
    rateSource: "OWN_TYPE" as const,
    stayStart: D(stayStart),
    stayEnd: D(stayEnd),
    // #2736: every real caller loads the guest's `BookingGuestNight` rows, so
    // this double carries them — otherwise these #2029 pins would only ever
    // exercise the envelope FALLBACK and stop covering the branch production
    // takes. Contiguous stay, so they are the envelope expanded and every
    // expectation below is unchanged.
    //
    // #3031: they carry their SOLD PRICE too. The plan prices a stay from the
    // stored rows and refuses to invent an amount when they do not reconcile to
    // the guest total, so a night row without a price is no longer a fixture
    // detail — it is the unpriceable case. These are contiguous stays at one
    // rate, so the rows reconcile and every expectation below is unchanged.
    nights: eachDateOnlyInRange(D(stayStart), D(stayEnd)).map((stayDate) => ({
      stayDate,
      priceCents: priceCents / eachDateOnlyInRange(D(stayStart), D(stayEnd)).length,
    })),
    priceCents,
  };
}

/**
 * The plan, insisting it priced.
 *
 * #3031 made `buildInProgressGuestRangePlan` return a discriminated result, and
 * unwrapping it through an assertion rather than a cast is deliberate: a fixture
 * that drifts into the unpriceable case fails HERE, naming the causes, instead
 * of failing twenty lines later on an expectation about a number that was never
 * produced.
 */
function pricedPlan(input: BuildInProgressGuestRangePlanInput) {
  const result = buildInProgressGuestRangePlan(input);
  if (result.kind !== "priced") {
    throw new Error(
      `Expected a priced plan, got financial review: ${result.occurrences
        .map((occurrence) => occurrence.cause)
        .join(", ")}`,
    );
  }
  return result.plan;
}

function planInput(
  overrides: {
    editableFrom: string;
    newCheckOut: string;
    addGuests?: BuildInProgressGuestRangePlanInput["addGuests"];
    removeGuestIds?: string[];
  },
  guests = [guest("2026-08-20", "2026-08-24", 4 * RATE)],
): BuildInProgressGuestRangePlanInput {
  const totalPriceCents = guests.reduce((s, g) => s + g.priceCents, 0);
  return {
    booking: {
      id: "booking-1",
      checkIn: D("2026-08-20"),
      checkOut: D("2026-08-24"),
      totalPriceCents,
      discountCents: 0,
      promoAdjustmentCents: 0,
      finalPriceCents: totalPriceCents,
      guests,
    },
    editableFrom: D(overrides.editableFrom),
    newCheckOut: D(overrides.newCheckOut),
    seasons: SEASONS,
    ...(overrides.addGuests ? { addGuests: overrides.addGuests } : {}),
    ...(overrides.removeGuestIds ? { removeGuestIds: overrides.removeGuestIds } : {}),
  };
}

describe("buildInProgressGuestRangePlan — #2029 check-out-day extension pricing", () => {
  it("(a) charges exactly 1 night for a check-out-day +1 extension (was free)", () => {
    // today == checkOut (2026-08-24) => editableFrom = NZ tomorrow (08-25).
    const plan = pricedPlan(
      planInput({ editableFrom: "2026-08-25", newCheckOut: "2026-08-25" }),
    );

    // The added night is the check-out day itself (08-24), priced at RATE.
    expect(plan.proposedExistingGuests[0].futureDeltaCents).toBe(RATE);
    expect(plan.futureExistingDeltaCents).toBe(RATE);
    expect(plan.priceDiffCents).toBe(RATE);
    expect(plan.newFinalPriceCents).toBe(4 * RATE + RATE);
    expect(plan.proposedExistingGuests[0].priceCents).toBe(4 * RATE + RATE);
    // The guest's stay now runs to the new check-out.
    expect(plan.proposedExistingGuests[0].stayEnd).toEqual(D("2026-08-25"));
  });

  it("(b) charges exactly 2 nights for a check-out-day +2 extension", () => {
    const plan = pricedPlan(
      planInput({ editableFrom: "2026-08-25", newCheckOut: "2026-08-26" }),
    );

    // Added nights: 08-24 (the check-out day) and 08-25.
    expect(plan.proposedExistingGuests[0].futureDeltaCents).toBe(2 * RATE);
    expect(plan.priceDiffCents).toBe(2 * RATE);
    expect(plan.newFinalPriceCents).toBe(4 * RATE + 2 * RATE);
  });

  it("(c) last-night-day extension still charges exactly the added nights (regression pin)", () => {
    // today == checkOut - 1 (2026-08-23) => editableFrom = 08-24 == original
    // check-out. This case was ALREADY correct before #2029; pin it unchanged.
    const plan = pricedPlan(
      planInput({ editableFrom: "2026-08-24", newCheckOut: "2026-08-26" }),
    );

    // Added nights: 08-24 and 08-25.
    expect(plan.proposedExistingGuests[0].futureDeltaCents).toBe(2 * RATE);
    expect(plan.priceDiffCents).toBe(2 * RATE);
  });

  it("(d) mid-stay extension is unchanged", () => {
    // today == 2026-08-21 => editableFrom = 08-22, well before the old check-out.
    const plan = pricedPlan(
      planInput({ editableFrom: "2026-08-22", newCheckOut: "2026-08-26" }),
    );

    // Added nights: 08-24 and 08-25 (the [22,24) future window is unchanged).
    expect(plan.proposedExistingGuests[0].futureDeltaCents).toBe(2 * RATE);
    expect(plan.priceDiffCents).toBe(2 * RATE);
  });

  it("(e) rejects a check-out shrink below editableFrom", () => {
    expect(() =>
      buildInProgressGuestRangePlan(
        planInput({ editableFrom: "2026-08-25", newCheckOut: "2026-08-24" }),
      ),
    ).toThrow(/Check-out cannot move before NZ tomorrow/);
  });

  it("charges per guest: a two-guest check-out-day +1 costs one night each", () => {
    const plan = pricedPlan(
      planInput({ editableFrom: "2026-08-25", newCheckOut: "2026-08-25" }, [
        guest("2026-08-20", "2026-08-24", 4 * RATE, "g1"),
        guest("2026-08-20", "2026-08-24", 4 * RATE, "g2"),
      ]),
    );

    for (const entry of plan.proposedExistingGuests) {
      expect(entry.futureDeltaCents).toBe(RATE);
    }
    expect(plan.futureExistingDeltaCents).toBe(2 * RATE);
    expect(plan.priceDiffCents).toBe(2 * RATE);
  });

  it("does not over-charge a future-dated partial-range guest (#713 guard preserved)", () => {
    // Guest only occupies [08-22, 08-24); their stay starts AFTER editableFrom.
    // The extension must still cost exactly their two added nights (08-24, 08-25),
    // never the [editableFrom, stayStart) nights they were never there for.
    const plan = pricedPlan(
      planInput({ editableFrom: "2026-08-21", newCheckOut: "2026-08-26" }, [
        guest("2026-08-22", "2026-08-24", 2 * RATE),
      ]),
    );

    expect(plan.proposedExistingGuests[0].futureDeltaCents).toBe(2 * RATE);
  });
});

describe("buildInProgressGuestRangePlan — #2029 capacity ranges", () => {
  it("covers the check-out-day night in the +1 capacity range and window start", () => {
    const plan = pricedPlan(
      planInput({ editableFrom: "2026-08-25", newCheckOut: "2026-08-25" }),
    );

    expect(plan.capacityRangeStart).toEqual(D("2026-08-24"));
    // #2736: the range now also carries the exact nights it occupies. For this
    // contiguous guest that is the window expanded, night for night, so the
    // capacity verdict is unchanged.
    expect(plan.capacityGuestRanges).toEqual([
      {
        stayStart: D("2026-08-24"),
        stayEnd: D("2026-08-25"),
        nights: [D("2026-08-24")],
        memberId: "m-g1",
      },
    ]);
  });

  it("covers both new nights in a +2 capacity range", () => {
    const plan = pricedPlan(
      planInput({ editableFrom: "2026-08-25", newCheckOut: "2026-08-26" }),
    );

    expect(plan.capacityRangeStart).toEqual(D("2026-08-24"));
    expect(plan.capacityGuestRanges).toEqual([
      {
        stayStart: D("2026-08-24"),
        stayEnd: D("2026-08-26"),
        nights: [D("2026-08-24"), D("2026-08-25")],
        memberId: "m-g1",
      },
    ]);
  });

  it("leaves the capacity window at editableFrom for a mid-stay extension (unchanged)", () => {
    const plan = pricedPlan(
      planInput({ editableFrom: "2026-08-22", newCheckOut: "2026-08-26" }),
    );

    expect(plan.capacityRangeStart).toEqual(D("2026-08-22"));
    expect(plan.capacityGuestRanges[0].stayStart).toEqual(D("2026-08-22"));
  });

  it("anchors a future-dated partial-range guest's capacity range at their arrival, not earlier (#713)", () => {
    const plan = pricedPlan(
      planInput({ editableFrom: "2026-08-21", newCheckOut: "2026-08-26" }, [
        guest("2026-08-22", "2026-08-24", 2 * RATE),
      ]),
    );

    // The guest arrives 08-22, so their checked range never starts before then.
    expect(plan.capacityGuestRanges[0].stayStart).toEqual(D("2026-08-22"));
  });
});
