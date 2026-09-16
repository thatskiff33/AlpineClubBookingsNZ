import { describe, expect, it } from "vitest";

/**
 * #3166 (epic #2797): WHICH STRANDS A PARKED PRE-CHECK-IN EDIT RECORDS.
 *
 * `preCheckInEditEvidence` answers two questions at once, and only the first is
 * obvious. Whether the edit parks at all is decided by the strands whose own
 * rows cannot be read. What ELSE gets written down is decided by which readable
 * strands this edit is about to make unreadable — and that half is the one that
 * silently destroys money, because a strand recorded nowhere leaves no trace of
 * having been exact.
 *
 * Three ways a parked edit destroys an exact strand's evidence, all covered
 * here: its rows are deleted (a removal), it gives nights BACK (both night
 * writers delete every row and recreate only the proposed ones), and it GAINS
 * nights against a frozen stored total (every new night is written `NULL`, so
 * the strand stops reconciling and is unpriceable for ever). Each case sits
 * beside a CONTROL proving the identical edit on a readable booking records
 * nothing at all — a gate that recorded everything would otherwise pass.
 */

import {
  preCheckInEditEvidence,
  type PreCheckInEditStrand,
} from "@/lib/stored-sold-price-evidence";
import { editFinancialReviewStrandRecords } from "@/lib/edit-financial-review-context";

const BOOKING = { checkIn: new Date("2026-08-01"), checkOut: new Date("2026-08-04") };

/** An exact strand: every night carries a stored price and they sum to its total. */
function exactStrand(
  bookingGuestId: string,
  nightDates: readonly string[],
  perNightCents: number,
  overrides: Partial<PreCheckInEditStrand> = {},
): PreCheckInEditStrand {
  return {
    bookingGuestId,
    guestTotalCents: perNightCents * nightDates.length,
    nights: nightDates.map((stayDate) => ({
      stayDate: new Date(stayDate),
      priceCents: perNightCents,
      priceSource: "SOLD",
    })),
    proposedNightDates: nightDates.map((stayDate) => new Date(stayDate)),
    ...overrides,
  };
}

/** A strand whose stored rows cannot price anything — one blank night. */
function unreadableStrand(bookingGuestId: string): PreCheckInEditStrand {
  return {
    bookingGuestId,
    guestTotalCents: 15000,
    nights: [
      { stayDate: new Date("2026-08-01"), priceCents: 5000, priceSource: "SOLD" },
      { stayDate: new Date("2026-08-02"), priceCents: null, priceSource: "UNKNOWN" },
      { stayDate: new Date("2026-08-03"), priceCents: 5000, priceSource: "SOLD" },
    ],
    proposedNightDates: [
      new Date("2026-08-01"),
      new Date("2026-08-02"),
      new Date("2026-08-03"),
    ],
  };
}

/**
 * The strands a parked edit RECORDED, read off the one occurrence it raises.
 *
 * #3498 moved the grain: this used to be a list of occurrences, one per strand.
 * Every assertion below is about WHICH strands are recorded and WHAT is recorded
 * on each, and neither of those changed - so the shape they read is the only
 * thing that did. `editFinancialReviewStrandRecords` is the one place that list
 * is assembled, which is what stops this test growing a second answer.
 */
function evidenceFor(strands: PreCheckInEditStrand[]) {
  const { occurrence, storedNightPriceByGuestId } = preCheckInEditEvidence({
    bookingId: "booking-1",
    booking: BOOKING,
    strands,
  });
  return {
    occurrence,
    storedNightPriceByGuestId,
    recorded: occurrence ? editFinancialReviewStrandRecords(occurrence) : [],
  };
}

