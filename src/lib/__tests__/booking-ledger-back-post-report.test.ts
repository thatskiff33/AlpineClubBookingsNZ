/**
 * The back-post's report (#4627): a booking whose only work is a journal batch
 * (a journal-era booking's missing R01, or lines no batch had picked up) is
 * reported as JOURNAL_ONLY and counted, so a dry run says exactly what --apply
 * commits. The outcome itself is proven on PostgreSQL in
 * `booking-ledger-journal.realdb.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  backPostTotals,
  formatBookingLedgerBackPostOutcome,
  formatBookingLedgerBackPostSummary,
  type BookingBackPostOutcome,
} from "@/lib/booking-ledger-back-post-report";

const outcomes: BookingBackPostOutcome[] = [
  { bookingId: "posted", kind: "POSTED", lines: 3, lineIds: [], journalBatches: 2, steps: ["confirmation (3)"], classes: [] },
  { bookingId: "journal", kind: "JOURNAL_ONLY", journalBatches: 1, steps: [], classes: [] },
  { bookingId: "nothing", kind: "NOTHING_TO_POST", classes: [] },
];

describe("a back-post booking whose only work is the journal (#4627)", () => {
  it("is counted apart, and its batches with the posted bookings'", () => {
    expect(backPostTotals(outcomes)).toEqual({ bookings: 3, posted: 1, lines: 3, journalOnly: 1, journalBatches: 3, nothingToPost: 1, cannotPost: 0 });
  });

  it("is printed in the dry run as it would be applied", () => {
    expect(formatBookingLedgerBackPostOutcome(outcomes[1]!, "dry-run", String)).toEqual(["WOULD POST  journal  journal only, 1 batch(es): no legacy line to fill"]);
    expect(formatBookingLedgerBackPostOutcome(outcomes[0]!, "apply", String)[0]).toMatch(/^POSTED  posted  3 line\(s\), 2 journal batch\(es\): confirmation \(3\)$/);
    const summary = formatBookingLedgerBackPostSummary({ mode: "dry-run", runId: "r", startedAt: "s", finishedAt: "f", outcomes, totals: backPostTotals(outcomes) });
    expect(summary).toMatch(/journal only: 1   journal batches: 3/);
  });
});
