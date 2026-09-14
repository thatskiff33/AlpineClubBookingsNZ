import type { AgeTier, DisplayNameGranularity } from "@prisma/client";

// The ONE definition of how a person's name is reduced before it reaches a
// surface that other people read, and of when a booking may name individuals
// at all (#2942).
//
// WHY THIS FILE EXISTS SEPARATELY. These rules were written for the lobby
// display and lived inside `lodge-display-state.ts`, a module that imports
// Prisma and builds a whole screen payload. The member lodge roster (#2942)
// needs exactly the same rules on a different surface, and `INV-SSOT` says a
// second place that needs a rule gets an import, not a copy — so the rules
// moved here and both surfaces import them. Nothing about their behaviour
// changed in the move.
//
// This module is deliberately PURE: it imports types only, touches no
// database, and can be unit-tested and reasoned about on its own. Keep it that
// way. A surface's own policy — which granularity it reads, which rows it
// selected, who is allowed to see it at all — belongs to that surface, not
// here. What belongs here is the shared shape of the answer.

/**
 * The lobby display's default when a lodge has not chosen one.
 *
 * The two surfaces deliberately default DIFFERENTLY, and the difference is not
 * an oversight: a screen on the wall inside the hut is read by people already
 * in the building, while a web page reaches anyone who can sign in. See
 * `DEFAULT_ROSTER_NAME_GRANULARITY` in `member-lodge-roster.ts` for the
 * roster's own default and the owner decision behind it.
 */
export const DEFAULT_DISPLAY_NAME_GRANULARITY: DisplayNameGranularity =
  "FIRST_NAME_SURNAME_INITIAL";

/**
 * Age tiers that make a person a minor for every naming rule below.
 *
 * `NOT_APPLICABLE` is deliberately absent: it marks an organisation, which is
 * not a person at all and is handled by its own branch in `bookingLabel`.
 */
export const MINOR_AGE_TIERS: readonly AgeTier[] = ["INFANT", "CHILD", "YOUTH"];

/**
 * Is this age tier a minor?
 *
 * Accepts a loose string and a nullish value as well as the enum, because the
 * custodian/hut-leader surfaces read the tier off rows that type it as a plain
 * string. That breadth is here so there is ONE answer to this question rather
 * than a strict copy and a loose copy that can disagree the day a club adds an
 * age tier (they are configurable — Admin -> Age tiers).
 */
export function isMinorAgeTier(
  ageTier: AgeTier | string | null | undefined
): boolean {
  return ageTier
    ? (MINOR_AGE_TIERS as readonly string[]).includes(ageTier)
    : false;
}

/**
 * How many guests make a booking a GROUP for the sole-occupancy privacy gate.
 *
 * Below this, a booking alone in the lodge is just a small party and its people
 * are named normally; at or above it, a booking that had the building to itself
 * is reduced to its group label. An organisation booking is a group at any size.
 * Documented in the lobby display's design.md §10 and review-flagged on epic #25.
 *
 * Shared with the member lodge roster (#2942), which applies the same gate.
 */
export const WHOLE_LODGE_MIN_GUESTS = 8;

/** Reduce an adult's name to the configured granularity. */
export function reduceName(
  firstName: string,
  lastName: string,
  granularity: DisplayNameGranularity
): string | null {
  const first = firstName.trim();
  const last = lastName.trim();
  switch (granularity) {
    case "FULL_NAME":
      return [first, last].filter(Boolean).join(" ");
    case "FIRST_NAME_SURNAME_INITIAL": {
      // `last` truthy means non-empty, so its first character always exists.
      const initial = last[0];
      return initial ? `${first} ${initial.toUpperCase()}` : first;
    }
    case "FIRST_NAME_ONLY":
      return first;
    case "COUNTS_ONLY":
      return null;
  }
}

interface OrganiserShape {
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
}

