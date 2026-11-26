/**
 * The request schemas of the Lodge Operations hut-leader and chore-roster
 * officer routes (ALP-722, `INV-MCP-006`): hut leader assignments and their
 * pickers, the nights with no leader, who may lead a school booking's nights,
 * and the chore roster of one lodge night.
 *
 * In a pure lib module because each route parses with these and the AI app
 * action catalogue offers the same fields (`INV-SSOT`). Zod and client-safe
 * helpers only: no database or server imports, so the catalogue can load it.
 *
 * Where a route answers a missing or malformed query value with its own 400
 * text, the field is read as the page sends it and the route keeps that text
 * (the `GET /api/admin/bookings` precedent, ALP-719).
 */
import { z } from "zod";

import { dateOnlyStringSchema } from "@/lib/date-only-schema";

const LODGE_FROM_LIST = "The lodge, from `list_lodges`.";

// ---------------------------------------------------------------------------
// Hut leader assignments
// ---------------------------------------------------------------------------

/**
 * `?lodgeId=` where the route requires one lodge (the assignment list, the
 * candidate picker, the nights with no leader, the school hut-leader kinds).
 * A missing value answers the route's own 400.
 */
export const hutLeaderLodgeQuerySchema = z.object({
  lodgeId: z.string().min(1).describe(LODGE_FROM_LIST),
});

/** `POST /api/admin/hut-leaders`. */
export const hutLeaderAssignmentCreateBodySchema = z
  .object({
    memberId: z
      .string()
      .min(1)
      .describe("The member to make hut leader, as `id` in `list_hut_leader_candidates`."),
    startDate: dateOnlyStringSchema.describe("First night led, `YYYY-MM-DD`."),
    endDate: dateOnlyStringSchema.describe("Last night led, `YYYY-MM-DD`, on or after `startDate`."),
    lodgeId: z.string().min(1).describe(LODGE_FROM_LIST),
    // Custodian bed hold (#2286). Optional AND nullable: absent or null is the
    // default "No bed — role only", which behaves exactly as it did before this
    // feature and has zero capacity effect.
    bedId: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        "A bed to hold for the leader on those nights, as `bedId` in `list_hut_leader_bed_options`; omit or null for the role only, which holds no bed.",
      ),
    // #3817: the "Custodian (lives on site)" tick. Absent is false.
    isCustodian: z
      .boolean()
      .optional()
      .describe("True when the leader is the lodge custodian, living on site. Omitted means false."),
    // #1668-style explicit override of the over-capacity warning.
    confirmOverCapacity: z
      .boolean()
      .optional()
      .describe("True to hold the bed even though the lodge would be over capacity, after a 409 said so."),
    // #2698 ordering case: the officer's EXPLICIT acceptance that holding this
    // bed narrows an existing whole-lodge hold's represented bed set. Absent is
    // decline-by-default — the request is refused with 409
    // CUSTODIAN_OVERLAPS_WHOLE_LODGE_HOLD and nothing is written.
    amendOverlappingHolds: z
      .boolean()
      .optional()
      .describe(
        "True to accept that holding the bed takes it out of an overlapping whole-lodge hold, after a 409 `CUSTODIAN_OVERLAPS_WHOLE_LODGE_HOLD` said so.",
      ),
  })
  .refine((data) => data.startDate <= data.endDate, {
    message: "startDate must be before or equal to endDate",
  });

