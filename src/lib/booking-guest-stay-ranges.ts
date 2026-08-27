import {
  addCalendarDays,
  calendarDateOfDateOnlyInstant,
  calendarDateOfSerialisedDbDate,
  requireCalendarDate,
  requireStoredCalendarDay,
  type CalendarDate,
} from "@/lib/club-time";
import { addDaysDateOnly, parseDateOnly } from "@/lib/date-only";

/**
 * A single included night for a guest. Accepts a Date, a `yyyy-mm-dd`
 * date-only string, or the Prisma `BookingGuestNight` relation row shape so a
 * guest loaded with `include: { nights: true }` can be passed straight through.
 */
export type GuestNightInput = Date | string | { stayDate: Date | string };

export type GuestStayRange = {
  stayStart?: Date | null;
  stayEnd?: Date | null;
  // Explicit set of included nights (issue #713). When present and non-empty,
  // this is the authoritative per-night presence for the guest and overrides
  // the contiguous stayStart/stayEnd envelope. When absent/empty, presence
  // falls back to the envelope — which keeps every read surface that loads only
  // stayStart/stayEnd behaving exactly as before.
  nights?: ReadonlyArray<GuestNightInput> | null;
};

export type BookingStayRange = {
  checkIn: Date;
  checkOut: Date;
};

/**
 * The lodge-night key a stored calendar day carries.
 *
 * IT DECODES, AND IT DOES NOT PROJECT (#3107). Every value reaching it is a
 * `@db.Date` column - `booking.checkIn` / `checkOut`, `BookingGuest.stayStart` /
 * `stayEnd`, `BookingGuestNight.stayDate` - or a date-only `Date` a caller built
 * from one. Those are ENCODINGS of a calendar day rather than moments, so the day
 * is read straight back out in UTC: `INV-DATE-019`'s first exact boundary,
 * together with `INV-DATE-026`, which is what says the column really is
 * date-only. Do not cite `INV-DATE-010` for this direction - that rule names
 * these two ids rather than itself, and what it forbids is deriving a rule from
 * one of these values read as a MOMENT.
 *
 * IT USED TO PROJECT THROUGH THE ENVIRONMENT ZONE (`formatDateOnlyForTimeZone`),
 * which is the identity for a club at or ahead of Greenwich and the PREVIOUS day
 * for one behind it - so every key this module produced was a day early there.
 * Worse than uniformly early: {@link nightEntryKey} takes a `yyyy-mm-dd` string
 * VERBATIM, so the same logical night landed in two different frames depending on
 * the shape it arrived in. The measured consequence was a capacity UNDER-COUNT.
 * `ProposalGuest.nights` is declared `string[]` and
 * `createModificationExceptionRequest` passes it straight into
 * `checkCapacityForGuestRanges`; for a two-guest three-night proposal on
 * `America/Denver` the admission check saw 0 proposed beds on two of the three
 * nights instead of 2, inside `acquireGlobalBookingLock` and
 * `acquireLodgeCapacityLock`, on the branch that reserves beds. A proposal that
 * should have been refused for want of beds could be admitted.
 *
 * THE PRECONDITION IS ASSERTED RATHER THAN ASSUMED, and that is the whole
 * difference between this and quietly swapping the reader for a UTC one. A bare
 * `Date` cannot say whether it encodes a stored day or holds a real timestamp,
 * and a timestamp decoded here would yield its UTC day - the same
 * `INV-DATE-019` defect from the other direction, which is precisely why #3100
 * refused to fold this fix into itself. So a value carrying a UTC time of day is
 * refused by name. That refusal is unreachable from today's callers: every one
 * derives its argument from `parseDateOnly`, `eachDateOnlyInRange`,
 * the club's own today, `storedDateOnly` or a `@db.Date` read, each of which is UTC
 * midnight by construction.
 */
function dateOnlyKey(value: Date): CalendarDate {
  return calendarDateOfDateOnlyInstant(
    requireStoredCalendarDay(value, {
      subject: "A lodge-night key",
      instead:
        "Pass the stored calendar day the night is, or resolve a real timestamp's club " +
        "day with clubCalendarDateOf first and pass that.",
    })
  );
}

