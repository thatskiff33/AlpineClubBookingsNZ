import { ManualRefundTaskDirection } from "@prisma/client";

import type { CalendarDate } from "@/lib/club-time";
import { isCalendarDate } from "@/lib/club-time";
import {
  editFinancialReviewGuestsRemovedSinceRaised,
  editFinancialReviewRemovedByItsOwnEdit,
  editFinancialReviewStrandMovesNights,
  editFinancialReviewStrandRecords,
  isNonNegativeIntegerCents,
  parseEditFinancialReviewContext,
  type EditFinancialReviewStrandRecord,
} from "@/lib/edit-financial-review-context";
import { valueStrandNights } from "@/lib/strand-night-valuation";

/**
 * What wave B (#4343) does with one still-OPEN edit review, and which bookings
 * still carry a frozen headline. Pure: no clock, no database, no provider.
 *
 * The money rule is the owner's D1, D3, D5, D7 and D8, plus the 24 Oct 2026
 * consent-removal rule. Settlement itself stays `resolveManualRefundTask`; this
 * module only decides which call that is, or that the headline pass should run.
 */

export const EDIT_REVIEW_CLEANUP_DISMISS_REASONS = [
  "unreadable",
  "negative-stored-total",
  "null-guest-total",
  "consent-removed",
  "unpriced-added-night",
  "unpriced-added-guest",
  "no-anchor",
  "nothing-owing",
] as const;

export type EditReviewCleanupDismissReason =
  (typeof EDIT_REVIEW_CLEANUP_DISMISS_REASONS)[number];

const DISMISS_NOTE: Record<EditReviewCleanupDismissReason, string> = {
  unreadable:
    "Wave B cleanup: this review could not be read, so no money was moved.",
  "negative-stored-total":
    "Wave B cleanup: a stored guest total is negative (D11, #2745), so no money was moved.",
  "null-guest-total":
    "Wave B cleanup: a guest total this review would price is missing, so no money was moved.",
  "consent-removed":
    "Wave B cleanup: a guest this review names was removed after it was raised, and that removal already credited the guest, so no money was moved.",
  "unpriced-added-night":
    "Wave B cleanup: a night this review added has no stored price, so no money was moved.",
  "unpriced-added-guest":
    "Wave B cleanup: a guest this review added has no stored total, so no money was moved.",
  "no-anchor":
    "Wave B cleanup: the priced adjustment has no booking modification to settle against, so no money was moved.",
  "nothing-owing":
    "Wave B cleanup: the parked edit comes to nothing once it is priced, so no money was moved.",
};

export const EDIT_REVIEW_CLEANUP_COMPLETE_NOTE =
  "Wave B cleanup: priced the parked edit from the guests' stored night values and settled it through the ordinary refund, credit or charge path.";

export type OpenEditReviewDecision =
  | {
      action: "dismiss";
      taskId: string;
      bookingId: string;
      reason: EditReviewCleanupDismissReason;
      note: string;
      /** Guests removed after the review was raised. Empty except for `consent-removed`. */
      removedGuestIds: readonly string[];
      /** Moved strands still on the booking, named so the report does not drop them. */
      remainingStrandGuestIds: readonly string[];
    }
  | {
      action: "complete";
      taskId: string;
      bookingId: string;
      direction: ManualRefundTaskDirection;
      amountCents: number;
      feeCents: number;
      creditCents: number;
      chargeCents: number;
      note: string;
    };

export type OpenEditReviewInput = {
  taskId: string;
  bookingId: string;
  reviewContext: unknown;
  /** Guest strands still stored on the booking. */
  currentGuestIds: ReadonlySet<string>;
  /**
   * Current `BookingGuestNight.priceCents` for nights an existing strand gained,
   * keyed `${bookingGuestId}|${yyyy-mm-dd}`. A missing key is a missing row.
   * `null` is a row whose price is null.
   */
  addedNightPrices: ReadonlyMap<string, number | null>;
  /** The anchored modification moved check-in. */
  checkInChanged: boolean;
  /** `BookingModification.changeFeeCents` already stored for that edit. */
  changeFeeAlreadyChargedCents: number;
  /**
   * What `calculateModificationChangeFee` would charge now. Used only when
   * check-in changed and the stored fee is still 0, so a fee already charged
   * is not added again (D8).
   */
  prospectiveChangeFeeCents: number;
  /** The new check-in could not be read, so the fee cannot be priced. */
  changeFeeUnreadable?: boolean;
  /** The booking's status. An unpaid, unconfirmed booking carries no change fee. */
  bookingStatus: string;
  /** A captured payment exists. With an unconfirmed status, the change fee is zero. */
  paymentCaptured: boolean;
};

