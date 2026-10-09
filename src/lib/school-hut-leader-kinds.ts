// "Who can be hut leader for school bookings" (#3819): the vocabulary, with no
// server imports, so the admin card can share it with the resolver in
// `lodge-settings.ts` (INV-SSOT-001) without pulling Prisma into a browser
// bundle.

/**
 * The four kinds of leader a lodge may accept for a school booking's nights
 * (owner decisions, 2 Oct 2026, #3789/#3820), in the order the admin card
 * lists them. A lodge ticks any combination.
 *
 * - `teacherOnBooking`: a teacher on the school booking. Ticking it is also
 *   what makes approving a school request assign its teachers as hut leaders.
 * - `custodian`: the lodge custodian — an assignment ticked "Custodian (lives
 *   on site)" or holding a custodian bed (`isCustodianOccupancy`, #3817).
 * - `memberOnBooking`: a member who is a guest on the school booking that night.
 * - `memberStayingSeparately`: a member staying that night on a booking of
 *   their own at the lodge.
 */
export const SCHOOL_HUT_LEADER_KINDS = [
  "teacherOnBooking",
  "custodian",
  "memberOnBooking",
  "memberStayingSeparately",
] as const;

export type SchoolHutLeaderKind = (typeof SCHOOL_HUT_LEADER_KINDS)[number];
export type SchoolHutLeaderKinds = Record<SchoolHutLeaderKind, boolean>;

/**
 * What a lodge reads with no row of its own. These match the column defaults,
 * which the expand migration chose so nothing changes for a lodge until an
 * officer edits it: before this setting any present leader covered a school
 * night, and #3416's switch (whose value the migration carried over) defaulted
 * teachers off.
 */
export const DEFAULT_SCHOOL_HUT_LEADER_KINDS: Readonly<SchoolHutLeaderKinds> = {
  teacherOnBooking: false,
  custodian: true,
  memberOnBooking: true,
  memberStayingSeparately: true,
};
