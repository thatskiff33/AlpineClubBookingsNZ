// The hut-leaders page's row shapes and its month-bounds helper, moved here
// verbatim from `../page.tsx` so the page stays under its size ceiling
// (#4926). Pure types and zone-free date-only arithmetic: no state, no fetch.
import { addDaysDateOnly, parseDateOnly } from "@/lib/date-only";

export interface HutLeaderAssignment {
  id: string;
  memberId: string;
  memberName: string;
  memberEmail: string;
  startDate: string;
  endDate: string;
  createdAt: string;
  lodgeId: string | null;
  lodgeName: string | null;
  // #2286: the bed this assignment holds, or null for a role-only assignment.
  bedId: string | null;
  bedName: string | null;
  bedRoomName: string | null;
  isCustodian?: boolean; // #3817
  source?: string; // #3821: SCHOOL_BOOKING rows get no custodian tick
}

export interface UnassignedDate {
  date: string;
  // One row per uncovered lodge-night since #2917; here always the selected
  // lodge, so these are for keying, not display. Optional: an older cached
  // response must not break the panel.
  lodgeId?: string | null;
  lodgeName?: string | null;
  bookingCount: number;
  guestCount: number;
}

// Compute the last inclusive day of a "YYYY-MM" month.
export function monthBounds(monthKey: string) {
  const start = parseDateOnly(`${monthKey}-01`);
  // Sliced at the fixed `YYYY-MM` offsets rather than split: the two halves
  // read as `number` where a destructured split hands back lookups the
  // compiler must treat as possibly absent (#2801).
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const endExclusive = parseDateOnly(
    `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`,
  );
  return { start, end: addDaysDateOnly(endExclusive, -1) };
}
