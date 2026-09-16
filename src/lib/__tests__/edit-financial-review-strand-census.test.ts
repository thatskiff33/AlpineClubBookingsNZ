import { describe, expect, it } from "vitest";

/**
 * #3498 (owner decision D1): NO STORED FIGURE IS LOST WHEN THE GRAIN MOVES.
 *
 * Until #3498 each guest strand of a parked edit became its own
 * `EDIT_FINANCIAL_REVIEW` work item, carrying that strand's cause, the nights
 * the edit took from it and gave it, its stored guest total and every stored
 * night-price row it held. D1 collapses those into ONE item per edit. The whole
 * hazard of that change is that a figure quietly stops being written down: the
 * per-strand records exist precisely because a parked edit deletes and recreates
 * night rows, so a number it stops recording is a number nothing in the database
 * holds any more.
 *
 * D1 therefore asks for a census, and this is it. It is deliberately NOT another
 * "does the happy path still work" test:
 *
 *  - `RECORDED_STRAND_FIELDS` is a FROZEN MANIFEST of every field a strand's
 *    record carried before the grain moved. Adding a field to the record does
 *    not fail; dropping one does, by name;
 *  - every field is asserted against the value the edit ACTUALLY destroyed, read
 *    from the fixture rather than from the record, so a record that carries the
 *    field with a hollowed-out value fails too;
 *  - it runs over one parked edit holding EVERY SHAPE the current code records -
 *    all four unreadable causes and all three ways an exact strand's evidence is
 *    destroyed - because a census over one shape proves one shape;
 *  - and it asserts the whole thing SURVIVES THE WRITE, through the same
 *    `parseEditFinancialReviewContext` the raise validates with and the finance
 *    queue reads back. A record composed correctly and then refused, truncated
 *    or silently dropped by that schema is lost just as thoroughly.
 *
 * Mutation-verified per `docs/TESTING.md`: removing `storedEvidence.nightPrices`
 * from `composeStrandRecord`, removing `otherStrands` from `occurrenceSchema`,
 * and returning only the lead strand from `parkedEditOccurrence` each fail this
 * file by name, and each mutation was restored.
 */

import {
  editFinancialReviewStrandRecords,
  parseEditFinancialReviewContext,
  type EditFinancialReviewContext,
  type EditFinancialReviewStrandRecord,
} from "@/lib/edit-financial-review-context";
import {
  preCheckInEditEvidence,
  type PreCheckInEditStrand,
} from "@/lib/stored-sold-price-evidence";

/**
 * EVERY FIELD ONE STRAND'S RECORD MUST STILL CARRY, as a path.
 *
 * Measured off the pre-#3498 `EditFinancialReviewOccurrence`, which is what one
 * work item was. `bookingId` is not here because it belongs to the edit rather
 * than to a strand and lives once on the occurrence; everything else on that
 * type is per-strand and is listed.
 */
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

const BOOKING = {
  checkIn: new Date("2026-08-01"),
  checkOut: new Date("2026-08-04"),
};

const NIGHTS = ["2026-08-01", "2026-08-02", "2026-08-03"] as const;

function nightsHeld(
  prices: ReadonlyArray<number | null>,
  source: "SOLD" | "EVEN_SPLIT" | "UNKNOWN" = "SOLD",
) {
  return NIGHTS.map((stayDate, index) => ({
    stayDate: new Date(stayDate),
    priceCents: prices[index] ?? null,
    priceSource: source,
  }));
}

const allNights = NIGHTS.map((date) => new Date(date));

/**
 * One parked edit holding every shape the current code records.
 *
 * Each strand is named for what it proves, and the fixture is the SOURCE OF
 * TRUTH for the assertions below - the census reads the expected figures from
 * here, never from the record it is checking.
 */
