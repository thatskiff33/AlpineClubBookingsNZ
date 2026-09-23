/**
 * WHAT THE STORED NIGHT PRICES ARE MADE OF, AND WHAT PARKS EDITS (#3531
 * stage 3c, programme #3527) - two read-only summaries the money census
 * (`npm run booking-money:census`) reports beside `INV-MONEY-031`'s verdicts,
 * so the effect of 3a (the gate's grain) and 3b (the rate-derived backfill) is
 * read off the database rather than asserted.
 *
 * Pure: both summarisers take rows the store loaded in the census's own
 * repeatable-read snapshot. Nothing here writes, repairs or names a booking.
 *
 * Grouped by the club's calendar month of the booking's (or task's) creation,
 * so a "before deploy / after deploy" comparison is one line against another.
 * The month is derived through `club-time` from the stored instant and the
 * club's zone (`INV-DATE-019`): a booking made late on the last evening of a
 * month at the club belongs to that month, not to the UTC day it was still.
 */
import type { BookingGuestNightPriceSource } from "@prisma/client";
import {
  calendarDateOfDateOnlyInstant,
  calendarMonthOf,
  clubCalendarDateOf,
  type ClubTimeZone,
} from "@/lib/club-time";
import { classifyStoredSoldPriceEvidence } from "@/lib/stored-sold-price-evidence";
import {
  EDIT_FINANCIAL_REVIEW_CAUSES,
  parseEditFinancialReviewContext,
  type EditFinancialReviewCause,
} from "@/lib/edit-financial-review-context";

/**
 * How a strand's rows read as a whole: `INV-MOD-028`'s own verdict on the
 * strand at individual-night grain — the grain an edit that moves one of its
 * nights needs — so a class here is either `EXACT` or the cause the edit gate
 * would park with. The same vocabulary as the review tasks the second summary
 * counts, which is what lets the two summaries be read against each other.
 */
export type StrandProvenanceClass = "EXACT" | EditFinancialReviewCause;
// (3b's `RateDerivationResidueReason.UNVALUED_NIGHT` names a different, narrower
// fact — a NULL row on a strand the backfill would otherwise have priced.)

export type NightPriceProvenanceCensus = {
  /** Every night row, by its provenance value as stored. */
  nightRowsBySource: Record<string, number>;
  /** Every strand, by class. */
  strandsByClass: Record<StrandProvenanceClass, number>;
  /** The same two counts per booking-creation month (`YYYY-MM`), oldest first. */
  byMonth: Array<{
    month: string;
    bookings: number;
    nightRowsBySource: Record<string, number>;
    strandsByClass: Record<StrandProvenanceClass, number>;
  }>;
};

export type ProvenanceCensusStrandRow = {
  /** `BookingGuest.priceCents` as stored: what the rows must reconcile to. */
  priceCents: number;
  nights: ReadonlyArray<{
    stayDate: Date;
    priceCents: number | null;
    priceSource: BookingGuestNightPriceSource;
  }>;
};

export type ProvenanceCensusBookingRow = {
  createdAt: Date;
  guests: ReadonlyArray<ProvenanceCensusStrandRow>;
};

/**
 * The one classifier (`INV-SSOT`): `classifyStoredSoldPriceEvidence` judges
 * the rows against the stored total exactly as the edit gate does, so a strand
 * whose exact-looking rows do not sum (`STORED_TOTAL_MISMATCH`), or which holds
 * a negative row, is counted where the gate would park it rather than as exact.
 */
export function classifyStrandProvenance(strand: ProvenanceCensusStrandRow): StrandProvenanceClass {
  const verdict = classifyStoredSoldPriceEvidence(
    strand.nights.map((night) => ({
      date: calendarDateOfDateOnlyInstant(night.stayDate),
      priceCents: night.priceCents,
      priceSource: night.priceSource,
    })),
    strand.priceCents,
    "INDIVIDUAL_NIGHT",
  );
  return verdict.kind === "exact" ? "EXACT" : verdict.cause;
}