export function addedNightPriceKey(bookingGuestId: string, date: CalendarDate): string {
  return `${bookingGuestId}|${date}`;
}

/**
 * Statuses that have been confirmed. Anything else is unconfirmed: with no
 * captured payment it carries no change fee (owner, 10 Nov 2026).
 */
const CONFIRMED_BOOKING_STATUSES = new Set(["CONFIRMED", "PAID", "COMPLETED", "CANCELLED"]);

/**
 * The change fee wave B adds (D8). Zero when check-in did not move, and zero
 * when the edit already stored a positive fee — that fee was charged once.
 */
export function changeFeeToAdd(input: {
  checkInChanged: boolean;
  changeFeeAlreadyChargedCents: number;
  prospectiveChangeFeeCents: number;
}): number {
  if (!input.checkInChanged || input.changeFeeAlreadyChargedCents > 0) return 0;
  return input.prospectiveChangeFeeCents;
}

/** D8, plus the unpaid-unconfirmed rule. The decision function is the only caller. */
export function cleanupChangeFeeCents(input: {
  checkInChanged: boolean;
  changeFeeAlreadyChargedCents: number;
  prospectiveChangeFeeCents: number;
  bookingStatus: string;
  paymentCaptured: boolean;
}): number {
  if (!CONFIRMED_BOOKING_STATUSES.has(input.bookingStatus) && !input.paymentCaptured) return 0;
  return changeFeeToAdd(input);
}

function dismiss(
  input: OpenEditReviewInput,
  reason: EditReviewCleanupDismissReason,
  extra?: { removedGuestIds?: readonly string[]; remainingStrandGuestIds?: readonly string[]; note?: string },
): OpenEditReviewDecision {
  return {
    action: "dismiss",
    taskId: input.taskId,
    bookingId: input.bookingId,
    reason,
    note: extra?.note ?? DISMISS_NOTE[reason],
    removedGuestIds: extra?.removedGuestIds ?? [],
    remainingStrandGuestIds: extra?.remainingStrandGuestIds ?? [],
  };
}

/** A negative integer guest total anywhere in the raw context (D11). The parser rejects it, so this is read first. */
export function contextHasNegativeGuestTotal(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const occurrence = (value as { occurrence?: unknown }).occurrence;
  return strandHasNegativeTotal(occurrence);
}

function strandHasNegativeTotal(strand: unknown): boolean {
  if (strand === null || typeof strand !== "object") return false;
  const total = (strand as { storedEvidence?: { guestTotalCents?: unknown } }).storedEvidence?.guestTotalCents;
  if (typeof total === "number" && Number.isInteger(total) && total < 0) return true;
  const others = (strand as { otherStrands?: unknown }).otherStrands;
  return Array.isArray(others) && others.some(strandHasNegativeTotal);
}

/**
 * Price one OPEN edit review, or say why it closes with no money.
 *
 * Net = charges − credits + change fee. A positive net is charged, a negative
 * net is refunded, and zero is a dismissal: the resolver refuses a zero
 * completion. Anything that cannot be priced is a dismissal too (D3), except a
 * resolver refusal, which this function never sees — the runner leaves that
 * task OPEN.
 */