const STRANDS: readonly PreCheckInEditStrand[] = [
  // NO_STORED_NIGHT_PRICES: nothing stored at all.
  {
    bookingGuestId: "no-prices",
    guestTotalCents: 24_000,
    nights: nightsHeld([null, null, null], "UNKNOWN"),
    proposedNightDates: allNights,
  },
  // PARTIAL_STORED_NIGHT_PRICES: some rows priced, some blank.
  {
    bookingGuestId: "partial",
    guestTotalCents: 24_000,
    nights: nightsHeld([8_000, null, 8_000]),
    proposedNightDates: allNights,
  },
  // STORED_TOTAL_MISMATCH: every row priced, and they do not add up.
  {
    bookingGuestId: "mismatch",
    guestTotalCents: 30_000,
    nights: nightsHeld([8_000, 8_000, 8_000]),
    proposedNightDates: allNights,
  },
  // INEXACT_STORED_NIGHT_PRICES: reconciles as a whole guest, from an even
  // split, while the edit moves individual nights.
  {
    bookingGuestId: "even-split",
    guestTotalCents: 24_000,
    nights: nightsHeld([8_000, 8_000, 8_000], "EVEN_SPLIT"),
    proposedNightDates: [new Date("2026-08-01")],
  },
  // COUNTERPART_STRAND_UNREADABLE, way 1: gives nights back.
  {
    bookingGuestId: "shortened",
    guestTotalCents: 24_000,
    nights: nightsHeld([8_000, 8_000, 8_000]),
    proposedNightDates: [new Date("2026-08-01")],
  },
  // COUNTERPART_STRAND_UNREADABLE, way 2: gains nights against a frozen total.
  {
    bookingGuestId: "extended",
    guestTotalCents: 24_000,
    nights: nightsHeld([8_000, 8_000, 8_000]),
    proposedNightDates: [...allNights, new Date("2026-08-04")],
  },
  // COUNTERPART_STRAND_UNREADABLE, way 3: its rows are deleted outright.
  {
    bookingGuestId: "removed",
    guestTotalCents: 24_000,
    nights: nightsHeld([8_000, 8_000, 8_000]),
    proposedNightDates: [],
    rowsDestroyed: true,
  },
  // The CONTROL, and it is load-bearing: an exact strand whose night set does
  // not move keeps every row byte for byte, so there is nothing of its to
  // record. A census that recorded everything would pass without it.
  {
    bookingGuestId: "untouched",
    guestTotalCents: 24_000,
    nights: nightsHeld([8_000, 8_000, 8_000]),
    proposedNightDates: allNights,
  },
];

/** Every strand the edit records, which is every one above except the control. */
const RECORDED_GUEST_IDS = [
  "no-prices",
  "partial",
  "mismatch",
  "even-split",
  "shortened",
  "extended",
  "removed",
] as const;

function parkedEdit() {
  const { occurrence } = preCheckInEditEvidence({
    bookingId: "booking-1",
    booking: BOOKING,
    strands: STRANDS,
  });
  if (occurrence === null) {
    throw new Error("The fixture must park; it holds four unreadable strands.");
  }
  return occurrence;
}

