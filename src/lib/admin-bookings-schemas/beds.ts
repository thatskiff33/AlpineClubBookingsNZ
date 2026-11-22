/**
 * The request schemas of the bed allocation routes
 * (`/api/admin/bed-allocation/**`): the board, its settings, rooms, beds,
 * placing, moving, approving and removing allocations (ALP-719,
 * `INV-MCP-006`).
 *
 * In a pure lib module because each route parses with these and the AI app
 * action catalogue offers the same fields (`INV-SSOT`). No database or server
 * imports, so the catalogue can load it. The limits and closed vocabularies
 * the schemas need (move scopes, removal categories, bulk-room caps) live here
 * too, moved from the server modules that also read them, so neither side
 * holds a second copy.
 *
 * A schema with a refinement is still a `z.object` (zod 4 keeps the checks on
 * the object), so the catalogue offers the route's own schema; only its fields
 * reach the app's description, and the route remains the authority for the
 * cross-field rules.
 */
import { BedType } from "@prisma/client";
import { z } from "zod";

import { BED_ALLOCATION_PRIORITY_VOCABULARY } from "@/config/club-settings-defaults";
import { MAX_BED_ALLOCATION_RANGE_NIGHTS } from "@/lib/bed-allocation-date-range";
import { MAX_BED_ALLOCATION_ASSIGN_RANGE_NIGHTS } from "@/lib/bed-allocation-range-report";
import type { BedAllocationSettingsWriteBody } from "@/lib/bed-allocation-settings";
import { countNightsDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { dateOnlyStringSchema } from "@/lib/date-only-schema";

// ---------------------------------------------------------------------------
// Limits and vocabularies the routes and the services share
// ---------------------------------------------------------------------------

/** How many rooms one bulk seed may create (ADR-003). */
export const MAX_BULK_ROOMS = 50;
/** How many beds each bulk-seeded room may have. */
export const MAX_BULK_BEDS_PER_ROOM = 20;

/** What a typed board move covers: one night, or the guest's whole stay. */
export const BED_ALLOCATION_MOVE_SCOPES = ["ALLOCATION_NIGHT", "BOOKING_GUEST"] as const;

/** The kinds of allocation row a removal may take away. */
export const BED_ALLOCATION_REMOVAL_CATEGORIES = ["AUTO_DRAFT", "MANUAL_DRAFT", "APPROVED"] as const;

/** The widest lodge window one removal may cover. */
export const MAX_BED_ALLOCATION_REMOVAL_WINDOW_NIGHTS = 31;

/** The digest a move or removal preview answers with, sent back to apply exactly that preview. */
const PREVIEW_DIGEST_PATTERN = /^v1:[0-9a-f]{64}$/;

const previewDigestSchema = z.string().regex(PREVIEW_DIGEST_PATTERN);

const NIGHT_FORMAT = "`YYYY-MM-DD`";

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

/**
 * `GET /api/admin/bed-allocation`. Plain strings, as the route always read
 * them: the date parse and the lodge checks stay in the route, which refuses
 * a bad date or an unknown lodge with a 400.
 */
export const bedAllocationBoardQuerySchema = z.object({
  from: z
    .string()
    .optional()
    .describe(`The first night shown, ${NIGHT_FORMAT}; the club's today when omitted.`),
  to: z
    .string()
    .optional()
    .describe(
      `The date-out column, ${NIGHT_FORMAT} (the morning after the last night shown); 7 nights after \`from\` when omitted, at most ${MAX_BED_ALLOCATION_RANGE_NIGHTS} nights.`,
    ),
  lodgeId: z
    .string()
    .optional()
    .describe("A lodge id from `list_lodges`; omit for every lodge. Refused if it contradicts `bookingId`'s lodge."),
  bookingId: z
    .string()
    .optional()
    .describe("A booking id (from `search_bookings`) to focus: the board is scoped to that booking's lodge."),
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** `GET /api/admin/bed-allocation/settings`. */
export const bedAllocationSettingsQuerySchema = z.object({
  lodgeId: z.string().min(1).describe("The lodge, from `list_lodges`."),
});

/**
 * `PUT /api/admin/bed-allocation/settings`.
 *
 * The `satisfies` is a compile-time proof that this schema and the write
 * contract the editor builds name the SAME fields (#2931). `Record` requires
 * every contract field to be present, and the object literal's excess-property
 * check refuses any field the contract does not have, so adding a field on
 * either side, or dropping one, fails `pnpm run typecheck` rather than failing
 * in a browser as a 400 "Invalid input" that nobody could read.
 *
 * `allocationPriorityOrder` stays `unknown[]` here: the route reads it through
 * `parseBedAllocationPriorityOrder`, the one closed-vocabulary boundary, which
 * names an unknown or repeated entry in its refusal.
 */
export const bedAllocationSettingsBodySchema = z
  .object({
    autoAllocationEnabled: z.boolean().describe("Whether the board suggests beds automatically."),
    allocationPriorityOrder: z
      .array(z.unknown())
      .describe(
        `The automatic placement priorities, most important first, each at most once: ${BED_ALLOCATION_PRIORITY_VOCABULARY.map((value) => `\`${value}\``).join(", ")}.`,
      ),
    lodgeId: z.string().min(1).describe("The lodge, from `list_lodges`."),
  } satisfies Record<keyof BedAllocationSettingsWriteBody, z.ZodType>)
  .strict();

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

const roomNameSchema = z.string().trim().min(1).max(100);
const sortOrderSchema = z.coerce.number().int().min(0).max(10000);
const ROOM_NOTES_MAX_LENGTH = 500;
const roomNotesSchema = z.string().trim().max(ROOM_NOTES_MAX_LENGTH).nullable().optional();

/** `GET /api/admin/bed-allocation/rooms`. */
export const bedAllocationRoomsQuerySchema = z.object({
  lodgeId: z.string().optional().describe("A lodge id from `list_lodges`; the default lodge when omitted."),
});

/** `POST /api/admin/bed-allocation/rooms`. */
export const bedAllocationRoomCreateBodySchema = z
  .object({
    name: roomNameSchema.describe("The room's name, unique at its lodge."),
    sortOrder: sortOrderSchema.default(0).describe("Where the room sits in lists, lowest first."),
    active: z.boolean().default(true).describe("Whether its beds can be allocated."),
    notes: roomNotesSchema.describe(`Notes for officers, up to ${ROOM_NOTES_MAX_LENGTH} characters.`),
    lodgeId: z.string().min(1).optional().describe("A lodge id from `list_lodges`; the default lodge when omitted."),
  })
  .strict();

/** `PATCH /api/admin/bed-allocation/rooms/[id]`: only the fields sent change. */
export const bedAllocationRoomUpdateBodySchema = z
  .object({
    name: roomNameSchema.optional().describe("The room's new name, unique at its lodge."),
    sortOrder: sortOrderSchema.optional().describe("Where the room sits in lists, lowest first."),
    active: z
      .boolean()
      .optional()
      .describe("Whether its beds can be allocated; refused while a custodian holds one of its beds."),
    notes: roomNotesSchema.describe(`Notes for officers, up to ${ROOM_NOTES_MAX_LENGTH} characters; null clears them.`),
  })
  .strict();

/** `POST /api/admin/bed-allocation/rooms/bulk`. */
export const bedAllocationRoomsBulkBodySchema = z
  .object({
    roomCount: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_BULK_ROOMS)
      .describe(`How many rooms to create, 1 to ${MAX_BULK_ROOMS}.`),
    bedsPerRoom: z.coerce
      .number()
      .int()
      .min(0)
      .max(MAX_BULK_BEDS_PER_ROOM)
      .describe(`How many beds each room gets, 0 to ${MAX_BULK_BEDS_PER_ROOM}.`),
    namePrefix: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional()
      .describe("Rooms are named `<prefix> 1` to `<prefix> N`; `Room` when omitted."),
    lodgeId: z.string().min(1).optional().describe("A lodge id from `list_lodges`; the default lodge when omitted."),
  })
  .strict();

// ---------------------------------------------------------------------------
// Beds
// ---------------------------------------------------------------------------

const bedNameSchema = z.string().trim().min(1).max(100);
const BED_TYPE_DESCRIPTION = `The bed's type, one of ${Object.values(BedType).map((value) => `\`${value}\``).join(", ")}; it does not change capacity except that an active DOUBLE can take a partner as a second occupant.`;
const BUNK_GROUP_DESCRIPTION =
  "A label pairing two beds of one room as a bunk (one BUNK_TOP, one BUNK_BOTTOM); null for none.";

/** `POST /api/admin/bed-allocation/beds`. */
export const bedAllocationBedCreateBodySchema = z
  .object({
    roomId: z.string().min(1).describe("The room, from `list_lodge_rooms_and_beds`."),
    name: bedNameSchema.describe("The bed's name."),
    sortOrder: sortOrderSchema.default(0).describe("Where the bed sits in its room, lowest first."),
    active: z.boolean().default(true).describe("Whether the bed can be allocated."),
    // Descriptive bed type (#1675); mirrors the Prisma BedType enum.
    bedType: z.nativeEnum(BedType).default(BedType.SINGLE).describe(BED_TYPE_DESCRIPTION),
    // Bunk-pairing label; validated server-side in createBedAllocationBed.
    bunkGroup: z.string().trim().max(50).nullable().optional().describe(BUNK_GROUP_DESCRIPTION),
  })
  .strict();

/** `PATCH /api/admin/bed-allocation/beds/[id]`: only the fields sent change. */
export const bedAllocationBedUpdateBodySchema = z
  .object({
    name: bedNameSchema.optional().describe("The bed's new name."),
    sortOrder: sortOrderSchema.optional().describe("Where the bed sits in its room, lowest first."),
    active: z
      .boolean()
      .optional()
      .describe("Whether the bed can be allocated; refused while it has future allocations or a custodian holds it."),
    // Descriptive bed type (#1675); mirrors the Prisma BedType enum.
    bedType: z.nativeEnum(BedType).optional().describe(BED_TYPE_DESCRIPTION),
    // Bunk-pairing label; validated server-side in updateBedAllocationBed.
    bunkGroup: z.string().trim().max(50).nullable().optional().describe(BUNK_GROUP_DESCRIPTION),
  })
  .strict();

// ---------------------------------------------------------------------------
// Placing guests in beds
// ---------------------------------------------------------------------------

const BOOKING_GUEST_DESCRIPTION = "The booking guest, as `bookingGuestId` on the board.";
const DESTINATION_BED_DESCRIPTION = "The bed, from the board's rooms.";

/** `POST /api/admin/bed-allocation/allocations`: one guest, one night. */
export const bedAllocationManualBodySchema = z
  .object({
    bookingGuestId: z.string().min(1).describe(BOOKING_GUEST_DESCRIPTION),
    bedId: z.string().min(1).describe(DESTINATION_BED_DESCRIPTION),
    stayDate: z.string().min(1).describe(`The lodge night, ${NIGHT_FORMAT}.`),
  })
  .strict();

/** `POST /api/admin/bed-allocation/allocations/bulk`: one guest, several nights. */
export const bedAllocationBulkBodySchema = z
  .object({
    bookingGuestId: z.string().min(1).describe(BOOKING_GUEST_DESCRIPTION),
    bedId: z.string().min(1).describe(DESTINATION_BED_DESCRIPTION),
    stayDates: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_BED_ALLOCATION_RANGE_NIGHTS)
      .describe(`The lodge nights, ${NIGHT_FORMAT}, 1 to ${MAX_BED_ALLOCATION_RANGE_NIGHTS} of them.`),
  })
  .strict();

/** `POST /api/admin/bed-allocation/allocations/range`. */
export const bedAllocationRangeBodySchema = z
  .object({
    bookingGuestId: z.string().min(1).describe(BOOKING_GUEST_DESCRIPTION),
    bedId: z.string().min(1).describe(DESTINATION_BED_DESCRIPTION),
    // Date-only lodge nights: `from` is the first night, `to` the check-out
    // date (exclusive), matching every other bed-allocation endpoint.
    // Checked here so a malformed range is refused by the schema, before the
    // lib is called at all (#2251 review C2): `.min(1)` accepted "9999999-01-01".
    from: dateOnlyStringSchema.describe(`The first night, ${NIGHT_FORMAT}.`),
    to: dateOnlyStringSchema.describe(`The date out, ${NIGHT_FORMAT} (the morning after the last night).`),
    /*
     * The admin's explicit SECOND action after a refusal (#2251): the exact
     * nights they were shown as free and chose to assign. Never a default — the
     * first attempt is always all-or-nothing — and never a flag the server
     * re-interprets: it assigns this set or refuses it with a fresh report, so
     * a night freed by someone else between the report and the click cannot be
     * written without the admin ever seeing it.
     */
    nights: z
      .array(dateOnlyStringSchema)
      .min(1)
      .max(MAX_BED_ALLOCATION_ASSIGN_RANGE_NIGHTS)
      .optional()
      .describe(
        "Omit on the first try, which is all or nothing. After a refusal, the exact free nights from its `freeNights` to place only those.",
      ),
  })
  .strict();

// ---------------------------------------------------------------------------
// Moving allocations
// ---------------------------------------------------------------------------

const moveTargetFields = {
  anchorAllocationId: z.string().min(1).describe("The allocation to move, as `id` in the board's `allocations`."),
  destinationBedId: z.string().min(1).describe("The bed to move to, from the board's rooms."),
  scope: z
    .enum(BED_ALLOCATION_MOVE_SCOPES)
    .describe("`ALLOCATION_NIGHT` moves that one night; `BOOKING_GUEST` moves every night of that guest's stay."),
};

/** `POST /api/admin/bed-allocation/allocations/move`: the read-only preview. */
export const bedAllocationMovePreviewBodySchema = z.object(moveTargetFields).strict();

/** `PATCH /api/admin/bed-allocation/allocations`, the typed move the board sends after its preview. */
export const bedAllocationMoveApplyBodySchema = z
  .object({
    ...moveTargetFields,
    previewDigest: previewDigestSchema.describe(
      "The `digest` of the preview being applied; refused if anything changed since that preview.",
    ),
  })
  .strict();

/** The older same-night move by allocation ids, which the route still accepts. */
const legacyMoveBodySchema = z
  .object({
    allocationIds: z.array(z.string().min(1)).min(1).max(MAX_BED_ALLOCATION_RANGE_NIGHTS),
    bedId: z.string().min(1),
  })
  .strict();

/** The route's whole `PATCH` body: the typed move, or the older id list. */
export const bedAllocationMoveRequestSchema = z.union([legacyMoveBodySchema, bedAllocationMoveApplyBodySchema]);

// ---------------------------------------------------------------------------
// Removing allocations
// ---------------------------------------------------------------------------

const anchorFields = {
  allocationId: z.string().min(1).describe("An allocation in the scope, as `id` in the board's `allocations`."),
  bookingId: z.string().min(1).describe("That allocation's `bookingId`."),
  bookingGuestId: z.string().min(1).describe("That allocation's `bookingGuestId`."),
  lodgeId: z.string().min(1).describe("That allocation's lodge."),
  stayDate: dateOnlyStringSchema.describe(`That allocation's night, ${NIGHT_FORMAT}.`),
};

const windowScopeSchema = z
  .object({
    type: z.literal("WINDOW"),
    lodgeId: z.string().min(1),
    from: dateOnlyStringSchema,
    to: dateOnlyStringSchema,
  })
  .strict();

const removalScopeSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("ALLOCATION"), ...anchorFields }).strict(),
    z.object({ type: z.literal("BOOKING_GUEST"), ...anchorFields }).strict(),
    z.object({ type: z.literal("BOOKING"), ...anchorFields }).strict(),
    windowScopeSchema,
  ])
  .superRefine((scope, context) => {
    if (scope.type !== "WINDOW") return;
    if (!isDateOnlyString(scope.from) || !isDateOnlyString(scope.to)) {
      context.addIssue({ code: "custom", message: "Invalid removal window" });
      return;
    }
    const nights = countNightsDateOnly(parseDateOnly(scope.from), parseDateOnly(scope.to));
    if (nights < 1 || nights > MAX_BED_ALLOCATION_REMOVAL_WINDOW_NIGHTS) {
      context.addIssue({
        code: "custom",
        message: `Removal window must cover 1 to ${MAX_BED_ALLOCATION_REMOVAL_WINDOW_NIGHTS} nights`,
      });
    }
  })
  .describe(
    `What to remove from. \`ALLOCATION\` is that one row, \`BOOKING_GUEST\` every night of that guest, \`BOOKING\` every guest of that booking, each named by one of its allocations; \`WINDOW\` is every allocation at \`lodgeId\` from the night \`from\` to the date out \`to\` (${NIGHT_FORMAT}, 1 to ${MAX_BED_ALLOCATION_REMOVAL_WINDOW_NIGHTS} nights).`,
  );

