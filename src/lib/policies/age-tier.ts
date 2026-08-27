import type { AgeTier } from "@prisma/client";
import {
  calendarDateFromParts,
  calendarDateOfDateOnlyInstant,
  calendarDateParts,
  dateOnlyInstantOf,
  requireStoredCalendarDay,
  type CalendarDate,
} from "@/lib/club-time";
import { getSeasonStartMonth } from "@/lib/financial-year";

/**
 * THE AGE-TIER COMPARISON HAS TWO SIDES AND THEY SHARE ONE FRAME (#3082).
 *
 * A date of birth and a season start are both CALENDAR DAYS. Neither carries a
 * time of day, neither carries a zone, and the answer they produce - an age, and
 * therefore a tier, and therefore a price band - must be the same on every host
 * on earth. So both sides are held as {@link CalendarDate} text and compared
 * with integer arithmetic, and the `Date`-shaped entry points below exist only
 * to decode the `@db.Date` values 23 call sites already hold.
 *
 * WHAT THIS REPLACED, because the next author's instinct will be to fix one half
 * and the halves were interlocked. `getSeasonStartDate` built
 * `new Date(seasonYear, startMonth - 1, 1)` - HOST-local midnight - and
 * `computeAge` read both arguments with `getFullYear`/`getMonth`/`getDate`, also
 * host-local. The reference side survived that by a round trip: local getters
 * read back exactly the parts the local constructor was given, in every zone
 * (swept: 418 zones x 2015-2036 x all 12 season-start months, zero failures).
 * The DATE OF BIRTH side had no such luck - it is stored at UTC midnight
 * (`INV-DATE-024`), so host-local getters read the PREVIOUS day for any host
 * behind Greenwich, which makes the member look a day older.
 *
 * Measured on the old pair, over every stored date of birth in a full year and
 * every zone this runtime knows: **161 of 418 zones misclassified exactly one
 * day of birthdays - the day AFTER the season start - and by +1 year**, never
 * fewer and never more. `Pacific/Auckland` and every other zone at or ahead of
 * Greenwich answered correctly, which is why the defect was latent rather than
 * live. A member born on 2 April whose true age at season start is 17 was read
 * as 18 and quoted the ADULT band; at 4 and 9 the same +1 crosses the INFANT and
 * CHILD boundaries.
 *
 * THE AGE-UP CRON WAS NOT AFFECTED, and an earlier draft of this docblock said it
 * was. `cron-age-up.ts` prefilters candidates on
 * `dateOfBirthPrefilterBoundForMinAge`, whose EXCLUSIVE bound and this
 * misclassification's boundary coincide exactly: the bound admits
 * `dateOfBirth <= seasonStart - minAge years`, and the one day of birthdays the
 * old read got wrong is the day AFTER that. So the misread member was never a
 * candidate — and for candidates the old read DID move, both readings sit at or
 * above `minAge`, which `validateAgeTierPartition` guarantees means ADULT either
 * way. Swept: 27 638 160 admitted candidates over 418 zones x 12 season-start
 * months x 10 configured ADULT minimum ages. 19 423 of them had their age reading
 * changed by this fix and **zero had their promote-or-skip verdict changed.** The
 * candidate set itself is byte-identical too (280 896 comparisons, zero
 * differences), because the retired `setFullYear` spelling preserved the local
 * wall components and the read-back re-encoded them as UTC midnight.
 *
 * FIXING EITHER HALF ALONE MAKES IT WORSE, which is why they moved together.
 * Correct the date-of-birth read and the reference side (still host-local
 * midnight) is then read in UTC, so on a behind-Greenwich host the season start
 * itself lands a day early. Move `getSeasonStartDate` to UTC midnight and leave
 * the host-local getters and the same happens from the other direction. There is
 * no half of this that is an improvement on its own.
 */

/**
 * The club calendar day a season year starts on - the start of the membership
 * financial year. For the default 31 March year-end that is 1 April
 * (`getSeasonStartCalendarDate(2026)` is `"2026-04-01"`).
 *
 * NO `Date`, so nothing here can be moved by a host zone. This is the canonical
 * form; {@link getSeasonStartDate} is the encoding of it that the existing call
 * sites take.
 */
export function getSeasonStartCalendarDate(seasonYear: number): CalendarDate {
  return calendarDateFromParts(seasonYear, getSeasonStartMonth(), 1);
}

