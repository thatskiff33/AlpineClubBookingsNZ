/**
 * The club timezone's shape and validation (CT-1, #2989; epic #2988).
 *
 * ONE IANA IDENTIFIER PER INSTALLATION. The club's civil time is a named zone
 * such as `Pacific/Auckland` — a place, whose DST rules the platform reads from
 * the IANA database. It is never an abbreviation (`NZT`, `NZST`, `EST`), never a
 * fixed offset (`+12:00`, `Etc/GMT-12`), and never the reader's own clock.
 * INV-CONFIG-002.
 *
 * WHY A SHAPE RULE AND NOT `Intl.supportedValuesOf("timeZone")`. Membership of
 * that list was the obvious validator and is the wrong one. Measured on Node
 * 24.15.0 here it holds 418 zones and is NOT canonical across engines: it
 * contains `Asia/Calcutta` and NOT `Asia/Kolkata`, because it is whatever the
 * bundled ICU calls canonical. A different ICU answers the other way round. Both
 * spellings are accepted by `Intl.DateTimeFormat` on every engine, so validating
 * by list membership would let an ICU upgrade turn a perfectly good stored zone
 * into an invalid one. The list is still exactly right for OFFERING choices
 * (`listSelectableClubTimeZones`), and useless for judging a stored value.
 *
 * So the rule is: an IANA identifier SHAPE, then a runtime usability probe, then
 * the same shape rule again on whatever the runtime canonicalised it to.
 * Measured against all 418 zones the shape below matches every one of them, and
 * every zone in that list contains a `/` — which is what makes requiring one
 * reject the whole single-word alias family (`NZ`, `Japan`, `EST`, `UTC`, `GMT`,
 * `Zulu`, `PST8PDT`) in one stroke. Those are not wrong because the platform
 * cannot read them; `Intl` reads `EST` happily, as `America/Panama`. They are
 * wrong because an abbreviation does not name a place, so it carries no promise
 * about which DST rules a club's future bookings will be priced and rostered
 * against.
 *
 * TWO NAMESPACES ARE REJECTED BY NAME, and they are the reason the shape rule
 * alone is not enough. `Etc/GMT-14` and `SystemV/EST5` both satisfy the shape
 * (the hyphen and the digits are legal identifier characters) and both resolve to
 * themselves rather than to a real location. `Etc/*` is the fixed-offset
 * namespace — no DST, reversed sign convention, exactly the "fixed offset in a
 * spelling `Intl` accepts" the issue names — and `SystemV/*` is a legacy
 * posix-rule namespace with frozen DST rules. No club's civil time is either.
 *
 * This module is deliberately free of `server-only` and of every Prisma import:
 * the setup CLI, the boot backfill, the API route and the admin panel all need
 * the same judgement, and a validator that only half the writers can reach is how
 * two of them drift.
 */

/**
 * The generic New Zealand default — used ONLY where no prior effective
 * configuration exists at all. It is a distribution default, not an assumption
 * about which club this is: an install that has been running on another zone
 * keeps that zone (see `clubTimeZoneSelfHealStep`).
 */
export const CLUB_TIME_ZONE_FALLBACK = "Pacific/Auckland";

/**
 * The `ClubTimeSettings` singleton row id — the ONE spelling, and it lives in
 * this module rather than beside the reader for a measured reason (#2989 review).
 * Four writers query this row: the admin route, the boot backfill, the setup CLI
 * and the seed. Two of them cannot import the `server-only` reader, so each had
 * declared its own `"default"` literal — and a drift between them fails SILENTLY,
 * because `create` passes `id` explicitly: the writer would create a second row
 * under the wrong id, the reader would still find nothing at `"default"`, and the
 * club's chosen timezone would sit orphaned with no error anywhere. This module is
 * deliberately free of `server-only` precisely so every writer can reach it,
 * which is the same argument its own doc makes for the validator: "a validator
 * that only half the writers can reach is how two of them drift".
 */
export const CLUB_TIME_SETTINGS_ID = "default";

/** Matches `ClubTimeSettings.timeZone`'s `@db.VarChar(64)`. */
export const CLUB_TIME_ZONE_MAX_LENGTH = 64;

