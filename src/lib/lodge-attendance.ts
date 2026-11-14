import {
  isGuestReturningOnDay,
  type BookingStayRange,
  type GuestStayRange,
} from "@/lib/booking-guest-stay-ranges";

/**
 * The kiosk's attendance writes, decided in one place (#4965).
 *
 * WANTED STATE, NOT A SWITCH. The arrive and depart endpoints used to be
 * server-side toggles: "flip whatever is stored". A toggle is not idempotent,
 * so anything that repeats the request — a double tap on slow lodge Wi-Fi, an
 * impatient retry, a phantom tap — turned a check-in into a check-out and left
 * a misleading "cleared" audit row. The kiosk now sends the state the hut leader
 * saw and wants (`arrived` / `departed`), and a request asking for the state
 * the row already holds changes nothing: no write, no audit row.
 *
 * THE LEGACY TOGGLE STAYS for a request carrying no wanted state, so a kiosk
 * page that was already open when new code went live keeps working through a
 * blue-green deploy exactly as it did before.
 *
 * Both endpoints decide from the row they re-read (after the locks, on the
 * depart route), never from the page — the page only supplies the intent.
 *
 * This module imports nothing server-only, so the kiosk page reaches
 * `isGuestHereNow` from it too: the button label and the wanted state the page
 * sends are the same rule the server applies.
 */

type AttendancePair = {
  arrivedAt: Date | string | null;
  departedAt: Date | string | null;
};

/**
 * "Arrived" means HERE NOW. A stale `arrivedAt` left over from an earlier
 * segment of a stay with a gap in it is superseded by that segment's departure
 * and does not count until the return is recorded (#2628).
 */
export function isGuestHereNow(guest: AttendancePair): boolean {
  return Boolean(guest.arrivedAt) && !guest.departedAt;
}

export type ArrivalDecision =
  | { changed: false }
  | {
      changed: true;
      arrivedAt: Date | null;
      /** A RETURN also clears the departure recorded on an earlier segment. */
      clearsDeparture: boolean;
    };

/**
 * What a check-in request does to the stay's attendance pair.
 *
 * - A RETURN (`departedAt` set and the guest arriving again today on a sparse
 *   stay, #2628) records a fresh arrival and clears the superseded departure,
 *   whether the request says `arrived: true` or carries no wanted state. Only
 *   an explicit `arrived: false` is not a return.
 * - `wanted` absent: the toggle as it has always been.
 * - `arrived: true`: records an arrival only when none is recorded.
 * - `arrived: false`: clears an arrival only when one is recorded.
 */
export function decideArrival(input: {
  guest: GuestStayRange & AttendancePair;
  day: Date;
  booking: BookingStayRange;
  wanted: boolean | undefined;
  now: Date;
}): ArrivalDecision {
  const { guest, day, booking, wanted, now } = input;
  const isReturn =
    wanted !== false &&
    Boolean(guest.departedAt) &&
    isGuestReturningOnDay(guest, day, booking);
  if (isReturn) {
    return { changed: true, arrivedAt: now, clearsDeparture: true };
  }

  const recorded = Boolean(guest.arrivedAt);
  const target = wanted ?? !recorded;
  if (target === recorded) return { changed: false };
  return {
    changed: true,
    arrivedAt: target ? now : null,
    clearsDeparture: false,
  };
}

export type DepartureDecision =
  | { changed: false }
  | { changed: true; departedAt: Date | null };

/**
 * What a check-out request does to the stay's departure.
 *
 * - `wanted` absent: the toggle as it has always been.
 * - `departed: true`: records a departure only when none is recorded.
 * - `departed: false`: clears a departure only when one is recorded — which is
 *   how the kiosk clears a stale Departed card from an earlier segment before
 *   recording the real check-out.
 */
export function decideDeparture(input: {
  guest: Pick<AttendancePair, "departedAt">;
  wanted: boolean | undefined;
  now: Date;
}): DepartureDecision {
  const { guest, wanted, now } = input;
  const recorded = Boolean(guest.departedAt);
  const target = wanted ?? !recorded;
  if (target === recorded) return { changed: false };
  return { changed: true, departedAt: target ? now : null };
}
