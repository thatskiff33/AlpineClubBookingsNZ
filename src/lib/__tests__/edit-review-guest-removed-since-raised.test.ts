import { describe, expect, it } from "vitest";

import {
  editFinancialReviewGuestsRemovedSinceRaised,
  parseEditFinancialReviewContext,
} from "@/lib/edit-financial-review-context";
import { reviewGuestRemovedSinceRaisedWarning } from "@/lib/manual-refund-task-copy";
import { toOpenManualRefundTaskPayload } from "@/lib/manual-refund-task-queue-payload";

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/**
 * #4317 (owner decision on #4302, after review round 1): AN OPEN REVIEW WHOSE
 * GUEST WAS REMOVED AFTER IT WAS RAISED WARNS THE OFFICER.
 *
 * A priced removal credits the guest's whole stored total, which a parked edit
 * never changed: it still holds the nights the review's edit gave back (settling
 * could credit them a second time) and never held the nights it added (settling
 * could charge for nights the guest no longer holds). Wave B's clean-up closes such a review with no
 * money moved; until then the settle screen says so. The guest that a parked
 * REMOVAL itself took off - deleted in the transaction that raised the review -
 * is not one of these: nothing was credited for it.
 */

const NIGHTS = ["2026-08-01", "2026-08-02", "2026-08-03"];
const evidence = (total: number, prices: Array<number | null>) => ({
  guestTotalCents: total,
  nightPrices: NIGHTS.map((date, index) => ({ date, priceCents: prices[index] ?? null })),
});

/** A shortening of A that parked, beside B, which the edit did not touch. */
const SHORTENING = {
  version: 1,
  occurrence: {
    bookingId: "booking-1",
    bookingGuestId: "guest-a",
    cause: "PARTIAL_STORED_NIGHT_PRICES",
    surrenderedNightDates: ["2026-08-03"],
    addedNightDates: [],
    storedEvidence: evidence(30_000, [10_000, null, 10_000]),
    otherStrands: [
      {
        bookingGuestId: "guest-b",
        cause: "NO_STORED_NIGHT_PRICES",
        surrenderedNightDates: [],
        addedNightDates: [],
        storedEvidence: { guestTotalCents: 20_000, nightPrices: [] },
      },
    ],
  },
  guestMemberId: null,
  bookingCheckIn: "2026-08-01",
  bookingCheckOut: "2026-08-04",
  bookingModificationId: "mod-1",
};

/** A parked removal of C: its departing guest left in the edit that raised it. */
const PARKED_REMOVAL = {
  ...SHORTENING,
  occurrence: {
    bookingId: "booking-1",
    bookingGuestId: "guest-c",
    cause: "INEXACT_STORED_NIGHT_PRICES",
    surrenderedNightDates: NIGHTS,
    addedNightDates: [],
    storedEvidence: evidence(30_000, [10_000, 10_000, 10_000]),
  },
};

const read = (raw: unknown) => {
  const parsed = parseEditFinancialReviewContext(JSON.parse(JSON.stringify(raw)));
  if (!parsed) throw new Error("fixture failed to parse");
  return parsed;
};

describe("editFinancialReviewGuestsRemovedSinceRaised", () => {
  it("finds nobody while every guest the review names is still on the booking", () => {
    expect(
      editFinancialReviewGuestsRemovedSinceRaised(read(SHORTENING), new Set(["guest-a", "guest-b"])),
    ).toEqual([]);
  });

  it("finds the shortened guest once a removal has taken them off, with their place and stored total", () => {
    // A's nights MOVED, so the review's money is A's, and A's removal credited
    // A's stored $300 already.
    expect(
      editFinancialReviewGuestsRemovedSinceRaised(read(SHORTENING), new Set(["guest-b"])),
    ).toEqual([
      {
        bookingGuestId: "guest-a",
        strandIndex: 0,
        strandCount: 2,
        guestTotalCents: 30_000,
        gaveNightsBack: true,
        addedNights: false,
      },
    ]);
  });

  it("does NOT flag an untouched guest the review merely carries (review round 3)", () => {
    // B moved no nights: none of the review's money is B's, so B's removal can
    // credit nothing twice, and a warning would steer the officer away from the
    // money owed for A.
    expect(
      editFinancialReviewGuestsRemovedSinceRaised(read(SHORTENING), new Set(["guest-a"])),
    ).toEqual([]);
  });

  it("does NOT flag a pre-#3498 one-strand row about an untouched guest, removed since", () => {
    const untouchedOneStrand = {
      ...SHORTENING,
      occurrence: {
        bookingId: "booking-1",
        bookingGuestId: "guest-b",
        cause: "NO_STORED_NIGHT_PRICES",
        surrenderedNightDates: [],
        addedNightDates: [],
        storedEvidence: { guestTotalCents: 20_000, nightPrices: [] },
      },
    };
    expect(
      editFinancialReviewGuestsRemovedSinceRaised(read(untouchedOneStrand), new Set(["guest-a"])),
    ).toEqual([]);
  });

  it("does not count the guest a parked removal itself took off", () => {
    expect(
      editFinancialReviewGuestsRemovedSinceRaised(read(PARKED_REMOVAL), new Set(["guest-b"])),
    ).toEqual([]);
  });

  /** An extension of D that parked: D only ADDED a night, so the review is a charge. */
  const EXTENSION = {
    ...SHORTENING,
    occurrence: {
      bookingId: "booking-1",
      bookingGuestId: "guest-d",
      cause: "PARTIAL_STORED_NIGHT_PRICES",
      surrenderedNightDates: [],
      addedNightDates: ["2026-08-04"],
      storedEvidence: evidence(30_000, [10_000, null, 10_000]),
    },
  };

  it("flags a guest whose strand only ADDED nights, removed since, as a possible charge (review round 6)", () => {
    // THE FACT, settled at source: a parked edit left the guest's stored total
    // as it was (INV-MOD-040). On `main` every parked writer stored
    // `priceCents` unchanged - the batch save's pre-check-in park
    // (`priceCents: stored.priceCents`), the in-progress planner's park
    // (`priceCents: entry.guest.priceCents`) and the date change
    // (`parked ? g.priceCents : ...`) - and `booking-edit-financial-review-
    // parity.test.ts` pinned it: a three-night $150 strand extended to five
    // parked at $150. So D's added night was never in the total D's removal
    // credited, and settling this charge would bill a night D no longer holds.
    expect(editFinancialReviewGuestsRemovedSinceRaised(read(EXTENSION), new Set(["guest-b"]))).toEqual([
      {
        bookingGuestId: "guest-d",
        strandIndex: 0,
        strandCount: 1,
        guestTotalCents: 30_000,
        gaveNightsBack: false,
        addedNights: true,
      },
    ]);
  });

  it("flags a moved strand - nights given back AND added - in both directions", () => {
    const moved = {
      ...EXTENSION,
      occurrence: { ...EXTENSION.occurrence, surrenderedNightDates: ["2026-08-01"] },
    };
    expect(editFinancialReviewGuestsRemovedSinceRaised(read(moved), new Set(["guest-b"]))).toEqual([
      {
        bookingGuestId: "guest-d",
        strandIndex: 0,
        strandCount: 1,
        guestTotalCents: 30_000,
        gaveNightsBack: true,
        addedNights: true,
      },
    ]);
  });
});

