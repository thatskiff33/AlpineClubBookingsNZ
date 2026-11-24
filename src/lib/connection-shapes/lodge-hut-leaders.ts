/**
 * What the Lodge Operations hut-leader and chore-roster officer actions
 * return (ALP-722, `INV-MCP-006`). The catalogue entry and the route's
 * `connectionJson` both read these (`INV-SSOT`).
 *
 * Kept: what an officer's AI app needs to read and act: ids, names, dates,
 * statuses, counts and the warnings the screen shows.
 * Dropped: other members' email addresses (the assignment list and the
 * candidate picker carry them for the screen's mailto links), row timestamps,
 * when a member became eligible to lead, the roster email's per-recipient
 * failure text (a provider's message can quote the address it refused), and
 * every hut-leader PIN, which no answer here carries in the first place: the
 * create emails it to the leader and stores only its hash.
 *
 * The answer types the routes build inline are declared here and annotated in
 * the route, so a field the route renames is a type error in both places.
 *
 * Types only from the route modules: nothing here reaches the database.
 */
import type { HutLeaderAssignmentSource } from "@prisma/client";

import type { RosterActionInput } from "@/lib/admin-lodge-schemas/hut-leaders";
import type { AdminRosterSnapshot } from "@/lib/admin-roster-service";
import { connectionShapeFor, eachEntry, type ConnectionShape } from "@/lib/connection-projection";
import type { CustodianBedOption } from "@/lib/custodian-assignment";
import type { UnassignedHutLeaderDate } from "@/lib/hut-leader-coverage";
import type { HutLeaderOnNight } from "@/lib/hut-leader-handover";
import type { RosterDayStatusResult } from "@/lib/roster-status";
import type { SchoolHutLeaderKinds } from "@/lib/school-hut-leader-kinds";

// ---------------------------------------------------------------------------
// Hut leader assignments
// ---------------------------------------------------------------------------

/** One row of `GET /api/admin/hut-leaders`, as the route builds it. */
export interface AdminHutLeaderAssignmentRow {
  id: string;
  memberId: string;
  memberName: string;
  memberEmail: string;
  startDate: string;
  endDate: string;
  createdAt: string;
  lodgeId: string;
  lodgeName: string | null;
  bedId: string | null;
  bedName: string | null;
  bedRoomName: string | null;
  isCustodian: boolean;
  source: HutLeaderAssignmentSource;
}

export const ADMIN_HUT_LEADER_LIST_CONNECTION_SHAPE = connectionShapeFor<{
  bedAllocationEnabled: boolean;
  assignments: AdminHutLeaderAssignmentRow[];
}>({
  bedAllocationEnabled: true,
  assignments: {
    id: true,
    memberId: true,
    memberName: true,
    startDate: true,
    endDate: true,
    lodgeId: true,
    lodgeName: true,
    bedId: true,
    bedName: true,
    bedRoomName: true,
    isCustodian: true,
    source: true,
  },
});

export const ADMIN_HUT_LEADER_CREATED_CONNECTION_SHAPE = connectionShapeFor<{
  id: string;
  emailSent: boolean;
  minorCustodianWarning: string | null;
  schoolNightsWarning: string | null;
}>({
  id: true,
  emailSent: true,
  minorCustodianWarning: true,
  schoolNightsWarning: true,
});

export const ADMIN_HUT_LEADER_UPDATED_CONNECTION_SHAPE = connectionShapeFor<{
  success: boolean;
  schoolNightsWarning: string | null;
}>({
  success: true,
  schoolNightsWarning: true,
});

/** A change that answers `{ success: true }`: an assignment deleted, a roster regenerated or confirmed. */
export const ADMIN_HUT_LEADER_DONE_CONNECTION_SHAPE = connectionShapeFor<{ success: boolean }>({
  success: true,
});

/** `GET /api/admin/hut-leaders/available-beds`: every active bed, by room. */
export const ADMIN_HUT_LEADER_BED_OPTIONS_CONNECTION_SHAPE = connectionShapeFor<{
  lodgeId: string;
  rooms: Array<{ roomId: string; roomName: string; beds: CustodianBedOption[] }>;
}>({
  lodgeId: true,
  rooms: {
    roomId: true,
    roomName: true,
    beds: {
      bedId: true,
      bedName: true,
      bedType: true,
      available: true,
      allocatedNights: true,
      custodianHeldNights: true,
      heldByThisAssignment: true,
    },
  },
});