/**
 * An IANA identifier: ASCII segments separated by `/`, at least two of them.
 * Verified against every zone `Intl.supportedValuesOf("timeZone")` reports.
 */
const IANA_IDENTIFIER_SHAPE = /^[A-Za-z][A-Za-z0-9_-]*(?:\/[A-Za-z0-9_-]+)+$/;

/** Fixed-offset and legacy-posix namespaces — see the module doc. */
const NON_LOCATION_NAMESPACE = /^(?:etc|systemv)\//i;

function hasIanaIdentifierShape(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= CLUB_TIME_ZONE_MAX_LENGTH &&
    IANA_IDENTIFIER_SHAPE.test(value) &&
    !NON_LOCATION_NAMESPACE.test(value)
  );
}

/**
 * The canonical spelling of a usable named IANA club timezone, or `null`.
 *
 * Trims, then judges the SHAPE of what the caller supplied — so `EST` is refused
 * before the runtime gets a chance to widen it into `America/Panama` — then asks
 * the runtime to resolve it, and judges the resolved identifier by the same rule.
 * The resolved spelling is what comes back, so a deprecated alias
 * (`US/Pacific`) or a case variant (`pacific/auckland`) is stored the way this
 * runtime names the zone rather than the way it was typed.
 */
export function normaliseClubTimeZone(
  value: string | null | undefined,
): string | null {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!hasIanaIdentifierShape(candidate)) return null;

  let resolved: string;
  try {
    // Pinned by construction: `timeZone` is the value under test. The locale is
    // irrelevant — nothing here formats anything, the probe exists only to make
    // the runtime accept or reject the zone and report its canonical name.
    resolved = new Intl.DateTimeFormat("en-NZ", {
      timeZone: candidate,
    }).resolvedOptions().timeZone;
  } catch {
    // RangeError: this runtime has no such zone.
    return null;
  }

  return hasIanaIdentifierShape(resolved) ? resolved : null;
}

/**
 * The canonical zone for a value whose job is to be PRESERVED rather than
 * approved rather than typed: the boot backfill, the seed, and the environment
 * leg of {@link resolveClubTimeZone} — every context whose input is a zone a
 * deployment is ALREADY running on, and no context where a person chose it.
 *
 * IT DIFFERS FROM {@link normaliseClubTimeZone} IN ONE ORDERING, AND THAT
 * ORDERING IS THE WHOLE POINT (#2989 review, found independently by two lenses).
 * The validator judges the INPUT's shape before probing, which is right for a
 * value an operator types: it refuses `EST` outright rather than letting the
 * runtime widen it into `America/Panama`, because an abbreviation names no place
 * and so promises nothing about next spring's DST rules. Applied to a backfill
 * that ordering is a defect, because the backfill is not approving anybody's
 * choice — it is recording the zone a deployment has ALREADY been running on for
 * years, and refusing it does not undo that; it substitutes
 * `Pacific/Auckland` and moves the club.
 *
 * Measured on Node 24.15.0: forty-one `TZ` values that work perfectly today
 * (`Intl` accepts them, so `APP_TIME_ZONE` formats correctly) are refused by the
 * validator — `GB`, `NZ`, `NZ-CHAT`, `EST5EDT`, `PST8PDT`, `Japan`, `Israel`,
 * `W-SU`, `Navajo` and the rest. **Thirty-six of them canonicalise to a genuine
 * location that satisfies the shape rule**: `GB` → `Europe/London`, `NZ-CHAT` →
 * `Pacific/Chatham` (+12:45), `EST5EDT` → `America/New_York`. Probing first
 * preserves every one of those exactly, and still satisfies the issue's
 * requirement that only a named IANA identifier is ever stored — the STORED value
 * is a location either way.
 *
 * The residual class returns `null` and MUST NOT be substituted: `UTC`, `GMT`,
 * `Zulu`, `Universal`, `UCT`, `Greenwich` and `Etc/UTC` all canonicalise to
 * `UTC`, and `Etc/GMT±N` / `SystemV/*` to themselves. No place on earth has those
 * as its civil time, so there is nothing to preserve and every candidate would be
 * a guess. The callers therefore record nothing at all and leave the setup
 * checklist blocked naming the refused value, which satisfies both requirement 2
 * (never invent a zone for a configured install) and requirement 3 (never store a
 * fixed offset), and matches `INV-CONFIG-001`'s rule that an unconfigured state
 * is visible where an operator has to act.
 */