const removalCategoriesSchema = z
  .array(z.enum(BED_ALLOCATION_REMOVAL_CATEGORIES))
  .min(1)
  .max(BED_ALLOCATION_REMOVAL_CATEGORIES.length)
  .superRefine((categories, context) => {
    if (new Set(categories).size !== categories.length) {
      context.addIssue({
        code: "custom",
        message: "Duplicate categories are not allowed",
      });
    }
  })
  .describe(
    "Which rows in the scope to remove, each at most once: `AUTO_DRAFT` (suggested, not approved), `MANUAL_DRAFT` (placed by hand, not approved), `APPROVED`.",
  );

/** `POST /api/admin/bed-allocation/allocations/removal`: the read-only preview. */
export const bedAllocationRemovalPreviewBodySchema = z
  .object({ scope: removalScopeSchema, categories: removalCategoriesSchema })
  .strict();

/** `PUT /api/admin/bed-allocation/allocations/removal`: apply exactly the reviewed preview. */
export const bedAllocationRemovalApplyBodySchema = bedAllocationRemovalPreviewBodySchema
  .extend({
    previewDigest: previewDigestSchema.describe(
      "The `digest` of the preview being applied; refused if anything changed since that preview.",
    ),
  })
  .strict();

// ---------------------------------------------------------------------------
// Approving and auto-allocating
// ---------------------------------------------------------------------------