/**
 * The same day as a date-only `Date` - UTC midnight, the one encoding a
 * `@db.Date` column keeps (`INV-DATE-019`'s first exact boundary,
 * `INV-DATE-026`).
 *
 * It used to be `new Date(seasonYear, startMonth - 1, 1)`, host-local midnight,
 * which is a different instant in every zone. See the module doc above for why
 * that survived as long as it did and why it could not be corrected alone.
 */
export function getSeasonStartDate(seasonYear: number): Date {
  return dateOnlyInstantOf(getSeasonStartCalendarDate(seasonYear));
}

/**
 * Completed years between two calendar days. Pure integer arithmetic over the
 * `YYYY-MM-DD` parts, so there is nothing in it a zone could move.
 *
 * The rule is unchanged from the host-local version this replaced, including its
 * 29 February convention: a leap-day birthday counts the new year on 1 March in
 * a non-leap year, because `day` is compared as written and 28 < 29. That
 * deliberately differs from `member-age.ts`, which clamps the anniversary to
 * `min(dobDay, daysInMonth)` - 28 February - for an identity check.
 *
 * THE TWO CONVENTIONS CANNOT DISAGREE ON THIS PATH, and the earlier version of
 * this comment gave a reason for leaving them alone that was measurably false. It
 * said aligning them "would move a real member's tier for one day a year, so it
 * needs a decision rather than a tidy-up". Enumerated over 21 birth years x every
 * day x 17 reference years x every day: the two answers differ in exactly ONE
 * shape, a 29 February date of birth against a 28 February reference date, and in
 * **zero** cases where the reference day is the 1st. Every reference date this
 * function is given on the price path comes from
 * {@link getSeasonStartCalendarDate}, which always returns day 1 of a month, so
 * 28 February is unreachable as a reference and aligning the conventions would
 * move nobody's tier at any configured year-end month.
 *
 * SO DO NOT ALIGN THEM ANYWAY, for the honest reason rather than the false one:
 * the divergence is harmless and unreachable here, `member-age.ts` serves a
 * different purpose, and a change with no behavioural effect on this path is not
 * worth the risk of being wrong about the other one. What was corrected is the
 * justification, because a false reason for not doing work, written down in a
 * docblock and copied into an invariants document, is how a decision nobody made
 * becomes permanent.
 */
export function computeAgeOnCalendarDays(
  dateOfBirth: CalendarDate,
  referenceDate: CalendarDate,
): number {
  const dob = calendarDateParts(dateOfBirth);
  const reference = calendarDateParts(referenceDate);

  let age = reference.year - dob.year;
  const monthDiff = reference.month - dob.month;
  if (monthDiff < 0 || (monthDiff === 0 && reference.day < dob.day)) {
    age--;
  }
  return age;
}

// test seam
/**
 * {@link computeAgeOnCalendarDays} over the two stored calendar days the call
 * sites hold: a `@db.Date` date of birth, and a season start from
 * {@link getSeasonStartDate}.
 *
 * BOTH ARGUMENTS ARE DECODED IN UTC AND BOTH STATE THE PRECONDITION FIRST, which
 * is the only reading of a UTC-midnight encoding that answers the same on every
 * host (`INV-DATE-024`). `requireStoredCalendarDay` is `seasonYearOfStoredDate`'s
 * guard, shared: a value carrying a time of day is a real moment, and flooring
 * one to its UTC day is right for a club east of Greenwich and wrong for the
 * rest, which is worse than being wrong everywhere. On today's schema both
 * columns are `@db.Date`, so PostgreSQL cannot hand this a time - it fires for a
 * value some code path built rather than read, and it has already found fourteen
 * across two of this repository's own test files.
 */
export function computeAge(dateOfBirth: Date, referenceDate: Date): number {
  return computeAgeOnCalendarDays(
    calendarDateOfDateOnlyInstant(
      requireStoredCalendarDay(dateOfBirth, {
        subject: "computeAge's dateOfBirth",
        instead:
          "A date of birth is a calendar day: build it with parseDateOnly or an explicit " +
          "T00:00:00.000Z (INV-DATE-024), never from the clock.",
      }),
    ),
    calendarDateOfDateOnlyInstant(
      requireStoredCalendarDay(referenceDate, {
        subject: "computeAge's referenceDate",
        instead:
          "Pass getSeasonStartDate(seasonYear) - the season start at UTC midnight - from a " +
          "season the caller resolved once.",
      }),
    ),
  );
}

export type AgeTierSettingData = {
  tier: AgeTier;
  minAge: number;
  maxAge: number | null;
  label: string;
  subscriptionRequiredForBooking?: boolean;
  familyGroupRequestCreateMemberAllowed?: boolean;
  sortOrder: number;
};