export function decideOpenEditReview(input: OpenEditReviewInput): OpenEditReviewDecision {
  if (contextHasNegativeGuestTotal(input.reviewContext)) {
    return dismiss(input, "negative-stored-total");
  }
  const context = parseEditFinancialReviewContext(input.reviewContext);
  if (context === null) return dismiss(input, "unreadable");
  if (context.occurrence.bookingId !== input.bookingId) {
    return dismiss(input, "unreadable", {
      note: "Wave B cleanup: this review names a different booking from its task, so no money was moved.",
    });
  }
  if (input.changeFeeUnreadable) {
    return dismiss(input, "unreadable", {
      note: "Wave B cleanup: the date change's new check-in could not be read, so the change fee could not be priced and no money was moved.",
    });
  }

  const strands = editFinancialReviewStrandRecords(context.occurrence);
  const removed = editFinancialReviewGuestsRemovedSinceRaised(context, input.currentGuestIds);
  if (removed.length > 0) {
    const removedIds = new Set(removed.map((guest) => guest.bookingGuestId));
    const remainingStrandGuestIds = strands
      .filter(
        (strand) =>
          editFinancialReviewStrandMovesNights(strand) &&
          !removedIds.has(strand.bookingGuestId) &&
          input.currentGuestIds.has(strand.bookingGuestId),
      )
      .map((strand) => strand.bookingGuestId);
    return dismiss(input, "consent-removed", {
      removedGuestIds: removed.map((guest) => guest.bookingGuestId),
      remainingStrandGuestIds,
    });
  }

  let credits = 0;
  let charges = 0;
  for (const strand of strands) {
    if (!editFinancialReviewStrandMovesNights(strand)) continue;
    const guestTotalCents = strand.storedEvidence.guestTotalCents;
    if (guestTotalCents === null) return dismiss(input, "null-guest-total");
    if (guestTotalCents < 0) return dismiss(input, "negative-stored-total");
    const guestGone = !input.currentGuestIds.has(strand.bookingGuestId);
    if (guestGone && editFinancialReviewRemovedByItsOwnEdit(strand)) {
      credits += guestTotalCents;
      continue;
    }
    if (strand.surrenderedNightDates.length > 0) {
      const credited = creditSurrenderedNights(strand, guestTotalCents);
      if (credited === null) return dismiss(input, "unreadable");
      credits += credited;
    }
    if (strand.addedNightDates.length > 0) {
      const charged = chargeAddedNights(input.addedNightPrices, strand);
      if (charged === null) return dismiss(input, "unpriced-added-night");
      charges += charged;
    }
  }

  const addedGuests = context.guestsAddedByEdit ?? null;
  if (addedGuests !== null && addedGuests.count > 0) {
    if (addedGuests.totalPriceCents === null) return dismiss(input, "unpriced-added-guest");
    // The new guests are recorded only here. A strand that also gave nights
    // back is priced above; this total is the guests who were not a strand.
    charges += addedGuests.totalPriceCents;
  }

  const feeCents = cleanupChangeFeeCents({
    checkInChanged: input.checkInChanged,
    changeFeeAlreadyChargedCents: input.changeFeeAlreadyChargedCents,
    prospectiveChangeFeeCents: input.prospectiveChangeFeeCents,
    bookingStatus: input.bookingStatus,
    paymentCaptured: input.paymentCaptured,
  });
  if (!isNonNegativeIntegerCents(feeCents)) {
    return dismiss(input, "unreadable", {
      note: "Wave B cleanup: the change fee was not a whole number of cents, so no money was moved.",
    });
  }

  const net = charges - credits + feeCents;
  if (net === 0) return dismiss(input, "nothing-owing");
  if (context.bookingModificationId === null) return dismiss(input, "no-anchor");
  return {
    action: "complete",
    taskId: input.taskId,
    bookingId: input.bookingId,
    direction: net > 0 ? ManualRefundTaskDirection.CHARGE_TO_MEMBER : ManualRefundTaskDirection.REFUND_TO_MEMBER,
    amountCents: Math.abs(net),
    feeCents,
    creditCents: credits,
    chargeCents: charges,
    note: EDIT_REVIEW_CLEANUP_COMPLETE_NOTE,
  };
}

function creditSurrenderedNights(
  strand: Pick<EditFinancialReviewStrandRecord, "surrenderedNightDates" | "storedEvidence">,
  guestTotalCents: number,
): number | null {
  let valuation;
  try {
    valuation = valueStrandNights(
      strand.storedEvidence.nightPrices.map((night) => ({
        date: night.date,
        priceCents: night.priceCents,
      })),
      guestTotalCents,
    );
  } catch {
    return null;
  }
  if (valuation.flag === "NEGATIVE_STORED_TOTAL") return null;
  const byDate = new Map(valuation.nights.map((night) => [night.date, night.valueCents]));
  let credits = 0;
  const seen = new Set<string>();
  for (const date of strand.surrenderedNightDates) {
    if (seen.has(date)) continue;
    seen.add(date);
    const value = byDate.get(date as CalendarDate);
    if (value === undefined) return null;
    credits += value;
  }
  return credits;
}

function chargeAddedNights(
  addedNightPrices: ReadonlyMap<string, number | null>,
  strand: { bookingGuestId: string; addedNightDates: readonly CalendarDate[] },
): number | null {
  let charges = 0;
  const seen = new Set<string>();
  for (const date of strand.addedNightDates) {
    if (seen.has(date)) continue;
    seen.add(date);
    const key = addedNightPriceKey(strand.bookingGuestId, date);
    if (!addedNightPrices.has(key)) return null;
    const price = addedNightPrices.get(key);
    if (!isNonNegativeIntegerCents(price)) return null;
    charges += price;
  }
  return charges;
}

export type CleanupMoneyColumns = {
  totalPriceCents: number;
  discountCents: number;
  promoAdjustmentCents: number;
  finalPriceCents: number;
};