/**
 * Derive the date-only key for one explicit night entry.
 *
 * ONE KEY FRAME - and the comment here previously claimed that when it was false,
 * which is the shape of mistake #3107 exists to remove. Both input shapes now
 * decode the calendar day they carry and neither consults a zone: a `yyyy-mm-dd`
 * string is its own day, a serialised `@db.Date` (`"2026-07-04T00:00:00.000Z"`)
 * carries the day in its first ten characters, and a `Date` goes through
 * {@link dateOnlyKey}.
 *
 * BOTH SHAPES OCCUR IN PRODUCTION, which is why the split mattered rather than
 * being a tidiness point. `BookingGuestNight` rows and booking envelopes arrive
 * as `Date`s; `ProposalGuest.nights` is declared `string[]` and reaches
 * {@link countActiveGuestsForNight} verbatim through
 * `checkCapacityForGuestRanges`. While the `Date` side was projected and the
 * string side was not, one logical night was simultaneously occupied and
 * unoccupied depending on the shape it arrived in, and the capacity admission
 * check under-counted proposed beds inside the lodge capacity lock.
 * `operational-day-shift-club-zone.test.ts` holds that measurement and now
 * asserts the two frames AGREE.
 *
 * THE STRING BRANCH READS THE PREFIX INSTEAD OF REPARSING, which is
 * {@link calendarDateOfSerialisedDbDate}'s own reason for existing: reparsing
 * would project an offset-bearing string into UTC, so
 * `"2026-07-04T12:00:00+13:00"` would decode a day early. It replaces
 * `dateOnlyKey(new Date(entry))`, which projected through the environment zone. A
 * string naming no real day is now refused rather than turned into a plausible
 * wrong key.
 */
function nightEntryKey(entry: GuestNightInput): CalendarDate {
  if (typeof entry === "string") {
    return calendarDateOfSerialisedDbDate(entry);
  }
  if (entry instanceof Date) {
    return dateOnlyKey(entry);
  }
  return nightEntryKey(entry.stayDate);
}

// Cache the derived key set per `nights` array reference. The capacity and
// pricing loops call isGuestActiveOnNight once per (guest, night), so without
// this each call would rebuild the set; the WeakMap keeps it O(nights) once.
const nightKeySetCache = new WeakMap<object, Set<string>>();

/**
 * The set of date-only keys a guest explicitly stays, or null when the guest
 * has no explicit night set (caller should fall back to the envelope).
 */
function getGuestNightKeySet(
  guest: GuestStayRange
): Set<string> | null {
  const nights = guest.nights;
  if (!nights || nights.length === 0) {
    return null;
  }
  const cached = nightKeySetCache.get(nights as unknown as object);
  if (cached) {
    return cached;
  }
  const set = new Set<string>();
  for (const entry of nights) {
    set.add(nightEntryKey(entry));
  }
  nightKeySetCache.set(nights as unknown as object, set);
  return set;
}

export function getGuestStayStart(
  guest: GuestStayRange,
  booking: BookingStayRange
): Date {
  return guest.stayStart ?? booking.checkIn;
}

export function getGuestStayEnd(
  guest: GuestStayRange,
  booking: BookingStayRange
): Date {
  return guest.stayEnd ?? booking.checkOut;
}

/**
 * Does this guest hold a bed for the lodge night `night`?
 *
 * A lodge night is one bed held from midday NZ on that date to midday NZ on the
 * following date (INV-DATE-002). So the night a guest checks out is NOT one of
 * theirs — they occupy only its morning half, which is the operational-day
 * question below and never this one. That is why the envelope branch is
 * half-open `[stayStart, stayEnd)`: `stayEnd` is a departure morning, not an
 * occupied night (INV-DATE-003).
 *
 * This is the frozen night-model predicate that capacity, pricing, whole-lodge
 * and member-night logic are built on (INV-DATE-005), and
 * `booking-guest-stay-ranges-contract.test.ts` pins its body byte-for-byte. The
 * set form of exactly this rule is {@link getGuestBedNightKeys}.
 */