/*
  #2887 (owner decision 7): approve must name its lodge. Always.

  This was the last board mutation with no server-side lodge refusal — its
  sibling `auto-allocate` already required one. Omitting `lodgeId` made the
  service lock EVERY lodge plus the global key and approve across all of them.

  Absent a lodge the service still takes every lodge's key plus the global
  one, so ANY `bookings:edit` admin could stop the whole club's booking and
  allocation writers with a hand-made body naming two row ids. Contention, not
  authorization, is what makes it required — and it costs callers nothing,
  because every caller already sends it.
*/
/** `POST /api/admin/bed-allocation/approve`. */
export const bedAllocationApproveBodySchema = z
  .object({
    allocationIds: z
      .array(z.string().min(1))
      .max(250)
      .optional()
      .describe("Allocation ids from the board to approve, at most 250."),
    from: z.string().optional().describe(`With \`to\`: approve every draft from this night, ${NIGHT_FORMAT}.`),
    to: z.string().optional().describe(`With \`from\`: the date out, ${NIGHT_FORMAT}.`),
    // One booking's draft rows; sufficient without either broader selector.
    bookingId: z.string().min(1).optional().describe("Approve every draft of this booking."),
    // Board lodge scope. Required — see above.
    lodgeId: z.string().min(1).describe("The lodge, from `list_lodges`; always required."),
  })
  .strict();

/** `POST /api/admin/bed-allocation/auto-allocate`. */
export const bedAllocationAutoAllocateBodySchema = z
  .object({
    from: z.string().optional().describe(`The first night, ${NIGHT_FORMAT}; the club's today when omitted.`),
    to: z
      .string()
      .optional()
      .describe(
        `The date out, ${NIGHT_FORMAT}; 7 nights after \`from\` when omitted, at most ${MAX_BED_ALLOCATION_RANGE_NIGHTS} nights.`,
      ),
    // Board actions are always scoped to exactly one lodge.
    lodgeId: z.string().min(1).describe("The lodge, from `list_lodges`; always required."),
  })
  .strict();
