import { parseDateOnly } from "@/lib/date-only";
import { storedDateOnly } from "@/lib/stored-calendar-day";
import {
  normalizeGuestStayRange,
  type NormalizedBookingGuestStayRange,
} from "@/lib/booking-guest-stay-range-input";

/**
 * THE ONE definition of "what stay ranges does this modification delta produce".
 *
 * Extracted from `booking-modify-validation.ts` (`resolveTargetDates`) and
 * `booking-modify-plan.ts` (`prepareGuestPlan`) so the canonical modification
 * planner and every surface that has to PREDICT what it will do share a single
 * implementation instead of two that agree by inspection.
 *
 * Why this module exists (#2526 review finding). The booking-policy exception
 * workflow freezes a full PROPOSED PARTY at request time, an officer reviews and
 * approves that exact party, and the approval then drives the canonical service
 * with the stored DELTA. That is only sound while "the party the delta produces"
 * is computed the same way twice. It was not: the frozen model decided per guest
 * ("no explicit range for this guest + dates moved => reset to the new envelope")
 * while the planner decides on a GLOBAL flag ("ANY range input anywhere => every
 * guest without their own range keeps their stored nights"). A member sending a
 * date change plus a partial `guestStayRanges` therefore had a proposal reviewed,
 * hashed and capacity-checked for a party the execution never created.
 *
 * The rules, in one place:
 *
 *  - `hasRangeInputs` is GLOBAL: true when ANY `guestStayRanges` entry or ANY
 *    `addGuests` entry carries a stay range (a start, an end, or an explicit
 *    night set). It switches the whole request between two modes.
 *  - With NO range inputs, a remaining guest is reset to the new envelope when
 *    the booking dates moved, and otherwise keeps their STORED range AND their
 *    stored explicit night set (so editing one thing never collapses another
 *    guest's gaps — issue #713).
 *  - With range inputs, a remaining guest uses their OWN range entry when they
 *    have one, and otherwise keeps their stored range and night set — the
 *    dates-moved reset never runs.
 *  - Added guests always normalise against the final envelope.
 *  - The final booking envelope expands (never shrinks) to cover every resolved
 *    range, but only in range-input mode, exactly as `resolveTargetDates` does.
 *
 * Pure: no database, no clock, no policy. Range validation errors surface as
 * `BookingGuestStayRangeValidationError` from `normalizeGuestStayRange`; callers
 * map them to their own error type (the modify path to `ApiError` 400).
 */

/** One stay range as a caller may supply it (member payload or stored delta). */
export type StayRangeDeltaEntry = {
  stayStart?: Date | string | null;
  stayEnd?: Date | string | null;
  nights?: ReadonlyArray<Date | string> | null;
};

/** A live `BookingGuest` row, as much of it as range resolution needs. */
export type LiveGuestStayRow = {
  id: string;
  stayStart?: Date | null;
  stayEnd?: Date | null;
  /** The guest's stored explicit night set (#713), when it was loaded. */
  nights?: ReadonlyArray<{ stayDate: Date }> | null;
};

/** The delta fields that can move stay ranges. */
export type StayRangeDeltaInput = {
  checkIn?: Date | string | null;
  checkOut?: Date | string | null;
  addGuests?: ReadonlyArray<StayRangeDeltaEntry> | null;
  removeGuestIds?: ReadonlyArray<string> | null;
  guestStayRanges?: ReadonlyArray<{ guestId: string } & StayRangeDeltaEntry> | null;
};

/**
 * Booking dates are passed through RAW (never re-normalised) so this module is a
 * behaviour-preserving extraction: `resolveTargetDates` compares the requested
 * envelope against `booking.checkIn` as stored, and a caller that has already
 * normalised its own dates simply hands in the normalised values.
 */
export interface ResolvedModificationStayRanges<Guest extends LiveGuestStayRow> {
  /** The global range-input mode flag the two branches hinge on. */
  hasRangeInputs: boolean;
  /** Did the booking envelope move? Compared against the FINAL envelope. */
  datesChanged: boolean;
  /** The envelope the delta asked for, before any range-driven expansion. */
  requestedCheckIn: Date;
  requestedCheckOut: Date;
  /** The effective envelope after range-driven expansion. */
  checkIn: Date;
  checkOut: Date;
  /** Every guest that stays on the booking, with its resolved range. */
  remaining: Array<{ guest: Guest } & NormalizedBookingGuestStayRange>;
  /** Every added guest, in input order, with its resolved range. */
  added: NormalizedBookingGuestStayRange[];
}