/**
 * The hard-coded age-tier safety net (epic #1943, child C4 / issue #1983).
 *
 * The DB (`AgeTierSetting`) is the sole runtime source of age tiers; this array
 * is only the fallback when the table is empty or the boot-time self-heal has
 * not yet populated it (age classification must never break). It is NO LONGER
 * derived from `config/club.json` — a configured install always reads DB, and
 * `config/club.json ageTiers[]` is now a seed input only.
 *
 * These values are byte-for-byte what a live boot resolved before the config
 * demotion: the 4-tier TAC default shape shared by `config/club.example.json`,
 * `SAFE_DEFAULT_CONFIG` (`src/config/safe-default-config.ts`), and the state a
 * legacy DB reaches after migration
 * `20260412190000_backfill_infant_age_tier_settings` (INFANT 0-4, CHILD 5-9,
 * YOUTH 10-17, ADULT 18+). Keeping it hard-coded means the fallback can never
 * silently change with an edited/absent config file.
 */
export const AGE_TIER_DEFAULTS: AgeTierSettingData[] = [
  {
    tier: "INFANT",
    minAge: 0,
    maxAge: 4,
    label: "Infant (under 5)",
    subscriptionRequiredForBooking: false,
    familyGroupRequestCreateMemberAllowed: true,
    sortOrder: 0,
  },
  {
    tier: "CHILD",
    minAge: 5,
    maxAge: 9,
    label: "Child (5-9)",
    subscriptionRequiredForBooking: false,
    familyGroupRequestCreateMemberAllowed: true,
    sortOrder: 1,
  },
  {
    tier: "YOUTH",
    minAge: 10,
    maxAge: 17,
    label: "Youth (10-17)",
    subscriptionRequiredForBooking: true,
    familyGroupRequestCreateMemberAllowed: false,
    sortOrder: 2,
  },
  {
    tier: "ADULT",
    minAge: 18,
    maxAge: null,
    label: "Adult (18+)",
    subscriptionRequiredForBooking: true,
    familyGroupRequestCreateMemberAllowed: false,
    sortOrder: 3,
  },
];

const LEGACY_THREE_TIER_SETTINGS = [
  { tier: "CHILD" as AgeTier, minAge: 0, maxAge: 9 as number | null, sortOrder: 1 },
  { tier: "YOUTH" as AgeTier, minAge: 10, maxAge: 17 as number | null, sortOrder: 2 },
  { tier: "ADULT" as AgeTier, minAge: 18, maxAge: null as number | null, sortOrder: 3 },
];

export function cloneAgeTierSettings(settings: AgeTierSettingData[]): AgeTierSettingData[] {
  return settings.map((setting) => ({ ...setting }));
}

function isLegacyThreeTierSettings(settings: AgeTierSettingData[]): boolean {
  if (settings.length !== LEGACY_THREE_TIER_SETTINGS.length) {
    return false;
  }

  const sorted = [...settings].sort((a, b) => a.sortOrder - b.sortOrder);
  return LEGACY_THREE_TIER_SETTINGS.every((legacy, index) => {
    const actual = sorted[index];
    return (
      actual?.tier === legacy.tier &&
      actual.minAge === legacy.minAge &&
      actual.maxAge === legacy.maxAge &&
      actual.sortOrder === legacy.sortOrder
    );
  });
}

export function normalizeAgeTierSettings(
  settings: AgeTierSettingData[]
): AgeTierSettingData[] {
  if (settings.length === 0 || isLegacyThreeTierSettings(settings)) {
    return cloneAgeTierSettings(AGE_TIER_DEFAULTS);
  }

  return cloneAgeTierSettings(
    [...settings]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((setting) => ({
        ...setting,
        subscriptionRequiredForBooking:
          setting.subscriptionRequiredForBooking ?? true,
        familyGroupRequestCreateMemberAllowed:
          setting.familyGroupRequestCreateMemberAllowed ?? false,
      }))
  );
}

