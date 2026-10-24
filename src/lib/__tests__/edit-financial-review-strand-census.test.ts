import { describe, expect, it } from "vitest";

/**
 * #3498 (owner decision D1) and #4317: EVERY STORED FIGURE ON A REVIEW ITEM ALREADY
 * ON FILE STILL READS BACK.
 *
 * Until #4317 a parked edit raised `EDIT_FINANCIAL_REVIEW` work items, each
 * carrying, per guest strand, the strand's cause, the nights the edit took from
 * it and gave it, its stored guest total and every stored night-price row it
 * held. #4317 (epic #4302) prices every edit, so nothing raises an item any more
 * — but the items already raised stay open until wave B settles them, and the
 * finance queue and settle screens read them through
 * `parseEditFinancialReviewContext`. A figure that parser stops reading is a
 * figure nothing in the database holds any more: the parked edit deleted the
 * rows it came from.
 *
 * So this census is now over the PARSER, on the shapes production is holding:
 *
 *  - `RECORDED_STRAND_FIELDS` is a FROZEN MANIFEST of every field a strand's
 *    record carries. Dropping one fails by name;
 *  - every field is asserted against the value written in the fixture, so a
 *    parser that keeps the field with a hollowed-out value fails too;
 *  - the fixture holds every cause the raise could record, in both the one-item
 *    grain (a lead strand with `otherStrands`) and a v1 row from before #3498.
 */

import {
  editFinancialReviewStrandRecords,
  parseEditFinancialReviewContext,
  type EditFinancialReviewStrandRecord,
} from "@/lib/edit-financial-review-context";

/** EVERY FIELD ONE STRAND'S RECORD MUST STILL CARRY, as a path. */
const RECORDED_STRAND_FIELDS = [
  "bookingGuestId",
  "cause",
  "surrenderedNightDates",
  "addedNightDates",
  "storedEvidence.guestTotalCents",
  "storedEvidence.nightPrices[].date",
  "storedEvidence.nightPrices[].priceCents",
] as const;

function fieldPresent(
  strand: EditFinancialReviewStrandRecord,
  path: (typeof RECORDED_STRAND_FIELDS)[number],
): boolean {
  switch (path) {
    case "bookingGuestId":
      return typeof strand.bookingGuestId === "string";
    case "cause":
      return typeof strand.cause === "string";
    case "surrenderedNightDates":
      return Array.isArray(strand.surrenderedNightDates);
    case "addedNightDates":
      return Array.isArray(strand.addedNightDates);
    case "storedEvidence.guestTotalCents":
      return (
        strand.storedEvidence !== undefined &&
        "guestTotalCents" in strand.storedEvidence
      );
    case "storedEvidence.nightPrices[].date":
      return (
        Array.isArray(strand.storedEvidence?.nightPrices) &&
        strand.storedEvidence.nightPrices.every(
          (night) => typeof night.date === "string",
        )
      );
    case "storedEvidence.nightPrices[].priceCents":
      return (
        Array.isArray(strand.storedEvidence?.nightPrices) &&
        strand.storedEvidence.nightPrices.every(
          (night) => "priceCents" in night,
        )
      );
  }
}

const NIGHTS = ["2026-08-01", "2026-08-02", "2026-08-03"];

function evidence(guestTotalCents: number | null, prices: ReadonlyArray<number | null>) {
  return {
    guestTotalCents,
    nightPrices: NIGHTS.map((date, index) => ({
      date,
      priceCents: prices[index] ?? null,
    })),
  };
}

/**
 * One item of each cause the deleted raise could record, as it wrote them: the
 * lead strand on the occurrence, the rest under `otherStrands`.
 */
