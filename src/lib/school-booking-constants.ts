/**
 * Client-safe constants for the school booking flow.
 *
 * Kept separate from `school-booking-request.ts` (which pulls in prisma, email
 * and bcrypt) so the public `"use client"` form can import these without
 * bundling server-only code.
 */

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
