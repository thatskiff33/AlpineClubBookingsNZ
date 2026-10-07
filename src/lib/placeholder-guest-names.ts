/**
 * Placeholder guest names (#2550).
 *
 * Two booking front doors create a party before anybody knows who is actually
 * coming, so they store generated placeholder names:
 *
 *  - **School / organisation requests** number their children
 *    `School Child 1..N` (`generateSchoolGuests`, src/lib/school-booking-constants.ts).
 *  - **Member whole-lodge requests** number the member's party `Guest 1..N`,
 *    all ADULT, because the member gives only an approximate headcount at
 *    request time (`buildMemberWholeLodgePlaceholderGuests`,
 *    src/lib/booking-request.ts).
 *
 * Both reach the lodge unnamed if nobody edits them, and the chore list and
 * arrival roster read guest names straight off the row
 * (`src/lib/admin-roster-service.ts`), so the roster up at the lodge says
 * "School Child 1, School Child 2" instead of naming real people.
 *
 * This module owns the two prefixes and the DETECTOR that says whether a guest
 * still carries its generated default. It is deliberately a pure, read-only
 * module: **nothing here may ever gate a stay.** The owner's decision on #2550
 * is that an unnamed party is chased by reminders and flagged on the admin
 * dashboard, but check-in, booking confirmation and roster generation are never
 * withheld — a genuine last-minute arrival must not be stranded at the lodge
 * over a name. `placeholder-guest-name-reminders.ts` (visibility) is the only
 * consumer that acts on it.
 */

/**
 * Display-name prefix for the placeholder guests a member whole-lodge request
 * carries (#2263, epic #2245). The member never names their party at request
 * time (privacy decision D5 — the form asks for an approximate headcount only),
 * but every existing reader of `BookingRequest.guests` assumes a list of that
 * length, so the row stores "Guest 1..N" placeholders. Names are edited in
 * later, on the converted booking, through the ordinary guest-edit path.
 */
export const MEMBER_WHOLE_LODGE_GUEST_NAME_PREFIX = "Guest";

/** Display-name prefix for the generated bulk school child guests (#709). */
export const SCHOOL_CHILD_NAME_PREFIX = "School Child";

/**
 * Every generated placeholder first name, for a coarse database pre-filter.
 *
 * A Prisma `where` cannot express "the last name is a number", so a query
 * narrows on this list and then re-checks each candidate with
 * {@link isPlaceholderGuestName}, which is the authority.
 */
export const PLACEHOLDER_GUEST_NAME_PREFIXES: readonly string[] = [
  MEMBER_WHOLE_LODGE_GUEST_NAME_PREFIX,
  SCHOOL_CHILD_NAME_PREFIX,
];

/**
 * The shape the detector needs. Deliberately structural rather than the Prisma
 * `BookingGuest` row, so callers can narrow their `select` to four columns.
 */
export interface PlaceholderGuestNameCandidate {
  firstName: string;
  lastName: string;
  /** Member guests are identity-linked, never generated, and never renameable. */
  isMember?: boolean;
  memberId?: string | null;
}

/**
 * Does this guest still carry the name the generator gave it?
 *
 * The generators split the placeholder across BOTH columns — `firstName` is the
 * bare prefix and `lastName` is the ordinal, e.g. `{ firstName: "Guest",
 * lastName: "3" }` — so the detector matches that exact shape rather than
 * sniffing for a substring. Two consequences that the #2550 acceptance criteria
 * name explicitly, and that a substring guess would get wrong:
 *
 *  - A member who renames "Guest 1" to "Jane Smith" is NAMED from that moment,
 *    because neither column matches any more.
 *  - A real person legitimately called Guest — "Guest Fisher", say — is NAMED,
 *    because their last name is not an ordinal. Only the generated
 *    `<prefix> <positive integer>` pair counts.
 *
 * A member-linked guest is never a placeholder: those rows come from a real
 * member identity and cannot be renamed on the booking at all.
 */
export function isPlaceholderGuestName(
  guest: PlaceholderGuestNameCandidate,
): boolean {
  if (guest.isMember || guest.memberId) return false;

  const firstName = guest.firstName?.trim() ?? "";
  if (!PLACEHOLDER_GUEST_NAME_PREFIXES.includes(firstName)) return false;

  const lastName = guest.lastName?.trim() ?? "";
  // The ordinal is written with String(index + 1), so it is always a bare
  // positive integer with no sign, separator, or leading zero.
  if (!/^[1-9][0-9]*$/.test(lastName)) return false;

  return true;
}

/** How many of this party still carry a generated placeholder name. */
export function countPlaceholderGuestNames(
  guests: readonly PlaceholderGuestNameCandidate[],
): number {
  return guests.filter(isPlaceholderGuestName).length;
}

/** True when at least one guest in the party is still unnamed. */
export function hasPlaceholderGuestNames(
  guests: readonly PlaceholderGuestNameCandidate[],
): boolean {
  return guests.some(isPlaceholderGuestName);
}
