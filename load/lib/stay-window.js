/**
 * Stay-date arithmetic for the k6 write scenarios (#4940). Pure and free of k6
 * imports so `src/lib/__tests__/load-stay-window.test.ts` proves it.
 *
 * Every value is a `YYYY-MM-DD` lodge night (INV-DATE): a calendar day with no
 * zone, stepped by whole UTC days. The window is relative to the run's day so
 * it keeps landing inside the seeded, relativized seasons
 * (`scripts/e2e-stack.sh prepare`) instead of drifting into the past the way a
 * fixed default date does.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function requireDateOnly(value, name) {
  if (typeof value !== "string" || !DATE_ONLY.test(value)) {
    throw new Error(name + ' must be a YYYY-MM-DD date, got "' + value + '"');
  }
  const ms = Date.parse(value + "T00:00:00Z");
  if (!isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new Error(name + ' is not a real calendar date: "' + value + '"');
  }
  return ms;
}

/** `dateOnly` moved by `days` whole days. */
export function addDaysIso(dateOnly, days) {
  return new Date(requireDateOnly(dateOnly, "date") + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** The UTC calendar day of an epoch-millisecond instant. */
export function utcDayOf(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Days after the run's UTC day that the booking-contention night falls when
 * CONTENTION_CHECKIN names none. +116 sits between the last seeded fixture
 * window (+111..+112, two lodges) and the mixed-writes window (+120), so the
 * UTC run day being one behind the club's day still lands on an empty night
 * (#4002 lists the seeded windows).
 */
export const CONTENTION_OFFSET_DAYS = 116;

/** The default booking-contention night for a run started at `epochMs`. */
export function contentionCheckIn(epochMs) {
  return addDaysIso(utcDayOf(epochMs), CONTENTION_OFFSET_DAYS);
}

/** Nights `[from, toExclusive)`, in order. */
export function nightsBetween(from, toExclusive) {
  const end = requireDateOnly(toExclusive, "toExclusive");
  const out = [];
  for (let t = requireDateOnly(from, "from"); t < end; t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * The calendar months a night range touches, as the availability API takes
 * them: `{ year, month }` with a ZERO-based month.
 */
export function monthsTouched(nights) {
  const seen = {};
  const out = [];
  for (const night of nights) {
    const key = night.slice(0, 7);
    if (seen[key]) continue;
    seen[key] = true;
    out.push({
      year: parseInt(night.slice(0, 4), 10),
      month: parseInt(night.slice(5, 7), 10) - 1,
    });
  }
  return out;
}

/**
 * The mixed-writes stay for one VU iteration: a lodge (index into the run's
 * lodges) and a one- or two-night stay starting within `spread` nights of
 * `start`. Neighbouring VUs land on different lodges and nights, so writers
 * contend across lodges and nights rather than on one hot key.
 */
export function mixedWriteStay(start, vu, iter, spread, lodgeCount) {
  if (!(spread >= 1 && lodgeCount >= 1)) {
    throw new Error("mixedWriteStay needs spread >= 1 and lodgeCount >= 1");
  }
  const turn = vu + iter;
  const checkIn = addDaysIso(start, turn % spread);
  return {
    lodgeIndex: turn % lodgeCount,
    checkIn: checkIn,
    checkOut: addDaysIso(checkIn, 1 + (turn % 2)),
  };
}

/**
 * Every night a mixed-writes run can touch: the spread, plus the longest stay
 * (two nights) and the one-night extension the modify step asks for.
 */
export function mixedWriteNights(start, spread) {
  return nightsBetween(start, addDaysIso(start, spread + 2));
}

/**
 * The payment-path stay for one VU iteration: one night, a week apart per
 * iteration and spread over seven nights by VU, so the paid bookings it leaves
 * behind stay well under any lodge's capacity.
 */
export function paymentStay(start, vu, iter, lodgeCount) {
  const checkIn = addDaysIso(start, iter * 7 + (vu % 7));
  return {
    lodgeIndex: lodgeCount >= 1 ? vu % lodgeCount : 0,
    checkIn: checkIn,
    checkOut: addDaysIso(checkIn, 1),
  };
}
