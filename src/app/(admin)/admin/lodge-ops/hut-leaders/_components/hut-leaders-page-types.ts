// The hut-leaders page's row shapes, moved here verbatim from `../page.tsx`
// so the page stays under its size ceiling (#4926). Types only: no state, no
// fetch, no date arithmetic.

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