describe("#3498 census: one item per parked edit loses no stored figure", () => {
  it("raises exactly ONE occurrence for an edit touching eight strands", () => {
    const occurrence = parkedEdit();
    expect(occurrence.bookingId).toBe("booking-1");
    // The acceptance criterion, as a fact about the value rather than a count of
    // rows written: there is one identity, so there is one work item.
    expect(editFinancialReviewStrandRecords(occurrence)).toHaveLength(
      RECORDED_GUEST_IDS.length,
    );
  });

  it("records EVERY strand the per-strand rule recorded, and no other", () => {
    const recorded = editFinancialReviewStrandRecords(parkedEdit());
    expect([...recorded.map((strand) => strand.bookingGuestId)].sort()).toEqual(
      [...RECORDED_GUEST_IDS].sort(),
    );
  });

  it.each(RECORDED_GUEST_IDS)(
    "carries every manifest field on the %s strand",
    (bookingGuestId) => {
      const strand = editFinancialReviewStrandRecords(parkedEdit()).find(
        (candidate) => candidate.bookingGuestId === bookingGuestId,
      );
      expect(strand).toBeDefined();
      const missing = RECORDED_STRAND_FIELDS.filter(
        (path) => !fieldPresent(strand!, path),
      );
      expect(missing).toEqual([]);
    },
  );

  it("records the real stored figures, not hollowed-out ones", () => {
    const recorded = editFinancialReviewStrandRecords(parkedEdit());
    for (const fixture of STRANDS) {
      const strand = recorded.find(
        (candidate) => candidate.bookingGuestId === fixture.bookingGuestId,
      );
      if (!RECORDED_GUEST_IDS.includes(fixture.bookingGuestId as never)) {
        expect(strand).toBeUndefined();
        continue;
      }
      expect(strand).toBeDefined();
      // The stored total, as the fixture holds it.
      expect(strand!.storedEvidence.guestTotalCents).toBe(
        fixture.guestTotalCents,
      );
      // One evidence row per night the strand HELD - including the blanks, which
      // are the absence an admin needs to see rather than a zero.
      expect(strand!.storedEvidence.nightPrices).toEqual(
        (fixture.nights ?? []).map((night) => ({
          date: (night.stayDate as Date).toISOString().slice(0, 10),
          priceCents: night.priceCents ?? null,
        })),
      );
      // And what the edit did to it: the nights it took and the nights it gave.
      const held = new Set(
        (fixture.nights ?? []).map((night) =>
          (night.stayDate as Date).toISOString().slice(0, 10),
        ),
      );
      const proposed = new Set(
        fixture.proposedNightDates.map((date) =>
          (date as Date).toISOString().slice(0, 10),
        ),
      );
      expect([...strand!.surrenderedNightDates].sort()).toEqual(
        [...held].filter((date) => !proposed.has(date)).sort(),
      );
      expect([...strand!.addedNightDates].sort()).toEqual(
        [...proposed].filter((date) => !held.has(date)).sort(),
      );
    }
  });

  it("survives the WRITE: every strand round-trips through the stored-context schema", () => {
    const occurrence = parkedEdit();
    const context: EditFinancialReviewContext = {
      version: 1,
      occurrence,
      guestMemberId: null,
      bookingCheckIn: "2026-08-01" as never,
      bookingCheckOut: "2026-08-04" as never,
      guestsAddedByEdit: null,
      bookingModificationId: "mod-1",
    };
    /*
      The raise refuses to write a context this parser cannot read back, so a
      schema that silently dropped `otherStrands` would not lose the evidence
      quietly - it would lose the whole item. Either way the figures are gone,
      which is why the census checks the round trip rather than the composition
      alone.
    */
    const parsed = parseEditFinancialReviewContext(context);
    expect(parsed).not.toBeNull();
    expect(
      editFinancialReviewStrandRecords(parsed!.occurrence),
    ).toEqual(editFinancialReviewStrandRecords(occurrence));
  });

  it("RAISES AN ITEM ON A PURE GUEST ADD, where no existing strand moves at all", () => {
    /*
      THE CASE THAT RULES OUT THE SMALL FIX, and the acceptance criterion in its
      own right. Adding guests surrenders no night and gains none on any strand
      already on the booking, so "filter the fan-out down to the strands the edit
      touched" raises NOTHING and the money owed for the new guests vanishes -
      which is exactly why the grain moves UP instead.

      Every strand here is untouched and unreadable, so `parkedEditOccurrence`
      ranks them all equally and the lead is decided by guest id alone. What the
      add is worth rides on `EditFinancialReviewContext.guestsAddedByEdit`, as
      it has since #3166.
    */
    const { occurrence } = preCheckInEditEvidence({
      bookingId: "booking-add",
      booking: BOOKING,
      strands: [
        {
          bookingGuestId: "b-existing",
          guestTotalCents: 24_000,
          nights: nightsHeld([null, null, null], "UNKNOWN"),
          proposedNightDates: allNights,
        },
        {
          bookingGuestId: "a-existing",
          guestTotalCents: 24_000,
          nights: nightsHeld([null, null, null], "UNKNOWN"),
          proposedNightDates: allNights,
        },
      ],
    });
    expect(occurrence).not.toBeNull();
    expect(
      editFinancialReviewStrandRecords(occurrence!).map(
        (strand) => strand.bookingGuestId,
      ),
    ).toEqual(["a-existing", "b-existing"]);
    // And nothing anywhere on it claims a night moved, because none did.
    for (const strand of editFinancialReviewStrandRecords(occurrence!)) {
      expect(strand.surrenderedNightDates).toEqual([]);
      expect(strand.addedNightDates).toEqual([]);
    }
  });

  it("still reads a row written BEFORE the grain moved, which production is holding", () => {
    /*
      #3498 does not migrate the items already raised - they are worked by hand -
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