function hasStayRangeValue(value: Date | string | null | undefined): boolean {
  if (value instanceof Date) return true;
  if (typeof value === "string") return value.trim() !== "";
  return false;
}

/** Does this one entry carry a stay range at all? */
export function entryHasStayRange(entry: StayRangeDeltaEntry): boolean {
  return (
    hasStayRangeValue(entry.stayStart) ||
    hasStayRangeValue(entry.stayEnd) ||
    (entry.nights != null && entry.nights.length > 0)
  );
}

/** The GLOBAL range-input mode flag: any range anywhere switches the mode. */
export function deltaHasStayRangeInputs(input: StayRangeDeltaInput): boolean {
  return (
    (input.guestStayRanges?.some(entryHasStayRange) ?? false) ||
    (input.addGuests?.some(entryHasStayRange) ?? false)
  );
}

function toDate(value: Date | string | null | undefined, fallback: Date): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string" && value.trim() !== "") {
    return parseDateOnly(value);
  }
  return fallback;
}

/**
 * A guest's STORED range, as the calendar days the `@db.Date` columns hold.
 *
 * CT-4 (#2870), and this line is one half of a cross-file FRAME PAIR — read the
 * next paragraph before changing it. `normalizeDateOnlyForTimeZone`, which this
 * replaces, projected the stored value through `APP_TIME_ZONE` first: the
 * identity for a club ahead of Greenwich, the PREVIOUS day for one behind it.
 *
 * Two callers depend on this agreeing with how they decoded the same columns
 * themselves, and both now decode in UTC:
 *
 *  - `/api/bookings/[id]/modify-quote` compares its own `storedDateOnly(...)`
 *    of `guest.stayStart` against the range this returns to decide whether the
 *    member changed anything. One projected side made `guestRangesChanged` true
 *    for a delta that moved no dates, and then priced a window one night from
 *    the one it compared against — a date-change charge for no date change.
 *  - `buildModificationProposalParties` builds the frozen policy-exception BASE
 *    party from the values its caller passes in and the PROPOSED party from
 *    this, so a projection here alone shifted the proposal a day off its own
 *    base, and `verifyLiveProposalIntegrity` then read the pair as drift.
 *
 * Both consequences are invisible on a deployment at or ahead of UTC, which is
 * why they survived: `Pacific/Auckland` makes the projection the identity.
 *
 * THE SIBLING PATH IS NOW CONVERGED TOO (group F4b). This docblock used to warn
 * that `normalizeGuestStayRange` in `booking-guest-stay-range-input.ts` still
 * projected, and that one of those sites was reachable from here: the `added`
 * map below normalises every ADDED guest through it, so one carrying no range of
 * their own was defaulted from the envelope a night early on a club behind
 * Greenwich. Worse, the two passes below then disagreed with each other — pass 1
 * defaults that same guest to `{ requestedCheckIn, requestedCheckOut }`
 * unprojected, so the guest's resolved range could fall a night OUTSIDE the
 * envelope the same call returned. F4b read those two calls as stored calendar
 * days; `__tests__/booking-range-less-guest-frame.test.ts` pins it on the
 * environment and the host axis. Measured under `America/Denver`, correcting
 * this line took the resolver's own suites from 32 failures to 28.
 */
function storedRange(
  guest: LiveGuestStayRow,
  booking: { checkIn: Date; checkOut: Date },
): NormalizedBookingGuestStayRange {
  const nights =
    guest.nights && guest.nights.length > 0
      ? guest.nights.map((night) => night.stayDate)
      : undefined;
  return {
    stayStart: storedDateOnly(guest.stayStart ?? booking.checkIn),
    stayEnd: storedDateOnly(guest.stayEnd ?? booking.checkOut),
    ...(nights ? { nights } : {}),
  };
}

function minDate(values: Date[]): Date {
  return values.reduce((earliest, value) => (value < earliest ? value : earliest));
}

function maxDate(values: Date[]): Date {
  return values.reduce((latest, value) => (value > latest ? value : latest));
}