export type CleanupGuest = { id: string; priceCents: number };

export type CleanupBooking = CleanupMoneyColumns & {
  id: string;
  guests: readonly CleanupGuest[];
};

export type CleanupReviewTask = {
  id: string;
  bookingId: string;
  status: string;
  reviewContext: unknown;
};

export function guestStoredTotalCents(guests: readonly CleanupGuest[]): number {
  return guests.reduce((sum, guest) => sum + guest.priceCents, 0);
}

/**
 * A frozen headline (D5): the booking has an edit review, none of them still
 * OPEN, at least one guest, and `totalPriceCents` is not the sum of the
 * guests' stored totals. A booking with no edit review is left alone, even
 * when those figures disagree.
 */
export function isFrozenEditReviewHeadline(
  booking: CleanupBooking,
  tasks: readonly Pick<CleanupReviewTask, "bookingId" | "status">[],
): boolean {
  const reviews = tasks.filter((task) => task.bookingId === booking.id);
  if (reviews.length === 0) return false;
  if (reviews.some((task) => task.status === "OPEN")) return false;
  if (booking.guests.length === 0) return false;
  return booking.totalPriceCents !== guestStoredTotalCents(booking.guests);
}

export type D7Row = {
  bookingId: string;
  taskId: string;
  guestId: string;
  guestTotalCents: number;
};

/**
 * D7, list only: a DISMISSED shortening whose surrendered guest is still
 * stored at the total the review recorded. The money stayed inside that total.
 */
export function listDismissedShortenings(
  tasks: readonly CleanupReviewTask[],
  guestsByBooking: ReadonlyMap<string, readonly CleanupGuest[]>,
): D7Row[] {
  const rows: D7Row[] = [];
  for (const task of tasks) {
    if (task.status !== "DISMISSED") continue;
    const context = parseEditFinancialReviewContext(task.reviewContext);
    if (context === null) continue;
    const guests = new Map((guestsByBooking.get(task.bookingId) ?? []).map((guest) => [guest.id, guest.priceCents]));
    for (const strand of editFinancialReviewStrandRecords(context.occurrence)) {
      if (strand.surrenderedNightDates.length === 0) continue;
      const stored = guests.get(strand.bookingGuestId);
      const recorded = strand.storedEvidence.guestTotalCents;
      if (stored === undefined || recorded === null || stored !== recorded) continue;
      rows.push({
        bookingId: task.bookingId,
        taskId: task.id,
        guestId: strand.bookingGuestId,
        guestTotalCents: recorded,
      });
    }
  }
  return rows;
}

/**
 * Check-in dates on a modification's before/after snapshots.
 *
 * A guest add or removal stores no check-in at all. That is "check-in did not
 * move", and the fee is zero — not an unreadable date. Unreadable is a check-in
 * that is present but not a calendar day, or present on only one side, or a
 * snapshot that is not an object. The fee is then not guessed as zero, because
 * a date change with a broken snapshot must not be priced.
 *
 * `previousCheckIn` is the day the change fee is measured from. The booking's
 * live check-in is already the new day: the parked edit wrote it before it
 * raised the review.
 */
export function modificationCheckInChange(previousData: unknown, newData: unknown): {
  changed: boolean;
  previousCheckIn: CalendarDate | null;
  newCheckIn: CalendarDate | null;
  unreadable: boolean;
} {
  const previous = readCheckIn(previousData);
  const next = readCheckIn(newData);
  if (previous.state === "absent" && next.state === "absent") {
    return { changed: false, previousCheckIn: null, newCheckIn: null, unreadable: false };
  }
  if (previous.state !== "date" || next.state !== "date") {
    return {
      changed: false,
      previousCheckIn: previous.state === "date" ? previous.date : null,
      newCheckIn: next.state === "date" ? next.date : null,
      unreadable: true,
    };
  }
  return {
    changed: previous.date !== next.date,
    previousCheckIn: previous.date,
    newCheckIn: next.date,
    unreadable: false,
  };
}

type CheckInRead = { state: "absent" } | { state: "invalid" } | { state: "date"; date: CalendarDate };

function readCheckIn(data: unknown): CheckInRead {
  if (data === null || typeof data !== "object") return { state: "invalid" };
  if (!Object.prototype.hasOwnProperty.call(data, "checkIn")) return { state: "absent" };
  const value = (data as { checkIn?: unknown }).checkIn;
  if (typeof value !== "string") return { state: "invalid" };
  const day = value.slice(0, 10);
  return isCalendarDate(day) ? { state: "date", date: day } : { state: "invalid" };
}