/** `PUT /api/admin/hut-leaders/[id]`: only what is sent changes. */
export const hutLeaderAssignmentUpdateBodySchema = z.object({
  startDate: dateOnlyStringSchema.optional().describe("New first night led, `YYYY-MM-DD`."),
  endDate: dateOnlyStringSchema.optional().describe("New last night led, `YYYY-MM-DD`."),
  lodgeId: z.string().min(1).optional().describe("Move the assignment to this lodge, from `list_lodges`."),
  // Custodian bed hold (#2286), THREE-state and deliberately so:
  //   absent          -> leave the bed exactly as it is
  //   null            -> CLEAR the bed (back to role only; the bed is bookable
  //                      again from the moment this commits)
  //   a bed id string -> set/replace the bed
  // `.nullable()` as well as `.optional()` is what makes "clear" expressible at
  // all — without it there would be no way to undo a hold except deleting the
  // whole assignment.
  bedId: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe(
      "A bed to hold, as `bedId` in `list_hut_leader_bed_options` (pass the assignment's `id` there as `assignmentId`); null releases the held bed; omit to leave it.",
    ),
  isCustodian: z
    .boolean()
    .optional()
    .describe("Whether the leader is the lodge custodian, living on site; omit to leave it."), // #3817
  // #1668-style explicit override of the over-capacity warning.
  confirmOverCapacity: z
    .boolean()
    .optional()
    .describe("True to hold the bed even though the lodge would be over capacity, after a 409 said so."),
  // #2698 ordering case: the officer's EXPLICIT acceptance that holding this
  // bed narrows an existing whole-lodge hold's represented bed set. Absent is
  // decline-by-default — 409 CUSTODIAN_OVERLAPS_WHOLE_LODGE_HOLD, nothing
  // written on either side.
  amendOverlappingHolds: z
    .boolean()
    .optional()
    .describe(
      "True to accept that holding the bed takes it out of an overlapping whole-lodge hold, after a 409 `CUSTODIAN_OVERLAPS_WHOLE_LODGE_HOLD` said so.",
    ),
});

/**
 * `GET /api/admin/hut-leaders/available-beds`. Only the dates can fail here,
 * and they answer the route's own 400; a named assignment fixes the lodge.
 */
export const hutLeaderBedOptionsQuerySchema = z.object({
  startDate: dateOnlyStringSchema.describe("First night, `YYYY-MM-DD`."),
  endDate: dateOnlyStringSchema.describe("Last night, `YYYY-MM-DD`, on or after `startDate`."),
  lodgeId: z
    .string()
    .optional()
    .describe("The lodge, from `list_lodges`. Required unless `assignmentId` is given, whose lodge then applies."),
  assignmentId: z
    .string()
    .optional()
    .describe("When changing an assignment, its `id` from `list_hut_leaders`, so the bed it already holds shows as free."),
});

/**
 * `GET /api/admin/hut-leaders/eligible-members`. The lodge is checked first,
 * then the dates, each with the route's own 400 text.
 */
export const hutLeaderCandidatesQuerySchema = hutLeaderLodgeQuerySchema.extend({
  startDate: dateOnlyStringSchema.describe("First night of the range, `YYYY-MM-DD`."),
  endDate: dateOnlyStringSchema.describe("Last night of the range, `YYYY-MM-DD`, on or after `startDate`."),
});

/**
 * `GET /api/admin/hut-leaders/unassigned-dates`. Only the lodge can fail at
 * parse; the route answers a bad month or window with its own 400 text, and a
 * month wins over a window when both are sent.
 */
export const hutLeaderUnassignedNightsQuerySchema = hutLeaderLodgeQuerySchema.extend({
  month: z
    .string()
    .optional()
    .describe("One calendar month, `YYYY-MM`: its nights, with who leads each covered one."),
  from: z
    .string()
    .optional()
    .describe("With `to`, an explicit window instead of a month: first night, `YYYY-MM-DD`."),
  to: z.string().optional().describe("With `from`: last night, `YYYY-MM-DD`."),
});

// ---------------------------------------------------------------------------
// Who can be hut leader for school bookings (#3819)
// ---------------------------------------------------------------------------

const schoolHutLeaderKindsSchema = z
  .object({
    teacherOnBooking: z
      .boolean()
      .describe("A teacher on the school booking; also makes approving a school request assign its teachers."),
    custodian: z.boolean().describe("The lodge custodian."),
    memberOnBooking: z.boolean().describe("A member who is a guest on the school booking that night."),
    memberStayingSeparately: z
      .boolean()
      .describe("A member staying that night on a booking of their own at the lodge."),
  })
  .strict();

/** `PUT /api/admin/lodge-settings/school-hut-leaders`: all four kinds, every time. */
export const schoolHutLeaderKindsBodySchema = z
  .object({
    lodgeId: z.string().min(1).describe(LODGE_FROM_LIST),
    kinds: schoolHutLeaderKindsSchema.describe(
      "Which kinds of leader cover a school booking's nights at the lodge. All four are sent.",
    ),
  })
  .strict();

