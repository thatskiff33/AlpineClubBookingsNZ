/**
 * Lodge Operations: hut leader assignments, the nights with no leader, who
 * may lead a school booking's nights, and the chore roster of one lodge night.
 * Part of the Lodge Operations officer actions (ALP-722): spread into
 * `MCP_ACTIONS`.
 *
 * Kinds: every change here is `destructive` (owner decision, #5305). Making
 * someone hut leader emails them their lodge PIN; changing or removing an
 * assignment overwrites another member's record and can take a bed out of, or
 * give one back to, the lodge; the school hut-leader kinds are club-wide
 * configuration; and every roster change overwrites the guests' chores, which
 * the roster email then sends them. The PIN itself is never an answer: the
 * create emails it and stores only its hash, and the PIN reset is the kiosk's
 * (`exclusions.ts`).
 *
 * The roster save, regenerate, confirm and email are one route method told
 * apart by `action`, so each is its own action with `action` fixed.
 */
import {
  adminRosterConnectionQuerySchema,
  adminRosterDateParamsSchema,
  adminRosterLodgeQuerySchema,
  adminRosterMonthStatusQuerySchema,
  hutLeaderAssignmentCreateBodySchema,
  hutLeaderAssignmentUpdateBodySchema,
  hutLeaderBedOptionsQuerySchema,
  hutLeaderCandidatesQuerySchema,
  hutLeaderLodgeQuerySchema,
  hutLeaderUnassignedNightsQuerySchema,
  rosterEmailBodySchema,
  rosterRegenerateBodySchema,
  rosterSaveBodySchema,
  schoolHutLeaderKindsBodySchema,
} from "@/lib/admin-lodge-schemas/hut-leaders";
import {
  ADMIN_HUT_LEADER_BED_OPTIONS_CONNECTION_SHAPE,
  ADMIN_HUT_LEADER_CANDIDATES_CONNECTION_SHAPE,
  ADMIN_HUT_LEADER_CREATED_CONNECTION_SHAPE,
  ADMIN_LODGE_DONE_CONNECTION_SHAPE,
  ADMIN_HUT_LEADER_LIST_CONNECTION_SHAPE,
  ADMIN_HUT_LEADER_UNASSIGNED_NIGHTS_CONNECTION_SHAPE,
  ADMIN_HUT_LEADER_UPDATED_CONNECTION_SHAPE,
  ADMIN_ROSTER_ACTION_CONNECTION_SHAPES,
  ADMIN_ROSTER_CONNECTION_SHAPE,
  ADMIN_ROSTER_MONTH_STATUS_CONNECTION_SHAPE,
  ADMIN_SCHOOL_HUT_LEADER_KINDS_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/lodge-hut-leaders";
import { routeIdParamsSchema } from "@/lib/route-id-params";

import type { McpAction } from "../catalogue";

// The handlers that name their own `requireAdmin({ permission })`; the census
// holds each entry's `requires` to the handler's.
const LODGE_VIEW = { area: "lodge", level: "view" } as const;
const LODGE_EDIT = { area: "lodge", level: "edit" } as const;

/** Said once on every action that may refuse a bed or the custodian with a 409. */
const BED_HOLD_REFUSALS =
  "A held bed, or a custodian, takes a space at the lodge on each night: a 409 says when the lodge would be over capacity (send `confirmOverCapacity: true` after the officer agrees) or when it would narrow a whole-lodge hold (`amendOverlappingHolds: true`).";

export const LODGE_HUT_LEADER_MCP_ACTIONS: readonly McpAction[] = [
  // --- Hut leader assignments ------------------------------------------------
  {
    id: "list_hut_leaders",
    title: "List hut leaders",
    summary:
      "Officer: the hut leader assignments at one lodge (`lodgeId` from `list_lodges`), latest first, under `assignments`: the leader's member id and name, the first and last night led (`YYYY-MM-DD`, both included), any bed held for them, whether they are the lodge custodian, and `source` (`MANUAL` by an officer, `CRON` assigned automatically, `SCHOOL_BOOKING` a school's teacher). `bedAllocationEnabled` says whether a bed can be held.",
    method: "GET",
    path: "/api/admin/hut-leaders",
    query: hutLeaderLodgeQuerySchema,
    kind: "read",
    returns: ADMIN_HUT_LEADER_LIST_CONNECTION_SHAPE,
    core: true,
    requires: LODGE_VIEW,
  },
  {
    id: "create_hut_leader_assignment",
    title: "Make a member hut leader",
    summary: `Officer: makes a member (\`memberId\`, best from \`list_hut_leader_candidates\`) hut leader at a lodge from \`startDate\` to \`endDate\` (\`YYYY-MM-DD\`, both nights included). The member must be staying those nights, unless they hold a bed or are the custodian, and may overlap another leader by one handover night only. The member is emailed a new lodge PIN, which is never shown here. ${BED_HOLD_REFUSALS} Answers the new assignment's \`id\`, whether the email went, and any warning to pass on: a minor custodian is never named on the lodge screen, or school nights the lodge does not accept this leader for.`,
    method: "POST",
    path: "/api/admin/hut-leaders",
    body: hutLeaderAssignmentCreateBodySchema,
    kind: "destructive",
    returns: ADMIN_HUT_LEADER_CREATED_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_EDIT,
  },
  {
    id: "update_hut_leader_assignment",
    title: "Change a hut leader assignment",
    summary: `Officer: changes a hut leader assignment (\`id\` from \`list_hut_leaders\`): its nights (\`YYYY-MM-DD\`), lodge, held bed (null releases it) or custodian tick. Only what is sent changes, and the same staying and overlap rules as the create apply. ${BED_HOLD_REFUSALS} Answers \`success\` and any school-nights warning to pass on.`,
    method: "PUT",
    path: "/api/admin/hut-leaders/[id]",
    params: routeIdParamsSchema,
    body: hutLeaderAssignmentUpdateBodySchema,
    kind: "destructive",
    returns: ADMIN_HUT_LEADER_UPDATED_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_EDIT,
  },
  {
    id: "delete_hut_leader_assignment",
    title: "Remove a hut leader assignment",
    summary:
      "Officer: removes a hut leader assignment (`id` from `list_hut_leaders`), and with it any bed it held, which can be booked again. It cannot be undone; the member would have to be assigned again, with a new PIN. Answers `success`.",
    method: "DELETE",
    path: "/api/admin/hut-leaders/[id]",
    params: routeIdParamsSchema,
    kind: "destructive",
    returns: ADMIN_LODGE_DONE_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_EDIT,
  },
  {
    id: "list_hut_leader_bed_options",
    title: "List beds a hut leader could hold",
    summary:
      "Officer: every active bed at a lodge, by room, for holding one for a hut leader from `startDate` to `endDate` (`YYYY-MM-DD`, both nights included): whether it is free, and if not the nights a guest is allocated to it or another leader holds it. Give `lodgeId` (from `list_lodges`), or, when changing an assignment, its `assignmentId` from `list_hut_leaders`. Not found while bed allocation is off.",
    method: "GET",
    path: "/api/admin/hut-leaders/available-beds",
    query: hutLeaderBedOptionsQuerySchema,
    kind: "read",
    returns: ADMIN_HUT_LEADER_BED_OPTIONS_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_VIEW,
  },
  {
    id: "list_hut_leader_candidates",
    title: "List members who could be hut leader",
    summary:
      "Officer: adult members staying at a lodge (`lodgeId` from `list_lodges`) on some night from `startDate` to `endDate` (`YYYY-MM-DD`), under `members`: their member `id` and name, whether a completed induction has made them eligible to lead, their booking's check-in and check-out, the suggested first and last night to lead (the first run of their nights with no leader), how many of their nights have no leader, and school nights the lodge does not accept them for. Members already fully covered come last. No contact details.",
    method: "GET",
    path: "/api/admin/hut-leaders/eligible-members",
    query: hutLeaderCandidatesQuerySchema,
    kind: "read",
    returns: ADMIN_HUT_LEADER_CANDIDATES_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_nights_without_hut_leader",
    title: "List nights with no hut leader",
    summary:
      "Officer: the nights at a lodge (`lodgeId` from `list_lodges`) with guests staying but no hut leader staying, under `unassignedDates` (`YYYY-MM-DD`, with booking and guest counts). With no `month` or window, the nights coming up in the club's look-ahead. With `month` (`YYYY-MM`), or `from` and `to` (`YYYY-MM-DD`), those nights, plus `coveredNights`: each covered night from the night before the window, with its leaders' member ids and names.",
    method: "GET",
    path: "/api/admin/hut-leaders/unassigned-dates",
    query: hutLeaderUnassignedNightsQuerySchema,
    kind: "read",
    returns: ADMIN_HUT_LEADER_UNASSIGNED_NIGHTS_CONNECTION_SHAPE,
    core: false,
  },

  // --- Who can be hut leader for school bookings -----------------------------
  {
    id: "get_school_hut_leader_kinds",
    title: "Read who can lead school bookings",
    summary:
      "Officer: which kinds of hut leader cover a school booking's nights at a lodge (`lodgeId` from `list_lodges`), under `kinds`: a teacher on the booking, the custodian, a member on the booking, a member staying separately.",
    method: "GET",
    path: "/api/admin/lodge-settings/school-hut-leaders",
    query: hutLeaderLodgeQuerySchema,
    kind: "read",
    returns: ADMIN_SCHOOL_HUT_LEADER_KINDS_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_VIEW,
  },
  {
    id: "update_school_hut_leader_kinds",
    title: "Change who can lead school bookings",
    summary:
      "Officer: sets which kinds of hut leader cover a school booking's nights at a lodge (`lodgeId` from `list_lodges`). Send all four `kinds`, as read with `get_school_hut_leader_kinds`. Ticking `teacherOnBooking` also makes approving a school request assign its teachers as hut leaders. Answers the saved kinds.",
    method: "PUT",
    path: "/api/admin/lodge-settings/school-hut-leaders",
    body: schoolHutLeaderKindsBodySchema,
    kind: "destructive",
    returns: ADMIN_SCHOOL_HUT_LEADER_KINDS_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_EDIT,
  },

  // --- The chore roster ------------------------------------------------------
  {
    id: "get_chore_roster",
    title: "Read a night's chore roster",
    summary:
      "Officer: the chore roster for one lodge night (`date`, `YYYY-MM-DD`; `lodgeId` from `list_lodges`, default lodge if omitted): the guests there that day (first and last name, age tier, arriving or departing, and their booking), each chore assignment with its status (SUGGESTED, CONFIRMED or COMPLETED), the lodge's active chores and whether each is due that day, each guest's chores in the four days before, and the `revision` a save sends. A night with no roster yet gets one suggested and saved as SUGGESTED, as opening it on the website does.",
    method: "GET",
    path: "/api/admin/roster/[date]",
    params: adminRosterDateParamsSchema,
    query: adminRosterConnectionQuerySchema,
    kind: "read",
    returns: ADMIN_ROSTER_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_VIEW,
  },
  {
    id: "save_chore_roster",
    title: "Save a night's chore roster",
    summary:
      "Officer: replaces one lodge night's chore roster (`date`, `YYYY-MM-DD`; `lodgeId` as for `get_chore_roster`) with `assignments`, the whole list: each a chore and a guest from `get_chore_roster`, keeping an existing assignment by its `assignmentId`. Any assignment left out is removed and every saved one goes back to SUGGESTED. Send the roster's `revision` as `baseRevision`; a roster changed since is refused with 409. Answers the saved roster.",
    method: "PUT",
    path: "/api/admin/roster/[date]",
    params: adminRosterDateParamsSchema,
    query: adminRosterLodgeQuerySchema,
    body: rosterSaveBodySchema,
    fixedBody: { action: "save" },
    kind: "destructive",
    returns: ADMIN_ROSTER_ACTION_CONNECTION_SHAPES.save,
    core: false,
    requires: LODGE_EDIT,
  },
  {
    id: "regenerate_chore_roster",
    title: "Suggest a night's chore roster again",
    summary:
      "Officer: throws away one lodge night's suggested chores (`date`, `YYYY-MM-DD`; `lodgeId` as for `get_chore_roster`) and suggests them again from the guests there. A roster with confirmed or completed chores is refused with 409 unless `overwriteConfirmed` is true, which replaces those too. Answers `success`; read the result with `get_chore_roster`.",
    method: "PUT",
    path: "/api/admin/roster/[date]",
    params: adminRosterDateParamsSchema,
    query: adminRosterLodgeQuerySchema,
    body: rosterRegenerateBodySchema,
    fixedBody: { action: "regenerate" },
    kind: "destructive",
    returns: ADMIN_ROSTER_ACTION_CONNECTION_SHAPES.regenerate,
    core: false,
    requires: LODGE_EDIT,
  },
  {
    id: "confirm_chore_roster",
    title: "Confirm a night's chore roster",
    summary:
      "Officer: confirms every suggested chore on one lodge night's roster (`date`, `YYYY-MM-DD`; `lodgeId` as for `get_chore_roster`). Refused with 409 if a guest is no longer there that day or a chore is no longer active. Answers `success`.",
    method: "PUT",
    path: "/api/admin/roster/[date]",
    params: adminRosterDateParamsSchema,
    query: adminRosterLodgeQuerySchema,
    fixedBody: { action: "confirm" },
    kind: "destructive",
    returns: ADMIN_ROSTER_ACTION_CONNECTION_SHAPES.confirm,
    core: false,
    requires: LODGE_EDIT,
  },
  {
    id: "email_chore_roster",
    title: "Email a night's chore roster",
    summary:
      "Officer: emails each guest on one lodge night's roster (`date`, `YYYY-MM-DD`; `lodgeId` as for `get_chore_roster`) their chores and a link to tick them off, replacing any link sent before; guests who opted out of roster emails are skipped. `notifyMember: false` sends nothing and only records that choice. Answers how many were sent, skipped and failed (`suppressed` when nothing was sent by choice).",
    method: "PUT",
    path: "/api/admin/roster/[date]",
    params: adminRosterDateParamsSchema,
    query: adminRosterLodgeQuerySchema,
    body: rosterEmailBodySchema,
    fixedBody: { action: "email" },
    kind: "destructive",
    returns: ADMIN_ROSTER_ACTION_CONNECTION_SHAPES.email,
    core: false,
    requires: LODGE_EDIT,
  },
  {
    id: "get_chore_roster_month_status",
    title: "Read the roster status of a month",
    summary:
      "Officer: for each day of one month (`month`, `YYYY-MM`), the chore roster's state under `statuses`: `no-guests`, `needs-roster`, `suggested`, `needs-attention` or `confirmed`, with how many bookings are staying and, for `needs-attention`, how many of them have nobody given a chore. Give `lodgeId` (from `list_lodges`) for one lodge; omitted reads every lodge together.",
    method: "GET",
    path: "/api/admin/roster/status",
    query: adminRosterMonthStatusQuerySchema,
    kind: "read",
    returns: ADMIN_ROSTER_MONTH_STATUS_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_VIEW,
  },
];
