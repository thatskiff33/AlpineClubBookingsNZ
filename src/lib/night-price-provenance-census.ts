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
import { calendarMonthOf, clubCalendarDateOf, type ClubTimeZone } from "@/lib/club-time";
import { storedNightPriceSourceIsInexact } from "@/lib/stored-sold-price-evidence";
import {
  EDIT_FINANCIAL_REVIEW_CAUSES,
  parseEditFinancialReviewContext,
  type EditFinancialReviewCause,
} from "@/lib/edit-financial-review-context";

/** How a strand's rows read as a whole, the classes `INV-MOD-028` cares about. */
export type StrandProvenanceClass =
  /** Every row exact under `INV-MOD-028`: sold, officer-valued or rate-derived. */
  | "EXACT_NIGHTS"
  /** Every row an integer, at least one only an even split or of unknown origin. */
  | "INEXACT_NIGHTS"
  /** At least one row NULL: a parked edit's blank. */
  | "UNVALUED_NIGHT"
  /** No night rows at all. */
  | "NO_ROWS";

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

export type ProvenanceCensusBookingRow = {
  createdAt: Date;
  guests: ReadonlyArray<{
    nights: ReadonlyArray<{ priceCents: number | null; priceSource: BookingGuestNightPriceSource }>;
  }>;
};

export function classifyStrandProvenance(
  nights: ReadonlyArray<{ priceCents: number | null; priceSource: BookingGuestNightPriceSource }>,
): StrandProvenanceClass {
  if (nights.length === 0) return "NO_ROWS";
  if (nights.some((night) => night.priceCents === null)) return "UNVALUED_NIGHT";
  // Exactness is `INV-MOD-028`'s own predicate, imported (`INV-SSOT`): a sixth
  // provenance value is classed here exactly as the edit gate would class it.
  return nights.some((night) => storedNightPriceSourceIsInexact(night.priceSource)) ? "INEXACT_NIGHTS" : "EXACT_NIGHTS";
}

function emptyClasses(): Record<StrandProvenanceClass, number> {
  return { EXACT_NIGHTS: 0, INEXACT_NIGHTS: 0, UNVALUED_NIGHT: 0, NO_ROWS: 0 };
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
      const cls = classifyStrandProvenance(guest.nights);
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
    nightRowsBySource,
    strandsByClass,
    byMonth: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
  };
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
    byStatus,
    byCause,
    byMonth: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
  };
}