/** One member of `GET /api/admin/hut-leaders/eligible-members`, as the route builds it. */
export interface AdminHutLeaderCandidateRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  hutLeaderEligible: boolean;
  hutLeaderEligibleAt: string | null;
  bookingCheckIn: string;
  bookingCheckOut: string;
  suggestedStartDate: string;
  suggestedEndDate: string;
  uncoveredNightCount: number;
  schoolNightsNotAccepted: number;
  fullyCovered: boolean;
}

export const ADMIN_HUT_LEADER_CANDIDATES_CONNECTION_SHAPE = connectionShapeFor<{
  members: AdminHutLeaderCandidateRow[];
}>({
  members: {
    id: true,
    firstName: true,
    lastName: true,
    hutLeaderEligible: true,
    bookingCheckIn: true,
    bookingCheckOut: true,
    suggestedStartDate: true,
    suggestedEndDate: true,
    uncoveredNightCount: true,
    schoolNightsNotAccepted: true,
    fullyCovered: true,
  },
});

/** `coveredNights` is sent only for a month or a window. */
export const ADMIN_HUT_LEADER_UNASSIGNED_NIGHTS_CONNECTION_SHAPE = connectionShapeFor<{
  unassignedDates: UnassignedHutLeaderDate[];
  coveredNights?: Array<{ date: string; leaders: HutLeaderOnNight[] }>;
}>({
  unassignedDates: {
    date: true,
    lodgeId: true,
    lodgeName: true,
    lodgeActive: true,
    bookingCount: true,
    guestCount: true,
  },
  coveredNights: { date: true, leaders: { memberId: true, name: true } },
});

// ---------------------------------------------------------------------------
// Who can be hut leader for school bookings (#3819)
// ---------------------------------------------------------------------------

export const ADMIN_SCHOOL_HUT_LEADER_KINDS_CONNECTION_SHAPE = connectionShapeFor<{
  kinds: SchoolHutLeaderKinds;
}>({
  kinds: { teacherOnBooking: true, custodian: true, memberOnBooking: true, memberStayingSeparately: true },
});

// ---------------------------------------------------------------------------
// The chore roster
// ---------------------------------------------------------------------------

export const ADMIN_ROSTER_CONNECTION_SHAPE = connectionShapeFor<AdminRosterSnapshot>({
  date: true,
  lodgeId: true,
  revision: true,
  guestCount: true,
  guests: {
    id: true,
    bookingId: true,
    firstName: true,
    lastName: true,
    ageTier: true,
    isArriving: true,
    isDeparting: true,
    bookingGroupLabel: true,
  },
  assignments: {
    id: true,
    choreTemplateId: true,
    choreTemplateName: true,
    choreDescription: true,
    choreSortOrder: true,
    bookingGuestId: true,
    guestName: true,
    guestAgeTier: true,
    bookingId: true,
    status: true,
  },
  templates: {
    id: true,
    name: true,
    description: true,
    recommendedPeopleMin: true,
    recommendedPeopleMax: true,
    isEssential: true,
    ageRestriction: true,
    conditionalNote: true,
    minAge: true,
    sortOrder: true,
    timeOfDay: true,
    frequencyMode: true,
    frequencyDays: true,
    frequencyDaysOfWeek: true,
    active: true,
    lodgeId: true,
    isDueOnDate: true,
  },
  guestHistory: eachEntry({ date: true, choreName: true }),
});

/** The roster email's answer: `suppressed` when the officer chose to send nothing. */
const ADMIN_ROSTER_EMAIL_CONNECTION_SHAPE = connectionShapeFor<{
  success: boolean;
  suppressed?: boolean;
  partialFailure?: boolean;
  sent: number;
  failed: number;
  skipped: number;
  failures: Array<{ error: string }>;
}>({
  success: true,
  suppressed: true,
  partialFailure: true,
  sent: true,
  failed: true,
  skipped: true,
});

/** What each variant of `PUT /api/admin/roster/[date]` answers, by its `action`. */
export const ADMIN_ROSTER_ACTION_CONNECTION_SHAPES = {
  save: ADMIN_ROSTER_CONNECTION_SHAPE,
  regenerate: ADMIN_HUT_LEADER_DONE_CONNECTION_SHAPE,
  confirm: ADMIN_HUT_LEADER_DONE_CONNECTION_SHAPE,
  email: ADMIN_ROSTER_EMAIL_CONNECTION_SHAPE,
} as const satisfies Record<RosterActionInput["action"], ConnectionShape>;

export const ADMIN_ROSTER_MONTH_STATUS_CONNECTION_SHAPE = connectionShapeFor<{
  month: string;
  statuses: RosterDayStatusResult[];
}>({
  month: true,
  statuses: { date: true, status: true, stayingBookingCount: true, uncoveredBookingCount: true },
});
