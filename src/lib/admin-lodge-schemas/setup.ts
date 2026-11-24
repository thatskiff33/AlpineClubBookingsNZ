/**
 * The request schemas of the Lodge Operations setup routes: the club's
 * lodges, each lodge's central-server link and member roster name detail, the
 * per-lodge settings, and the Other lodges registry (ALP-722, `INV-MCP-006`).
 *
 * In a pure lib module because each route parses with these and the AI app
 * action catalogue offers the same fields (`INV-SSOT`). No database or server
 * imports, so the catalogue can load it.
 *
 * THE DOOR CODE IS NEVER AN APP FIELD. A lodge's door code is a physical-access
 * secret: the lodge instructions route that holds it is website-only, and the
 * lodge routes here accept it from the screen only. The catalogue offers the
 * `...ConnectionBodySchema` variants, which are the route's own schema without
 * `doorCode`; the dispatcher sends only the fields an action names, so an app
 * cannot set or clear a door code.
 */
import { z } from "zod";

import { DISPLAY_NAME_GRANULARITY_VALUES } from "@/lib/display-name-granularity";
import { MAX_CONFIGURED_LODGE_CAPACITY, MIN_CONFIGURED_LODGE_CAPACITY } from "@/lib/lodge-effective-capacity";
import { isSafeHttpUrl, SAFE_HTTP_URL_MESSAGE } from "@/lib/http-url";
import {
  amenitiesInputSchema,
  otherLodgeDataShape,
  otherLodgeNameSchema,
  OWNED_CENTRAL_LODGE_ID_MAX,
} from "@/lib/other-lodges";

const CAPACITY_DESCRIPTION = `How many guests the lodge takes a night, ${MIN_CONFIGURED_LODGE_CAPACITY} to ${MAX_CONFIGURED_LODGE_CAPACITY}.`;

// ---------------------------------------------------------------------------
// Lodges
// ---------------------------------------------------------------------------

/** `POST /api/admin/lodges`. */
export const lodgeCreateBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).describe("The lodge's name, up to 120 characters."),
    address: z.string().trim().max(300).nullable().optional().describe("Street address; null or omitted for none."),
    doorCode: z.string().trim().max(80).nullable().optional(),
    travelNote: z
      .string()
      .trim()
      .max(2000)
      .nullable()
      .optional()
      .describe("Travel and access notes shown to guests; null or omitted for none."),
    active: z.boolean().optional().default(true).describe("Whether the lodge takes bookings; true by default."),
    /*
      REQUIRED (#3407, owner decision 14 Sep 2026). A lodge used to be born with
      no `LodgeSettings` row, so with Bed Allocation off — the default — it
      resolved to capacity 0 (`unconfigured_lodge`) and refused every booking,
      while the setup wizard, which has no rooms step in that mode, told the
      officer it was ready. Asking for the number here is what closes that gap.
      The bounds are the save bounds every other editor of the field reads
      (`INV-SSOT-001`), so a figure accepted here is exactly one
      `/api/admin/lodge-settings` would accept. It is per-deployment data a
      club types, never a default this code supplies (`INV-CONFIG-001`).
    */
    capacity: z
      .number()
      .int()
      .min(MIN_CONFIGURED_LODGE_CAPACITY)
      .max(MAX_CONFIGURED_LODGE_CAPACITY)
      .describe(CAPACITY_DESCRIPTION),
  })
  .strict();

/** What an AI app may send to create a lodge: everything but the door code. */
export const lodgeCreateConnectionBodySchema = lodgeCreateBodySchema.omit({ doorCode: true });

/** `PATCH /api/admin/lodges/[id]`: a field left out is left alone. */
export const lodgeUpdateBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional().describe("A new name; the lodge's slug follows it."),
    address: z.string().trim().max(300).nullable().optional().describe("Street address; null clears it."),
    doorCode: z.string().trim().max(80).nullable().optional(),
    travelNote: z.string().trim().max(2000).nullable().optional().describe("Travel and access notes; null clears them."),
    active: z
      .boolean()
      .optional()
      .describe("false deactivates the lodge; refused while future bookings or other records depend on it, unless `force`."),
    // Acknowledge the deactivation dependency pre-flight and proceed anyway.
    // Never written to the lodge row.
    force: z
      .boolean()
      .optional()
      .describe("Deactivate even though the refusal listed records that depend on the lodge. Only after the officer agrees."),
  })
  .strict();

/** What an AI app may send to change a lodge: everything but the door code. */
export const lodgeUpdateConnectionBodySchema = lodgeUpdateBodySchema.omit({ doorCode: true });

// ---------------------------------------------------------------------------
// One lodge's central-server link and roster name detail
// ---------------------------------------------------------------------------