/**
 * Whether a booking's guests may be individually named on a surface other
 * people read (design.md §10 settled rules; issue #174): sole occupancy of the
 * lodge, any minor in the booking, an organisation organiser, or counts-only
 * granularity all suppress individual names in favour of the booking's reduced
 * group label. This is the SINGLE definition of that condition — every surface
 * that might name an individual (display booking rows, chore assignees, the
 * member lodge roster) calls this instead of re-deriving the condition list.
 *
 * `soleOccupancy`, not `wholeLodge` (#2735). It was renamed because the two
 * came apart: `row.wholeLodge` says the wall may draw a BLOCKOUT (the group
 * holds a night inside the window), while this asks whether the group had the
 * building to itself on any night that put it on the surface — which includes
 * the night before the window, whose occupants are still here on the first
 * morning. The privacy rule follows the second, so it is the second that
 * belongs here.
 */
export function namesAllowedForBooking(options: {
  soleOccupancy: boolean;
  containsMinors: boolean;
  organiserAgeTier: AgeTier;
  granularity: DisplayNameGranularity;
}): boolean {
  return (
    !options.soleOccupancy &&
    !options.containsMinors &&
    options.organiserAgeTier !== "NOT_APPLICABLE" &&
    options.granularity !== "COUNTS_ONLY"
  );
}

/**
 * The booking-level label (design.md §10 settled rules):
 * - organisation organiser (schools, clubs): the organisation's full name at
 *   EVERY granularity — organisations are not people;
 * - booking containing minors: a family/group label, never individual names;
 * - otherwise: the organiser's name at the configured granularity.
 */
export function bookingLabel(
  organiser: OrganiserShape,
  options: {
    granularity: DisplayNameGranularity;
    containsMinors: boolean;
    guestCount: number;
  }
): string {
  const { granularity, containsMinors, guestCount } = options;

  if (organiser.ageTier === "NOT_APPLICABLE") {
    return [organiser.firstName.trim(), organiser.lastName.trim()]
      .filter(Boolean)
      .join(" ");
  }

  if (containsMinors) {
    const last = organiser.lastName.trim();
    if (
      last &&
      (granularity === "FULL_NAME" ||
        granularity === "FIRST_NAME_SURNAME_INITIAL")
    ) {
      return `${last} family`;
    }
    return `Family of ${guestCount}`;
  }

  return (
    reduceName(organiser.firstName, organiser.lastName, granularity) ??
    `Guests · ${guestCount}`
  );
}

/**
 * Every level, in the order a settings screen offers them — most detail first,
 * so reading down the list is reading privacy increasing.
 *
 * Two surfaces let an administrator pick a level: the lobby display's per-lodge
 * dial and the member lodge roster's (#2942). They share this list rather than
 * each spelling the four values, which is `INV-SSOT` applied to a vocabulary the
 * schema already fixes.
 *
 * `satisfies` rather than an annotation, so the array keeps its literal tuple
 * type (`z.enum` and exhaustive `Record`s need that) while still failing to
 * compile if the schema enum ever gains or renames a value.
 *
 * DELIBERATELY NOT CENTRALISED HERE: the bundle-validation list in
 * `config-transfer/categories/lodge-config.ts`. That one checks values arriving
 * from ANOTHER deployment's export file, so it is pinned to the bundle format
 * rather than to whatever this product currently offers; coupling it to a UI
 * constant would make a future UI change silently reject or accept old bundles.
 */
export const DISPLAY_NAME_GRANULARITY_VALUES = [
  "FULL_NAME",
  "FIRST_NAME_SURNAME_INITIAL",
  "FIRST_NAME_ONLY",
  "COUNTS_ONLY",
] as const satisfies readonly DisplayNameGranularity[];

/**
 * What each level is called on an admin screen.
 *
 * An exhaustive `Record`, so adding a level to the schema enum fails to compile
 * here rather than rendering a blank option nobody can interpret.
 */
export const DISPLAY_NAME_GRANULARITY_LABELS: Record<
  DisplayNameGranularity,
  string
> = {
  FULL_NAME: "Full names",
  FIRST_NAME_SURNAME_INITIAL: "First name + surname initial",
  FIRST_NAME_ONLY: "First names only",
  COUNTS_ONLY: "Counts only (no names)",
};