/**
 * Validate that a proposed set of age-tier rows forms a single complete,
 * non-overlapping partition of `[0, ∞)` with ADULT as the unbounded terminal
 * tier (issue #2009 — the interim age-tier SUBSET relaxation).
 *
 * A set is valid iff:
 *   1. It is non-empty.
 *   2. Every tier appears at most once (no duplicate enum slot).
 *   3. ADULT is present — age classification must always have a terminal tier
 *      that catches every age above the highest boundary.
 *   4. ONLY ADULT is unbounded (`maxAge === null`) and ADULT MUST be unbounded;
 *      every other tier has a finite `maxAge`.
 *   5. Sorted by `minAge`, the youngest tier starts at age 0 and each tier's
 *      `maxAge + 1` equals the next tier's `minAge` (no gaps or overlaps), so
 *      ADULT (the null-maxAge tier) necessarily sorts last.
 *
 * Which enum identities make up the subset is otherwise free: `CHILD 0-17 +
 * ADULT 18+` legally skips INFANT and YOUTH, and `ADULT 0+` (ADULT only) is
 * legal. The canonical all-four TAC install satisfies every clause unchanged.
 *
 * Pure and DB-free so it can be unit-tested directly and reused by the admin
 * save route. On success it returns the rows sorted ascending by age; the caller
 * re-indexes `sortOrder` from that order. NOT_APPLICABLE is rejected by the
 * route's zod schema before this runs, so it is not special-cased here.
 */
export type AgeTierPartitionRow = {
  tier: AgeTier;
  minAge: number;
  maxAge: number | null;
};

export type AgeTierPartitionResult<T extends AgeTierPartitionRow> =
  | { ok: true; sorted: T[] }
  | { ok: false; error: string };

export function validateAgeTierPartition<T extends AgeTierPartitionRow>(
  settings: T[]
): AgeTierPartitionResult<T> {
  if (settings.length === 0) {
    return { ok: false, error: "At least one age tier is required." };
  }

  const tiers = settings.map((s) => s.tier);
  if (new Set(tiers).size !== tiers.length) {
    return { ok: false, error: "Each age tier may appear at most once." };
  }

  // Defense-in-depth: NOT_APPLICABLE is the server-managed organisation/school
  // tier (#1440) — it has no age range and never gets an AgeTierSetting row, so
  // it can never be part of a bookable partition. The admin route's zod already
  // rejects it before this runs; we also reject it here so the pure rule is
  // safe for any caller that skips the zod layer.
  if (tiers.some((tier) => tier === "NOT_APPLICABLE")) {
    return {
      ok: false,
      error: "The N/A age tier is not part of the bookable age partition.",
    };
  }

  const adult = settings.find((s) => s.tier === "ADULT");
  if (!adult) {
    return {
      ok: false,
      error:
        "Age tier settings must include the ADULT tier (the unbounded top tier that classifies every age above the highest boundary).",
    };
  }

  for (const s of settings) {
    if (s.tier !== "ADULT" && s.maxAge === null) {
      return {
        ok: false,
        error:
          "Only the ADULT tier can have no upper age limit (maxAge must be null).",
      };
    }
  }
  if (adult.maxAge !== null) {
    return {
      ok: false,
      error: "ADULT tier must have no upper age limit (maxAge must be null).",
    };
  }

  const sorted = [...settings].sort((a, b) => a.minAge - b.minAge);
  if (sorted[0].minAge !== 0) {
    return {
      ok: false,
      error: `The youngest age tier must start at age 0 (got minAge ${sorted[0].minAge}); otherwise the ages below it would be unclassified.`,
    };
  }
  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i];
    const next = sorted[i + 1];
    if (current.maxAge === null) {
      return {
        ok: false,
        error: "Only the highest tier (ADULT) can have no upper age limit",
      };
    }
    if (current.maxAge + 1 !== next.minAge) {
      return {
        ok: false,
        error: `Age boundaries must be contiguous: gap or overlap between maxAge ${current.maxAge} and minAge ${next.minAge}`,
      };
    }
  }

  const highest = sorted[sorted.length - 1];
  if (highest.tier !== "ADULT" || highest.maxAge !== null) {
    return {
      ok: false,
      error: "The highest age tier must be ADULT with no upper age limit.",
    };
  }

  return { ok: true, sorted };
}

/**
 * Compute age tier from explicit settings array.
 * Settings are matched in ascending sortOrder; first match wins.
 * Falls back to ADULT if nothing matches.
 */
export function computeAgeTierWithSettings(
  dateOfBirth: Date,
  referenceDate: Date,
  settings: AgeTierSettingData[]
): AgeTier {
  const age = computeAge(dateOfBirth, referenceDate);
  const sorted = [...settings].sort((a, b) => a.sortOrder - b.sortOrder);
  for (const s of sorted) {
    if (age >= s.minAge && (s.maxAge === null || age <= s.maxAge)) {
      return s.tier;
    }
  }
  return "ADULT";
}
