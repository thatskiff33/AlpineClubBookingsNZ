/**
 * Lodge Operations: the chores a lodge's rosters are built from, and work
 * parties (working bees) with their booking discount. Part of the Lodge
 * Operations officer actions (ALP-722): spread into `MCP_ACTIONS`.
 *
 * Kinds: every change here is `destructive` (owner decision, #5305). Chores
 * and work parties are club-wide configuration: a chore changes every roster
 * suggested after it, and a work party's discount prices the bookings that
 * attend it and shows on the Events Calendar.
 *
 * The officer's work-party ids are named apart from the member's
 * `list_work_parties` and `get_work_party`, which read only open work parties.
 */
import {
  choreCreateBodySchema,
  choreListQuerySchema,
  choreUpdateBodySchema,
  workPartyEventSchema,
} from "@/lib/admin-lodge-schemas/chores-work-parties";
import { MAX_WORK_PARTY_NIGHTS } from "@/lib/work-party-rules";
import {
  ADMIN_CHORE_CONNECTION_SHAPE,
  ADMIN_CHORE_LIST_CONNECTION_SHAPE,
  ADMIN_WORK_PARTY_CALENDAR_CONNECTION_SHAPE,
  ADMIN_WORK_PARTY_CREATED_CONNECTION_SHAPE,
  ADMIN_WORK_PARTY_DETAIL_CONNECTION_SHAPE,
  ADMIN_WORK_PARTY_LIST_CONNECTION_SHAPE,
  ADMIN_WORK_PARTY_UPDATED_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/lodge-chores-work-parties";
import { ADMIN_LODGE_DONE_CONNECTION_SHAPE } from "@/lib/connection-shapes/lodge-hut-leaders";
import { routeIdParamsSchema } from "@/lib/route-id-params";

import type { McpAction } from "../catalogue";

const CHORE_FIELDS =
  "how many people it takes, whether it is essential, who may do it (age restriction and youngest age), its place in the roster, time of day, how often it is due (daily, every so many days, or on given weekdays, 1 Monday to 7 Sunday), whether it is active, and its lodge";

export const LODGE_CHORE_WORK_PARTY_MCP_ACTIONS: readonly McpAction[] = [
  // --- Chores ----------------------------------------------------------------
  {
    id: "list_chore_templates",
    title: "List chores",
    summary: `Officer: the chores rosters are built from, in roster order, under \`chores\`: name, description, ${CHORE_FIELDS}. Give \`lodgeId\` (from \`list_lodges\`) for one lodge.`,
    method: "GET",
    path: "/api/admin/chores",
    query: choreListQuerySchema,
    kind: "read",
    returns: ADMIN_CHORE_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "create_chore_template",
    title: "Create a chore",
    summary:
      "Officer: adds a chore at a lodge (`lodgeId` from `list_lodges`, default lodge if omitted), which rosters suggested from then on include when it is due. `SPECIFIC_DAYS` needs at least one weekday; the most people must be at least the fewest. Answers the saved chore.",
    method: "POST",
    path: "/api/admin/chores",
    body: choreCreateBodySchema,
    kind: "destructive",
    returns: ADMIN_CHORE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_chore_template",
    title: "Change a chore",
    summary:
      "Officer: changes a chore (`id` from `list_chore_templates`); only what is sent changes. Setting `active` false leaves it out of rosters suggested from then on. Answers the saved chore.",
    method: "PUT",
    path: "/api/admin/chores/[id]",
    params: routeIdParamsSchema,
    body: choreUpdateBodySchema,
    kind: "destructive",
    returns: ADMIN_CHORE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "delete_chore_template",
    title: "Delete a chore",
    summary:
      "Officer: deletes a chore (`id` from `list_chore_templates`). It cannot be undone; to stop rostering it but keep it, use `update_chore_template` with `active: false`. Answers `success`.",
    method: "DELETE",
    path: "/api/admin/chores/[id]",
    params: routeIdParamsSchema,
    kind: "destructive",
    returns: ADMIN_LODGE_DONE_CONNECTION_SHAPE,
    core: false,
  },

  // --- Work parties ----------------------------------------------------------
  {
    id: "list_all_work_parties",
    title: "List all work parties",
    summary:
      "Officer: every work party (working bee), past and future, latest first, under `events`: name, description, first and last discounted night (ISO timestamps whose date part is the night, both included), discount percentage, whether active, lodge (null for club-wide), whether it is on the Events Calendar and can be added to it, how many bookings attend it and their total discount in integer cents.",
    method: "GET",
    path: "/api/admin/work-parties",
    kind: "read",
    returns: ADMIN_WORK_PARTY_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_work_party_attendance",
    title: "Read a work party and its bookings",
    summary:
      "Officer: one work party by `id` (from `list_all_work_parties`), with each booking attending it under `attendingBookings`: the booking's id, dates (ISO timestamps whose date part is the lodge night), status and final price, the discount it got, and the member's id and name; and `totalDiscountCents`. Money in integer cents. No contact details.",
    method: "GET",
    path: "/api/admin/work-parties/[id]",
    params: routeIdParamsSchema,
    kind: "read",
    returns: ADMIN_WORK_PARTY_DETAIL_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "create_work_party",
    title: "Create a work party",
    // The night cap is the calendar's series cap (`workPartyEventDatesError`).
    summary: `Officer: adds a work party: name, the first and last discounted night (\`YYYY-MM-DD\`, both included, at most ${MAX_WORK_PARTY_NIGHTS} nights), the discount percentage a booking attending it gets on those nights (100 if omitted), and its lodge (\`lodgeId\` from \`list_lodges\`, or null for club-wide). Members can then choose it when booking. With the Events Calendar on, it is also put on the calendar; \`calendarWarning\` says if that failed. Answers the saved work party.`,
    method: "POST",
    path: "/api/admin/work-parties",
    body: workPartyEventSchema,
    kind: "destructive",
    returns: ADMIN_WORK_PARTY_CREATED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_work_party",
    title: "Change a work party",
    summary:
      "Officer: changes a work party (`id` from `list_all_work_parties`). Send every field, as read from `get_work_party_attendance`: name, description, dates (`YYYY-MM-DD`, the date part of what was read), discount, whether active and lodge; an omitted description is cleared, an omitted discount becomes 100, an omitted `active` true and an omitted lodge club-wide. Deactivating stops new bookings choosing it and never changes bookings already attending. Its calendar entries follow the change. Answers the saved work party.",
    method: "PUT",
    path: "/api/admin/work-parties/[id]",
    params: routeIdParamsSchema,
    body: workPartyEventSchema,
    kind: "destructive",
    returns: ADMIN_WORK_PARTY_UPDATED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "delete_work_party",
    title: "Delete a work party",
    summary:
      "Officer: deletes a work party (`id` from `list_all_work_parties`) and its calendar entries. Refused while any booking attends it: deactivate it with `update_work_party` instead. It cannot be undone. Answers `success`.",
    method: "DELETE",
    path: "/api/admin/work-parties/[id]",
    params: routeIdParamsSchema,
    kind: "destructive",
    returns: ADMIN_LODGE_DONE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "add_work_party_to_calendar",
    title: "Put a work party on the calendar",
    summary:
      "Officer: puts a work party (`id` from `list_all_work_parties`) on the Events Calendar, one entry per night, for one made before the calendar was on; asked again, it rewrites the same entries. Check first that the club has not already added it by hand. Refused with 409 while the Events Calendar is off. Answers `entryCount`.",
    method: "POST",
    path: "/api/admin/work-parties/[id]/calendar",
    params: routeIdParamsSchema,
    kind: "destructive",
    returns: ADMIN_WORK_PARTY_CALENDAR_CONNECTION_SHAPE,
    core: false,
  },
];