function emptyClasses(): Record<StrandProvenanceClass, number> {
  const causes = Object.fromEntries(EDIT_FINANCIAL_REVIEW_CAUSES.map((cause) => [cause, 0])) as Record<
    EditFinancialReviewCause,
    number
  >;
  return { EXACT: 0, ...causes };
}

export function monthOf(instant: Date, zone: ClubTimeZone): string {
  return calendarMonthOf(clubCalendarDateOf(instant, zone));
}

export function summarizeNightPriceProvenance(
  bookings: ReadonlyArray<ProvenanceCensusBookingRow>,
  zone: ClubTimeZone,
): NightPriceProvenanceCensus {
  const nightRowsBySource: Record<string, number> = {};
  const strandsByClass = emptyClasses();
  const months = new Map<string, NightPriceProvenanceCensus["byMonth"][number]>();
  for (const booking of bookings) {
    const month = monthOf(booking.createdAt, zone);
    const bucket = months.get(month) ?? { month, bookings: 0, nightRowsBySource: {}, strandsByClass: emptyClasses() };
    bucket.bookings += 1;
    for (const guest of booking.guests) {
      const cls = classifyStrandProvenance(guest);
      strandsByClass[cls] += 1;
      bucket.strandsByClass[cls] += 1;
      for (const night of guest.nights) {
        nightRowsBySource[night.priceSource] = (nightRowsBySource[night.priceSource] ?? 0) + 1;
        bucket.nightRowsBySource[night.priceSource] = (bucket.nightRowsBySource[night.priceSource] ?? 0) + 1;
      }
    }
    months.set(month, bucket);
  }
  return {
    nightRowsBySource: sortedKeys(nightRowsBySource),
    strandsByClass,
    byMonth: [...months.values()]
      .sort((a, b) => a.month.localeCompare(b.month))
      .map((bucket) => ({ ...bucket, nightRowsBySource: sortedKeys(bucket.nightRowsBySource) })),
  };
}

/**
 * Key order follows the value, not the row order the database happened to
 * return (the nested selects carry no ORDER BY), so two runs over the same
 * data print byte-identical JSON and a diff between them shows only change.
 */
function sortedKeys(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export type EditFinancialReviewCensus = {
  total: number;
  byStatus: Record<string, number>;
  /** By the cause the raise recorded; `UNREADABLE_CONTEXT` for a row the parser refuses. */
  byCause: Record<EditFinancialReviewCause | "UNREADABLE_CONTEXT", number>;
  /** Per task-creation month, oldest first. */
  byMonth: Array<{
    month: string;
    total: number;
    byCause: Record<EditFinancialReviewCause | "UNREADABLE_CONTEXT", number>;
  }>;
};

export type ReviewCensusTaskRow = {
  createdAt: Date;
  status: string;
  reviewContext: unknown;
};

function emptyCauses(): EditFinancialReviewCensus["byCause"] {
  const causes = Object.fromEntries(EDIT_FINANCIAL_REVIEW_CAUSES.map((cause) => [cause, 0])) as Record<
    EditFinancialReviewCause,
    number
  >;
  return { ...causes, UNREADABLE_CONTEXT: 0 };
}

export function summarizeEditFinancialReviews(
  tasks: ReadonlyArray<ReviewCensusTaskRow>,
  zone: ClubTimeZone,
): EditFinancialReviewCensus {
  const byStatus: Record<string, number> = {};
  const byCause = emptyCauses();
  const months = new Map<string, EditFinancialReviewCensus["byMonth"][number]>();
  for (const task of tasks) {
    byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
    // The one parser (`INV-SSOT`): a context it refuses is counted as such,
    // never guessed at from its shape.
    const cause = parseEditFinancialReviewContext(task.reviewContext)?.occurrence.cause ?? "UNREADABLE_CONTEXT";
    byCause[cause] += 1;
    const month = monthOf(task.createdAt, zone);
    const bucket = months.get(month) ?? { month, total: 0, byCause: emptyCauses() };
    bucket.total += 1;
    bucket.byCause[cause] += 1;
    months.set(month, bucket);
  }
  return {
    total: tasks.length,
    byStatus: sortedKeys(byStatus),
    byCause,
    byMonth: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
  };
}