describe("#3166 a parked pre-check-in edit records every exact strand whose evidence it destroys", () => {
  it("CONTROL: records nothing at all when every strand is readable, however much the edit moves", () => {
    const { occurrence, recorded } = evidenceFor([
      // Shortened, extended and removed — all exact, so the edit prices normally
      // and none of them is anybody's business.
      exactStrand("shortened", ["2026-08-01", "2026-08-02", "2026-08-03"], 8000, {
        proposedNightDates: [new Date("2026-08-01")],
      }),
      exactStrand("extended", ["2026-08-01"], 8000, {
        proposedNightDates: [new Date("2026-08-01"), new Date("2026-08-02")],
      }),
      exactStrand("removed", ["2026-08-01"], 8000, {
        proposedNightDates: [],
        rowsDestroyed: true,
      }),
    ]);
    expect(occurrence).toBeNull();
    expect(recorded).toEqual([]);
  });

  it("CONTROL: records only the unreadable strand when every readable one keeps its nights", () => {
    const { recorded } = evidenceFor([
      unreadableStrand("unreadable"),
      exactStrand("untouched", ["2026-08-01", "2026-08-02"], 8000),
    ]);
    expect(recorded.map((strand) => strand.bookingGuestId)).toEqual([
      "unreadable",
    ]);
  });

  it("records an exact strand that GIVES NIGHTS BACK, whose surrendered prices the edit is about to delete", () => {
    // 1–6 Aug, guest B exact at $80 a night. Shortened to 1–3 Aug: $240 of B's
    // stored per-night evidence stops existing, B stops reconciling, and
    // `BookingModification.previousData` keeps booking-level totals only.
    const { recorded } = evidenceFor([
      unreadableStrand("A"),
      exactStrand(
        "B",
        ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05"],
        8000,
        {
          proposedNightDates: [
            new Date("2026-08-01"),
            new Date("2026-08-02"),
          ],
        },
      ),
    ]);
    const strandB = recorded.find((o) => o.bookingGuestId === "B");
    expect(strandB?.cause).toBe("COUNTERPART_STRAND_UNREADABLE");
    expect(strandB?.surrenderedNightDates).toEqual([
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
    ]);
    // The only surviving copy of what those nights were sold for.
    expect(strandB?.storedEvidence.nightPrices).toEqual([
      { date: "2026-08-01", priceCents: 8000 },
      { date: "2026-08-02", priceCents: 8000 },
      { date: "2026-08-03", priceCents: 8000 },
      { date: "2026-08-04", priceCents: 8000 },
      { date: "2026-08-05", priceCents: 8000 },
    ]);
    expect(strandB?.storedEvidence.guestTotalCents).toBe(40000);
  });

  it("records an exact strand that GAINS NIGHTS, which the parked write turns unpriceable for ever", () => {
    // 1–3 Aug, guest B exact 2 × $80 = $160. Extended to 1–6 Aug: B's new nights
    // are written NULL against a frozen $160 total, so B becomes
    // PARTIAL_STORED_NIGHT_PRICES with $240 owed and — without this — nothing
    // recording that B was ever exact.
    const { recorded } = evidenceFor([
      unreadableStrand("A"),
      exactStrand("B", ["2026-08-01", "2026-08-02"], 8000, {
        proposedNightDates: [
          new Date("2026-08-01"),
          new Date("2026-08-02"),
          new Date("2026-08-03"),
          new Date("2026-08-04"),
          new Date("2026-08-05"),
        ],
      }),
    ]);
    const strandB = recorded.find((o) => o.bookingGuestId === "B");
    expect(strandB?.cause).toBe("COUNTERPART_STRAND_UNREADABLE");
    expect(strandB?.addedNightDates).toEqual([
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
    ]);
    expect(strandB?.storedEvidence.guestTotalCents).toBe(16000);
  });

  it("still records an exact strand the edit DELETES, which is the case #3032 raised it for", () => {
    const { recorded } = evidenceFor([
      unreadableStrand("A"),
      exactStrand("leaving", ["2026-08-01", "2026-08-02"], 8000, {
        proposedNightDates: [],
        rowsDestroyed: true,
      }),
    ]);
    const leaving = recorded.find((o) => o.bookingGuestId === "leaving");
    expect(leaving?.cause).toBe("COUNTERPART_STRAND_UNREADABLE");
    expect(leaving?.surrenderedNightDates).toEqual([
      "2026-08-01",
      "2026-08-02",
    ]);
  });

  it("leads with the strand the edit could not price and whose nights it moves, so the money is not buried", () => {
    /*
      #3498: the ORDER is now a ranking rather than "unreadable first, then the
      rest" - `parkedEditOccurrence` states it. A is unreadable and keeps its
      nights (rank 2); B is exact and gives one back (rank 1). So B leads: it is
      the strand carrying nights the booking gave back, which is the money, and
      the seven-item production fan-out this issue removes made exactly that row
      indistinguishable from six that carried none.
    */
    const { recorded } = evidenceFor([
      exactStrand("B", ["2026-08-01", "2026-08-02"], 8000, {
        proposedNightDates: [new Date("2026-08-01")],
      }),
      unreadableStrand("A"),
    ]);
    expect(recorded.map((strand) => strand.bookingGuestId)).toEqual(["B", "A"]);
  });

  it("raises exactly ONE occurrence however many strands it records (#3498 D1)", () => {
    const { occurrence, recorded } = evidenceFor([
      unreadableStrand("A"),
      unreadableStrand("B"),
      exactStrand("C", ["2026-08-01", "2026-08-02"], 8000, {
        proposedNightDates: [new Date("2026-08-01")],
      }),
      exactStrand("D", ["2026-08-01", "2026-08-02"], 8000),
    ]);
    expect(occurrence).not.toBeNull();
    // Four strands judged, three of them recorded - D keeps every night byte
    // for byte, so there is nothing of D's to record - and ONE item to work.
    expect(recorded.map((strand) => strand.bookingGuestId)).toEqual([
      "C",
      "A",
      "B",
    ]);
  });
});