/** `PUT /api/admin/lodges/[id]/central-lodge`. */
export const lodgeCentralLinkBodySchema = z
  .object({
    // Null clears the link, and the lodge then answers nothing (#4262: every
    // club links explicitly; there is no one-lodge default).
    centralLodgeId: z
      .string()
      .trim()
      .min(1)
      .max(OWNED_CENTRAL_LODGE_ID_MAX)
      .nullable()
      .describe(
        "The Alpine Central Server's id of a lodge the club owns, as `id` in `ownedLodges` from `get_lodge_central_link`; null unlinks the lodge.",
      ),
  })
  .strict();

/** `PUT /api/admin/lodges/[id]/roster-settings`. */
export const lodgeRosterSettingsBodySchema = z
  .object({
    // Null clears the per-lodge choice and falls back to the roster default.
    rosterNameGranularity: z
      .enum(DISPLAY_NAME_GRANULARITY_VALUES)
      .nullable()
      .describe("How much of each name the member lodge roster shows at this lodge; null uses the roster default."),
  })
  .strict();

// ---------------------------------------------------------------------------
// Lodge settings
// ---------------------------------------------------------------------------

/**
 * `?lodgeId=` on the lodge settings read. Not `.min(1)`, so an empty value
 * reads the club-wide row as the route always has.
 */
export const lodgeSettingsQuerySchema = z.object({
  lodgeId: z
    .string()
    .optional()
    .describe(
      "A lodge id from `list_lodges_for_officers` to read that lodge's capacity, school-group cap and readiness; omit for the club-wide row.",
    ),
});

/** `PUT /api/admin/lodge-settings`. */
export const lodgeSettingsBodySchema = z
  .object({
    // Null clears the override. Since #1982 nothing falls back to the club
    // config bed total at runtime: a cleared lodge resolves from its active
    // beds, or to 0 (`unconfigured_lodge`) when it has none.
    // The bounds are the shared ones (#2724, INV-SSOT-001), so the lodge
    // configuration screen can tell an officer whether a typed figure will be
    // accepted here without keeping its own copy of the limits.
    capacity: z
      .number()
      .int()
      .min(MIN_CONFIGURED_LODGE_CAPACITY)
      .max(MAX_CONFIGURED_LODGE_CAPACITY)
      .nullable()
      .describe(`${CAPACITY_DESCRIPTION} Required; null clears it, and the lodge then takes as many as its active beds.`),
    hutLeaderLookaheadDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe("Club-wide: how many days ahead hut leaders are planned, 1 to 365. Omitted keeps the current value."),
    // Per-lodge school-group soft cap; null clears it to the code default.
    schoolGroupSoftCap: z
      .number()
      .int()
      .positive()
      .max(100000)
      .nullable()
      .optional()
      .describe("The lodge's school-group soft cap; null clears it to the default, omitted keeps it."),
    // Lodge whose per-lodge settings are edited; the lookahead stays
    // club-wide regardless.
    lodgeId: z
      .string()
      .min(1)
      .optional()
      .describe("The active lodge whose settings change, from `list_lodges_for_officers`; omit for the club-wide row."),
  })
  .strict();

// ---------------------------------------------------------------------------
// Other lodges
// ---------------------------------------------------------------------------

/**
 * `PATCH /api/admin/other-lodges/[id]`.
 *
 * Strict: an unknown key is a 400, so every data column has to be named in the
 * shared `otherLodgeDataShape` (the one field list) to be accepted here. A key
 * left out leaves that column alone; `amenities`, when present, replaces the
 * lodge's whole set. `name` may be sent (the panel sends the whole form); a
 * DIFFERENT name renames the lodge (triyder/AlpineClubBookingsNZ#64), but only
 * once the row carries the central server's id: the upload then sends that id,
 * and the server renames its lodge. Before the id is known a new name would
 * reach the server as a second lodge and strand the first
 * (triyder/AlpineClubBookingsNZ#52), so it is refused.
 */
export const otherLodgeUpdateBodySchema = z
  .object({
    name: otherLodgeNameSchema.optional().describe("A new name; refused until the lodge has been downloaded from the central server."),
    ...otherLodgeDataShape,
    // Stricter than the pull's: the address must be one the central server
    // accepts (triyder/AlpineClubBookingsNZ#55). A request that leaves it out
    // leaves the stored one alone.
    siteUrl: otherLodgeDataShape.siteUrl.refine((v) => v == null || isSafeHttpUrl(v), SAFE_HTTP_URL_MESSAGE),
    amenities: amenitiesInputSchema.optional().describe("The lodge's whole amenity list, which replaces the stored one."),
    // This club's own lodge only (triyder/AlpineClubBookingsNZ#77): fill its
    // rates and season dates from the Fees page. While on, rates and dates sent
    // here are ignored.
    ratesFromFees: z
      .boolean()
      .optional()
      .describe("Fill the rates (integer cents) and season dates (`YYYY-MM-DD`) from the Fees page; while on, those sent are ignored."),
  })
  .strict();