/**
 * Resolve the effective envelope and every guest's stay range for a
 * modification delta.
 *
 * Index note: range entries are normalised in one sequence — remaining guests in
 * booking order (skipping removals), then added guests — so a validation error
 * label ("Guest 3: ...") is stable and matches the order `resolveTargetDates`
 * already used, which is the error the member sees first.
 */
export function resolveModificationStayRanges<Guest extends LiveGuestStayRow>(args: {
  booking: { checkIn: Date; checkOut: Date };
  guests: ReadonlyArray<Guest>;
  input: StayRangeDeltaInput;
  /**
   * The requested envelope, when the caller has already resolved it. Supplied by
   * `resolveTargetDates`, which validates the parsed dates itself before this
   * runs, so the extraction cannot change what it passes downstream.
   */
  requested?: { checkIn: Date; checkOut: Date };
}): ResolvedModificationStayRanges<Guest> {
  const bookingCheckIn = args.booking.checkIn;
  const bookingCheckOut = args.booking.checkOut;
  const booking = { checkIn: bookingCheckIn, checkOut: bookingCheckOut };

  const requestedCheckIn =
    args.requested?.checkIn ?? toDate(args.input.checkIn, bookingCheckIn);
  const requestedCheckOut =
    args.requested?.checkOut ?? toDate(args.input.checkOut, bookingCheckOut);

  const removeSet = new Set(args.input.removeGuestIds ?? []);
  const rangeByGuestId = new Map(
    (args.input.guestStayRanges ?? []).map((range) => [range.guestId, range]),
  );
  const remainingGuests = args.guests.filter((guest) => !removeSet.has(guest.id));
  const addGuests = args.input.addGuests ?? [];

  const hasRangeInputs = deltaHasStayRangeInputs(args.input);

  // Pass 1 — the envelope. Only range-input mode can expand it; the normalising
  // envelope is the union of the stored and requested ranges, which is what
  // `resolveTargetDates` has always used.
  let checkIn = requestedCheckIn;
  let checkOut = requestedCheckOut;
  if (hasRangeInputs) {
    const unionEnvelope = {
      checkIn: requestedCheckIn < bookingCheckIn ? requestedCheckIn : bookingCheckIn,
      checkOut:
        requestedCheckOut > bookingCheckOut ? requestedCheckOut : bookingCheckOut,
    };
    const proposedRanges: NormalizedBookingGuestStayRange[] = [];
    for (const guest of remainingGuests) {
      const entry = rangeByGuestId.get(guest.id);
      proposedRanges.push(
        entry && entryHasStayRange(entry)
          ? normalizeGuestStayRange(entry, unionEnvelope, proposedRanges.length)
          : storedRange(guest, booking),
      );
    }
    for (const addGuest of addGuests) {
      proposedRanges.push(
        entryHasStayRange(addGuest)
          ? normalizeGuestStayRange(addGuest, unionEnvelope, proposedRanges.length)
          : { stayStart: requestedCheckIn, stayEnd: requestedCheckOut },
      );
    }
    if (proposedRanges.length > 0) {
      checkIn = minDate(proposedRanges.map((range) => range.stayStart));
      checkOut = maxDate(proposedRanges.map((range) => range.stayEnd));
    }
  }

  const datesChanged =
    checkIn.getTime() !== new Date(bookingCheckIn).getTime() ||
    checkOut.getTime() !== new Date(bookingCheckOut).getTime();

  // Pass 2 — every guest's final range, normalised against the FINAL envelope
  // (which is what the planner writes onto the guest rows).
  const finalEnvelope = { checkIn, checkOut };
  let index = 0;
  const remaining = remainingGuests.map((guest) => {
    if (!hasRangeInputs) {
      index += 1;
      return {
        guest,
        ...(datesChanged
          ? { stayStart: checkIn, stayEnd: checkOut }
          : storedRange(guest, booking)),
      };
    }
    const entry = rangeByGuestId.get(guest.id);
    const resolved =
      entry && entryHasStayRange(entry)
        ? normalizeGuestStayRange(entry, finalEnvelope, index)
        : storedRange(guest, booking);
    index += 1;
    return { guest, ...resolved };
  });

  const added = addGuests.map((addGuest) => {
    const resolved = normalizeGuestStayRange(addGuest, finalEnvelope, index);
    index += 1;
    return resolved;
  });

  return {
    hasRangeInputs,
    datesChanged,
    requestedCheckIn,
    requestedCheckOut,
    checkIn,
    checkOut,
    remaining,
    added,
  };
}