export function isGuestActiveOnNight(
  guest: GuestStayRange,
  night: Date,
  booking: BookingStayRange
): boolean {
  const nightKey = dateOnlyKey(night);

  // Explicit night set wins: a guest is active on a night iff that night is in
  // their set. This correctly handles non-contiguous stays (gaps are absences).
  const nightKeySet = getGuestNightKeySet(guest);
  if (nightKeySet) {
    return nightKeySet.has(nightKey);
  }

  // Fallback: contiguous envelope, half-open [stayStart, stayEnd).
  const stayStartKey = dateOnlyKey(getGuestStayStart(guest, booking));
  const stayEndKey = dateOnlyKey(getGuestStayEnd(guest, booking));

  return stayStartKey <= nightKey && nightKey < stayEndKey;
}

// ---------------------------------------------------------------------------
// The operational day (#2622)
// ---------------------------------------------------------------------------
//
// Owner rule: everyone who stays a night is in the lodge from midday NZ on the
// day they arrive until midday NZ on the day they leave. So an NZ calendar day
// D has two halves and a guest occupies
//
//   the MORNING half of D  iff  D-1 is one of their booked nights
//   the EVENING half of D  iff  D   is one of their booked nights
//
// and they are operationally present on D if they occupy either half. The
// boundary is fixed at midday NZ by definition (epic D-M3): there is no
// setting, no threshold and no time-of-day data anywhere in this file.
//
// This is a PURE per-night rule, so it handles sparse (non-contiguous) stays
// segment by segment (epic D-M4): nights {5, 8} means present on {5, 6, 8, 9},
// and the gap day 7 — adjacent to no booked night — is an absence. A booking
// with zero nights is never operationally present on any day.
//
// The derived labels the chore allocator and the roster badges consume are
// nothing more than which half is occupied:
//
//   isArriving(D)  = evening half only  ("arrives today")
//   isDeparting(D) = morning half only  ("leaves today")
//
// They are never independent data. `isGuestActiveOnNight` — the NIGHT model
// that capacity, pricing and the whole-lodge rules are built on — is untouched
// and deliberately separate; do not conflate the two.

/**
 * Shift a `yyyy-mm-dd` lodge-night key by whole days.
 *
 * A lodge-night key IS a calendar day, so this is integer civil-calendar
 * arithmetic on that day and nothing else. `addCalendarDays` constructs no
 * `Date` and reads no zone, so the answer cannot be moved by where the club or
 * the host sits — and a fractional step or one leaving the four-digit year
 * range throws there rather than returning a key that is not one.
 *
 * IT USED TO ROUND-TRIP THROUGH AN INSTANT, and the comment that justified
 * doing so was the disproved premise this epic exists to remove (#3100). It said
 * the key was re-anchored at "UTC midnight, which is midday NZ (UTC+12/+13)" and
 * so could never roll the calendar day the wrong way. That holds only for a club
 * at or ahead of Greenwich; `INV-DATE-010` no longer asserts it. The body it
 * justified added `days * 24h` to that instant and read the result back through
 * `APP_TIME_ZONE`, which for a club behind Greenwich ATE THE SHIFT: `+1` came
 * back as the same day and `-1` skipped one, on every call rather than at a
 * boundary, and {@link expandStayEnvelopeToNightKeys} — which steps with this
 * function — did not terminate at all.
 *
 * `operational-day-shift-club-zone.test.ts` holds the measurements, and the two
 * near-miss spellings that are also wrong: adding 24 hours to an instant, which
 * breaks on a 25-hour day even with the zone read correctly, and keeping the
 * round trip with a UTC reader, which is correct only until somebody changes the
 * encoder.
 */
function shiftDateOnlyKey(key: string, days: number): CalendarDate {
  return addCalendarDays(requireCalendarDate(key), days);
}

/**
 * Is `nightKey` one of this guest's booked nights?
 *
 * Deliberately duplicates `isGuestActiveOnNight`'s two branches against a
 * pre-derived key instead of refactoring it: that function is frozen (the
 * capacity, pricing, whole-lodge and multi-date-range suites pin it), so the
 * operational-day rule takes a private copy rather than touching it.
 */