const LEAD = {
  bookingGuestId: "no-prices",
  cause: "NO_STORED_NIGHT_PRICES",
  surrenderedNightDates: ["2026-08-03"],
  addedNightDates: [],
  storedEvidence: evidence(24_000, [null, null, null]),
} as const;
const OTHER_STRANDS = [
  {
    bookingGuestId: "partial",
    cause: "PARTIAL_STORED_NIGHT_PRICES",
    surrenderedNightDates: [],
    addedNightDates: [],
    storedEvidence: evidence(24_000, [8_000, null, 8_000]),
  },
  {
    bookingGuestId: "mismatch",
    cause: "STORED_TOTAL_MISMATCH",
    surrenderedNightDates: [],
    addedNightDates: [],
    storedEvidence: evidence(30_000, [8_000, 8_000, 8_000]),
  },
  {
    bookingGuestId: "even-split",
    cause: "INEXACT_STORED_NIGHT_PRICES",
    surrenderedNightDates: ["2026-08-02", "2026-08-03"],
    addedNightDates: [],
    storedEvidence: evidence(24_000, [8_000, 8_000, 8_000]),
  },
  {
    bookingGuestId: "extended",
    cause: "COUNTERPART_STRAND_UNREADABLE",
    surrenderedNightDates: [],
    addedNightDates: ["2026-08-04"],
    storedEvidence: evidence(24_000, [8_000, 8_000, 8_000]),
  },
] as const;
const ALL_STRANDS = [LEAD, ...OTHER_STRANDS];

const ON_FILE = {
  version: 1,
  occurrence: { bookingId: "booking-1", ...LEAD, otherStrands: OTHER_STRANDS },
  guestMemberId: null,
  bookingCheckIn: "2026-08-01",
  bookingCheckOut: "2026-08-04",
  guestsAddedByEdit: null,
  bookingModificationId: "mod-1",
};

function readBack() {
  const parsed = parseEditFinancialReviewContext(
    JSON.parse(JSON.stringify(ON_FILE)),
  );
  if (!parsed) throw new Error("A review context production holds failed to parse.");
  return editFinancialReviewStrandRecords(parsed.occurrence);
}

describe("#4317 census: a review item already on file loses no stored figure", () => {
  it("reads back every strand the raise recorded, lead first, once each", () => {
    expect(readBack().map((strand) => strand.bookingGuestId)).toEqual(
      ALL_STRANDS.map((strand) => strand.bookingGuestId),
    );
  });

  it.each(ALL_STRANDS.map((strand) => strand.bookingGuestId))(
    "carries every manifest field on the %s strand",
    (bookingGuestId) => {
      const strand = readBack().find(
        (candidate) => candidate.bookingGuestId === bookingGuestId,
      );
      expect(strand).toBeDefined();
      expect(
        RECORDED_STRAND_FIELDS.filter((path) => !fieldPresent(strand!, path)),
      ).toEqual([]);
    },
  );

  it("reads the real stored figures, not hollowed-out ones", () => {
    const read = readBack();
    for (const fixture of ALL_STRANDS) {
      const strand = read.find(
        (candidate) => candidate.bookingGuestId === fixture.bookingGuestId,
      );
      expect(strand?.cause).toBe(fixture.cause);
      expect(strand?.storedEvidence).toEqual(fixture.storedEvidence);
      expect(strand?.surrenderedNightDates).toEqual(fixture.surrenderedNightDates);
      expect(strand?.addedNightDates).toEqual(fixture.addedNightDates);
    }
  });

  it("still reads a row written BEFORE the grain moved, which production is holding", () => {
    /*
      #3498 did not migrate the items already raised - they are worked by hand -
      so a v1 row, which has no `otherStrands` at all, must parse exactly as it
      always did and read back as the one-strand item it is.
    */
    const legacy = {
      version: 1,
      occurrence: {
        bookingId: "booking-legacy",
        bookingGuestId: "guest-legacy",
        cause: "INEXACT_STORED_NIGHT_PRICES",
        surrenderedNightDates: [],
        addedNightDates: [],
        storedEvidence: {
          guestTotalCents: 14_000,
          nightPrices: [{ date: "2026-08-01", priceCents: 14_000 }],
        },
      },
      guestMemberId: null,
      bookingCheckIn: "2026-08-01",
      bookingCheckOut: "2026-08-02",
      bookingModificationId: null,
    };
    const parsed = parseEditFinancialReviewContext(legacy);
    expect(parsed).not.toBeNull();
    expect(parsed!.occurrence.otherStrands).toBeUndefined();
    expect(
      editFinancialReviewStrandRecords(parsed!.occurrence).map(
        (strand) => strand.bookingGuestId,
      ),
    ).toEqual(["guest-legacy"]);
  });
});