describe("reviewGuestRemovedSinceRaisedWarning: worded in the direction the nights moved", () => {
  const guest = { ordinal: "Guest 1 of 2", guestTotalCents: 30_000 };
  it("a credit strand could credit its nights again", () => {
    const text = reviewGuestRemovedSinceRaisedWarning({ ...guest, gaveNightsBack: true, addedNights: false }, CLUB_FORMAT_TEST);
    expect(text).toContain("could credit those nights again");
    expect(text).not.toContain("could charge");
  });
  it("an add strand could charge for nights the guest no longer holds", () => {
    const text = reviewGuestRemovedSinceRaisedWarning({ ...guest, gaveNightsBack: false, addedNights: true }, CLUB_FORMAT_TEST);
    expect(text).toContain("could charge for nights this guest no longer holds");
    expect(text).not.toContain("could credit");
  });
  it("a mixed strand warns both ways", () => {
    const text = reviewGuestRemovedSinceRaisedWarning({ ...guest, gaveNightsBack: true, addedNights: true }, CLUB_FORMAT_TEST);
    expect(text).toContain("could credit those nights again");
    expect(text).toContain("could charge for nights this guest no longer holds");
  });
});

describe("the queue payload's reviewGuestRemovedSinceRaised", () => {
  const row = {
    id: "task-1",
    bookingId: "booking-1",
    amountCents: null,
    raisedAmountCents: null,
    kind: "EDIT_FINANCIAL_REVIEW",
    paymentId: null,
    payment: null,
    lateCaptureApprovalIntentId: null,
    partPaymentReviewPaymentId: null,
    partPaymentReviewXeroPaidAt: null,
    partPaymentReviewXeroPaidCents: null,
    occurrenceKey: "edit-financial-review:v1:abc",
    reviewContext: SHORTENING,
    reason: "r",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    booking: {
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      checkOut: new Date("2026-08-04T00:00:00.000Z"),
      member: { firstName: "Ann", lastName: "Owner" },
      organisation: null,
      memberId: "ann",
      deletedAt: null,
      organiserSettled: false,
      parentBookingId: null,
      status: "CONFIRMED",
      payment: null,
      guests: [{ id: "guest-b" }],
    },
  };

  it("names the shortened guest, removed since, by place and stored total - never by id", () => {
    expect(toOpenManualRefundTaskPayload(row, null, []).reviewGuestsRemovedSinceRaised).toEqual([
      { strandIndex: 0, strandCount: 2, guestTotalCents: 30_000, gaveNightsBack: true, addedNights: false },
    ]);
  });

  it("is empty while the guests are all still on the booking", () => {
    const stillThere = { ...row, booking: { ...row.booking, guests: [{ id: "guest-a" }, { id: "guest-b" }] } };
    expect(toOpenManualRefundTaskPayload(stillThere, null, []).reviewGuestsRemovedSinceRaised).toEqual([]);
  });

  it("is empty where the booking's guests were not read, and on a hand-back", () => {
    const bookingWithoutGuests: Omit<typeof row.booking, "guests"> & { guests?: undefined } = {
      ...row.booking,
      guests: undefined,
    };
    expect(
      toOpenManualRefundTaskPayload({ ...row, booking: bookingWithoutGuests }, null, [])
        .reviewGuestsRemovedSinceRaised,
    ).toEqual([]);
    expect(
      toOpenManualRefundTaskPayload({ ...row, kind: "CANCELLED_BOOKING_HAND_BACK" }, null, [])
        .reviewGuestsRemovedSinceRaised,
    ).toEqual([]);
  });
});