function isGuestNightKeyBooked(
  guest: GuestStayRange,
  nightKey: string,
  booking: BookingStayRange
): boolean {
  const nightKeySet = getGuestNightKeySet(guest);
  if (nightKeySet) {
    return nightKeySet.has(nightKey);
  }
  const stayStartKey = dateOnlyKey(getGuestStayStart(guest, booking));
  const stayEndKey = dateOnlyKey(getGuestStayEnd(guest, booking));
  return stayStartKey <= nightKey && nightKey < stayEndKey;
}

/** Which halves of NZ day `day` a guest occupies, plus the derived labels. */
export type GuestOperationalDayPresence = {
  /** Occupies the pre-midday half: the night BEFORE `day` was booked. */
  morning: boolean;
  /** Occupies the post-midday half: the night OF `day` is booked. */
  evening: boolean;
  /** Occupies either half. */
  present: boolean;
  /** Evening half only — they arrive today. */
  isArriving: boolean;
  /** Morning half only — they leave today. */
  isDeparting: boolean;
};

export function getGuestOperationalDayPresence(
  guest: GuestStayRange,
  day: Date,
  booking: BookingStayRange
): GuestOperationalDayPresence {
  const dayKey = dateOnlyKey(day);
  const evening = isGuestNightKeyBooked(guest, dayKey, booking);
  const morning = isGuestNightKeyBooked(
    guest,
    shiftDateOnlyKey(dayKey, -1),
    booking
  );
  return {
    morning,
    evening,
    present: morning || evening,
    isArriving: evening && !morning,
    isDeparting: morning && !evening,
  };
}

/**
 * Is the guest in the lodge at any point on NZ day `day`?
 *
 * This is the one named eligibility rule for every operational surface — chore
 * roster generation, roster save/confirm validation and chore cleanup all read
 * it, so they cannot disagree about who was there.
 */
export function isGuestOperationallyPresentOnDay(
  guest: GuestStayRange,
  day: Date,
  booking: BookingStayRange
): boolean {
  return getGuestOperationalDayPresence(guest, day, booking).present;
}

/** Arrives on `day`: occupies the evening half only. */
export function isGuestArrivingOnDay(
  guest: GuestStayRange,
  day: Date,
  booking: BookingStayRange
): boolean {
  return getGuestOperationalDayPresence(guest, day, booking).isArriving;
}

/** Leaves on `day`: occupies the morning half only. */
export function isGuestDepartingOnDay(
  guest: GuestStayRange,
  day: Date,
  booking: BookingStayRange
): boolean {
  return getGuestOperationalDayPresence(guest, day, booking).isDeparting;
}

/** Everyone operationally present on NZ day `day`, in input order. */
export function getOperationallyPresentGuestsForDay<Guest extends GuestStayRange>(
  guests: Guest[] | null | undefined,
  day: Date,
  booking: BookingStayRange
): Guest[] {
  return (guests ?? []).filter((guest) =>
    isGuestOperationallyPresentOnDay(guest, day, booking)
  );
}

export function getActiveGuestsForNight<Guest extends GuestStayRange>(
  guests: Guest[] | null | undefined,
  night: Date,
  booking: BookingStayRange
): Guest[] {
  return (guests ?? []).filter((guest) =>
    isGuestActiveOnNight(guest, night, booking)
  );
}

export function countActiveGuestsForNight(
  guests: GuestStayRange[] | null | undefined,
  night: Date,
  booking: BookingStayRange
): number {
  return getActiveGuestsForNight(guests, night, booking).length;
}

// ---------------------------------------------------------------------------
// Expanding a stay into nights (#2628)
// ---------------------------------------------------------------------------
//
// `BookingGuestNight` is the canonical night set. `BookingGuest.stayStart` /
// `stayEnd` is a DERIVED half-open envelope whose `stayEnd` is the morning after
// the last night (INV-DATE-012). The two agree for a contiguous stay; for a
// SPARSE (non-contiguous) one the envelope silently fills the internal gaps, so
// anything that expands the envelope when a night set exists reports nights the
// guest is not there.
//
// Six places used to expand a stay and they disagreed. These helpers are the one
// definition (INV-DATE-020); route new callers here rather than writing another
// `eachDateOnlyInRange(guest.stayStart, guest.stayEnd)`.

