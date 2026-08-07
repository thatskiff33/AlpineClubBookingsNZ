/**
 * The one definition of a valid expected arrival time (#2621).
 *
 * WHY THIS EXISTS. The rule was written out three times — in
 * `api/bookings/route.ts`, in `api/bookings/[id]/arrival-time/route.ts`, and a
 * third time inside `phase-b1.test.ts`, which re-implemented the regex instead of
 * importing it. All three read `/^([01]\d|2[0-3]):[0-5]0$/`, which accepts
 * `:00`, `:10`, `:20`, `:30`, `:40` and `:50` — six values — while the message
 * beside it said "30-minute increments" and the comment above it said "(00 or
 * 30)". The picker the field is edited with (`time-picker.tsx`) only ever offers
 * `:00` and `:30`, so the API contract was strictly looser than every other
 * statement of it, and the test that should have caught that agreed with the bug
 * because it was a copy of it.
 *
 * The canonical set is therefore `:00` and `:30`, matching the picker, the
 * message and the comment. Off-step values could only ever arrive through a
 * direct API call, never through the app.
 *
 * ON EXISTING DATA. This validates writes only; nothing re-validates a stored
 * value on read, so a booking that already carries an off-step time (only
 * reachable by a direct API call against the old regex) keeps displaying it and
 * is not rejected anywhere. The next edit through the picker moves it onto the
 * canonical set, because those are the only values the picker offers.
 */
import { z } from "zod";

/**
 * The minute values a valid expected arrival time may carry.
 *
 * `time-picker.tsx` builds its option list from this rather than from its own
 * `[0, 30]` literal, so the control and the validator cannot disagree about the
 * allowed set — which is the drift this whole module exists to end.
 */
export const ARRIVAL_TIME_MINUTES = ["00", "30"] as const;

/**
 * `HH:mm` on the hour or the half hour, 24-hour clock.
 *
 * Deliberately not `[0-5]0`: that was the bug. Kept as a single exported literal
 * so no caller can hand-roll a fourth copy that drifts again.
 */
export const EXPECTED_ARRIVAL_TIME_PATTERN = /^([01]\d|2[0-3]):(00|30)$/;

/** Shown to whoever sent the value, so it names the actual rule. */
export const EXPECTED_ARRIVAL_TIME_MESSAGE =
  "Must be HH:mm on the hour or half hour, for example 17:00 or 17:30";

/** True when `value` is a valid expected arrival time. */
export function isExpectedArrivalTime(value: string): boolean {
  return EXPECTED_ARRIVAL_TIME_PATTERN.test(value);
}

/**
 * The Zod schema every writer validates with. Both routes use this, so a change
 * to the rule cannot reach one endpoint and miss the other.
 */
export const expectedArrivalTimeSchema = z
  .string()
  .regex(EXPECTED_ARRIVAL_TIME_PATTERN, EXPECTED_ARRIVAL_TIME_MESSAGE);
