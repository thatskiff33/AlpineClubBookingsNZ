import { describe, expect, it } from "vitest";

import {
  bookingPromoCodeSnapshot,
  changeRequestPromoChangeSchema,
  PROMO_CHANGE_SUMMARY_SUFFIX,
  promoChangeBatchFields,
  promoChangeChangesCodes,
  promoChangeCodes,
  promoCodesDriftedFromRequest,
  withPromoChange,
} from "@/lib/booking-change-request-promo";
import {
  lockedPeriodRequestToBatchInput,
  storedLockedPeriodRequestSchema,
  storedRequestNamesNoChange,
  storedRequestNamesOnlyPromoChange,
  storedRequestPromoFacts,
} from "@/lib/booking-change-request-stored";

/**
 * #4533: the promo change a finished-stay change request carries — its shape,
 * its stored record, and how approval maps it onto the batch edit.
 */

const BOOKING = {
  checkIn: new Date("2026-06-10T00:00:00.000Z"),
  checkOut: new Date("2026-06-12T00:00:00.000Z"),
};

/** A stored request naming no change, as Edit Booking's correction card writes it before the promo. */
function emptyRequest(extra: Record<string, unknown> = {}) {
  return {
    original: {
      checkIn: "2026-06-10",
      checkOut: "2026-06-12",
      guests: [{ id: "g1", stayStart: "2026-06-10", stayEnd: "2026-06-12", nights: null }],
    },
    requested: {
      checkIn: null,
      checkOut: null,
      addGuests: [],
      removeGuests: [],
      guestStayRanges: [],
      requestedEffectiveDate: null,
      ...extra,
    },
    lockedPeriod: { today: "2026-07-01", editableFrom: null, touchesLockedPeriod: true },
    payment: null,
  };
}

const STAMP = { officerMemberId: "officer-1", enteredAt: new Date("2026-07-01T00:00:00.000Z"), enteredOn: "request" as const };

describe("the promo change's shape (#4533)", () => {
  it("accepts Edit Booking's one-code field, with guests", () => {
    expect(changeRequestPromoChangeSchema.parse({ promoCode: " freenight ", promoGuestIds: ["g1"] })).toEqual({
      promoCode: "freenight",
      promoGuestIds: ["g1"],
    });
  });

  it("accepts Edit Booking's plural list", () => {
    expect(
      changeRequestPromoChangeSchema.safeParse({ promoCodes: [{ code: "A" }, { code: "B", promoGuestIds: ["g1"] }] })
        .success,
    ).toBe(true);
  });

  it("refuses both shapes at once, neither, guests beside a list, and an empty list", () => {
    for (const body of [
      { promoCode: "A", promoCodes: [{ code: "B" }] },
      {},
      { promoCodes: [{ code: "A" }], promoGuestIds: ["g1"] },
      { promoCodes: [] },
      { promoGuestIds: ["g1"] },
    ]) {
      expect(changeRequestPromoChangeSchema.safeParse(body).success).toBe(false);
    }
  });

  it("cannot express a removal, or targets for guests being added", () => {
    expect(changeRequestPromoChangeSchema.safeParse({ removePromoCode: true }).success).toBe(false);
    expect(changeRequestPromoChangeSchema.safeParse({ promoCode: "A", promoAddedGuestIndexes: [0] }).success).toBe(
      false,
    );
    expect(
      changeRequestPromoChangeSchema.safeParse({ promoCodes: [{ code: "A", promoAddedGuestIndexes: [0] }] }).success,
    ).toBe(false);
  });

  it("maps to the batch edit's own promo fields and reads codes through the edit's reader", () => {
    expect(promoChangeBatchFields({ promoCode: "A", promoGuestIds: ["g1"] })).toEqual({
      promoCode: "A",
      promoGuestIds: ["g1"],
    });
    expect(promoChangeBatchFields({ promoCodes: [{ code: "A" }] })).toEqual({ promoCodes: [{ code: "A" }] });
    // The stored spelling (#3770): upper-cased and trimmed, as the edit stores it.
    expect(promoChangeCodes({ promoCode: "freenight" })).toEqual(["FREENIGHT"]);
  });
});