/**
 * Expand a half-open date-only envelope `[stayStart, stayEnd)` into night keys.
 *
 * **THE MOST DANGEROUS FUNCTION IN THIS FILE. IT IS HALF-OPEN. KEEP IT THAT
 * WAY.** `stayEnd` is a departure morning, never an occupied night
 * (INV-DATE-003), and the bed-allocation planner is fed ONE PSEUDO-GUEST PER
 * NIGHT — each carrying `stayStart = night`, `stayEnd = night + 1`
 * (`candidateGuestBookings` in `bed-allocation-board-records.ts`). Make this inclusive
 * and every pseudo-guest grows a phantom second night, so the planner claims the
 * morning-after bed while its real occupant is still in it: a genuine double
 * booking, on the automatic path, silently. `bed-allocation.test.ts` →
 * "pseudo-guest envelope (#2628)" pins that; it is a mutation probe, not
 * decoration.
 *
 * An empty or reversed envelope yields no nights, which is what makes a
 * zero-night booking present on no day (INV-DATE-008).
 *
 * IT TERMINATES BECAUSE THE STEP BELOW IS A LITERAL FORWARD DAY, not because of
 * anything {@link shiftDateOnlyKey} guarantees: `addCalendarDays(key, 0)` is a
 * fixpoint by design, so parameterising the step reinstates a loop that runs
 * until V8 aborts on the heap limit. #3100 was that loop, and
 * `guest-stay-expansion-census.test.ts` pins the literal for this reason.
 */
export function expandStayEnvelopeToNightKeys(
  stayStart: Date,
  stayEnd: Date
): string[] {
  const endKey = dateOnlyKey(stayEnd);
  const keys: string[] = [];
  for (
    let key = dateOnlyKey(stayStart);
    key < endKey;
    key = shiftDateOnlyKey(key, 1)
  ) {
    keys.push(key);
  }
  return keys;
}

/**
 * The explicit night set a guest carries, sorted — or `null` when they carry
 * none and a caller would have to fall back to the envelope.
 *
 * Use this where the surface deliberately places or counts only explicitly
 * listed nights, which is what the bed-allocation board and its lifecycle do:
 * both build their guest-nights straight from `BookingGuestNight` rows, so a
 * guest with none has nothing to allocate and any envelope fallback would
 * advertise work no allocator will ever do. Everywhere else wants
 * {@link getGuestBedNightKeys}.
 */
export function getExplicitGuestBedNightKeys(
  guest: GuestStayRange
): string[] | null {
  const nightKeySet = getGuestNightKeySet(guest);
  return nightKeySet ? [...nightKeySet].sort() : null;
}

/**
 * Every lodge night this guest holds a bed for, sorted.
 *
 * The set form of {@link isGuestActiveOnNight} and identical to it night for
 * night: the explicit night set wins when the guest has one, otherwise the
 * half-open envelope. That equivalence is pinned by
 * `booking-guest-stay-ranges-sparse.test.ts`, so the counting surfaces and the
 * capacity/pricing surfaces cannot disagree about who is in a bed.
 */
export function getGuestBedNightKeys(
  guest: GuestStayRange,
  booking: BookingStayRange
): string[] {
  const explicit = getExplicitGuestBedNightKeys(guest);
  if (explicit) return explicit;
  return expandStayEnvelopeToNightKeys(
    getGuestStayStart(guest, booking),
    getGuestStayEnd(guest, booking)
  );
}

/**
 * The mornings this guest leaves the lodge, sorted — one per SEGMENT, not one
 * per stay.
 *
 * A guest occupies the morning half of the day after each booked night
 * (INV-DATE-004), so a departure morning is the day after a booked night that is
 * not itself booked. A contiguous stay has exactly one, equal to `stayEnd`,
 * which is why this changes nothing for the ordinary case. Nights {10, 12} have
 * TWO: the 11th and the 13th — a guest who leaves and comes back really does
 * depart twice, and a surface keyed on `stayEnd` alone can only ever record the
 * last one.
 */
export function getGuestDepartureMorningKeys(
  guest: GuestStayRange,
  booking: BookingStayRange
): string[] {
  const nightKeys = getGuestBedNightKeys(guest, booking);
  const booked = new Set(nightKeys);
  return nightKeys
    .map((nightKey) => shiftDateOnlyKey(nightKey, 1))
    .filter((morningKey) => !booked.has(morningKey))
    .sort();
}

