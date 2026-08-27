/**
 * The lodge-night range the bed board and its ranged operations are expressed
 * in (#2688).
 *
 * Date-only, half-open: `from` is the first night and `to` is the date-out
 * column, never the last night (INV-DATE-002). Distinct from
 * `bed-allocation-board-window.ts`, which is the client-side window arithmetic
 * for stepping the board around; this is the server-side parse and the shape
 * every reader and writer passes about.
 */
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";
import type { CalendarDate } from "@/lib/club-time";
import { BedAllocationAdminError } from "@/lib/bed-allocation-admin-contract";

export const MAX_BED_ALLOCATION_RANGE_NIGHTS = 31;

export interface BedAllocationDateRange {
  from: Date;
  to: Date;
  fromDate: string;
  toDate: string;
}

/**
 * Parse the board's `from`/`to` pair, defaulting the window to the seven nights
 * starting at the club's own day.
 *
 * `clubToday` IS REQUIRED, and that is the whole point (#3123, `INV-CONFIG-002`).
 * It used to be a missing-parameter default read from the container's
 * environment timezone, so a club behind Greenwich opened its bed board on
 * yesterday. There is deliberately no default to police: the club's day is a
 * database read, this function is synchronous and pure, and the two callers that
 * matter feed its product straight into a transaction that holds
 * `pg_advisory_xact_lock(1)` plus every affected lodge capacity key
 * (`bed-allocation-approval.ts`, `bed-allocation-auto-allocate.ts`). Making this
 * function `async` so it could resolve the day itself would put a
 * `ClubTimeSettings` query on that path — and a later caller could then take it
 * from inside the locked span, which is what `INV-LOCK-004` forbids. The routes
 * resolve one day before they call anything and pass it in.
 *
 * A `CalendarDate` rather than a `string` because a lodge night has no timezone
 * and no time of day: the brand is what makes an INSTANT unrepresentable here.
 */
export function parseBedAllocationDateRange(
  input: {
    from?: string | null;
    to?: string | null;
  },
  clubToday: CalendarDate,
): BedAllocationDateRange {
  const fromDate = input.from || clubToday;
  if (!isDateOnlyString(fromDate)) {
    throw new BedAllocationAdminError("Invalid from date", 400);
  }

  const from = parseDateOnly(fromDate);
  const toDate = input.to || formatDateOnly(addDaysDateOnly(from, 7));
  if (!isDateOnlyString(toDate)) {
    throw new BedAllocationAdminError("Invalid to date", 400);
  }

  const to = parseDateOnly(toDate);
  if (to <= from) {
    throw new BedAllocationAdminError("Date out must be after date in", 400);
  }

  const nights = eachDateOnlyInRange(from, to).length;
  if (nights > MAX_BED_ALLOCATION_RANGE_NIGHTS) {
    throw new BedAllocationAdminError(
      `Date range cannot exceed ${MAX_BED_ALLOCATION_RANGE_NIGHTS} nights`,
      400,
    );
  }

  return { from, to, fromDate, toDate };
}

export function overlapsDateRange(
  stayStart: Date,
  stayEnd: Date,
  range: BedAllocationDateRange,
) {
  return stayStart < range.to && stayEnd > range.from;
}

export function clampGuestToRange(
  guest: { stayStart: Date; stayEnd: Date },
  range: { from: Date; to: Date },
) {
  return {
    stayStart: guest.stayStart > range.from ? guest.stayStart : range.from,
    stayEnd: guest.stayEnd < range.to ? guest.stayEnd : range.to,
  };
}
