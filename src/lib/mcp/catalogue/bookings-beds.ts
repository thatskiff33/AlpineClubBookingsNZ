/**
 * Beds and rooms: the bed allocation board, rooms, beds and allocation settings (`/api/admin/bed-allocation/**`).
 * Part of the Bookings & Beds officer actions (ALP-719): spread into `MCP_ACTIONS`.
 *
 * Every route here answers 404 while the club has bed allocation switched
 * off; the routes' own module check decides, as it does for the admin screen.
 *
 * Kinds: every action that places, moves, suggests, approves or removes a
 * guest's bed is `destructive`, because it changes a member's bed (owner
 * decision, #5305 item 2); approving also has no un-approve. The allocation
 * settings and every room and bed change are club-wide configuration, and
 * each is `destructive` too, so the app asks the officer first (owner
 * decision, #5305 comment 7093303964, item 2). The two previews change
 * nothing and run as reads.
 */
import { adminRecordIdParamsSchema } from "@/lib/admin-bookings-schemas/record-id";
import {
  bedAllocationApproveBodySchema,
  bedAllocationAutoAllocateBodySchema,
  bedAllocationBedCreateBodySchema,
  bedAllocationBedUpdateBodySchema,
  bedAllocationBoardQuerySchema,
  bedAllocationBulkBodySchema,
  bedAllocationManualBodySchema,
  bedAllocationMoveApplyBodySchema,
  bedAllocationMovePreviewBodySchema,
  bedAllocationRangeBodySchema,
  bedAllocationRemovalApplyBodySchema,
  bedAllocationRemovalPreviewBodySchema,
  bedAllocationRoomCreateBodySchema,
  bedAllocationRoomsBulkBodySchema,
  bedAllocationRoomsQuerySchema,
  bedAllocationRoomUpdateBodySchema,
  bedAllocationSettingsBodySchema,
  bedAllocationSettingsQuerySchema,
  MAX_BED_ALLOCATION_REMOVAL_WINDOW_NIGHTS,
} from "@/lib/admin-bookings-schemas/beds";
import {
  ADMIN_BED_ALLOCATION_APPROVE_CONNECTION_SHAPE,
  ADMIN_BED_ALLOCATION_AUTO_ALLOCATE_CONNECTION_SHAPE,
  ADMIN_BED_ALLOCATION_BOARD_CONNECTION_SHAPE,
  ADMIN_BED_ALLOCATION_BULK_CONNECTION_SHAPE,
  ADMIN_BED_ALLOCATION_CONNECTION_SHAPE,
  ADMIN_BED_ALLOCATION_MOVE_CONNECTION_SHAPE,
  ADMIN_BED_ALLOCATION_MOVE_PREVIEW_CONNECTION_SHAPE,
  ADMIN_BED_ALLOCATION_RANGE_CONNECTION_SHAPE,
  ADMIN_BED_ALLOCATION_REMOVAL_CONNECTION_SHAPE,
  ADMIN_BED_ALLOCATION_REMOVAL_PREVIEW_CONNECTION_SHAPE,
  ADMIN_BED_ALLOCATION_SETTINGS_CONNECTION_SHAPE,
  ADMIN_LODGE_BED_CONNECTION_SHAPE,
  ADMIN_LODGE_ROOM_CONNECTION_SHAPE,
  ADMIN_LODGE_ROOMS_BULK_CONNECTION_SHAPE,
  ADMIN_LODGE_ROOMS_CONNECTION_SHAPE,
  ADMIN_LODGE_ROOMS_IMPORT_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/bookings-beds";

import { MAX_BED_ALLOCATION_RANGE_NIGHTS } from "@/lib/bed-allocation-date-range";
import type { McpAction } from "../catalogue";

/**
 * The two previews' own guard (`requireBedAllocationRead`): looking changes
 * nothing, so view access is enough, below the path's edit rule for a POST.
 */
const BOOKINGS_VIEW = { area: "bookings", level: "view" } as const;

/** Said once on every action that changes the lodge's rooms or beds. */
const INVENTORY_SIDE_EFFECT = "Public pages that show the lodge's rooms update.";

export const BOOKINGS_BEDS_MCP_ACTIONS: readonly McpAction[] = [
  // --- The board ---------------------------------------------------------------
  {
    id: "get_bed_allocation_board",
    title: "Read the bed allocation board",
    summary:
      `Officer: who sleeps in which bed for a window of lodge nights (default the next 7 from the club's today, at most ${MAX_BED_ALLOCATION_RANGE_NIGHTS}), as the bed allocation board shows it. Answers the rooms and beds; the bookings in the window with their guests (names, age tiers, stay dates) and the booking owner's name; each placed \`allocations\` row (guest, room, bed, night, \`AUTO\` or \`MANUAL\`, \`approvedAt\` null for a draft); guest-nights still awaiting a bed; suggested placements; whole-lodge and custodian holds; and warnings such as a party split across rooms. Nights are \`YYYY-MM-DD\`; \`to\` is the date out. \`scopedLodgeId\` is the lodge shown, null for every lodge. Only when the club has bed allocation switched on.`,
    method: "GET",
    path: "/api/admin/bed-allocation",
    query: bedAllocationBoardQuerySchema,
    kind: "read",
    returns: ADMIN_BED_ALLOCATION_BOARD_CONNECTION_SHAPE,
    core: false,
  },

  // --- Placing and moving guests -----------------------------------------------
  {
    id: "allocate_guest_bed_night",
    title: "Put a guest in a bed for one night",
    summary:
      "Officer: places one booking guest (`bookingGuestId` from `get_bed_allocation_board`) in a bed for one lodge night (`YYYY-MM-DD`), as a draft to approve later, replacing that guest's bed that night. A partner may share an active DOUBLE as its second occupant; moving a shared double's main occupant away promotes the partner left behind. Refused if the bed is taken or held by a custodian, the guest is not staying that night or has not consented to the booking, or the guest's booking holds the whole lodge. Answers the allocation row (`stayDate` as an ISO date at midnight UTC). Needs Bookings & Beds edit access.",
    method: "POST",
    path: "/api/admin/bed-allocation/allocations",
    body: bedAllocationManualBodySchema,
    // Owner decision #5305 item 2: changes a member's bed.
    kind: "destructive",
    returns: ADMIN_BED_ALLOCATION_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "allocate_guest_bed_nights",
    title: "Put a guest in a bed for several nights",
    summary:
      `Officer: places one booking guest in one bed for each listed lodge night (\`YYYY-MM-DD\`, at most ${MAX_BED_ALLOCATION_RANGE_NIGHTS}), as drafts. Places what it can: \`conflicts\` names the nights the bed was taken or held by a custodian, \`skipped\` the nights the guest is not staying. Answers the allocations written. Needs Bookings & Beds edit access.`,
    method: "POST",
    path: "/api/admin/bed-allocation/allocations/bulk",
    body: bedAllocationBulkBodySchema,
    // Owner decision #5305 item 2: changes a member's bed.
    kind: "destructive",
    returns: ADMIN_BED_ALLOCATION_BULK_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "assign_guest_bed_range",
    title: "Put a guest in a bed for a range of nights",
    summary:
      "Officer: places one booking guest in one bed from the night `from` to the date out `to` (`YYYY-MM-DD`), approved at once. All or nothing: if any night is blocked, nothing is written and the refusal answers the report, naming who occupies each blocked night, with `freeNights`; send those as `nights` to place only them. Answers `result`: the nights requested, free and written, and any refusals. Needs Bookings & Beds edit access.",
    method: "POST",
    path: "/api/admin/bed-allocation/allocations/range",
    body: bedAllocationRangeBodySchema,
    // Its nights are approved at once, and there is no un-approve.
    kind: "destructive",
    returns: ADMIN_BED_ALLOCATION_RANGE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "preview_bed_allocation_move",
    title: "Preview moving a guest to another bed",
    summary:
      "Officer: what moving an allocation (`anchorAllocationId`, an `id` from the board's `allocations`) to another bed would do, for that one night or the guest's whole stay, without moving anything: the rows that would change, approved rows that would return to draft, partners who would be promoted, and any conflicts that block it. Answers a `digest`; run `move_bed_allocation` with it to apply exactly this preview.",
    method: "POST",
    path: "/api/admin/bed-allocation/allocations/move",
    body: bedAllocationMovePreviewBodySchema,
    kind: "read",
    preview: true,
    requires: BOOKINGS_VIEW,
    returns: ADMIN_BED_ALLOCATION_MOVE_PREVIEW_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "move_bed_allocation",
    title: "Move a guest to another bed",
    summary:
      "Officer: applies a move previewed with `preview_bed_allocation_move`, sending the same fields and its `digest`. Refused if anything changed since the preview (run it again) or if a conflict blocks the move. A moved approved row returns to draft. Answers how many rows moved and partners were promoted, and the nights affected (`YYYY-MM-DD`). Needs Bookings & Beds edit access.",
    method: "PATCH",
    path: "/api/admin/bed-allocation/allocations",
    // The route also takes an older same-night move by allocation ids, which
    // the board no longer sends; this is its previewed half.
    body: bedAllocationMoveApplyBodySchema,
    // Owner decision #5305 item 2: changes a member's bed.
    kind: "destructive",
    returns: ADMIN_BED_ALLOCATION_MOVE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "auto_allocate_beds",
    title: "Suggest beds automatically",
    summary:
      `Officer: writes the board's suggested placements (\`suggestedAllocations\` in \`get_bed_allocation_board\`) for one lodge (\`lodgeId\` from \`list_lodges\`) over a window of nights (default the next 7, at most ${MAX_BED_ALLOCATION_RANGE_NIGHTS}), as drafts; existing placements are kept. Refused when the lodge has automatic suggestions switched off. Answers \`createdCount\`. Needs Bookings & Beds edit access.`,
    method: "POST",
    path: "/api/admin/bed-allocation/auto-allocate",
    body: bedAllocationAutoAllocateBodySchema,
    // Owner decision #5305 item 2: changes members' beds.
    kind: "destructive",
    returns: ADMIN_BED_ALLOCATION_AUTO_ALLOCATE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "approve_bed_allocations",
    title: "Approve bed allocations",
    summary:
      "Officer: approves draft allocations at one lodge (`lodgeId`, always required): the listed `allocationIds`, every draft of one `bookingId`, or every draft from `from` to the date out `to` (`YYYY-MM-DD`). Once a booking has an approved bed its member can no longer change their requested room. Answers `approvedCount`. Cannot be undone: there is no un-approve. Needs Bookings & Beds edit access.",
    method: "POST",
    path: "/api/admin/bed-allocation/approve",
    body: bedAllocationApproveBodySchema,
    kind: "destructive",
    returns: ADMIN_BED_ALLOCATION_APPROVE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "preview_bed_allocation_removal",
    title: "Preview removing bed allocations",
    summary:
      `Officer: what removing allocations would take away, without removing anything: for one allocation, one guest's stay, one booking, or a lodge window of up to ${MAX_BED_ALLOCATION_REMOVAL_WINDOW_NIGHTS} nights, the rows of each chosen category, the bookings and nights affected, partners who would be promoted on shared doubles, and the bookings whose member could change their requested room again. Answers a \`digest\`; run \`remove_bed_allocations\` with it to apply exactly this preview.`,
    method: "POST",
    path: "/api/admin/bed-allocation/allocations/removal",
    body: bedAllocationRemovalPreviewBodySchema,
    kind: "read",
    preview: true,
    requires: BOOKINGS_VIEW,
    returns: ADMIN_BED_ALLOCATION_REMOVAL_PREVIEW_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "remove_bed_allocations",
    title: "Remove bed allocations",
    summary:
      "Officer: removes the allocations previewed with `preview_bed_allocation_removal`, sending the same `scope` and `categories` and its `digest`. Refused if anything changed since the preview. The guests go back to awaiting a bed. Answers how many rows were removed and partners promoted, and the bookings and nights affected. Cannot be undone: approved placements would have to be made and approved again. Needs Bookings & Beds edit access.",
    method: "PUT",
    path: "/api/admin/bed-allocation/allocations/removal",
    body: bedAllocationRemovalApplyBodySchema,
    kind: "destructive",
    returns: ADMIN_BED_ALLOCATION_REMOVAL_CONNECTION_SHAPE,
    core: false,
  },

  // --- Settings ------------------------------------------------------------------
  {
    id: "get_bed_allocation_settings",
    title: "Read a lodge's bed allocation settings",
    summary:
      "Officer: whether automatic bed suggestions are on at one lodge (`lodgeId` from `list_lodges`) and the placement priorities in order, plus `source`: `LODGE` for the lodge's own settings, `LEGACY` or `DEFAULT` when it has none yet.",
    method: "GET",
    path: "/api/admin/bed-allocation/settings",
    query: bedAllocationSettingsQuerySchema,
    kind: "read",
    returns: ADMIN_BED_ALLOCATION_SETTINGS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_bed_allocation_settings",
    title: "Change a lodge's bed allocation settings",
    summary:
      "Officer: saves one lodge's bed allocation settings: whether beds are suggested automatically and the placement priorities, most important first, each at most once. Both are always saved, so send the current values from `get_bed_allocation_settings` for the one not being changed. Answers the saved settings. Needs Bookings & Beds edit access.",
    method: "PUT",
    path: "/api/admin/bed-allocation/settings",
    body: bedAllocationSettingsBodySchema,
    kind: "destructive",
    returns: ADMIN_BED_ALLOCATION_SETTINGS_CONNECTION_SHAPE,
    core: false,
  },

  // --- Rooms ---------------------------------------------------------------------
  {
    id: "list_lodge_rooms_and_beds",
    title: "List a lodge's rooms and beds",
    summary:
      "Officer: one lodge's rooms (default lodge if `lodgeId` is omitted), each with its beds (type, bunk pairing, whether active), the lodge's sleeping capacity and how it is worked out, the partner spots active double beds add, and whether rooms can still be imported from the club's configuration (`configBeds`), which is only while no room or bed exists.",
    method: "GET",
    path: "/api/admin/bed-allocation/rooms",
    query: bedAllocationRoomsQuerySchema,
    kind: "read",
    returns: ADMIN_LODGE_ROOMS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "create_lodge_room",
    title: "Add a room",
    summary: `Officer: adds a room at a lodge (default lodge if \`lodgeId\` is omitted). Refused if the lodge already has a room by that name. Answers the room; add beds with \`create_lodge_bed\`. ${INVENTORY_SIDE_EFFECT} Needs Bookings & Beds edit access.`,
    method: "POST",
    path: "/api/admin/bed-allocation/rooms",
    body: bedAllocationRoomCreateBodySchema,
    kind: "destructive",
    returns: ADMIN_LODGE_ROOM_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "create_lodge_rooms_in_bulk",
    title: "Add several rooms with beds",
    summary: `Officer: adds \`roomCount\` rooms named \`<namePrefix> 1\` onward, each with \`bedsPerRoom\` beds, at a lodge (default lodge if \`lodgeId\` is omitted), all or nothing: refused if any name is taken. Answers how many rooms and beds were created. ${INVENTORY_SIDE_EFFECT} Needs Bookings & Beds edit access.`,
    method: "POST",
    path: "/api/admin/bed-allocation/rooms/bulk",
    body: bedAllocationRoomsBulkBodySchema,
    kind: "destructive",
    returns: ADMIN_LODGE_ROOMS_BULK_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "import_rooms_and_beds_from_config",
    title: "Import rooms and beds from the club's configuration",
    summary: `Officer: creates the default lodge's rooms and beds from the club's configuration (\`configBeds\` in \`list_lodge_rooms_and_beds\`). Refused once any room or bed exists. Answers how many were created and the rooms. ${INVENTORY_SIDE_EFFECT} Needs Bookings & Beds edit access.`,
    method: "POST",
    path: "/api/admin/bed-allocation/rooms/import-from-config",
    kind: "destructive",
    returns: ADMIN_LODGE_ROOMS_IMPORT_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_lodge_room",
    title: "Change a room",
    summary: `Officer: changes a room (\`id\` from \`list_lodge_rooms_and_beds\`): name, order, notes or whether it is active. Only the fields sent change. Deactivating is refused while a custodian holds one of its beds. Answers the room. ${INVENTORY_SIDE_EFFECT} Needs Bookings & Beds edit access.`,
    method: "PATCH",
    path: "/api/admin/bed-allocation/rooms/[id]",
    params: adminRecordIdParamsSchema,
    body: bedAllocationRoomUpdateBodySchema,
    kind: "destructive",
    returns: ADMIN_LODGE_ROOM_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "delete_lodge_room",
    title: "Delete a room",
    summary: `Officer: deletes a room (\`id\` from \`list_lodge_rooms_and_beds\`) and its beds. Refused while the room has allocation history or a custodian holds one of its beds; deactivate it instead. Answers the deleted room. ${INVENTORY_SIDE_EFFECT} Cannot be undone. Needs Bookings & Beds edit access.`,
    method: "DELETE",
    path: "/api/admin/bed-allocation/rooms/[id]",
    params: adminRecordIdParamsSchema,
    kind: "destructive",
    returns: ADMIN_LODGE_ROOM_CONNECTION_SHAPE,
    core: false,
  },

  // --- Beds ----------------------------------------------------------------------
  {
    id: "create_lodge_bed",
    title: "Add a bed",
    summary: `Officer: adds a bed to a room (\`roomId\` from \`list_lodge_rooms_and_beds\`). An active bed adds one to the lodge's sleeping capacity. Answers the bed. ${INVENTORY_SIDE_EFFECT} Needs Bookings & Beds edit access.`,
    method: "POST",
    path: "/api/admin/bed-allocation/beds",
    body: bedAllocationBedCreateBodySchema,
    kind: "destructive",
    returns: ADMIN_LODGE_BED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_lodge_bed",
    title: "Change a bed",
    summary: `Officer: changes a bed (\`id\` from \`list_lodge_rooms_and_beds\`): name, order, type, bunk pairing or whether it is active. Only the fields sent change. Deactivating is refused while the bed has future allocations or a custodian holds it. Answers the bed. ${INVENTORY_SIDE_EFFECT} Needs Bookings & Beds edit access.`,
    method: "PATCH",
    path: "/api/admin/bed-allocation/beds/[id]",
    params: adminRecordIdParamsSchema,
    body: bedAllocationBedUpdateBodySchema,
    kind: "destructive",
    returns: ADMIN_LODGE_BED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "delete_lodge_bed",
    title: "Delete a bed",
    summary: `Officer: deletes a bed (\`id\` from \`list_lodge_rooms_and_beds\`). Refused while it has allocation history or a custodian holds it; deactivate it instead. Answers the deleted bed. ${INVENTORY_SIDE_EFFECT} Cannot be undone. Needs Bookings & Beds edit access.`,
    method: "DELETE",
    path: "/api/admin/bed-allocation/beds/[id]",
    params: adminRecordIdParamsSchema,
    kind: "destructive",
    returns: ADMIN_LODGE_BED_CONNECTION_SHAPE,
    core: false,
  },
];