/** Is `day` one of this guest's departure mornings (per segment)? */
export function isGuestDepartureMorning(
  guest: GuestStayRange,
  day: Date,
  booking: BookingStayRange
): boolean {
  const dayKey = dateOnlyKey(day);
  return (
    isGuestNightKeyBooked(guest, shiftDateOnlyKey(dayKey, -1), booking) &&
    !isGuestNightKeyBooked(guest, dayKey, booking)
  );
}

/**
 * The next lodge night this guest holds a bed for AFTER `day`, or `null` when
 * `day` is inside or after their last segment.
 *
 * The bound anything scoped to "the segment that just ended" needs. The kiosk's
 * departure sweep is the reason it exists: marking a guest departed clears the
 * chores they can no longer do, and before #2628 the endpoint only ever fired on
 * the morning after the LAST night, so "everything after today" and "the rest of
 * this segment" were the same set. They are not the same set on a sparse stay —
 * a guest booked on nights {11, 14} who checks out on the 12th is BACK on the
 * 14th, and a sweep with no upper bound takes their 14th and 15th with it.
 */
export function getNextGuestBedNightAfter(
  guest: GuestStayRange,
  day: Date,
  booking: BookingStayRange
): Date | null {
  const dayKey = dateOnlyKey(day);
  const nextKey = getGuestBedNightKeys(guest, booking).find(
    (nightKey) => nightKey > dayKey
  );
  return nextKey ? parseDateOnly(nextKey) : null;
}

/**
 * Is `day` a RETURN — an arrival evening that follows an earlier departure
 * morning of the same stay?
 *
 * Only a sparse stay can have one. For a contiguous stay the single departure
 * morning is `stayEnd`, which is after every booked night, so no arrival evening
 * can follow it and this is false for every day of every contiguous stay —
 * deliberately, because it is what keeps the kiosk's attendance controls exactly
 * where they have always been for the ordinary case.
 *
 * It exists because `BookingGuest.arrivedAt` / `departedAt` is ONE attendance
 * pair for the whole stay: "where is this person now", not a log. A guest who
 * checks out on the 12th and comes back on the 14th arrives against a record
 * that still says "departed", and without this the kiosk hides the arrive button
 * (`!departedAt`) and offers no depart button (not a departure morning), leaving
 * the officer with no control at all on a night the guest is in the building.
 * Marking the return arrival clears the stale departure, so the NEXT check-out
 * records rather than toggling the first one off (#2628).
 */
export function isGuestReturningOnDay(
  guest: GuestStayRange,
  day: Date,
  booking: BookingStayRange
): boolean {
  const dayKey = dateOnlyKey(day);
  if (!getGuestOperationalDayPresence(guest, day, booking).isArriving) {
    return false;
  }
  return getGuestDepartureMorningKeys(guest, booking).some(
    (morningKey) => morningKey < dayKey
  );
}

/**
 * The earliest lodge night whose occupant may still be in the lodge right now:
 * YESTERDAY, not today.
 *
 * Night N runs to midday NZ on date N+1 (INV-DATE-002), so at any moment on day
 * D the person who slept on night D-1 is either still in their bed or has just
 * left it. A guard written `stayDate >= today` forgets them, which is how a bed
 * somebody is lying in can be deleted. Use this as the lower bound of any
 * "is this bed still spoken for?" query.
 *
 * Deliberately NOT for the partner-share sweeps, which DELETE rows: night D-1 is
 * occupancy that has already happened, and past lodge nights are history and
 * stay untouched (INV-CAP-010).
 *
 * `today` is REQUIRED and carries no default (#3123). The default it used to
 * carry resolved to the CONTAINER's timezone rather than the club's persisted
 * one (`INV-CONFIG-002`) — and this module cannot read the club's zone to fix
 * that in place: it reaches the browser bundle (`admin/reports/page.tsx` is
 * `"use client"` and imports it through `admin-reports.ts`), where
 * `@/lib/club-time/server` is a bare throw and `club-time-zone-runtime` would
 * drag Prisma in. Its one production caller is the bed-deactivation guard in
 * `bed-allocation-beds.ts`, which runs under the global cohort key and the
 * per-lodge capacity key, so the day has to be resolved outside that
 * transaction in any case (`INV-LOCK-004`). Deleting the default is what makes
 * the compiler ask every caller for the value.
 */