describe("judging a promo change against the booking's codes (#4533)", () => {
  it("is no change when the list names exactly the codes the booking holds", () => {
    expect(promoChangeChangesCodes({ promoCodes: [{ code: "a" }] }, ["A"])).toBe(false);
    expect(promoChangeChangesCodes({ promoCode: "A" }, ["A"])).toBe(false);
    expect(promoChangeChangesCodes({ promoCode: "B" }, ["A"])).toBe(true);
    expect(promoChangeChangesCodes({ promoCode: "A" }, [])).toBe(true);
    // Choosing guests for a held code is a change in who it covers.
    expect(promoChangeChangesCodes({ promoCode: "A", promoGuestIds: ["g1"] }, ["A"])).toBe(true);
  });

  it("drifts when a code is applied or released since the snapshot, and not without one", () => {
    expect(promoCodesDriftedFromRequest(["A"], ["A"])).toBe(false);
    expect(promoCodesDriftedFromRequest([], ["A"])).toBe(true);
    expect(promoCodesDriftedFromRequest(["A"], [])).toBe(true);
    expect(promoCodesDriftedFromRequest(null, ["A"])).toBe(false);
    expect(promoCodesDriftedFromRequest(undefined, [])).toBe(false);
  });

  it("snapshots the booking's codes sorted, skipping a redemption with no code", () => {
    expect(
      bookingPromoCodeSnapshot([{ promoCode: { code: "B" } }, { promoCode: null }, { promoCode: { code: "A" } }]),
    ).toEqual(["A", "B"]);
  });
});

describe("the stored record (#4533)", () => {
  it("writes the change, its stamp, the codes it was entered against and the summary, keeping the rest", () => {
    const written = withPromoChange(emptyRequest(), { promoCode: "FREENIGHT" }, STAMP, ["OTHER"]);
    const stored = storedLockedPeriodRequestSchema.parse(written);
    expect(stored.original.promoCodes).toEqual(["OTHER"]);
    expect(stored.requested.promoChange).toEqual({
      promoCode: "FREENIGHT",
      enteredBy: {
        onMemberBehalf: true,
        officerMemberId: "officer-1",
        enteredAt: "2026-07-01T00:00:00.000Z",
        enteredOn: "request",
      },
    });
    expect((written.requested as { summary: string }).summary).toBe(
      `apply promo code FREENIGHT ${PROMO_CHANGE_SUMMARY_SUFFIX}`,
    );
    expect(written.lockedPeriod).toEqual(emptyRequest().lockedPeriod);
    expect(stored.original.guests).toHaveLength(1);
  });

  it("extends a request's own summary rather than replacing it", () => {
    const written = withPromoChange(emptyRequest({ summary: "add Late Friend" }), { promoCode: "A" }, STAMP, []);
    expect((written.requested as { summary: string }).summary).toBe(
      `add Late Friend; apply promo code A ${PROMO_CHANGE_SUMMARY_SUFFIX}`,
    );
  });

  it("is mapped by approval onto the batch edit, and a request with only a promo change names a change", () => {
    const stored = storedLockedPeriodRequestSchema.parse(
      withPromoChange(emptyRequest(), { promoCode: "A", promoGuestIds: ["g1"] }, STAMP, []),
    );
    expect(lockedPeriodRequestToBatchInput(stored, BOOKING)).toEqual({ promoCode: "A", promoGuestIds: ["g1"] });
    expect(storedRequestNamesNoChange(stored, BOOKING)).toBe(false);
    expect(storedRequestNamesOnlyPromoChange(stored, BOOKING)).toBe(true);
    expect(storedRequestPromoFacts(stored, BOOKING)).toEqual({
      takesPromoEntry: false,
      promoCorrection: { codes: ["A"], onlyChange: true },
    });
  });

  it("is not promo-only beside a guest change, and a request without one takes an entry", () => {
    const withGuest = emptyRequest({
      addGuests: [{ firstName: "Late", lastName: "Friend", ageTier: "ADULT", isMember: false }],
    });
    const stored = storedLockedPeriodRequestSchema.parse(withPromoChange(withGuest, { promoCode: "A" }, STAMP, []));
    expect(storedRequestNamesOnlyPromoChange(stored, BOOKING)).toBe(false);
    expect(storedRequestPromoFacts(withGuest, BOOKING)).toEqual({ takesPromoEntry: true, promoCorrection: null });
    // An unreadable row takes no entry: the executor would refuse it as unreadable.
    expect(storedRequestPromoFacts({ nonsense: true }, BOOKING)).toEqual({
      takesPromoEntry: false,
      promoCorrection: null,
    });
  });

  it("reads a row written before #4533 exactly as before", () => {
    const stored = storedLockedPeriodRequestSchema.parse(emptyRequest());
    expect(stored.requested.promoChange).toBeUndefined();
    expect(stored.original.promoCodes).toBeUndefined();
    expect(lockedPeriodRequestToBatchInput(stored, BOOKING)).toBeNull();
  });
});
