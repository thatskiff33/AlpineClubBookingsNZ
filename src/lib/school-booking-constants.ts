/**
 * Client-safe constants for the school booking flow.
 *
 * Kept separate from `school-booking-request.ts` (which pulls in prisma, email
 * and bcrypt) so the public `"use client"` form can import these without
 * bundling server-only code.
 */

import type { AgeTier } from "@prisma/client";
import { SCHOOL_CHILD_NAME_PREFIX } from "@/lib/placeholder-guest-names";

/**
 * Soft cap on a school group's bed count (students + teachers/parent helpers).
 * A club member must stay on to host, so groups above this may be declined
 * unless the remaining beds (up to the lodge capacity) include a member staying
 * with the group. Surfaced only as a warning on the public form; the hard
 * limit stays the lodge capacity.
 */
export const DEFAULT_SCHOOL_GROUP_SOFT_CAP = 25;

/**
 * The bulk age tiers a school counts its children in, in the order the guest
 * list is generated (and therefore numbered).
 *
 * ONE definition (#3412). This list used to be written out three times — here's
 * where it lives now, and the server generator, the public form and the admin
 * queue panel all read it. It stopped being cosmetic when saving a quote began
 * pricing the officer's adjusted numbers: the panel's copy decides which rate
 * boxes exist and what is posted, so a tier added in one copy and missed in
 * another would be a tier the officer can be charged for and cannot enter a
 * rate for. Teachers and parent helpers are the named ADULTs and are never
 * counted here.
 */
export const SCHOOL_CHILD_TIERS = ["INFANT", "CHILD", "YOUTH"] as const;

export type SchoolChildTier = (typeof SCHOOL_CHILD_TIERS)[number];

/** How many children a school brings in each bulk tier; a missing tier is 0. */
export type SchoolChildTierCounts = Partial<Record<SchoolChildTier, number>>;

/**
 * The tiers a generated school row can carry. Drawn from the Prisma enum, so a
 * renamed tier fails to compile here rather than drifting from the database.
 */
export type SchoolGuestAgeTier = Extract<AgeTier, "ADULT" | SchoolChildTier>;

/**
 * One row of a generated school party. A type alias, not an interface, so it
 * stays assignable to Prisma's JSON input when the server stores the list.
 */
export type GeneratedSchoolGuest = {
  firstName: string;
  lastName: string;
  ageTier: SchoolGuestAgeTier;
};

/**
 * Build a school party from its named adults and its child counts: the
 * teachers/parent helpers first as named ADULT guests, then the children
 * numbered "School Child 1..N" with ONE running counter across the tiers in
 * `SCHOOL_CHILD_TIERS` order.
 *
 * ONE definition of the composition rule (#3486). The server generates the
 * stored list from it, and the admin queue panel builds the party the officer
 * is about to quote from it — which decides the per-guest-night rate boxes the
 * officer prices and which stored rows a regeneration moves. Two copies of this
 * rule could only ever disagree on money.
 *
 * It lives here, not in `school-booking-request.ts`, so the `"use client"`
 * panel can import it. `AgeTier` is read as a TYPE only: `"ADULT"` is the
 * enum's value, checked by the compiler, so the Prisma client never enters the
 * client bundle.
 */
export function generateSchoolGuests(input: {
  teachers: ReadonlyArray<{ firstName: string; lastName: string }>;
  childCounts: SchoolChildTierCounts;
}): GeneratedSchoolGuest[] {
  const adult: SchoolGuestAgeTier = "ADULT";
  const teacherGuests: GeneratedSchoolGuest[] = input.teachers.map((teacher) => ({
    firstName: teacher.firstName,
    lastName: teacher.lastName,
    ageTier: adult,
  }));

  const childGuests: GeneratedSchoolGuest[] = [];
  let childNumber = 0;
  for (const tier of SCHOOL_CHILD_TIERS) {
    const count = input.childCounts[tier] ?? 0;
    for (let i = 0; i < count; i += 1) {
      childNumber += 1;
      childGuests.push({
        firstName: SCHOOL_CHILD_NAME_PREFIX,
        lastName: String(childNumber),
        ageTier: tier,
      });
    }
  }

  return [...teacherGuests, ...childGuests];
}

/** The three columns a stored guest is compared on. */
interface ComparableGuest {
  firstName: string;
  lastName: string;
  ageTier: string;
}

/**
 * How many leading rows survive a regeneration untouched — the boundary a
 * member link may not cross (#3412).
 *
 * Read the two lists rather than the `teachers` column. The two agree today,
 * because one generator writes `teachers` and `guests` together at submission
 * and nothing rewrites `teachers` afterwards — but #3412's own incident row was
 * REPAIRED BY HAND, which is exactly how a production row stops agreeing. A
 * boundary counted in one column and applied to the other is a boundary that
 * silently moves; this one is derived from the very lists the renumbering acts
 * on, so it cannot.
 *
 * Positions at or past the answer are rows the regeneration renumbers: a member
 * linked there would come to mean a DIFFERENT person's bed, and would then be
 * priced, invoiced and emailed onto it. Positions before it are byte-identical
 * in both lists, which is the only thing that makes a link safe to keep.
 */
export function unchangedSchoolGuestPrefixLength(
  stored: readonly ComparableGuest[],
  resolved: readonly ComparableGuest[],
): number {
  const limit = Math.min(stored.length, resolved.length);
  let index = 0;
  while (index < limit) {
    // Indexed access is checked (`noUncheckedIndexedAccess`): a length that
    // bounded the loop is not a promise the element is there once either array
    // has been through JSON.
    const before = stored[index];
    const after = resolved[index];
    if (
      before === undefined ||
      after === undefined ||
      before.firstName !== after.firstName ||
      before.lastName !== after.lastName ||
      before.ageTier !== after.ageTier
    ) {
      return index;
    }
    index += 1;
  }
  return limit;
}

/** Same party, guest for guest? Compared on what is priced and held. */
export function sameSchoolGuestList(
  a: readonly ComparableGuest[],
  b: readonly ComparableGuest[],
): boolean {
  return a.length === b.length && unchangedSchoolGuestPrefixLength(a, b) === a.length;
}