export function normaliseClubTimeZoneForPreservation(
  value: string | null | undefined,
): string | null {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate || candidate.length > CLUB_TIME_ZONE_MAX_LENGTH) return null;

  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-NZ", {
      timeZone: candidate,
    }).resolvedOptions().timeZone;
  } catch {
    // This runtime has no such zone, so the deployment cannot have been using it.
    return null;
  }

  return hasIanaIdentifierShape(resolved) ? resolved : null;
}

/** True when `value` is a usable named IANA club timezone. */
export function isValidClubTimeZone(value: string | null | undefined): boolean {
  return normaliseClubTimeZone(value) !== null;
}

/**
 * Resolve the club timezone from the persisted value, with the environment as a
 * SEED-ONLY fallback and `Pacific/Auckland` as the last resort.
 *
 * THE PRECEDENCE IS THE WHOLE POINT (INV-CONFIG-002). A valid persisted value
 * wins outright: once the club has configured its timezone, `TZ` and
 * `NEXT_PUBLIC_TZ` are not a second opinion, and moving the container's clock
 * cannot move the club's civil time. The environment is read ONLY when nothing is
 * persisted — the window between `prisma migrate deploy` and the first boot of
 * the upgraded release, which is exactly the window in which an existing
 * deployment's current effective zone must be preserved unchanged.
 *
 * A persisted value that does not validate is treated as absent rather than
 * trusted, because the only ways to get one there are database surgery and an
 * ICU that no longer knows the zone; in both cases falling through to the
 * environment and then to the documented default keeps the app answering.
 *
 * Pure, so the precedence itself is unit-testable without a database.
 */
export function resolveClubTimeZone(
  persisted: string | null | undefined,
  environmentTimeZone: string | null | undefined,
): string {
  /*
    THE TWO LEGS USE DIFFERENT NORMALISERS, AND THAT IS THE POINT (#2989 review).

    The persisted leg is STRICT: a stored value passed the input validator when it
    was written, so one that fails now is corrupt — a hand-edit, a bad restore —
    and falling through is the safe reading.

    The environment leg is a PRESERVATION context, and it is the only thing this
    function's second argument is ever for: it answers "what is this deployment
    already effectively using" for the window between `prisma migrate deploy` and
    the first boot that records it. Judging it strictly gives the wrong answer for
    the same thirty-six legacy spellings the backfill had to stop mishandling —
    `TZ=GB` would report `Pacific/Auckland` here while the deployment runs on
    `Europe/London` and the backfill is about to record `Europe/London`. The window
    is one boot wide, and a reader that disagrees with the writer inside it is
    exactly the class the review found; making the two agree costs one call.
  */
  return (
    normaliseClubTimeZone(persisted) ??
    normaliseClubTimeZoneForPreservation(environmentTimeZone) ??
    CLUB_TIME_ZONE_FALLBACK
  );
}

/**
 * Every named zone this runtime can offer, for a selector's options.
 *
 * `Intl.supportedValuesOf` is the right source HERE and the wrong one for
 * validation (module doc). Filtered through the same shape rule so the two can
 * never disagree about a value the operator is shown, and sorted so the list
 * reads the same on every runtime. `CLUB_TIME_ZONE_FALLBACK` is unioned in so
 * the documented default is always offerable even on a runtime whose list omits
 * it.
 */
export function listSelectableClubTimeZones(): string[] {
  const offered = new Set<string>([CLUB_TIME_ZONE_FALLBACK]);
  try {
    for (const zone of Intl.supportedValuesOf("timeZone")) {
      if (hasIanaIdentifierShape(zone)) offered.add(zone);
    }
  } catch {
    // A runtime without supportedValuesOf still offers the documented default.
  }
  return [...offered].sort((left, right) => left.localeCompare(right, "en"));
}