// ---------------------------------------------------------------------------
// The chore roster of one lodge night
// ---------------------------------------------------------------------------

/** The `[date]` of `/api/admin/roster/[date]`; the route answers a bad date with its own 400. */
export const adminRosterDateParamsSchema = z.object({
  date: z.string().min(1).describe("The lodge night, `YYYY-MM-DD`."),
});

/** `?lodgeId=` on the roster: omitted means the club's default lodge. */
export const adminRosterLodgeQuerySchema = z.object({
  lodgeId: z
    .string()
    .optional()
    .describe("The lodge, from `list_lodges`; omitted means the club's default lodge."),
});

/** `GET /api/admin/roster/[date]`, as the roster page sends it. */
export const adminRosterQuerySchema = adminRosterLodgeQuerySchema.extend({
  regenerate: z.enum(["true", "false"]).optional(),
  includeNonEssential: z
    .enum(["true", "false"])
    .optional()
    .describe(
      "`true` or `false` to include or leave out non-essential chores when the night has no roster yet and one is suggested; omitted, the lodge's occupancy decides.",
    ),
});

/**
 * The same read as an AI app may ask for it: without `regenerate`, which
 * throws away the night's suggested chores and suggests them again. An app
 * does that with `regenerate_chore_roster`, a change it confirms first.
 */
export const adminRosterConnectionQuerySchema = adminRosterQuerySchema.omit({ regenerate: true });

// The variants of `PUT /api/admin/roster/[date]`, one AI app action each,
// told apart by `action` (which the catalogue fixes).
export const rosterSaveBodySchema = z.object({
  baseRevision: z
    .string()
    .min(1)
    .describe("The roster's `revision` from `get_chore_roster`; refused with 409 if the roster changed since."),
  acknowledgeCompletedReset: z
    .boolean()
    .describe("True to accept that chores already completed that night go back to suggested."),
  assignments: z
    .array(
      z.object({
        rowKey: z.string().min(1).describe("Any key unique within this list, echoed back on a refusal."),
        assignmentId: z
          .string()
          .min(1)
          .optional()
          .describe("An existing assignment's `id` from `get_chore_roster` to keep; omit for a new one."),
        choreTemplateId: z.string().min(1).describe("The chore, as `id` in the roster's `templates`."),
        bookingGuestId: z.string().min(1).describe("Who does it, as `id` in the roster's `guests`."),
      }),
    )
    .describe(
      "The whole roster for the night: every assignment to keep or add. One left out is removed. Each saved row is suggested again until confirmed.",
    ),
});

export const rosterRegenerateBodySchema = z.object({
  includeNonEssential: z
    .boolean()
    .optional()
    .describe("Include or leave out non-essential chores; omitted, the lodge's occupancy decides."),
  overwriteConfirmed: z
    .boolean()
    .optional()
    .describe("True to replace confirmed and completed chores too, after a 409 said the roster has them."),
});

export const rosterEmailBodySchema = z.object({
  notifyMember: z
    .boolean()
    .optional()
    .describe("False to send nothing and only record that the officer chose not to; omitted or true emails each guest."),
});

/** `PUT /api/admin/roster/[date]`: the four variants above. */
export const rosterActionSchema = z.discriminatedUnion("action", [
  rosterSaveBodySchema.extend({ action: z.literal("save") }),
  rosterRegenerateBodySchema.extend({ action: z.literal("regenerate") }),
  z.object({ action: z.literal("confirm") }),
  rosterEmailBodySchema.extend({ action: z.literal("email") }),
]);

export type RosterActionInput = z.infer<typeof rosterActionSchema>;

/** `GET /api/admin/roster/status`: a missing or bad month is the route's 400. */
export const adminRosterMonthStatusQuerySchema = z.object({
  month: z.string().describe("The calendar month, `YYYY-MM`."),
  lodgeId: z
    .string()
    .optional()
    .describe("One lodge, from `list_lodges`; omitted reads every lodge together."),
});
