/**
 * The club timezone, branded (CT-2, #2990; epic #2988).
 *
 * CT-1 (#2989) already owns the judgement — what a usable named IANA club
 * timezone is, why `Intl.supportedValuesOf` is the wrong validator and the right
 * source of CHOICES, and why the persisted value beats the environment
 * (`INV-CONFIG-002`). This module adds nothing to that judgement. It only
 * carries the answer into the type system, so a function that needs the club's
 * civil-time authority cannot be handed a bare `process.env.TZ`, a browser's
 * `resolvedOptions().timeZone`, or a hopeful string literal.
 */

import {
  normaliseClubTimeZone,
  normaliseClubTimeZoneForPreservation,
} from "@/lib/club-time-zone";

import type { ClubTimeZone } from "./types";

/**
 * `value` as the club's timezone, or `null` when CT-1's validator refuses it.
 * Returns the CANONICAL spelling this runtime uses, not the spelling supplied.
 */
export function asClubTimeZone(
  value: string | null | undefined,
): ClubTimeZone | null {
  return normaliseClubTimeZone(value) as ClubTimeZone | null;
}

/** {@link asClubTimeZone}, throwing with the offending value named. */
export function requireClubTimeZone(
  value: string | null | undefined,
): ClubTimeZone {
  const zone = asClubTimeZone(value);
  if (zone === null) {
    throw new Error(
      `Not a usable named IANA club timezone: ${JSON.stringify(value)}. ` +
        "Expected something like Pacific/Auckland — never an abbreviation (NZST), " +
        "a fixed offset (Etc/GMT-12) or the reader's own clock (INV-CONFIG-002).",
    );
  }
  return zone;
}

/**
 * The zone a deployment is ALREADY effectively running on, preserved rather than
 * approved. CT-1's second normaliser: it probes before judging, so the
 * thirty-six legacy `TZ` spellings that canonicalise to a real location (`GB` ->
 * `Europe/London`, `NZ-CHAT` -> `Pacific/Chatham`) survive instead of being
 * replaced by the New Zealand default. `null` for a value that names no place at
 * all (`UTC`, `Etc/GMT-12`), where there is nothing to preserve.
 */
export function preservedClubTimeZone(
  value: string | null | undefined,
): ClubTimeZone | null {
  return normaliseClubTimeZoneForPreservation(value) as ClubTimeZone | null;
}

/**
 * THE COMPATIBILITY SEAM, AND THE ONLY PLACE THAT BRANDS WITHOUT VALIDATING.
 * Retired with the legacy adapters by CT-6 (#2991).
 *
 * `src/lib/nzst-date.ts` and `src/lib/date-only.ts` pass `APP_TIME_ZONE`
 * straight to `Intl.DateTimeFormat` today, and `APP_TIME_ZONE` is
 * `process.env.TZ || NEXT_PUBLIC_TZ || "Pacific/Auckland"` — an unvalidated
 * string. `Intl` accepts far more than CT-1's validator does: a deployment
 * running `TZ=NZ`, `TZ=UTC` or `TZ=EST` formats perfectly well today, and CT-2's
 * whole promise is that pointing those adapters at this kernel changes NO
 * caller's behaviour. Validating here would break exactly those deployments, so
 * the seam brands the raw value and lets `Intl` reject it if it is genuinely
 * unusable — which is what happens today.
 *
 * One difference, stated because it is real: today an unusable `TZ` throws while
 * `nzst-date.ts` is being imported; after this it throws on the first format
 * call. Both are fatal and neither is silent.
 *
 * NEW CODE MUST NOT CALL THIS. A server module reads the club's zone with
 * `clubTimeZone()` from `./server`; a client module receives it as data.
 */
export function unvalidatedLegacyClubTimeZone(value: string): ClubTimeZone {
  return value as ClubTimeZone;
}