export function getEarliestCurrentBedNightDate(today: Date): Date {
  return addDaysDateOnly(today, -1);
}

/**
 * Lodge-date visibility for the lobby wall. Both branches now delegate to a
 * named model; this function chooses between them and holds nothing of its own.
 *
 * `includeDepartureDate: false` is the NIGHT model (INV-DATE-005): who holds a
 * bed on the lodge night `date`.
 *
 * `includeDepartureDate: true` is the OPERATIONAL DAY (INV-DATE-004): who is in
 * the lodge at any point on NZ day `date`, which is the guest whose night `date`
 * or whose night `date - 1` is booked. That is per SEGMENT, so a guest booked on
 * nights {10, 12} is visible on the 10th, the 11th, the 12th and the 13th — the
 * 11th being a morning they really are in the building until midday.
 *
 * ## What changed, and why it is safe now (#2735)
 *
 * This branch used to be narrower on one shape and one shape only: for an
 * explicit night set it admitted the morning after the FINAL listed night and no
 * other, so a sparse stay's intermediate departure mornings were missing. Every
 * other operational surface — the roster, the kiosk badges, the kiosk
 * check-in/check-out buttons — was made per-segment by #2628; the wall was
 * deliberately left behind, and #2622/#2628 both refused to move it.
 *
 * They refused because of the COUNT, not the rule. `lodge-display-state.ts` is
 * the club's unauthenticated public screen, and its guest-name privacy gate is a
 * sole-occupancy count over NIGHTS (INV-DATE-006, issue #58). That count used to
 * be derived from this list — "everyone visible except whoever's `stayEnd` is
 * today" — so widening this predicate by one morning would have added a phantom
 * NIGHT, dropped a sole-occupancy blockout and published guest names and phone
 * numbers. #2628 moved the count onto the night model; #2735 took it off this
 * list entirely, so it is now derived from the booking's whole guest set and
 * shares nothing with visibility in either direction. Widening this can no
 * longer move a night count. THAT ORDER IS THE WHOLE SAFETY ARGUMENT — if the
 * count is ever coupled back to this list, this predicate has to narrow again
 * first.
 *
 * Unchanged for every contiguous stay, envelope or explicit: "night `date` or
 * night `date - 1`" over `[stayStart, stayEnd)` is exactly the closed range
 * `[stayStart, stayEnd]` this used to compute, and a contiguous night set has
 * exactly one departure morning, the one after its final night.
 */
function isGuestVisibleOnLodgeDate(
  guest: GuestStayRange,
  date: Date,
  booking: BookingStayRange,
  options?: { includeDepartureDate?: boolean }
): boolean {
  if (!options?.includeDepartureDate) {
    return isGuestActiveOnNight(guest, date, booking);
  }
  return isGuestOperationallyPresentOnDay(guest, date, booking);
}

/**
 * @deprecated (#2622) Call the named model you actually mean:
 * `getOperationallyPresentGuestsForDay` for the operational day, or
 * `getActiveGuestsForNight` for the night model.
 *
 * Since #2631 this has exactly one caller — `lodge-display-state.ts`, the
 * fenced, privacy-load-bearing lobby wall — and
 * `booking-guest-stay-ranges-contract.test.ts` freezes that list so no new
 * caller can appear. It survives as the wall's single named entry point rather
 * than as a distinct rule: since #2735 both of its branches are a straight
 * delegation to a named model (see `isGuestVisibleOnLodgeDate` above), so
 * nothing is defined here and nothing can drift out of step.
 */
export function getLodgeVisibleGuestsForDate<Guest extends GuestStayRange>(
  guests: Guest[] | null | undefined,
  date: Date,
  booking: BookingStayRange,
  options?: { includeDepartureDate?: boolean }
): Guest[] {
  return (guests ?? []).filter((guest) =>
    isGuestVisibleOnLodgeDate(guest, date, booking, options)
  );
}
